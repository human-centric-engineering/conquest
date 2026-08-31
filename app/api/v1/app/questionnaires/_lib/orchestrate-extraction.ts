/**
 * Streaming-ingest orchestrator: extract → verify → repair → coherence (ingest verify + repair).
 *
 * The non-streaming ingest and re-ingest routes keep calling {@link extractFromDocument} directly
 * (a single synchronous extractor pass). The *streaming* route drives THIS generator instead: it
 * runs the same extract, then a critic pass that flags mis-typed / mis-scaled questions and a
 * scales-&-matrix specialist that re-extracts only the flagged ones, before the existing
 * coherence gate and persist.
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
import { validateTypeConfig } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import type { ExtractedQuestion } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ChangeRecordIntent, ChangeType } from '@/lib/app/questionnaire/ingestion/types';
import {
  validateVerifyResult,
  NOT_A_QUESTION_ISSUE,
  type VerifyResult,
  type QuestionVerdict,
} from '@/lib/app/questionnaire/ingestion/verify-schema';
import {
  validateRepairResult,
  type RepairResult,
} from '@/lib/app/questionnaire/ingestion/repair-schema';
import type { ExtractionPhaseEvent } from '@/lib/app/questionnaire/ingestion/extraction-stream-events';
import {
  normaliseBinding,
  readResolvedBinding,
  readResolvedCost,
} from '@/lib/app/questionnaire/ai-run/resolved-binding';

import {
  extractFromDocument,
  type ExtractedDocument,
  type FidelityRecord,
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

/**
 * How much of one ingest may be REMOVED as "not a question".
 *
 * A `not_a_question` verdict is the only one that deletes rather than corrects, so it needs a
 * blast radius. Real documents carry a handful of script lines against dozens of questions; a
 * critic claiming a quarter of the instrument is script has misread the document (a set of
 * statements to rate is the obvious way to get there), and losing a quarter of a questionnaire to
 * that misreading is far worse than shipping the script lines for an author to delete. Past the
 * ceiling nothing is dropped at all and the run is logged.
 *
 * The floor exists because the fraction alone is useless on a short document: 25% of an
 * eight-question instrument is two, and a two-page intro script is easily three lines. A handful
 * is always allowed; a proportion is what governs everything larger.
 */
const NON_QUESTION_DROP_FRACTION = 0.25;
const NON_QUESTION_DROP_FLOOR = 3;

/** The most questions this ingest may drop as non-questions. See the constants above. */
function nonQuestionDropCeiling(total: number): number {
  return Math.max(NON_QUESTION_DROP_FLOOR, Math.floor(total * NON_QUESTION_DROP_FRACTION));
}

const EMPTY_VERIFY: VerifyResult = { verdicts: [], matrixGroups: [] };
const EMPTY_REPAIR: RepairResult = { repairs: [] };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The streaming ingest pipeline. Yields phase events; returns the extractor output (verified +
 * repaired) or a ready-made error `Response` — exactly what the route's persist block already
 * expects.
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

  // Bridge the extractor's push-based "questions so far" callback (fired deep
  // inside the capability dispatch as the response streams) into pull-based
  // generator yields. A tiny queue + one-shot notifier converts callbacks into
  // awaited events without dropping the terminal result; bursts coalesce to the
  // latest count so a fast stream collapses into one up-to-date event, not a
  // backlog. Fail-soft: if the extractor never streams a count (blocking
  // fallback, tool-based extraction, a zero-question doc) the loop simply waits
  // for the result and no extra events fire.
  // Coalescing slot, not a queue: only the LATEST count matters, so a burst of
  // callbacks between drains collapses to one up-to-date event. `-1` = nothing
  // pending (a real count is always ≥ 0), which keeps this a plain `number` and
  // sidesteps closure-narrowing on a nullable slot.
  let pending = -1;
  let settled = false;
  let wake: (() => void) | null = null;
  const bump = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const extractionPromise = extractFromDocument(upload, {
    ...ctx,
    onExtractionProgress: (questionsSoFar) => {
      pending = questionsSoFar;
      bump();
    },
  }).finally(() => {
    settled = true;
    bump();
  });

  for (;;) {
    if (pending >= 0) {
      const latest = pending;
      pending = -1;
      yield {
        type: 'phase',
        phase: 'extracting',
        message: `Structure extractor — reading the document… ${latest} question${latest === 1 ? '' : 's'} so far`,
        progress: { done: latest },
      };
      continue;
    }
    if (settled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      // Close the race: if a callback (or the terminal settle) landed between the
      // checks above and this assignment, its `bump()` saw a null `wake` and did
      // nothing — so re-check and resolve immediately rather than block forever.
      if (pending >= 0 || settled) {
        wake = null;
        resolve();
      }
    });
  }

  const extracted = await extractionPromise;
  if (!extracted.ok) return extracted;

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
  const verification = await runVerification(extraction, documentText, fileName, ctx);
  const flags = verification.result;
  const flagged = flags.verdicts.filter((v) => v.verdict === 'suspect');

  // Split the flags by what they actually ask for. `not_a_question` says the span cannot be
  // answered at all (interviewer script, a transition, an instruction) and no answer type repairs
  // that, so the orchestrator drops it here and never sends it to the specialist. Everything else
  // is a mis-READ, which a re-read can correct.
  const nonQuestions = flagged.filter((v) => v.issue === NOT_A_QUESTION_ISSUE);
  const repairable = flagged.filter((v) => v.issue !== NOT_A_QUESTION_ISSUE);

  // F14.15: what the critic actually concluded, and what was done about it. Persisted against
  // the version by the caller (the version doesn't exist yet at this point in the pipeline).
  let repairOutcome: FidelityRecord['repairOutcome'] =
    verification.provider === null ? 'verifier_unavailable' : 'none_flagged';

  // ── Drop (deterministic): remove the spans that are not questions, revertibly. ──
  let droppedNonQuestionKeys: string[] = [];
  if (nonQuestions.length > 0) {
    const pruned = dropNonQuestions(extraction, nonQuestions, ctx.log);
    extraction = pruned.extraction;
    droppedNonQuestionKeys = pruned.droppedKeys;
    const dropped = droppedNonQuestionKeys.length;
    if (dropped > 0) {
      yield {
        type: 'phase',
        phase: 'verifying',
        message: `Removed ${dropped} line${dropped === 1 ? '' : 's'} that ${dropped === 1 ? 'is not a question' : 'are not questions'}: interviewer script, a transition, or an instruction.`,
      };
    }
  }

  if (repairable.length === 0) {
    // Verifier clean → no repair call at all (the common, cheap case). Said only when nothing
    // was flagged AT ALL: after a drop it would read as "and everything else was fine", which
    // the critic did not say. It said only that the rest needed no re-typing.
    if (flagged.length === 0) {
      yield {
        type: 'phase',
        phase: 'verifying',
        message: 'All questions look faithful — no repairs needed.',
      };
    }
  } else if (repairable.length > REPAIR_FLAG_CEILING) {
    // Systemic extractor failure. This used to be a log line and nothing else — the questions
    // stayed flagged-but-unrepaired in the persisted version with no trace of the bail-out.
    repairOutcome = 'skipped_systemic';
    ctx.log.warn('ingest verify flagged too many questions; skipping repair', {
      flagged: repairable.length,
      total,
    });
  } else {
    // ── Repair (fail-soft): re-extract ONLY the flagged questions, then guard the merge. ──
    yield {
      type: 'phase',
      phase: 'repairing',
      message: `Scales & matrix specialist — repairing ${repairable.length} flagged question${repairable.length === 1 ? '' : 's'}…`,
      progress: { done: 0, total: repairable.length },
    };
    const repairs = await runRepair(extraction, flags, repairable, documentText, fileName, ctx);
    // Set AFTER the call, from what came back. `runRepair` is fail-soft — an unseeded agent, a
    // failed dispatch, or a throw all return zero repairs — so claiming 'repaired' up front would
    // record the exact fiction this record exists to prevent: flagged-but-untouched questions
    // filed as repaired.
    repairOutcome = repairs.repairs.length > 0 ? 'repaired' : 'repair_failed';
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

  // Three count-level checks the per-question verdicts structurally cannot make. None blocks the
  // ingest: by the time any is readable the questions already exist, and refusing a document
  // over a fidelity nicety is worse than persisting it with the discrepancy on record. They are
  // logged and carried onto the `extraction_verify` provenance row so a corpus run — or anyone
  // asking "did that prompt change take?" — can see it without re-reading the Structure editor.
  const disallowedEditCount = countDisallowedEdits(extraction);
  if (disallowedEditCount > 0) {
    ctx.log.warn('ingest extractor made edits it is instructed not to make', {
      disallowedEditCount,
      kinds: [...DISALLOWED_EXTRACTOR_EDITS],
    });
  }

  const unattributedPromptKeys = findUnattributedPrompts(extraction, documentText);
  if (unattributedPromptKeys.length > 0) {
    ctx.log.warn('ingest reworded question prompts without recording the edit', {
      unattributedPromptCount: unattributedPromptKeys.length,
      unattributedPromptKeys,
      totalQuestions: total,
      repairOutcome,
    });
  }

  const coverage = verification.result.coverage ?? null;
  if (coverage && coverage.assessment !== 'matches' && coverage.assessment !== 'uncountable') {
    ctx.log.warn('ingest question count disagrees with the source', {
      assessment: coverage.assessment,
      sourceQuestionCount: coverage.sourceQuestionCount,
      extractedQuestionCount: total,
      detail: coverage.detail,
    });
  }

  return {
    ok: true,
    value: {
      extraction,
      parsed,
      fidelity: {
        // `??` was the bug here, not the sentinel: a verifier that resolves its model at call time
        // reported an EMPTY STRING, which is not nullish, so the fallback never fired and the
        // column stored ''. `normaliseBinding` treats empty and nullish alike, and keeps 'n/a' —
        // the codebase's existing spelling (run-worker.ts, the edit-agent apply seam) — so a
        // "runs by provider" grouping isn't split across two spellings.
        ...normaliseBinding(verification.provider, verification.model),
        verdicts: flags.verdicts,
        flaggedCount: flagged.length,
        totalCount: total,
        repairOutcome,
        costUsd: verification.costUsd,
        coverage,
        disallowedEditCount,
        unattributedPromptKeys,
        droppedNonQuestionKeys,
        // Counted HERE, off the final extraction, not from `total` minus the drops: everything
        // that can change the count between the critic's read and this line has already run.
        retainedCount: extraction.questions.length,
        durationMs: verification.durationMs,
      },
    },
  };
}

/**
 * Dispatch the verifier over all questions + the source. Fail-soft: a missing/failing verifier
 * agent returns empty verdicts, so persist proceeds on the raw extraction (never blocked).
 */
interface VerificationOutcome {
  result: VerifyResult;
  /** Resolved verifier binding; null when the agent wasn't available. */
  provider: string | null;
  model: string | null;
  /** USD billed for the verify call; null when it never reached a provider. */
  costUsd: number | null;
  durationMs: number;
}

/**
 * Editorial change types the extractor is instructed NOT to make (see `extraction-prompt.ts`).
 *
 * Both splitting a compound question and merging duplicates are genuine improvements — and both
 * belong to the judge panel, where an author reviews them before they land, rather than to a silent
 * ingest. Left at ingest they make the SAME document extract to a different question count on
 * different runs; corpus doc 02 produced 22, 28, 23, 28, 28 and 28 questions across six ingests of
 * one file. Counting them is how we can tell whether the instruction actually landed.
 */
const DISALLOWED_EXTRACTOR_EDITS: ReadonlySet<ChangeType> = new Set<ChangeType>([
  'split_question',
  'merge_questions',
]);

/**
 * Count the editorial edits the extractor was told not to make. Deterministic — no model involved.
 *
 * Typed against `ChangeType` rather than reading `changes` through a structural cast. The cast
 * would have been the more dangerous shortcut of the two available: this counter exists to notice
 * silent drift, so a rename of `changes` or `changeType` making it always return 0 — with no
 * compile error — is precisely the failure it is supposed to catch, arriving by the back door.
 */
function countDisallowedEdits(extraction: ExtractQuestionnaireStructureData): number {
  return extraction.changes.filter((c) => DISALLOWED_EXTRACTOR_EDITS.has(c.changeType)).length;
}

/**
 * Collapse runs of whitespace so a hard-wrapped source line can be compared to a single-line
 * prompt. Documents wrap at whatever width their author used and the parsers preserve those
 * newlines, so a prompt lifted verbatim from a wrapped bullet is NOT a substring of the raw text —
 * matching without this reports every long question as an unattributed edit.
 *
 * Whitespace only. Case, punctuation and hyphens are all left alone deliberately: "near-misses" →
 * "near misses" and "reads them" → "reviews them" are edits, and an aggressive normaliser that
 * folded them away would quietly shrink the count this exists to produce.
 */
function flattenWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Read the resulting prompt off a change record, whatever change type filed it.
 *
 * Keyed on the shape rather than a list of change types on purpose. The question is only ever "did
 * the extractor tell us this wording is its own?", and any record that put a prompt in `afterJson`
 * has answered it — including change types added later, which a hard-coded list would silently miss.
 */
function recordedPrompt(change: ChangeRecordIntent): string | null {
  const after = change.afterJson;
  if (typeof after !== 'object' || after === null) return null;
  const prompt = (after as { prompt?: unknown }).prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : null;
}

/**
 * The KEYS of questions whose prompt appears neither in the source nor in the editorial log.
 * Deterministic — no model involved. See `FidelityRecord.unattributedPromptKeys` for why this is
 * worth a column.
 *
 * Keys rather than a bare count, because the count alone is unactionable: an admin told "2
 * questions were reworded without a record" has to diff the whole draft against the document by
 * eye to find which two. The count is derived from this, never tracked separately, so the two can
 * never disagree.
 *
 * Substring containment rather than per-question alignment, because alignment needs to know which
 * source line each question came from and nothing in the extraction says. Containment can only err
 * one way — a prompt that happens to appear somewhere else in the document reads as attributed —
 * which is the right direction for a signal that must never cry wolf on a clean ingest.
 */
function findUnattributedPrompts(
  extraction: ExtractQuestionnaireStructureData,
  documentText: string
): string[] {
  const source = flattenWhitespace(documentText);
  const declared = new Set(
    extraction.changes
      .map(recordedPrompt)
      .filter((p): p is string => p !== null)
      .map(flattenWhitespace)
  );
  return extraction.questions
    .filter((q) => {
      const prompt = flattenWhitespace(q.prompt);
      return !source.includes(prompt) && !declared.has(prompt);
    })
    .map((q) => q.key);
}

async function runVerification(
  extraction: ExtractQuestionnaireStructureData,
  documentText: string,
  fileName: string,
  ctx: ExtractCtx
): Promise<VerificationOutcome> {
  const startedAt = Date.now();
  const unavailable = (): VerificationOutcome => ({
    result: EMPTY_VERIFY,
    provider: null,
    model: null,
    costUsd: null,
    durationMs: Date.now() - startedAt,
  });
  try {
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      ctx.log.warn('ingest verifier agent not seeded; skipping verification', {
        slug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
      });
      return unavailable();
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
      return unavailable();
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
      return unavailable();
    }
    // The binding the capability resolved and used — NOT `agent.provider`/`agent.model`, which are
    // empty on this agent by design (it resolves to the reasoning tier at call time). Recording the
    // agent row's blanks is what made `extraction_verify` rows store an empty provider.
    const binding = readResolvedBinding(dispatch.data);
    return {
      result: validated.value,
      provider: binding.provider,
      model: binding.model,
      costUsd: readResolvedCost(dispatch.data),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    ctx.log.warn('ingest verification threw; persisting raw extraction', {
      error: errorMessage(err),
    });
    return unavailable();
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

/**
 * Build a revertible `prune_question` change for a span the critic said is not a question.
 *
 * `beforeJson` is written in the shape `planPruneQuestion` (`extraction-review/planner.ts`) reads
 * back: `prompt` is what makes the revert possible at all, `type`/`typeConfig`/`guidelines`/
 * `rationale`/`required` are the fields `toNewQuestion` restores, and `sectionOrdinal` +
 * `sectionTitle` are how it finds the section to put the question back into. Getting these names
 * wrong is not a compile error and not a visible bug: the row still renders in the change log, and
 * the loss only shows up the day someone presses revert. The repair path has been bitten by exactly
 * that (see {@link changeForCorrect}), which is why the shape is spelled out rather than spread.
 *
 * `afterJson` is null because a prune has no after. `PRUNE_CHANGE_TYPES` requires it, and the
 * planner uses its absence to know the content lives in `beforeJson`.
 */
function changeForNonQuestion(
  question: ExtractedQuestion,
  sectionTitle: string | null,
  detail: string | null
): ChangeRecordIntent {
  return {
    changeType: 'prune_question',
    targetEntityType: 'question',
    beforeJson: {
      key: question.key,
      prompt: question.prompt,
      type: question.suggestedType,
      typeConfig: question.suggestedTypeConfig ?? null,
      sectionOrdinal: question.sectionOrdinal,
      ...(sectionTitle !== null ? { sectionTitle } : {}),
      ...(question.guidelines !== undefined ? { guidelines: question.guidelines } : {}),
      ...(question.rationale !== undefined ? { rationale: question.rationale } : {}),
      ...(question.required !== undefined ? { required: question.required } : {}),
    },
    afterJson: null,
    rationale: detail
      ? `Removed during ingestion: this is not a question. ${detail}`
      : 'Removed during ingestion: this is not a question but interviewer script, a transition, or an instruction.',
    ...(question.sourceQuote !== undefined ? { sourceQuote: question.sourceQuote } : {}),
  };
}

/**
 * Remove the questions the critic flagged `not_a_question`, filing a revertible `prune_question`
 * change for each. Deterministic once the verdicts are in: no second model call.
 *
 * ## Why the drop happens here rather than in repair
 *
 * The repair specialist can only `correct` (re-type one question) or `merge` (fold grid rows into a
 * matrix). Neither does anything useful to "Bot script: That's useful. Based on what you've said I
 * want to go deeper on the areas below." No answer type turns a line of interviewer narration into
 * something a respondent can answer, so sending it to repair spends a call to get the same
 * unanswerable question back. Removal is the only correct action, and it needs no judgement beyond
 * the verdict already in hand.
 *
 * ## Three guards, because this is the only path that deletes
 *
 * 1. **The ceiling** ({@link nonQuestionDropCeiling}). Past it nothing is dropped at all. A critic
 *    that calls a quarter of an instrument "script" has misread it, most likely a page of
 *    statements-to-rate, and a quarter of a questionnaire is far too much to lose to a misreading
 *    that an author would have caught in seconds.
 * 2. **Never empty the questionnaire.** Dropping every question leaves a version that cannot be
 *    launched and gives the admin nothing to review, which is strictly worse than a draft with some
 *    script in it. Redundant against the ceiling above three questions; the whole guard on a short
 *    document, where the floor allows three.
 * 3. **Revertibility.** Each drop is a `prune_question` row carrying the full question, so the
 *    change log shows what went and F2.3 puts it back. Dropping silently is the failure this
 *    pipeline keeps re-learning: an admin cannot review a decision nothing recorded.
 *
 * Sections are deliberately left alone. A section whose only member was script becomes empty rather
 * than pruned: an empty section is visible in the editor and takes one click to delete, whereas
 * removing a section the author expected to see is the more expensive mistake, and it is a separate
 * editorial decision from "this line is not a question".
 *
 * Exported for tests: the ceiling and the revert shape are the parts worth pinning.
 */
export function dropNonQuestions(
  extraction: ExtractQuestionnaireStructureData,
  verdicts: QuestionVerdict[],
  log: RouteLogger
): { extraction: ExtractQuestionnaireStructureData; droppedKeys: string[] } {
  // Verdict keys are model output: one may name a question that no longer exists (or never did).
  // Intersecting with the real questions is what makes the counts below trustworthy.
  const detailByKey = new Map(verdicts.map((v) => [v.key, v.detail ?? null]));
  const targets = extraction.questions.filter((q) => detailByKey.has(q.key));
  if (targets.length === 0) return { extraction, droppedKeys: [] };

  const total = extraction.questions.length;
  const ceiling = nonQuestionDropCeiling(total);
  if (targets.length > ceiling) {
    log.warn('ingest verify flagged too many spans as non-questions; dropping none', {
      flagged: targets.length,
      ceiling,
      total,
    });
    return { extraction, droppedKeys: [] };
  }
  if (targets.length >= total) {
    log.warn('ingest verify flagged every question as a non-question; dropping none', { total });
    return { extraction, droppedKeys: [] };
  }

  const titleByOrdinal = new Map(extraction.sections.map((s) => [s.ordinal, s.title]));
  const droppedKeys = new Set(targets.map((q) => q.key));
  const changes = targets.map((q) =>
    changeForNonQuestion(
      q,
      titleByOrdinal.get(q.sectionOrdinal) ?? null,
      detailByKey.get(q.key) ?? null
    )
  );

  log.info('ingest dropped spans that are not questions', {
    droppedKeys: [...droppedKeys],
    total,
  });

  return {
    extraction: {
      ...extraction,
      questions: extraction.questions.filter((q) => !droppedKeys.has(q.key)),
      changes: [...extraction.changes, ...changes],
    },
    droppedKeys: targets.map((q) => q.key),
  };
}

/**
 * Build a revertible change intent for a `correct` repair (type change vs config-only).
 *
 * Two things here are load-bearing and were both wrong until the corpus caught them:
 *
 * **The `key`.** `targetEntityId` is null for every question/section change by design (the planner
 * reconciles by value), but the key is what ties the row to a question in the admin's change list —
 * `changeForMerge` below has always written one. Without it the row that actually changed the
 * question names no question, and the earlier `infer_type` row it overrides stays `applied` and
 * un-superseded. Corpus doc 08 showed the result: three questions whose visible rationale read
 * "captured as free text to avoid inventing choices" against stored `single_choice` slots WITH
 * invented choices.
 *
 * **The field names.** `planInferType` (`extraction-review/planner.ts`) restores from
 * `beforeJson.type` / `beforeJson.typeConfig`, which is the shape every other change type uses.
 * Writing `suggestedType` here meant the two never met, so the planner took its documented "no prior
 * type recorded" branch and reverted to `free_text` with no config — silent data loss on the one
 * operation whose entire promise is that it can be undone. The planner now also accepts the old
 * spelling, so rows written before this fix revert correctly rather than needing a backfill.
 *
 * **Scope of that fix: the `infer_type` branch only.** When the type did NOT change this files an
 * `augment_question`, which `planRevert` routes to `planFieldRestore(..., ['prompt', 'guidelines',
 * 'rationale'])` — and none of `key`/`type`/`typeConfig` is in that allowlist, so `touched` is empty
 * and a config-only repair (the specialist fixing a likert's endpoint labels) still reverts as
 * `missing_before_json`. Pre-existing, not introduced here — the old spelling missed that allowlist
 * too — and left alone deliberately: widening it would change revert behaviour for every other
 * producer of `augment_question`, which is a separate decision from this rename.
 */
function changeForCorrect(
  original: ExtractedQuestion,
  candidate: ExtractedQuestion
): ChangeRecordIntent {
  const typeChanged = original.suggestedType !== candidate.suggestedType;
  return {
    changeType: typeChanged ? 'infer_type' : 'augment_question',
    targetEntityType: 'question',
    beforeJson: {
      key: original.key,
      type: original.suggestedType,
      typeConfig: original.suggestedTypeConfig ?? null,
    },
    afterJson: {
      key: candidate.key,
      type: candidate.suggestedType,
      typeConfig: candidate.suggestedTypeConfig ?? null,
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
