/**
 * Ingestion persistence writer (F1.1 / PR4, T1.4.2).
 *
 * Writes the extractor's structured result into the bespoke app graph —
 * `AppQuestionnaire` → `AppQuestionnaireVersion` → `AppQuestionnaireSection` →
 * `AppQuestionSlot`, plus the `AppQuestionnaireExtractionChange` audit log and
 * the `AppQuestionnaireSourceDocument` — in **one transaction**, all-or-nothing.
 * Applies the admin-wins-per-field goal/audience merge and returns the new ids,
 * structural counts, and per-field provenance.
 *
 * This is where the storage-agnostic capability output (PR3) meets the database:
 * the capability never imports Prisma; the route does, through this module.
 */

import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { executeTransaction } from '@/lib/db/utils';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import {
  mergeGoalAudience,
  type MergeProvenance,
} from '@/app/api/v1/app/questionnaires/_lib/merge';

/** The interactive-transaction client `executeTransaction` passes to its callback. */
type IngestTx = Parameters<Parameters<typeof executeTransaction>[0]>[0];

/**
 * How a freshly-written question graph resolves each slot's `required` flag.
 *  - `'all'`      — every question is required (the admin's "mark all required" default).
 *  - `'optional'` — every question is optional (the historical behaviour; refine keeps it).
 *  - `'source'`   — honour what the extractor read off the document (`q.required ?? false`).
 */
export type RequirednessPolicy = 'all' | 'optional' | 'source';

/** Resolve one slot's `required` flag from the policy and the extracted value. */
function resolveRequired(policy: RequirednessPolicy, extracted: boolean | undefined): boolean {
  switch (policy) {
    case 'all':
      return true;
    case 'source':
      return extracted ?? false;
    case 'optional':
      return false;
  }
}

/** Parse provenance carried from the route onto the source-document row. */
export interface IngestionSourceInput {
  fileName: string;
  /** SHA-256 of the raw upload bytes (lowercase hex). */
  fileHash: string;
  byteSize: number;
  mimeType?: string;
  pageCount?: number;
  warnings: string[];
  /** The text extraction consumed; F2.3 verifies source quotes against it. */
  extractedText: string;
}

export interface PersistIngestionInput {
  /** Title for the new questionnaire (admin-supplied name, else derived from the parsed document). */
  documentTitle: string;
  /** DEMO-ONLY (F2.5.1): attribute the new questionnaire to this demo client (omit for a generic demo). */
  demoClientId?: string;
  /** The structured, normalised extractor output. */
  extraction: ExtractQuestionnaireStructureData;
  /** Admin-supplied goal/audience (admin wins per field over inferred). */
  admin: { goal?: string; audience?: Partial<AudienceShape> };
  source: IngestionSourceInput;
  /**
   * How each written question's `required` flag is resolved. Defaults to `'all'`
   * for a new ingest/compose (the admin's "mark all required" default, checked by
   * default in the UI); pass `'source'` to honour the document's required markers.
   */
  requiredness?: RequirednessPolicy;
}

export interface PersistIngestionResult {
  questionnaireId: string;
  versionId: string;
  sectionCount: number;
  questionCount: number;
  changeCount: number;
  goal: string | null;
  audience: AudienceShape | null;
  fieldProvenance: MergeProvenance;
}

/**
 * One question references a section that the extraction never declared. Surfaced
 * by {@link assertPersistable} *before* any write so the route can return a typed
 * 422 rather than persisting a dangling-FK graph or silently dropping the
 * question. Carries the offending ordinals for the error envelope.
 */
export class IncoherentExtractionError extends Error {
  constructor(readonly orphanSectionOrdinals: number[]) {
    super(
      `Extraction references ${orphanSectionOrdinals.length} section ordinal(s) that no section declares: ${orphanSectionOrdinals.join(', ')}`
    );
    this.name = 'IncoherentExtractionError';
  }
}

/**
 * Convert an arbitrary (LLM-originated) JSON value into a Prisma `Json` input.
 * `null`/`undefined` map to the DB-null sentinel; any other value is stored as
 * opaque JSON. The shape is intentionally untrusted — this is a storage-boundary
 * cast, the same discipline the capability seed uses for its function definition.
 */
function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value;
}

/**
 * Validate that every question maps to a declared section ordinal. Throws
 * {@link IncoherentExtractionError} listing the orphans. Pure — no DB — so the
 * route can call it before opening a transaction.
 */
export function assertPersistable(extraction: ExtractQuestionnaireStructureData): void {
  const declared = new Set(extraction.sections.map((s) => s.ordinal));
  const orphans = new Set<number>();
  for (const q of extraction.questions) {
    if (!declared.has(q.sectionOrdinal)) orphans.add(q.sectionOrdinal);
  }
  if (orphans.size > 0) {
    throw new IncoherentExtractionError([...orphans].sort((a, b) => a - b));
  }
}

/** Structural counts written by {@link writeGraph}. */
export interface GraphCounts {
  sectionCount: number;
  questionCount: number;
  changeCount: number;
}

/**
 * Write the extracted section → slot graph and the editorial change log onto an
 * **existing** version, inside the caller's transaction. Shared by a new ingest
 * (F1.1, fresh version) and a re-ingest (F2.4, after the draft's prior graph is
 * cleared). Call {@link assertPersistable} first — this assumes every question's
 * `sectionOrdinal` resolves.
 */
export async function writeGraph(
  tx: IngestTx,
  versionId: string,
  extraction: ExtractQuestionnaireStructureData,
  requiredness: RequirednessPolicy = 'optional'
): Promise<GraphCounts> {
  // Sections first — slots and change records reference them.
  const sectionIdByOrdinal = new Map<number, string>();
  for (const section of extraction.sections) {
    const created = await tx.appQuestionnaireSection.create({
      data: {
        versionId,
        ordinal: section.ordinal,
        title: section.title,
        ...(section.description !== undefined ? { description: section.description } : {}),
      },
      select: { id: true },
    });
    sectionIdByOrdinal.set(section.ordinal, created.id);
  }

  // Slots — one createMany; `versionId` is denormalised onto each row (F2.2
  // tag validation reads it), `sectionId` resolved from the ordinal map.
  if (extraction.questions.length > 0) {
    await tx.appQuestionSlot.createMany({
      data: extraction.questions.map((q, index) => {
        // assertPersistable guarantees the ordinal resolves.
        const sectionId = sectionIdByOrdinal.get(q.sectionOrdinal) as string;
        return {
          versionId,
          sectionId,
          ordinal: index,
          key: q.key,
          prompt: q.prompt,
          type: q.suggestedType,
          required: resolveRequired(requiredness, q.required),
          // Neutral midpoint of the 0.1–1.0 weight scale; admins tune it in the Structure editor.
          weight: 0.5,
          ...(q.guidelines !== undefined ? { guidelines: q.guidelines } : {}),
          ...(q.rationale !== undefined ? { rationale: q.rationale } : {}),
          ...(q.suggestedTypeConfig !== undefined
            ? { typeConfig: jsonInput(q.suggestedTypeConfig) }
            : {}),
          extractionConfidence: q.extractionConfidence,
        };
      }),
    });
  }

  // Change records — the revertible editorial log. `targetEntityId` resolves to
  // the version for version-level (infer_*) decisions; section/question-targeted
  // edits stay null (the LLM intent carries no entity linkage — F2.3 reconciles
  // them against `sourceQuote` / before-after JSON on the review surface).
  if (extraction.changes.length > 0) {
    await tx.appQuestionnaireExtractionChange.createMany({
      data: extraction.changes.map((change) => ({
        versionId,
        changeType: change.changeType,
        targetEntityType: change.targetEntityType,
        targetEntityId: change.targetEntityType === 'version' ? versionId : null,
        ...(change.sourceQuote !== undefined ? { sourceQuote: change.sourceQuote } : {}),
        ...(change.beforeJson !== undefined ? { beforeJson: jsonInput(change.beforeJson) } : {}),
        ...(change.afterJson !== undefined ? { afterJson: jsonInput(change.afterJson) } : {}),
        ...(change.rationale !== undefined ? { rationale: change.rationale } : {}),
        ...(change.confidence !== undefined ? { confidence: change.confidence } : {}),
        status: 'applied',
      })),
    });
  }

  return {
    sectionCount: extraction.sections.length,
    questionCount: extraction.questions.length,
    changeCount: extraction.changes.length,
  };
}

/**
 * Write the source-document provenance row for a version, inside the caller's
 * transaction. Shared by ingest and re-ingest; re-ingest **appends** a new row
 * (prior source docs are kept), so the relation is 1:many.
 */
export async function writeSourceDocument(
  tx: IngestTx,
  versionId: string,
  source: IngestionSourceInput
): Promise<void> {
  await tx.appQuestionnaireSourceDocument.create({
    data: {
      versionId,
      fileName: source.fileName,
      fileHash: source.fileHash,
      byteSize: source.byteSize,
      ...(source.mimeType !== undefined ? { mimeType: source.mimeType } : {}),
      ...(source.pageCount !== undefined ? { pageCount: source.pageCount } : {}),
      warnings: source.warnings.length > 0 ? jsonInput(source.warnings) : Prisma.JsonNull,
      extractedText: source.extractedText,
      // Raw `bytes` deliberately not persisted: no consumer yet (F2.4 re-ingest
      // re-uploads rather than diffing against a stored copy). The column stays
      // nullable, reserved for a future diff-against-source / re-parse feature.
    },
    select: { id: true },
  });
}

/**
 * Persist a freshly-extracted questionnaire graph in a single transaction.
 *
 * Call {@link assertPersistable} first (the route does) — this assumes every
 * question's `sectionOrdinal` resolves.
 */
export async function persistIngestion(
  input: PersistIngestionInput
): Promise<PersistIngestionResult> {
  const { extraction, admin, source } = input;

  // Resolve goal/audience once, outside the transaction (pure).
  const merged = mergeGoalAudience({
    admin,
    inferred: {
      ...(extraction.inferredGoal !== undefined ? { goal: extraction.inferredGoal } : {}),
      ...(extraction.inferredAudience !== undefined
        ? { audience: extraction.inferredAudience }
        : {}),
    },
  });

  return executeTransaction(async (tx) => {
    const questionnaire = await tx.appQuestionnaire.create({
      data: {
        title: input.documentTitle,
        status: 'draft',
        // DEMO-ONLY (F2.5.1): optional attribution set at create time.
        ...(input.demoClientId !== undefined ? { demoClientId: input.demoClientId } : {}),
      },
      select: { id: true },
    });

    const version = await tx.appQuestionnaireVersion.create({
      data: {
        questionnaireId: questionnaire.id,
        versionNumber: 1,
        status: 'draft',
        goal: merged.goal,
        audience: merged.audience === null ? Prisma.JsonNull : jsonInput(merged.audience),
        // Persist the admin-wins-per-field provenance the merge resolved, so the
        // admin read surface can mark inferred values without re-deriving from
        // the change log. `goalProvenance` is null when no goal was resolved;
        // `audienceProvenance` is SQL-NULL when no audience field was.
        goalProvenance: merged.provenance.goal ?? null,
        audienceProvenance:
          Object.keys(merged.provenance.audience).length > 0
            ? jsonInput(merged.provenance.audience)
            : Prisma.JsonNull,
      },
      select: { id: true },
    });
    const versionId = version.id;

    // Default to "all required" for a fresh ingest/compose — the admin's
    // mark-all-required default (the UI checkbox is checked by default).
    const counts = await writeGraph(tx, versionId, extraction, input.requiredness ?? 'all');
    await writeSourceDocument(tx, versionId, source);

    return {
      questionnaireId: questionnaire.id,
      versionId,
      ...counts,
      goal: merged.goal,
      audience: merged.audience,
      fieldProvenance: merged.provenance,
    };
  });
}

/**
 * Synthesize the source-document provenance row for a **brief-composed**
 * questionnaire (generative authoring). There is no uploaded file, so the brief
 * itself is the provenance: it stands in as the "document text". This keeps
 * {@link persistIngestion}'s contract unchanged (every version gets a source row)
 * and lets a later re-ingest / diff feature treat a composed questionnaire the
 * same as an uploaded one. The hash is over the brief, so re-composing from the
 * exact same brief is detectable, but the compose route deliberately does not
 * dedup (each generation is intentionally a fresh questionnaire).
 */
export function briefSource(brief: string): IngestionSourceInput {
  return {
    fileName: 'brief.txt',
    fileHash: createHash('sha256').update(brief).digest('hex'),
    byteSize: Buffer.byteLength(brief, 'utf8'),
    mimeType: 'text/plain',
    warnings: [],
    extractedText: brief,
  };
}

/**
 * Replace a draft version's section→slot graph from a freshly-refined structure,
 * in a single transaction. Used by the conversational-refine turn: the composer
 * returns the FULL updated structure, so the simplest coherent write is to clear
 * the prior graph and re-write it (the same delete-then-write shape re-ingest
 * uses). Optionally re-resolves the version's goal/audience from the refined
 * inferred values when present.
 *
 * Call {@link assertPersistable} first (the route does) — this assumes every
 * question's `sectionOrdinal` resolves. The caller must ensure the version is a
 * draft with no respondent sessions (a refine never rewrites a launched graph).
 */
export async function replaceVersionStructure(
  versionId: string,
  extraction: ExtractQuestionnaireStructureData
): Promise<GraphCounts> {
  return executeTransaction(async (tx) => {
    // Clear the prior graph. Order: change log + sections (cascades slots →
    // slot-tag joins) first, then the now-unreferenced tag vocabulary — the same
    // order the re-ingest writer uses.
    await tx.appQuestionnaireExtractionChange.deleteMany({ where: { versionId } });
    await tx.appQuestionnaireSection.deleteMany({ where: { versionId } });
    await tx.appQuestionTag.deleteMany({ where: { versionId } });

    // Refresh goal/audience from the refined structure when the composer inferred
    // them this turn; otherwise leave the existing values untouched.
    const data: Prisma.AppQuestionnaireVersionUpdateInput = {};
    if (extraction.inferredGoal !== undefined) data.goal = extraction.inferredGoal;
    if (extraction.inferredAudience !== undefined) {
      data.audience = jsonInput(extraction.inferredAudience);
    }
    if (Object.keys(data).length > 0) {
      await tx.appQuestionnaireVersion.update({
        where: { id: versionId },
        data,
        select: { id: true },
      });
    }

    return writeGraph(tx, versionId, extraction);
  });
}
