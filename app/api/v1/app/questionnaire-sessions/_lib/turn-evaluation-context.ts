/**
 * Shared seam for the turn-evaluation routes — the evaluator agent binding and the
 * server-loaded questionnaire objectives that frame a verdict.
 *
 * Used by both `evaluate-turn` (live drawer dump) and `evaluate-saved` (persisted-trace
 * re-evaluation by `publicRef`) so the agent lookup and the objectives projection can't drift.
 * The per-turn conversation messages differ per route (a client body vs. a saved turn row), so
 * those stay at each call site; only the version-derived objectives live here.
 *
 * The projection reads the **whole** config row rather than two columns, because the interviewer
 * policy the judge has to score against (house rules, questioning approach, question fidelity,
 * conditional topics) is spread across four blocks. It is rendered through
 * {@link SETTING_DESCRIPTORS} — the same registry the Questionnaire Pack's setup listing uses —
 * so there is one definition of "how a config block reads in English", and a new field is
 * described the moment it gains a descriptor. Deliberately NOT the `chat/**` prompt builders:
 * those emit second-person imperatives written *at* the interviewer, and splicing one into a
 * judge's context would instruct the judge instead of describing the interviewer.
 */

import { prisma } from '@/lib/db/client';
import {
  QUESTION_FIDELITY_DESCRIPTIONS,
  QUESTION_FIDELITY_LABELS,
  resolveQuestionFidelity,
} from '@/lib/app/questionnaire/types';
import { SETTING_DESCRIPTORS } from '@/lib/app/questionnaire/settings-registry';
import type { ConfigView } from '@/lib/app/questionnaire/views';
import { toConfigView } from '@/app/api/v1/app/questionnaires/_lib/detail';
import type { TurnEvaluationContext } from '@/lib/app/questionnaire/turn-evaluation';

/** The seeded evaluator agent's slug — its provider/model binding drives the call. */
export const TURN_EVALUATOR_SLUG = 'turn-evaluator';

/** Compact, bounded summary of the version's audience JSON for the prompt. */
export function summariseAudience(audience: unknown): string | undefined {
  if (audience === null || audience === undefined) return undefined;
  try {
    const s = typeof audience === 'string' ? audience : JSON.stringify(audience);
    if (!s || s === '{}' || s === 'null') return undefined;
    return s.slice(0, 2_000);
  } catch {
    return undefined;
  }
}

/**
 * Render one config block as a single neutral line, via its settings-registry descriptor.
 *
 * Technical-tier rows are kept: this is a judge, not the external pack, and "planner confidence
 * floor 0.6" is exactly the kind of detail that explains a turn.
 *
 * Most descriptors state the negative when a feature is off ("House rules: None", "Conditional topics:
 * Disabled") and that is what the judge wants — see `TurnEvaluationContext`. `undefined` is
 * returned only when a descriptor emits no rows at all, which today means `tone` with no dial set
 * and no persona; the prompt builder then omits the field rather than printing an empty label.
 */
function describeBlock(
  config: ConfigView,
  key: keyof typeof SETTING_DESCRIPTORS
): string | undefined {
  const rows = SETTING_DESCRIPTORS[key].rows(config);
  const text = rows
    .map((row) => `${row.label}: ${row.value}`)
    .join('; ')
    .trim();
  return text.length > 0 ? text : undefined;
}

/** The version shape the objectives projection reads (goal/audience + the full config row). */
export interface EvaluatorVersionObjectives {
  goal: string | null;
  audience: unknown;
  /** The row as selected by {@link CONFIG_SELECT}; `null` when the version has no config row yet. */
  config: Parameters<typeof toConfigView>[0];
}

/**
 * Project the version's goal / audience / selection strategy / tone / interviewer policy into the
 * evaluator context (absent fields simply omitted, so the evaluator degrades gracefully). The
 * conversation messages and the per-turn fidelity level are layered on top by the caller.
 */
export function buildObjectivesContext(version: EvaluatorVersionObjectives): TurnEvaluationContext {
  const audience = summariseAudience(version.audience);
  // `toConfigView(null)` yields the documented defaults, so an unsaved version still describes the
  // behaviour a session would actually get rather than describing nothing.
  const config = toConfigView(version.config);
  const tone = describeBlock(config, 'tone');
  const houseRules = describeBlock(config, 'houseRules');
  const interviewerStrategy = describeBlock(config, 'interviewerStrategy');
  const questionFidelity = describeBlock(config, 'questionFidelity');
  const conditionalTopics = describeBlock(config, 'conditionalTopics');
  return {
    ...(version.goal ? { goal: version.goal } : {}),
    ...(audience ? { audience } : {}),
    ...(config.selectionStrategy ? { selectionStrategy: config.selectionStrategy } : {}),
    ...(tone ? { tone } : {}),
    ...(houseRules ? { houseRules } : {}),
    ...(interviewerStrategy ? { interviewerStrategy } : {}),
    ...(questionFidelity ? { questionFidelity } : {}),
    ...(conditionalTopics ? { conditionalTopics } : {}),
  };
}

/** Which question a turn was about — by row id (a saved turn) or by stable key (the live drawer). */
export interface TurnQuestionRef {
  questionId?: string | null;
  questionKey?: string | null;
}

/**
 * Resolve how faithfully THIS turn's question had to be put, as a line for the context block.
 *
 * Goes through {@link resolveQuestionFidelity} rather than reading `slot.fidelity` directly, so a
 * version whose gate is off resolves to `balanced` exactly as the live turn loop does — reading the
 * column raw would describe a dial the admin never switched on.
 *
 * Returns `undefined` — meaning the field is omitted entirely — in three cases, all of them
 * "nothing to say": the turn targeted no question (a completion or offer turn), the question has
 * since been deleted, or the level is `balanced`. `balanced` is the standard behaviour the rubric
 * already assumes, so stating it would spend tokens telling the judge nothing and risk it
 * over-weighting a redundant line. Same rule the prompt builder itself applies.
 */
export async function describeTurnFidelity(
  versionId: string,
  config: ConfigView,
  ref: TurnQuestionRef
): Promise<string | undefined> {
  // `versionId` is part of every lookup, not just a post-hoc check: a turn's `targetedQuestionId`
  // carries no FK (UG-1), so a stale or crafted id must not be able to describe a question
  // belonging to another questionnaire.
  const slot = ref.questionId
    ? await prisma.appQuestionSlot.findFirst({
        where: { id: ref.questionId, versionId },
        select: { fidelity: true },
      })
    : ref.questionKey
      ? await prisma.appQuestionSlot.findUnique({
          where: { versionId_key: { versionId, key: ref.questionKey } },
          select: { fidelity: true },
        })
      : null;
  if (!slot) return undefined;

  const level = resolveQuestionFidelity(slot.fidelity, config.questionFidelity);
  if (level === 'balanced') return undefined;
  return `${QUESTION_FIDELITY_LABELS[level]} — ${QUESTION_FIDELITY_DESCRIPTIONS[level]}`;
}

/** The resolved evaluator agent binding the service needs. */
export interface TurnEvaluatorAgent {
  id: string;
  provider: string;
  model: string;
  fallbackProviders: string[];
}

/**
 * Load the seeded `turn-evaluator` judge agent's binding (empty provider/model → system default at
 * resolve time). Returns null when the agent isn't seeded — the caller maps that to a config 404.
 */
export async function loadTurnEvaluatorAgent(): Promise<TurnEvaluatorAgent | null> {
  return prisma.aiAgent.findFirst({
    where: { slug: TURN_EVALUATOR_SLUG, kind: 'judge' },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
}
