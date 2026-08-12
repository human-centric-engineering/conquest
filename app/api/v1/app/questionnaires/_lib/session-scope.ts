/**
 * Session scope loading (P17) — the one place a session's {@link ResolvedScope} is built.
 *
 * Every surface that reads "the version's questions" or "the version's data slots" routes through
 * here, so scope can never be applied in one place and forgotten in another. The pure filter lives
 * in `lib/app/questionnaire/scope/resolve.ts`; this module is only its DB seam.
 *
 * ## Cost
 *
 * Two extra queries per call, and both are skipped entirely for a version with no topics — which,
 * on a fresh install, is every version. `loadSessionScope` is also given a `prisma`-compatible
 * client parameter so a caller already inside a transaction reuses it rather than opening a second
 * connection mid-write.
 */

import { prisma } from '@/lib/db/client';
import { resolveScope, type ResolvedScope } from '@/lib/app/questionnaire/scope/resolve';
import {
  narrowAdaptiveScopeSettings,
  narrowInterviewPlan,
  type AdaptiveScopeSettings,
  type InterviewPlan,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { toTopic, TOPIC_SELECT } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

/** The minimal client surface this module needs — `prisma` or an interactive transaction client. */
type Db = Pick<typeof prisma, 'appQuestionnaireTopic'>;

/** What a scope load resolved, with the raw pieces so callers can render "why". */
export interface SessionScope {
  scope: ResolvedScope;
  topics: Topic[];
  settings: AdaptiveScopeSettings;
  plan: InterviewPlan | null;
}

/** A scope that filters nothing — the answer for every version that never opted in. */
export function inertScope(): SessionScope {
  const settings = narrowAdaptiveScopeSettings({});
  return {
    scope: resolveScope({ topics: [], plan: null, settings }),
    topics: [],
    settings,
    plan: null,
  };
}

/**
 * Build the scope for a session whose version config and plan the caller has already loaded.
 *
 * Preferred over {@link loadSessionScope} wherever the caller is already reading the session — the
 * turn pipeline reads both in its one big query, so re-fetching them here would be waste.
 *
 * `weightByQuestionKey` / `weightByDataSlotKey` matter only for `light`-depth topics (the blind-spot
 * check), which pick their highest-weight members; omitting them falls back to authored order.
 */
export async function buildSessionScope(
  db: Db,
  input: {
    versionId: string;
    settings: AdaptiveScopeSettings;
    interviewPlan: unknown;
    allQuestionKeys?: readonly string[];
    allDataSlotKeys?: readonly string[];
    weightByQuestionKey?: ReadonlyMap<string, number>;
    weightByDataSlotKey?: ReadonlyMap<string, number>;
  }
): Promise<SessionScope> {
  // The short-circuit that keeps this free for everyone who never turned it on: an disabled
  // version needs no topic query at all, because the result cannot depend on the answer.
  if (!input.settings.enabled) {
    const plan = narrowInterviewPlan(input.interviewPlan);
    return {
      scope: resolveScope({ topics: [], plan, settings: input.settings }),
      topics: [],
      settings: input.settings,
      plan,
    };
  }

  const rows = await db.appQuestionnaireTopic.findMany({
    where: { versionId: input.versionId },
    orderBy: { ordinal: 'asc' },
    select: TOPIC_SELECT,
  });
  const topics = rows.map(toTopic);
  const plan = narrowInterviewPlan(input.interviewPlan);

  return {
    scope: resolveScope({
      topics,
      plan,
      settings: input.settings,
      ...(input.allQuestionKeys ? { allQuestionKeys: input.allQuestionKeys } : {}),
      ...(input.allDataSlotKeys ? { allDataSlotKeys: input.allDataSlotKeys } : {}),
      ...(input.weightByQuestionKey ? { weightByQuestionKey: input.weightByQuestionKey } : {}),
      ...(input.weightByDataSlotKey ? { weightByDataSlotKey: input.weightByDataSlotKey } : {}),
    }),
    topics,
    settings: input.settings,
    plan,
  };
}

/**
 * Load a session's scope from its id alone, for callers with nothing already in hand (the report
 * worker, the exports).
 *
 * Returns an inert scope for a session that does not exist rather than throwing — a caller in that
 * position has a bigger problem than scope, and every one of them handles the missing session
 * itself.
 */
export async function loadSessionScope(
  sessionId: string,
  options: {
    allQuestionKeys?: readonly string[];
    allDataSlotKeys?: readonly string[];
  } = {}
): Promise<SessionScope> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      versionId: true,
      interviewPlan: true,
      version: { select: { config: { select: { adaptiveScope: true } } } },
    },
  });
  if (!session) return inertScope();

  return buildSessionScope(prisma, {
    versionId: session.versionId,
    settings: narrowAdaptiveScopeSettings(session.version.config?.adaptiveScope),
    interviewPlan: session.interviewPlan,
    ...options,
  });
}
