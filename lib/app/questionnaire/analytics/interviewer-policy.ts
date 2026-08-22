/**
 * Interviewer-policy analytics (F18.7) — what the configured policy actually did.
 *
 * Every other interviewer-policy surface is about **intent**: the rules you wrote, the arc you
 * chose, the fidelity you set. This is the only account of what happened when real respondents met
 * them, and it exists because the three features shipped with no aggregate signal at all — a
 * questionnaire could run its whole cohort with an arc that never narrowed, or a `must_ask` question
 * no plan ever reached, and nothing would say so.
 *
 * Structured like {@link file://./routing.ts}: a pure `assemble*` over already-loaded rows, and a
 * thin `get*` that is the only part touching Prisma. The split is what makes the arithmetic testable
 * without a database.
 *
 * **What it deliberately does not claim.** There is no per-turn record of a house rule firing, so
 * `houseRulesActive` is a *configuration* count and the surface says so. Inventing a behavioural
 * count by parsing prompt blobs would be a guess dressed as a number — and `inspectorCalls` is
 * never read in aggregate anywhere in this layer, by the same rule that has Diagnostics read
 * denormalized columns instead.
 */

import { prisma } from '@/lib/db/client';
import { narrowQuestionFidelity, resolveQuestionFidelity } from '@/lib/app/questionnaire/types';
import { narrowInterviewerStrategy } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import { narrowHouseRules } from '@/lib/app/questionnaire/chat/house-rules';
import { isCohortSuppressed } from '@/lib/app/questionnaire/analytics/privacy';
import {
  roundSessionFilter,
  type AnalyticsScope,
} from '@/lib/app/questionnaire/analytics/query-schema';
import type {
  FunnelPhaseKey,
  InterviewerPolicyFinding,
  InterviewerPolicyResult,
  MustAskQuestionRow,
} from '@/lib/app/questionnaire/analytics/views';

/**
 * Turns read per request. Higher than routing's plan cap because a turn is one row of a session
 * rather than one row per session — a 20-turn interview contributes 20. Newest-first, so a
 * truncated read describes the policy as it stands rather than as it was.
 */
export const POLICY_TURN_READ_CAP = 20_000;

/**
 * Below this many sessions, nothing is stated. Separate constant from `K_ANONYMITY_THRESHOLD`
 * despite sharing its value, and from `ROUTING_FINDING_MIN_PLANS` — one governs disclosure, these
 * govern inference, and sharing a constant would let a privacy change silently redefine evidence.
 */
export const POLICY_FINDING_MIN_SESSIONS = 5;

/** Phase ordering, so "furthest reached" is a max rather than a special case per phase. */
const PHASE_RANK: Record<FunnelPhaseKey, number> = { open: 0, mixed: 1, targeted: 2 };

/** Is this stored string one of the three phases? Anything else is treated as unrecorded. */
function asPhase(value: unknown): FunnelPhaseKey | null {
  return value === 'open' || value === 'mixed' || value === 'targeted' ? value : null;
}

/** One turn, as the aggregator needs it. */
export interface PolicyTurnRow {
  sessionId: string;
  ordinal: number;
  funnelPhase: string | null;
  targetedQuestionKey: string | null;
  questionCardKey: string | null;
}

/** One `must_ask` question on the version today. */
export interface PolicyMustAskQuestion {
  key: string;
  prompt: string;
}

/** The version-level facts the result has to be read against. */
export interface PolicyVersionFacts {
  arcConfigured: boolean;
  fidelityGateOn: boolean;
  houseRulesActive: number;
}

/** The median of a non-empty numeric list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Assemble the result from already-loaded rows. Pure — no Prisma, no clock.
 *
 * Sessions are the unit for the arc, not turns: an arc is a property of a conversation, and
 * counting turns would weight a twenty-turn interview more heavily than a five-turn one that got
 * just as far.
 */
export function assembleInterviewerPolicyAnalytics(
  turns: readonly PolicyTurnRow[],
  mustAskQuestions: readonly PolicyMustAskQuestion[],
  facts: PolicyVersionFacts,
  meta: { versionId: string; range: InterviewerPolicyResult['range'] }
): InterviewerPolicyResult {
  const furthestBySession = new Map<string, FunnelPhaseKey>();
  const firstTargetedOrdinal = new Map<string, number>();
  let turnsWithoutPhase = 0;

  for (const turn of turns) {
    const phase = asPhase(turn.funnelPhase);
    if (!phase) {
      // A turn written before the column exists. Counted and reported rather than folded into
      // `open`, which would invent a narrative out of missing data.
      turnsWithoutPhase += 1;
      continue;
    }
    const current = furthestBySession.get(turn.sessionId);
    if (!current || PHASE_RANK[phase] > PHASE_RANK[current]) {
      furthestBySession.set(turn.sessionId, phase);
    }
    if (phase === 'targeted') {
      const seen = firstTargetedOrdinal.get(turn.sessionId);
      if (seen === undefined || turn.ordinal < seen) {
        firstTargetedOrdinal.set(turn.sessionId, turn.ordinal);
      }
    }
  }

  const furthestPhase: Record<FunnelPhaseKey, number> = { open: 0, mixed: 0, targeted: 0 };
  for (const phase of furthestBySession.values()) furthestPhase[phase] += 1;

  const sessions = furthestBySession.size;
  const targetedOrdinals = [...firstTargetedOrdinal.values()];

  // Must-ask reach, keyed by question. A question absent from the turn record was never the target
  // of a turn in this window — which is exactly the finding worth surfacing.
  const reached = new Map<string, number>();
  const cardShown = new Map<string, number>();
  for (const turn of turns) {
    if (turn.targetedQuestionKey) {
      reached.set(turn.targetedQuestionKey, (reached.get(turn.targetedQuestionKey) ?? 0) + 1);
    }
    if (turn.questionCardKey) {
      cardShown.set(turn.questionCardKey, (cardShown.get(turn.questionCardKey) ?? 0) + 1);
    }
  }

  const mustAsk: MustAskQuestionRow[] = mustAskQuestions.map((q) => ({
    key: q.key,
    prompt: q.prompt,
    reached: reached.get(q.key) ?? 0,
    cardShown: cardShown.get(q.key) ?? 0,
  }));

  const findings = deriveFindings(sessions, furthestPhase, mustAsk, facts);

  return {
    versionId: meta.versionId,
    range: meta.range,
    sessions,
    furthestPhase,
    medianTurnsToTargeted: targetedOrdinals.length > 0 ? median(targetedOrdinals) : null,
    turnsWithoutPhase,
    arcConfigured: facts.arcConfigured,
    mustAsk,
    fidelityGateOn: facts.fidelityGateOn,
    houseRulesActive: facts.houseRulesActive,
    findings,
    suppressed: false,
    truncated: false,
  };
}

/**
 * The observations, each carrying its sample size. Silent below
 * {@link POLICY_FINDING_MIN_SESSIONS} — a policy judged on three interviews is a guess.
 */
function deriveFindings(
  sessions: number,
  furthestPhase: Record<FunnelPhaseKey, number>,
  mustAsk: readonly MustAskQuestionRow[],
  facts: PolicyVersionFacts
): InterviewerPolicyFinding[] {
  if (sessions < POLICY_FINDING_MIN_SESSIONS) return [];
  const findings: InterviewerPolicyFinding[] = [];

  // The arc never leaving `open`. Only meaningful when an arc is configured at all — an `open`
  // approach is *supposed* to stay open, and reporting that as a failure would be the surface
  // arguing with a correct decision.
  if (facts.arcConfigured && furthestPhase.open === sessions) {
    findings.push({
      code: 'arc_never_narrowed',
      questionKey: null,
      message:
        `The questioning stayed broad for all ${sessions} interviews — it never reached the ` +
        `targeted phase. Either they end before coverage builds, or the pace is set to stay open ` +
        `longer than these conversations run.`,
    });
  }

  // A must-ask question no interview reached. The fidelity analogue of routing's
  // `criteria_never_fires`: the author marked it an instrument, and it is never put.
  for (const q of mustAsk) {
    if (q.reached === 0) {
      findings.push({
        code: 'must_ask_never_reached',
        questionKey: q.key,
        message:
          `"${q.prompt}" is marked must-ask, but no interview in these ${sessions} reached it. ` +
          `A question set as an instrument that is never put is worth checking against the ` +
          `selection strategy and, if routing is on, the topic it belongs to.`,
      });
    }
  }

  return findings;
}

/**
 * Load and assemble. The only Prisma-touching part.
 *
 * Suppressed when the cohort is non-empty but below the k-anonymity threshold: a per-question reach
 * count over two interviews describes those two respondents. Everything is zeroed EXCEPT
 * `sessions`, which stays so the surface can say how far off the threshold it is — the same carve-
 * out `getRoutingAnalytics` makes, and for the same reason.
 */
export async function getInterviewerPolicyAnalytics(
  scope: AnalyticsScope
): Promise<InterviewerPolicyResult> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };

  const [rows, version] = await Promise.all([
    prisma.appQuestionnaireTurn.findMany({
      where: {
        session: {
          versionId: scope.versionId,
          isPreview: false,
          ...roundSessionFilter(scope.roundId),
        },
        createdAt: { gte: scope.from, lt: scope.to },
      },
      orderBy: { createdAt: 'desc' },
      take: POLICY_TURN_READ_CAP + 1,
      select: {
        sessionId: true,
        ordinal: true,
        funnelPhase: true,
        questionCardKey: true,
        targetedQuestionId: true,
      },
    }),
    prisma.appQuestionnaireVersion.findUnique({
      where: { id: scope.versionId },
      select: {
        config: {
          select: { interviewerStrategy: true, questionFidelity: true, houseRules: true },
        },
        sections: {
          select: { questions: { select: { id: true, key: true, prompt: true, fidelity: true } } },
        },
      },
    }),
  ]);

  const strategy = narrowInterviewerStrategy(version?.config?.interviewerStrategy);
  const fidelityGate = narrowQuestionFidelity(version?.config?.questionFidelity);
  const houseRules = narrowHouseRules(version?.config?.houseRules);

  const slots = (version?.sections ?? []).flatMap((s) => s.questions);
  // `resolveQuestionFidelity` rather than the raw column, so a value the admin pre-set but never
  // switched on is correctly reported as absent rather than as a must-ask nobody reached.
  const mustAskQuestions: PolicyMustAskQuestion[] = slots
    .filter((q) => resolveQuestionFidelity(q.fidelity, fidelityGate) === 'must_ask')
    .map((q) => ({ key: q.key, prompt: q.prompt }));

  // The turn stores the question's row id; every reader downstream works in stable keys.
  const keyById = new Map(slots.map((q) => [q.id, q.key]));
  const turns: PolicyTurnRow[] = rows.slice(0, POLICY_TURN_READ_CAP).map((r) => ({
    sessionId: r.sessionId,
    ordinal: r.ordinal,
    funnelPhase: r.funnelPhase,
    targetedQuestionKey: r.targetedQuestionId ? (keyById.get(r.targetedQuestionId) ?? null) : null,
    questionCardKey: r.questionCardKey,
  }));

  const result = {
    ...assembleInterviewerPolicyAnalytics(
      turns,
      mustAskQuestions,
      {
        // The arc only reads for a funnel: `open` and `targeted` have no arc to narrow, and
        // `paceProfile` ignores the pace for them anyway.
        arcConfigured: strategy.enabled && strategy.approach === 'funnel',
        fidelityGateOn: fidelityGate.enabled,
        houseRulesActive: houseRules.enabled ? houseRules.rules.filter((r) => r.enabled).length : 0,
      },
      { versionId: scope.versionId, range }
    ),
    truncated: rows.length > POLICY_TURN_READ_CAP,
  };

  if (!isCohortSuppressed(result.sessions)) return result;

  return {
    ...result,
    furthestPhase: { open: 0, mixed: 0, targeted: 0 },
    medianTurnsToTargeted: null,
    turnsWithoutPhase: 0,
    mustAsk: [],
    findings: [],
    suppressed: true,
  };
}
