/**
 * Route-local DB seam for the definitions / glossary feature (P16).
 *
 * The `lib/app/questionnaire/glossary/**` module stays Prisma-free, so every query lives here:
 * loading a version's curated set into the client-safe views, replacing it on a save, and
 * persisting the analyst's proposals.
 *
 * Mirrors `_lib/data-slot-routes.ts` in shape and in the rule it enforces — a proposal is not the
 * live set.
 */

import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { normalizeGlossarySurface } from '@/lib/app/questionnaire/glossary';
import type { DefinitionGlossaryTerm } from '@/lib/app/questionnaire/authoring/definition-export';
import type {
  GlossaryDefinitionSource,
  GlossaryDefinitionView,
  GlossaryDocumentView,
  GlossaryTermInput,
  GlossaryTermSource,
  GlossaryTermStatus,
  GlossaryTermView,
} from '@/lib/app/questionnaire/glossary';

/** Shared select projecting a term + its definitions in ordinal order. */
export const GLOSSARY_TERM_SELECT = {
  id: true,
  term: true,
  normalizedTerm: true,
  aliases: true,
  status: true,
  source: true,
  rationale: true,
  contextQuote: true,
  ordinal: true,
  definitions: {
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      text: true,
      selected: true,
      source: true,
      sourceQuote: true,
      edited: true,
      ordinal: true,
    },
  },
} as const;

type GlossaryDefinitionRow = {
  id: string;
  text: string;
  selected: boolean;
  source: string;
  sourceQuote: string | null;
  edited: boolean;
  ordinal: number;
};

type GlossaryTermRow = {
  id: string;
  term: string;
  normalizedTerm: string;
  aliases: unknown;
  status: string;
  source: string;
  rationale: string | null;
  contextQuote: string | null;
  ordinal: number;
  definitions: GlossaryDefinitionRow[];
};

/**
 * Read the `aliases` JSON column as a string array.
 *
 * The column is written only by this module from a Zod-validated payload, but it is still `Json`
 * as far as the client types go, so it is narrowed rather than asserted (no `as` on stored data).
 * A row that somehow holds a non-array reads as no aliases — the term still matches on its own
 * surface, which degrades gracefully instead of throwing into the admin surface.
 */
function readAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Project a `GLOSSARY_TERM_SELECT` row to the client-safe view. */
export function toGlossaryTermView(row: GlossaryTermRow): GlossaryTermView {
  return {
    id: row.id,
    term: row.term,
    normalizedTerm: row.normalizedTerm,
    aliases: readAliases(row.aliases),
    // Plain String columns validated at the seam (house style); the writer is the only producer.
    status: row.status as GlossaryTermStatus,
    source: row.source as GlossaryTermSource,
    rationale: row.rationale,
    contextQuote: row.contextQuote,
    ordinal: row.ordinal,
    definitions: row.definitions.map((d): GlossaryDefinitionView => ({
      id: d.id,
      text: d.text,
      selected: d.selected,
      source: d.source as GlossaryDefinitionSource,
      sourceQuote: d.sourceQuote,
      edited: d.edited,
      ordinal: d.ordinal,
    })),
  };
}

/** Every glossary term for a version, ordinal order, with its definitions. */
export async function loadGlossaryTerms(versionId: string): Promise<GlossaryTermView[]> {
  const rows = await prisma.appGlossaryTerm.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: GLOSSARY_TERM_SELECT,
  });
  return rows.map(toGlossaryTermView);
}

/** The version's attached definitions document, or `null`. Never returns the extracted text. */
export async function loadGlossaryDocument(
  versionId: string
): Promise<GlossaryDocumentView | null> {
  const row = await prisma.appGlossaryDocument.findUnique({
    where: { versionId },
    select: {
      id: true,
      fileName: true,
      byteSize: true,
      mimeType: true,
      extractedText: true,
      createdAt: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    fileName: row.fileName,
    byteSize: row.byteSize,
    mimeType: row.mimeType,
    textLength: row.extractedText.length,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Count of ACCEPTED terms for a version — what the admin surfaces and the launch summary read. */
export async function countAcceptedGlossaryTerms(versionId: string): Promise<number> {
  return prisma.appGlossaryTerm.count({ where: { versionId, status: 'accepted' } });
}

/**
 * Replace a version's entire glossary with `terms` (the admin's reviewed set), in a transaction:
 * delete every existing term (definitions cascade), then recreate each with its definitions.
 *
 * Delete-then-recreate rather than a diff because the durable identity of a term is its
 * normalised surface, not its cuid — nothing outside this table references a term id, so there is
 * nothing to re-link, and a diff would buy complexity for no invariant.
 *
 * `ordinal` follows array order for both terms and definitions, so the admin's drag order and the
 * order senses are numbered in a popover are the same order the admin saw when saving.
 */
export async function replaceGlossaryTerms(
  versionId: string,
  terms: GlossaryTermInput[],
  createdBy: string | null
): Promise<GlossaryTermView[]> {
  await executeTransaction(async (tx) => {
    await tx.appGlossaryTerm.deleteMany({ where: { versionId } });

    for (let i = 0; i < terms.length; i += 1) {
      const entry = terms[i];
      // Aliases are deduped against each other AND against the term itself: a duplicate surface
      // would add a redundant alternation branch to the matcher for no extra match.
      const normalizedTerm = normalizeGlossarySurface(entry.term);
      const aliases = [
        ...new Set(
          entry.aliases
            .map((alias) => alias.trim())
            .filter(
              (alias) => alias.length > 0 && normalizeGlossarySurface(alias) !== normalizedTerm
            )
        ),
      ];

      await tx.appGlossaryTerm.create({
        data: {
          versionId,
          term: entry.term,
          normalizedTerm,
          aliases: jsonInput(aliases),
          status: entry.status,
          source: entry.source,
          ordinal: i,
          ...(entry.rationale ? { rationale: entry.rationale } : {}),
          ...(entry.contextQuote ? { contextQuote: entry.contextQuote } : {}),
          ...(createdBy ? { createdBy } : {}),
          definitions: {
            create: entry.definitions.map((definition, ordinal) => ({
              text: definition.text,
              selected: definition.selected,
              source: definition.source,
              edited: definition.edited,
              ordinal,
              ...(definition.sourceQuote ? { sourceQuote: definition.sourceQuote } : {}),
            })),
          },
        },
        select: { id: true },
      });
    }
  });

  return loadGlossaryTerms(versionId);
}

/** Delete every `proposed` term for a version, leaving accepted/rejected adjudications intact. */
export async function deleteProposedGlossaryTerms(versionId: string): Promise<void> {
  await prisma.appGlossaryTerm.deleteMany({ where: { versionId, status: 'proposed' } });
}

/* -------------------------------------------------------------------------- */
/* Glossary analysis (the Glossary Analyst's input + its proposals)            */
/* -------------------------------------------------------------------------- */

/** What one analysis run needs, assembled from the version. */
export interface GlossaryAnalysisRouteInput {
  goal: string | null;
  audience: unknown;
  questions: { key: string; prompt: string; guidelines?: string; sectionTitle?: string }[];
  dataSlotNames: string[];
  documentText?: string;
  documentFileName?: string;
  /** Display forms of terms the admin has already accepted or rejected. */
  existingTerms: string[];
}

/**
 * Assemble the analyst's input for one version, scoped to its parent questionnaire (a mismatched
 * pair returns `null` → 404). Returns `null` when the version has no questions — there is no
 * vocabulary to analyse, and an empty run would bill for nothing.
 *
 * Loads the definitions document's TEXT (unlike {@link loadGlossaryDocument}, which deliberately
 * returns only metadata for the admin surface) because that text is the whole point of the
 * document: it is the authoritative source the analyst prefers over anything it infers.
 */
export async function buildGlossaryAnalysisInput(
  questionnaireId: string,
  versionId: string
): Promise<GlossaryAnalysisRouteInput | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      goal: true,
      audience: true,
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          title: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: { key: true, prompt: true, guidelines: true },
          },
        },
      },
      dataSlots: { orderBy: { ordinal: 'asc' }, select: { name: true } },
      glossaryDocument: { select: { fileName: true, extractedText: true } },
      // Only adjudicated terms are excluded. A still-`proposed` term is fair game to re-propose —
      // the run replaces the proposal set wholesale, so excluding those would empty the queue.
      glossaryTerms: {
        where: { status: { in: ['accepted', 'rejected'] } },
        select: { term: true },
      },
    },
  });
  if (!version) return null;

  const questions = version.sections.flatMap((section) =>
    section.questions.map((question) => ({
      key: question.key,
      prompt: question.prompt,
      ...(question.guidelines ? { guidelines: question.guidelines } : {}),
      sectionTitle: section.title,
    }))
  );
  if (questions.length === 0) return null;

  return {
    goal: version.goal,
    audience: version.audience ?? undefined,
    questions,
    dataSlotNames: version.dataSlots.map((slot) => slot.name),
    ...(version.glossaryDocument
      ? {
          documentText: version.glossaryDocument.extractedText,
          documentFileName: version.glossaryDocument.fileName,
        }
      : {}),
    existingTerms: version.glossaryTerms.map((term) => term.term),
  };
}

/** One proposal to persist (already validated by `glossaryAnalysisSchema`). */
export interface ProposedTermInput {
  term: string;
  aliases: string[];
  rationale: string;
  contextQuote?: string;
  definitions: { text: string; sourceQuote?: string }[];
}

/** What a persist reported back — the numbers the terminal SSE event carries. */
export interface PersistProposalsResult {
  proposedCount: number;
  skippedExistingCount: number;
  acceptedCount: number;
}

/**
 * Replace the version's `proposed` terms with a fresh analysis run's output.
 *
 * The two rules that make re-running safe:
 *   - **`accepted` and `rejected` rows are never touched.** Only the proposal set is replaced.
 *   - **A proposal whose normalised surface is already adjudicated is dropped**, so a re-run never
 *     re-raises a decision the admin has made. That count is reported rather than swallowed —
 *     "0 new" and "12 suggested, all already settled" are different answers.
 *
 * Duplicates *within* one run are also collapsed (first wins), since the DB's
 * `@@unique([versionId, normalizedTerm])` would otherwise fail the whole write.
 */
export async function persistProposedTerms(
  versionId: string,
  proposals: ProposedTermInput[],
  createdBy: string | null
): Promise<PersistProposalsResult> {
  const adjudicated = await prisma.appGlossaryTerm.findMany({
    where: { versionId, status: { in: ['accepted', 'rejected'] } },
    select: { normalizedTerm: true, status: true },
  });
  const taken = new Set(adjudicated.map((term) => term.normalizedTerm));
  const acceptedCount = adjudicated.filter((term) => term.status === 'accepted').length;

  const fresh: (ProposedTermInput & { normalizedTerm: string })[] = [];
  let skippedExistingCount = 0;
  for (const proposal of proposals) {
    const normalizedTerm = normalizeGlossarySurface(proposal.term);
    if (normalizedTerm.length === 0) continue;
    if (taken.has(normalizedTerm)) {
      skippedExistingCount += 1;
      continue;
    }
    taken.add(normalizedTerm);
    fresh.push({ ...proposal, normalizedTerm });
  }

  await executeTransaction(async (tx) => {
    await tx.appGlossaryTerm.deleteMany({ where: { versionId, status: 'proposed' } });

    for (let i = 0; i < fresh.length; i += 1) {
      const proposal = fresh[i];
      const aliases = [
        ...new Set(
          proposal.aliases
            .map((alias) => alias.trim())
            .filter(
              (alias) =>
                alias.length > 0 && normalizeGlossarySurface(alias) !== proposal.normalizedTerm
            )
        ),
      ];

      await tx.appGlossaryTerm.create({
        data: {
          versionId,
          term: proposal.term,
          normalizedTerm: proposal.normalizedTerm,
          aliases: jsonInput(aliases),
          status: 'proposed',
          source: 'ai_proposed',
          rationale: proposal.rationale,
          ordinal: i,
          ...(proposal.contextQuote ? { contextQuote: proposal.contextQuote } : {}),
          ...(createdBy ? { createdBy } : {}),
          definitions: {
            create: proposal.definitions.map((definition, ordinal) => ({
              text: definition.text,
              // Proposals arrive unticked: accepting a term is an explicit choice of reading, and
              // pre-ticking would let a whole glossary go live on a distracted click of "Accept".
              selected: false,
              // A definition the analyst drew from the admin's own document is marked as such —
              // that provenance is what lets them accept it without re-reading the source.
              source: definition.sourceQuote ? 'document' : 'ai_proposed',
              ordinal,
              ...(definition.sourceQuote ? { sourceQuote: definition.sourceQuote } : {}),
            })),
          },
        },
        select: { id: true },
      });
    }
  });

  return { proposedCount: fresh.length, skippedExistingCount, acceptedCount };
}

/* -------------------------------------------------------------------------- */
/* The authoritative definitions document                                     */
/* -------------------------------------------------------------------------- */

/** One parsed definitions document to attach to a version. */
export interface GlossaryDocumentInput {
  fileName: string;
  fileHash: string;
  byteSize: number;
  mimeType: string | null;
  extractedText: string;
}

/**
 * Attach (or replace) a version's definitions document. One per version, so this is an upsert on
 * `versionId` — uploading a second document replaces the first rather than accumulating, which
 * matches the mental model of "the glossary we work from".
 *
 * Terms already proposed from an older document are deliberately left alone: the admin may have
 * accepted some, and silently discarding those on a re-upload would lose curation work. Re-running
 * the analysis is the explicit way to redraw proposals from the new source.
 */
export async function upsertGlossaryDocument(
  versionId: string,
  document: GlossaryDocumentInput,
  uploadedBy: string | null
): Promise<GlossaryDocumentView> {
  const data = {
    fileName: document.fileName,
    fileHash: document.fileHash,
    byteSize: document.byteSize,
    extractedText: document.extractedText,
    ...(document.mimeType !== null ? { mimeType: document.mimeType } : {}),
    ...(uploadedBy ? { uploadedBy } : {}),
  };

  const row = await prisma.appGlossaryDocument.upsert({
    where: { versionId },
    create: { versionId, ...data },
    update: data,
    select: {
      id: true,
      fileName: true,
      byteSize: true,
      mimeType: true,
      extractedText: true,
      createdAt: true,
    },
  });

  return {
    id: row.id,
    fileName: row.fileName,
    byteSize: row.byteSize,
    mimeType: row.mimeType,
    textLength: row.extractedText.length,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Remove a version's definitions document. No-op when there is none.
 *
 * Terms already drawn from it are kept — a definition the admin accepted is theirs now, and the
 * `sourceQuote` on it remains a truthful record of where the wording came from even after the
 * source file is gone.
 */
export async function deleteGlossaryDocument(versionId: string): Promise<void> {
  await prisma.appGlossaryDocument.deleteMany({ where: { versionId } });
}

/**
 * The version's glossary in DEFINITION-EXPORT shape.
 *
 * Deliberately reads EVERY status, not just `accepted`: an export is the authored artifact, and a
 * rejected term is a decision worth carrying so re-importing elsewhere doesn't resurrect it as a
 * fresh proposal. The definitions document is NOT included — it is an upload, not part of a
 * portable definition, and its text can be large.
 */
export async function loadGlossaryForExport(versionId: string): Promise<DefinitionGlossaryTerm[]> {
  const rows = await prisma.appGlossaryTerm.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: {
      term: true,
      aliases: true,
      status: true,
      source: true,
      rationale: true,
      contextQuote: true,
      definitions: {
        orderBy: { ordinal: 'asc' },
        select: {
          text: true,
          selected: true,
          source: true,
          sourceQuote: true,
          edited: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    term: row.term,
    aliases: readAliases(row.aliases),
    status: row.status,
    source: row.source,
    rationale: row.rationale,
    contextQuote: row.contextQuote,
    definitions: row.definitions.map((definition) => ({
      text: definition.text,
      selected: definition.selected,
      source: definition.source,
      sourceQuote: definition.sourceQuote,
      edited: definition.edited,
    })),
  }));
}

/* -------------------------------------------------------------------------- */
/* Publish to the client knowledge base (opt-in, one-way)                     */
/* -------------------------------------------------------------------------- */

/** What a publish needs to know about the version and who owns it. */
export interface GlossaryPublishTarget {
  questionnaireTitle: string;
  versionNumber: number;
  demoClientId: string | null;
  demoClientName: string | null;
  acceptedTermCount: number;
}

/**
 * Resolve the publish target for a version, or `null` when the version doesn't resolve.
 *
 * A null `demoClientId` is a legitimate answer, not an error: an unattributed questionnaire has no
 * client corpus to publish into, and the route turns that into a clear 409 rather than a silent
 * no-op.
 */
export async function loadGlossaryPublishTarget(
  questionnaireId: string,
  versionId: string
): Promise<GlossaryPublishTarget | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      versionNumber: true,
      questionnaire: {
        select: {
          title: true,
          demoClientId: true,
          demoClient: { select: { name: true } },
        },
      },
      _count: { select: { glossaryTerms: { where: { status: 'accepted' } } } },
    },
  });
  if (!version) return null;

  return {
    questionnaireTitle: version.questionnaire.title,
    versionNumber: version.versionNumber,
    demoClientId: version.questionnaire.demoClientId,
    demoClientName: version.questionnaire.demoClient?.name ?? null,
    acceptedTermCount: version._count.glossaryTerms,
  };
}

/**
 * Render the accepted glossary as a knowledge-base markdown document.
 *
 * The SCOPE LINE at the top is load-bearing, not decoration. The knowledge base is scoped per demo
 * CLIENT while a glossary is scoped per VERSION, so a client with two questionnaires that define
 * the same term differently will end up with two documents in one corpus. Retrieval has no way to
 * tell them apart — the scope line is the only thing that gives a reader (or a report writer that
 * retrieved it) any chance of disambiguating.
 */
export function renderGlossaryKnowledgeDocument(
  target: GlossaryPublishTarget,
  entries: readonly { term: string; definitions: string[] }[]
): string {
  const lines: string[] = [
    `# Glossary — ${target.questionnaireTitle} (v${target.versionNumber})`,
    '',
    `These definitions apply to the questionnaire "${target.questionnaireTitle}" (version ` +
      `${target.versionNumber}). They may not hold for other questionnaires, even for the same ` +
      `client — the same term can legitimately be defined differently elsewhere.`,
    '',
  ];

  for (const entry of entries) {
    lines.push(`## ${entry.term}`, '');
    if (entry.definitions.length === 1) {
      lines.push(entry.definitions[0], '');
    } else {
      lines.push('This questionnaire uses this term in more than one sense:', '');
      entry.definitions.forEach((definition, i) => lines.push(`${i + 1}. ${definition}`));
      lines.push('');
    }
  }

  return lines.join('\n');
}
