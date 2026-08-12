/**
 * Shared judge-panel dispatch (F5.1 seam, extracted at F5.2).
 *
 * The single place that fans the seven design-evaluation judges out concurrently and
 * reduces their outcomes to a `{ results, summary }` shape. Two callers share it:
 *
 *   - the F5.1 preview route (`evaluate-preview`) — runs the panel and returns the
 *     result ephemerally (persists nothing),
 *   - the F5.2 run route (`evaluations`) — runs the panel, then persists the run + its
 *     findings.
 *
 * DB-free: the loaded judge agents and the version structure are passed in, so this
 * stays in the pure `lib/app/**` layer (no Prisma, no Next.js) — persistence and the
 * agent/structure loads are the route's concern, the same seam split as
 * `buildEvaluationStructure`. Per-judge failure is fail-soft: a missing agent or a
 * failed/throwing dispatch degrades to a `diagnostic` for that one dimension while the
 * others still return, so one flaky judge can never sink the whole panel.
 */

import type { Logger } from '@/lib/logging';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import {
  EVALUATE_STRUCTURE_CAPABILITY_SLUG,
  RECONCILE_SUGGESTIONS_CAPABILITY_SLUG,
  RECONCILER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type {
  EvaluateStructureData,
  ReconcileSuggestionsData,
} from '@/lib/app/questionnaire/capabilities';
import { RECONCILE_TIMEOUT_MS } from '@/lib/app/questionnaire/capabilities/reconcile-suggestions';
import {
  EVALUATION_DIMENSION_SPECS,
  MAX_RECONCILED_TARGETS,
  type EvaluationDimension,
  type JudgeVerdict,
  type ReconciledSuggestion,
  type ReconcileTargetInput,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';

/**
 * The wall-clock the panel may spend on LLM work, held below both routes' `maxDuration = 300`.
 *
 * The 15s reserve is for everything that is not a judge call: building the structure DTO, and (on
 * the run route) persisting the run and its findings. A function killed at the ceiling gives the
 * admin a blank failure with nothing in the logs — the exact outcome `maxDuration` was raised to
 * prevent — so the panel has to stay inside the budget itself rather than hope.
 */
const PANEL_BUDGET_MS = 285_000;

/**
 * What the reconcile step can cost at worst: the call plus its one retry, which
 * `runStructuredCompletion` gives a *fresh* `AbortSignal.timeout`.
 *
 * The judges are the same shape (90s each, retried), and they fan out concurrently — so the panel's
 * own worst case is one slow judge at 180s. Adding this serially after it reaches 360s, past the
 * 300s ceiling. Hence the check below rather than a bigger number: 300 is what the platform gives
 * us, and it is already the highest ceiling in the codebase.
 */
const RECONCILE_WORST_CASE_MS = RECONCILE_TIMEOUT_MS * 2;

/** One dimension's outcome: a verdict, or a diagnostic when its judge failed/was absent. */
export interface DimensionResult {
  dimension: EvaluationDimension;
  verdict?: JudgeVerdict;
  diagnostic?: string;
}

/** Aggregate tallies over the dispatched panel. */
export interface EvaluationPanelSummary {
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
}

/** The panel result: one entry per requested dimension, plus the summary tallies. */
export interface EvaluationPanelResult {
  results: DimensionResult[];
  summary: EvaluationPanelSummary;
  /**
   * Alternative phrasings for the questions more than one judge flagged — one extra call after the
   * panel (see `reconcile-schema.ts`). Empty when nothing was contested, when the reconciler agent
   * is unseeded, or when the call failed: it is an enhancement over the judges' own suggestions,
   * never a precondition for them.
   */
  reconciled: ReconciledSuggestion[];
}

/**
 * The slice of a loaded `kind='judge'` agent the dispatch needs — the provider-agnostic
 * binding the `evaluate-structure` capability resolves from the dispatch context. Mirrors
 * the `select` the routes run against `prisma.aiAgent`.
 */
export interface JudgeAgentRef {
  slug: string;
  id: string;
  provider: string | null;
  model: string | null;
  fallbackProviders: unknown;
}

/**
 * Pick the questions worth reconciling, richest-first, and render them as reconciler input.
 *
 * Three filters, each load-bearing:
 *
 *  - **More than one judge.** A question one judge flagged already has that judge's rewrite; there
 *    is no disagreement to resolve and no reason to spend a second call on it.
 *  - **Resolves to a real question.** Findings against the `goal`, the `audience`, or a section are
 *    not phrasings to rewrite. This also excludes the Coverage judge's drafted new questions, which
 *    are addressed at `goal` by convention — a question that does not exist yet cannot be rephrased.
 *  - **Capped at {@link MAX_RECONCILED_TARGETS}**, most-contested first (major findings, then total).
 *    The caller logs what fell off the end: a reconciliation that silently covered 15 of 30 contested
 *    questions would read as "the other 15 were fine".
 */
function selectContestedTargets(
  results: DimensionResult[],
  structure: VersionStructureInput
): { targets: ReconcileTargetInput[]; contestedTotal: number } {
  // Index the structure once: key → the question and where it sits, for the prompt and the chip.
  const questions = new Map<
    string,
    { prompt: string; type: string | null; sectionTitle: string; position: number }
  >();
  for (const section of structure.sections) {
    // Numbered within the section, not across the questionnaire: the chip the reconciler is given
    // has to be the chip the admin reads on the card, and every other surface derives it from
    // `indexInSection + 1` (see `resolveFindingTarget`). A global counter made the prompt say
    // "Q13 · Background" for the question the UI labels "Q1 · Background", so an alternative whose
    // note cited the number contradicted the card carrying it.
    let position = 0;
    for (const question of section.questions) {
      position += 1;
      questions.set(question.key, {
        prompt: question.prompt,
        type: question.type ?? null,
        sectionTitle: section.title,
        position,
      });
    }
  }

  const byKey = new Map<string, { judges: ReconcileTargetInput['judges']; major: number }>();
  for (const result of results) {
    if (!result.verdict) continue;
    const spec = EVALUATION_DIMENSION_SPECS[result.dimension];
    for (const finding of result.verdict.findings) {
      if (!questions.has(finding.targetKey)) continue;
      let entry = byKey.get(finding.targetKey);
      if (!entry) {
        entry = { judges: [], major: 0 };
        byKey.set(finding.targetKey, entry);
      }
      entry.judges.push({
        dimension: result.dimension,
        label: spec.label,
        severity: finding.severity,
        proposedChange: finding.proposedChange,
        rationale: finding.rationale,
      });
      if (finding.severity === 'major') entry.major += 1;
    }
  }

  // Two *judges*, not two findings: one judge raising two points about a question is still one
  // perspective, and reconciling a perspective with itself proposes nothing.
  const contested = [...byKey.entries()].filter(
    ([, entry]) => new Set(entry.judges.map((j) => j.dimension)).size >= 2
  );

  const ranked = contested.sort(([keyA, a], [keyB, b]) => {
    if (b.major !== a.major) return b.major - a.major;
    if (b.judges.length !== a.judges.length) return b.judges.length - a.judges.length;
    // Positional tiebreak keeps the batch (and therefore the cost) reproducible run to run.
    return (questions.get(keyA)?.position ?? 0) - (questions.get(keyB)?.position ?? 0);
  });

  const targets: ReconcileTargetInput[] = ranked
    .slice(0, MAX_RECONCILED_TARGETS)
    .map(([key, entry]) => {
      const question = questions.get(key);
      return {
        key,
        prompt: question?.prompt ?? key,
        questionType: question?.type ?? null,
        context: question ? `Q${question.position} · ${question.sectionTitle}` : null,
        judges: entry.judges,
      };
    });

  return { targets, contestedTotal: contested.length };
}

/**
 * Dispatch the requested judge dimensions concurrently and reduce to `{ results, summary }`.
 *
 * @param dimensions      The (already deduped) dimensions to run.
 * @param structure       The version's authored structure DTO (from `buildEvaluationStructure`).
 * @param questionnaireId Parent questionnaire id — log context only, so per-judge failures
 *                        stay correlatable to a questionnaire (the inline route had this).
 * @param versionId       For cost-tracking metadata on the dispatch + log context.
 * @param agentBySlug     Loaded judge agents keyed by slug (from the route's `aiAgent` query).
 * @param adminId         The admin who owns the run/spend — passed as the dispatch `userId`.
 * @param log             Route-scoped logger; per-judge failures are warned/errored here.
 * @param reconcile       Whether to run the cross-judge reconcile step after the fan-in. Required
 *                        rather than defaulted: it is an extra billed reasoning call on top of the
 *                        seven judges, so a new caller has to decide, not inherit. The persisted
 *                        run passes `true`; the ephemeral preview passes `false`, because it has
 *                        nowhere to put the result and an admin should not be charged for a payload
 *                        that is discarded on the way out.
 */
export async function runEvaluationPanel(args: {
  dimensions: EvaluationDimension[];
  structure: VersionStructureInput;
  questionnaireId: string;
  versionId: string;
  agentBySlug: Map<string, JudgeAgentRef>;
  adminId: string;
  log: Logger;
  reconcile: boolean;
}): Promise<EvaluationPanelResult> {
  const {
    dimensions,
    structure,
    questionnaireId,
    versionId,
    agentBySlug,
    adminId,
    log,
    reconcile,
  } = args;
  const startedAt = Date.now();

  // Flush capability handlers before the fan-out — this panel may be the first capability touch
  // on a fresh process (the dispatcher does not lazy-register). Idempotent, one-shot; registering
  // once here keeps it off the per-dimension hot path below.
  registerBuiltInCapabilities();

  // Dispatch the panel concurrently. Per-judge failure is fail-soft: a missing agent or a
  // failed call yields a `diagnostic` for that dimension, never a thrown error, so one
  // flaky judge can't sink the other six.
  const results: DimensionResult[] = await Promise.all(
    dimensions.map(async (dimension): Promise<DimensionResult> => {
      const agent = agentBySlug.get(EVALUATION_DIMENSION_SPECS[dimension].slug);
      if (!agent) {
        log.warn('Judge agent missing for dimension; skipping', {
          questionnaireId,
          versionId,
          dimension,
        });
        return { dimension, diagnostic: 'judge_not_configured' };
      }

      // The dispatcher represents capability failures as a `{ success: false }` envelope,
      // but it can still THROW on an infrastructure fault (e.g. the registry DB load inside
      // `dispatch` failing) — and because the panel fans out under one `Promise.all`, an
      // unguarded throw would reject the whole request. Wrap the dispatch so any throw
      // degrades to this dimension's diagnostic, keeping the fail-soft contract literally
      // true even for unexpected faults.
      let dispatch;
      try {
        dispatch = await capabilityDispatcher.dispatch(
          EVALUATE_STRUCTURE_CAPABILITY_SLUG,
          { dimension, structure, versionId },
          {
            userId: adminId,
            agentId: agent.id,
            entityContext: {
              judgeAgent: {
                provider: agent.provider,
                model: agent.model,
                fallbackProviders: agent.fallbackProviders,
              },
            },
          }
        );
      } catch (err) {
        log.error('Judge dispatch threw; returning diagnostic for dimension', {
          questionnaireId,
          versionId,
          dimension,
          error: err instanceof Error ? err.message : String(err),
        });
        return { dimension, diagnostic: 'dispatch_error' };
      }

      if (dispatch.success && dispatch.data) {
        return { dimension, verdict: (dispatch.data as EvaluateStructureData).verdict };
      }
      log.warn('Judge dispatch failed; returning diagnostic for dimension', {
        questionnaireId,
        versionId,
        dimension,
        code: dispatch.error?.code,
      });
      return { dimension, diagnostic: dispatch.error?.code ?? 'evaluation_failed' };
    })
  );

  const dimensionsRun = results.filter((r) => r.verdict !== undefined).length;
  const totalFindings = results.reduce((sum, r) => sum + (r.verdict?.findings.length ?? 0), 0);

  // Reconcile only if the judges left room for its worst case. They fan out concurrently but a
  // slow one can retry up to 180s, and this step runs serially after them — together that exceeds
  // the routes' 300s ceiling, and being killed here would throw away seven judge calls the admin
  // has already paid for. Skipping degrades to exactly what a failed reconcile degrades to: the
  // judges' own suggestions, which is what the surfaces showed before this step existed.
  const elapsedMs = Date.now() - startedAt;
  const budgetLeftMs = PANEL_BUDGET_MS - elapsedMs;
  const affordable = budgetLeftMs >= RECONCILE_WORST_CASE_MS;

  if (reconcile && !affordable) {
    log.warn('Skipping cross-judge reconciliation: panel left too little wall-clock', {
      questionnaireId,
      versionId,
      elapsedMs,
      budgetLeftMs,
      requiredMs: RECONCILE_WORST_CASE_MS,
    });
  }

  const reconciled =
    reconcile && affordable
      ? await reconcileContested({
          results,
          structure,
          questionnaireId,
          versionId,
          agentBySlug,
          adminId,
          log,
        })
      : [];

  return {
    results,
    summary: {
      dimensionsRequested: dimensions.length,
      dimensionsRun,
      dimensionsFailed: dimensions.length - dimensionsRun,
      totalFindings,
    },
    reconciled,
  };
}

/**
 * The reconcile step: one call after the panel, over the questions several judges flagged.
 *
 * **Fail-soft in every direction**, like the panel it follows. Nothing contested, no reconciler
 * agent seeded, a failed dispatch, a thrown fault — each returns `[]` and the run completes with
 * the judges' own suggestions intact. This step makes a good result better; it must never be able
 * to turn a good result into no result, and an admin who has just paid for seven judge calls should
 * not lose them because an eighth call failed.
 */
async function reconcileContested(args: {
  results: DimensionResult[];
  structure: VersionStructureInput;
  questionnaireId: string;
  versionId: string;
  agentBySlug: Map<string, JudgeAgentRef>;
  adminId: string;
  log: Logger;
}): Promise<ReconciledSuggestion[]> {
  const { results, structure, questionnaireId, versionId, agentBySlug, adminId, log } = args;

  const { targets, contestedTotal } = selectContestedTargets(results, structure);
  if (targets.length === 0) return [];

  // No silent caps: if the panel contested more questions than one call covers, say so, so the
  // absence of an alternative is never read as "the panel was happy with this one".
  if (contestedTotal > targets.length) {
    log.info('Reconciling the most contested questions only', {
      questionnaireId,
      versionId,
      contested: contestedTotal,
      reconciled: targets.length,
    });
  }

  const agent = agentBySlug.get(RECONCILER_AGENT_SLUG);
  if (!agent) {
    log.warn('Reconciler agent missing; returning judge suggestions unreconciled', {
      questionnaireId,
      versionId,
      slug: RECONCILER_AGENT_SLUG,
    });
    return [];
  }

  let dispatch;
  try {
    dispatch = await capabilityDispatcher.dispatch(
      RECONCILE_SUGGESTIONS_CAPABILITY_SLUG,
      {
        targets,
        goal: structure.goal ?? null,
        audience: structure.audience ?? null,
        versionId,
      },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          reconcilerAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );
  } catch (err) {
    log.error('Reconcile dispatch threw; returning judge suggestions unreconciled', {
      questionnaireId,
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (dispatch.success && dispatch.data) {
    // The envelope is `unknown` at this seam, so treat a shapeless payload as "nothing reconciled"
    // rather than trusting the cast — a run must not fall over because the capability returned a
    // shape it should not have.
    const suggestions = (dispatch.data as Partial<ReconcileSuggestionsData>).suggestions ?? [];
    log.info('Reconciled cross-judge suggestions', {
      questionnaireId,
      versionId,
      targets: targets.length,
      reconciled: suggestions.length,
    });
    return suggestions;
  }

  log.warn('Reconcile dispatch failed; returning judge suggestions unreconciled', {
    questionnaireId,
    versionId,
    code: dispatch.error?.code,
  });
  return [];
}
