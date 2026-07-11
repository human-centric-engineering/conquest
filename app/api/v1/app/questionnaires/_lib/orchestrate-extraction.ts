/**
 * Streaming-ingest orchestrator: extract → verify → repair → coherence (ingest verify + repair).
 *
 * The non-streaming ingest and re-ingest routes keep calling {@link extractFromDocument} directly
 * (a single synchronous extractor pass). The *streaming* route drives THIS generator instead: it
 * runs the same extract, then — when the verify+repair sub-flag is on — a critic pass that flags
 * mis-typed / mis-scaled questions and a scales-&-matrix specialist that re-extracts only the
 * flagged ones, before the existing coherence gate and persist.
 *
 * It yields real {@link ExtractionPhaseEvent}s as it goes (the route re-yields them over SSE) and
 * returns the same {@link PipelineResult} `extractFromDocument` does, so the route's persist block
 * is unchanged. Every added stage is FAIL-SOFT: a missing/failing verifier or repair agent, or a
 * repair that doesn't validate strictly better, leaves the extraction no worse than the raw pass.
 *
 * Server-only (Prisma agent loads + capability dispatch). Boundary note: this lives under
 * `app/api/**`, so importing Prisma / the dispatcher here is fine (unlike `lib/app/**`).
 */

import 'server-only';

import { errorResponse } from '@/lib/api/responses';
import type { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import {
  REPAIR_QUESTIONS_CAPABILITY_SLUG,
  QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
  QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
  VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import { isIngestVerifyRepairEnabled } from '@/lib/app/questionnaire/feature-flag';
import { validateTypeConfig } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import type { ExtractedQuestion } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ChangeRecordIntent } from '@/lib/app/questionnaire/ingestion/types';
import {
  validateVerifyResult,
  type VerifyResult,
  type QuestionVerdict,
} from '@/lib/app/questionnaire/ingestion/verify-schema';
import {
  validateRepairResult,
  type RepairResult,
} from '@/lib/app/questionnaire/ingestion/repair-schema';
import type { ExtractionPhaseEvent } from '@/lib/app/questionnaire/ingestion/extraction-stream-events';

import {
  extractFromDocument,
  type ExtractedDocument,
  type GuardedUpload,
  type PipelineResult,
} from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import {
  assertPersistable,
  IncoherentExtractionError,
} from '@/app/api/v1/app/questionnaires/_lib/persist';

type RouteLogger = Awaited<ReturnType<typeof getRouteLogger>>;
interface ExtractCtx {
  adminId: string;
  log: RouteLogger;
}

/**
 * When the verifier flags MORE than this many questions, the problem is systemic (a bad
 * extractor pass), not a handful of surgical fixes — churning a huge repair would be slower
 * and riskier than surfacing the raw draft for the admin to review. Skip repair and log.
 */
const REPAIR_FLAG_CEILING = 20;

const EMPTY_VERIFY: VerifyResult = { verdicts: [], matrixGroups: [] };
const EMPTY_REPAIR: RepairResult = { repairs: [] };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The streaming ingest pipeline. Yields phase events; returns the extractor output (verified +
 * repaired when the sub-flag is on) or a ready-made error `Response` — exactly what the route's
 * persist block already expects.
 */
export async function* orchestrateExtraction(
  upload: GuardedUpload,
  ctx: ExtractCtx
): AsyncGenerator<ExtractionPhaseEvent, PipelineResult<ExtractedDocument>> {
  yield {
    type: 'phase',
    phase: 'extracting',
    message: 'Structure extractor — reading and understanding the document…',
  };

  const extracted = await extractFromDocument(upload, ctx);
  if (!extracted.ok) return extracted;

  // Sub-flag off → today's exact behaviour (single extractor pass, already coherence-checked).
  if (!(await isIngestVerifyRepairEnabled())) return extracted;

  let extraction = extracted.value.extraction;
  const parsed = extracted.value.parsed;
  const documentText = parsed.fullText;
  const fileName = upload.file.name;
  const total = extraction.questions.length;

  // ── Verify (fail-soft): flag questions whose type/config doesn't match the source. ──
  yield {
    type: 'phase',
    phase: 'verifying',
    message: `Fidelity critic — checking all ${total} question${total === 1 ? '' : 's'} against the source…`,
  };
  const flags = await runVerification(extraction, documentText, fileName, ctx);
  const flagged = flags.verdicts.filter((v) => v.verdict === 'suspect');

  if (flagged.length === 0) {
    // Verifier clean → no repair call at all (the common, cheap case).
    yield {
      type: 'phase',
      phase: 'verifying',
      message: 'All questions look faithful — no repairs needed.',
    };
  } else if (flagged.length > REPAIR_FLAG_CEILING) {
    ctx.log.warn('ingest verify flagged too many questions; skipping repair', {
      flagged: flagged.length,
      total,
    });
  } else {
    // ── Repair (fail-soft): re-extract ONLY the flagged questions, then guard the merge. ──
    yield {
      type: 'phase',
      phase: 'repairing',
      message: `Scales & matrix specialist — repairing ${flagged.length} flagged question${flagged.length === 1 ? '' : 's'}…`,
      progress: { done: 0, total: flagged.length },
    };
    const repairs = await runRepair(extraction, flags, flagged, documentText, fileName, ctx);
    extraction = mergeRepairs(extraction, repairs, ctx.log);
  }

  // Coherence AFTER the merge (repair can add/replace questions). Same typed 422 the raw pass uses.
  try {
    assertPersistable(extraction);
  } catch (err) {
    if (err instanceof IncoherentExtractionError) {
      ctx.log.warn('ingest extraction incoherent after repair', {
        orphanSectionOrdinals: err.orphanSectionOrdinals,
      });
      return {
        ok: false,
        response: errorResponse(err.message, {
          code: 'EXTRACTION_INCOHERENT',
          status: 422,
          details: { orphanSectionOrdinals: err.orphanSectionOrdinals },
        }),
      };
    }
    throw err;
  }

  return { ok: true, value: { extraction, parsed } };
}

/**
 * Dispatch the verifier over all questions + the source. Fail-soft: a missing/failing verifier
 * agent returns empty verdicts, so persist proceeds on the raw extraction (never blocked).
 */
async function runVerification(
  extraction: ExtractQuestionnaireStructureData,
  documentText: string,
  fileName: string,
  ctx: ExtractCtx
): Promise<VerifyResult> {
  try {
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      ctx.log.warn('ingest verifier agent not seeded; skipping verification', {
        slug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
      });
      return EMPTY_VERIFY;
    }
    registerBuiltInCapabilities();
    const questions = extraction.questions.map((q) => ({
      key: q.key,
      prompt: q.prompt,
      suggestedType: q.suggestedType,
      ...(q.suggestedTypeConfig !== undefined
        ? { suggestedTypeConfig: q.suggestedTypeConfig }
        : {}),
      ...(q.sourceQuote !== undefined ? { sourceQuote: q.sourceQuote } : {}),
      extractionConfidence: q.extractionConfidence,
    }));
    const dispatch = await capabilityDispatcher.dispatch(
      VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG,
      { questions, documentText, fileName },
      {
        userId: ctx.adminId,
        agentId: agent.id,
        entityContext: {
          verifierAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );
    if (!dispatch.success || !dispatch.data) {
      ctx.log.warn('ingest verification failed; persisting raw extraction', {
        code: dispatch.error?.code,
      });
      return EMPTY_VERIFY;
    }
    // Validate the capability payload rather than trust its shape: a malformed `result` must
    // fall back to "no flags" (fail-soft), never crash the generator and abort the whole ingest.
    const validated = validateVerifyResult((dispatch.data as { result?: unknown }).result);
    if (!validated.ok) {
      ctx.log.warn(
        'ingest verification returned an unparseable result; persisting raw extraction',
        {
          issues: validated.issues,
        }
      );
      return EMPTY_VERIFY;
    }
    return validated.value;
  } catch (err) {
    ctx.log.warn('ingest verification threw; persisting raw extraction', {
      error: errorMessage(err),
    });
    return EMPTY_VERIFY;
  }
}

/**
 * Dispatch the repair specialist over the flagged subset. Fail-soft: a missing/failing repair
 * agent returns no repairs, so the flagged questions keep their original (imperfect) type — never
 * worse.
 */
async function runRepair(
  extraction: ExtractQuestionnaireStructureData,
  flags: VerifyResult,
  flagged: QuestionVerdict[],
  documentText: string,
  fileName: string,
  ctx: ExtractCtx
): Promise<RepairResult> {
  try {
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      ctx.log.warn('ingest repair agent not seeded; keeping flagged questions as-is', {
        slug: QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
      });
      return EMPTY_REPAIR;
    }
    registerBuiltInCapabilities();
    const flaggedKeys = new Set(flagged.map((f) => f.key));
    const targets = extraction.questions.filter((q) => flaggedKeys.has(q.key));
    const issueByKey: Record<string, string> = {};
    for (const f of flagged) {
      if (f.issue) issueByKey[f.key] = f.detail ? `${f.issue}: ${f.detail}` : f.issue;
    }
    const dispatch = await capabilityDispatcher.dispatch(
      REPAIR_QUESTIONS_CAPABILITY_SLUG,
      {
        targets,
        matrixGroups: flags.matrixGroups,
        issueByKey,
        documentText,
        fileName,
      },
      {
        userId: ctx.adminId,
        agentId: agent.id,
        entityContext: {
          repairAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );
    if (!dispatch.success || !dispatch.data) {
      ctx.log.warn('ingest repair failed; keeping flagged questions as-is', {
        code: dispatch.error?.code,
      });
      return EMPTY_REPAIR;
    }
    // Validate the capability payload rather than trust its shape: a malformed `result` must
    // fall back to "no repairs" (fail-soft), never crash the generator and abort the whole ingest.
    const validated = validateRepairResult((dispatch.data as { result?: unknown }).result);
    if (!validated.ok) {
      ctx.log.warn(
        'ingest repair returned an unparseable result; keeping flagged questions as-is',
        {
          issues: validated.issues,
        }
      );
      return EMPTY_REPAIR;
    }
    return validated.value;
  } catch (err) {
    ctx.log.warn('ingest repair threw; keeping flagged questions as-is', {
      error: errorMessage(err),
    });
    return EMPTY_REPAIR;
  }
}

/** Build a revertible change intent for a `correct` repair (type change vs config-only). */
function changeForCorrect(
  original: ExtractedQuestion,
  candidate: ExtractedQuestion
): ChangeRecordIntent {
  const typeChanged = original.suggestedType !== candidate.suggestedType;
  return {
    changeType: typeChanged ? 'infer_type' : 'augment_question',
    targetEntityType: 'question',
    beforeJson: {
      suggestedType: original.suggestedType,
      suggestedTypeConfig: original.suggestedTypeConfig ?? null,
    },
    afterJson: {
      suggestedType: candidate.suggestedType,
      suggestedTypeConfig: candidate.suggestedTypeConfig ?? null,
    },
    rationale: 'Repaired by the scales/matrix specialist during ingestion.',
    ...(typeof candidate.extractionConfidence === 'number'
      ? { confidence: candidate.extractionConfidence }
      : {}),
  };
}

/** Build a revertible change intent for a `merge` repair (N mis-split rows → one matrix). */
function changeForMerge(
  originals: ExtractedQuestion[],
  matrix: ExtractedQuestion
): ChangeRecordIntent {
  return {
    changeType: 'merge_questions',
    targetEntityType: 'question',
    beforeJson: originals.map((q) => ({ key: q.key, suggestedType: q.suggestedType })),
    afterJson: { key: matrix.key, suggestedType: matrix.suggestedType },
    rationale: 'Merged mis-split rating-grid rows into one matrix question during ingestion.',
  };
}

/**
 * Merge the repair specialist's corrections back into the extraction, GUARDED. A `correct` is
 * accepted only if it keeps the original key and its config passes the tight write schema; a
 * `merge` only if it produces a valid `matrix` from ≥2 originals. Anything that doesn't pass
 * leaves the original question untouched (never worse). Accepted repairs append revertible change
 * intents. Question order is preserved; a merged matrix takes the position of its first row.
 */
export function mergeRepairs(
  extraction: ExtractQuestionnaireStructureData,
  repairs: RepairResult,
  log: RouteLogger
): ExtractQuestionnaireStructureData {
  if (repairs.repairs.length === 0) return extraction;

  const byKey = new Map(extraction.questions.map((q) => [q.key, q]));
  const order = extraction.questions.map((q) => q.key);
  const allKeys = new Set(order);
  const newChanges: ChangeRecordIntent[] = [];
  const removedKeys = new Set<string>();
  const replacements = new Map<string, ExtractedQuestion>();
  const mergeByAnchor = new Map<string, ExtractedQuestion>();

  // A key is "consumed" once an earlier repair removed it (merged away) or replaced it (corrected).
  const isConsumed = (key: string): boolean => removedKeys.has(key) || replacements.has(key);

  for (const repair of repairs.repairs) {
    if (repair.action === 'correct') {
      const originalKey = repair.originalKeys[0];
      const original = originalKey ? byKey.get(originalKey) : undefined;
      const candidate = repair.questions[0];
      if (!original || !candidate) continue;
      // A prior repair already claimed this key — don't record a second (discarded) change for it.
      if (isConsumed(originalKey)) continue;
      if (candidate.key !== originalKey) {
        log.warn('ingest repair: correct changed the key; keeping original', { originalKey });
        continue;
      }
      // A corrected config must be STRICTLY launchable (tight write schema) to be accepted.
      if (!validateTypeConfig(candidate.suggestedType, candidate.suggestedTypeConfig).ok) {
        log.warn('ingest repair: corrected config invalid; keeping original', { originalKey });
        continue;
      }
      // Never let repair move a question to a different section.
      candidate.sectionOrdinal = original.sectionOrdinal;
      replacements.set(originalKey, candidate);
      newChanges.push(changeForCorrect(original, candidate));
    } else {
      // merge: N mis-split rows → one matrix. Keep only rows that actually resolve to a real,
      // still-available question — a stale/hallucinated key from the model is dropped, and a row
      // already consumed by an earlier repair can't be merged twice (no duplicate across matrices).
      const originals = repair.originalKeys
        .map((k) => byKey.get(k))
        .filter((q): q is ExtractedQuestion => q !== undefined && !isConsumed(q.key));
      const matrix = repair.questions[0];
      if (originals.length < 2 || !matrix) continue;
      if (
        matrix.suggestedType !== 'matrix' ||
        !validateTypeConfig(matrix.suggestedType, matrix.suggestedTypeConfig).ok
      ) {
        log.warn('ingest repair: merge produced an invalid matrix; keeping originals', {
          originalKeys: repair.originalKeys,
        });
        continue;
      }
      matrix.sectionOrdinal = originals[0].sectionOrdinal;
      matrix.key = nextAvailableKey(matrix.key, allKeys);
      allKeys.add(matrix.key);
      // Anchor the inserted matrix at the first RESOLVED row's position — never `originalKeys[0]`,
      // which may be a stale key absent from `order`: the matrix would then never be re-inserted
      // and every merged row would be silently dropped (violating the "never worse" contract).
      const anchor = originals[0].key;
      for (const q of originals) removedKeys.add(q.key);
      mergeByAnchor.set(anchor, matrix);
      newChanges.push(changeForMerge(originals, matrix));
    }
  }

  if (newChanges.length === 0) return extraction;

  const out: ExtractedQuestion[] = [];
  for (const key of order) {
    if (removedKeys.has(key)) {
      const merged = mergeByAnchor.get(key);
      if (merged) out.push(merged); // insert the merged matrix at its first row's position
      continue;
    }
    const question = replacements.get(key) ?? byKey.get(key);
    if (question) out.push(question);
  }

  return { ...extraction, questions: out, changes: [...extraction.changes, ...newChanges] };
}
