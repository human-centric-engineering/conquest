/**
 * Admin session-viewer read seams — the DB reads behind the admin "view a respondent session"
 * surface (look up by support reference, then read the conversation).
 *
 * Two pure-ish reads, both Prisma-backed and admin-route-local (kept out of `lib/app/**`, which is
 * Prisma-free, exactly like {@link loadSessionExport} which this mirrors):
 *
 *  - {@link loadAdminSessionView} — the metadata the viewer page needs to decide read-only vs.
 *    continue (`isPreview`/`status`) and to render its header, with respondent identity redacted in
 *    anonymous mode the SAME way the PDF export redacts it (identity is queried only when NOT
 *    anonymous). The conversation itself is loaded separately via {@link loadTranscript}.
 *  - {@link resolveSessionRefLocation} — resolves a user-entered support reference (`publicRef`) to
 *    the session's location so the lookup UI can navigate to its viewer route. Lightweight (no turns
 *    or eval counts, unlike {@link lookupSessionByRef}); it only needs where to send the admin.
 */

import { prisma } from '@/lib/db/client';
import { SESSION_STATUSES, narrowToEnum, type SessionStatus } from '@/lib/app/questionnaire/types';
import { normalizeSessionRef } from '@/lib/app/questionnaire/session-ref';
import {
  narrowInterviewPlan,
  narrowTopicMembers,
  type ScopeDecisionSource,
  type TopicDepth,
} from '@/lib/app/questionnaire/scope/types';

/** One topic on the plan, resolved to its label so the viewer never shows a bare key. */
export interface AdminPlannedTopicView {
  key: string;
  /** The topic's label, or the key when the topic has since been deleted from the version. */
  label: string;
  depth?: TopicDepth;
  source: ScopeDecisionSource;
  rationale: string;
  /**
   * How much of the topic this interview asked, when the plan named a SUBSET of it (C6) — e.g.
   * `{ asked: 3, total: 10 }`. Absent when the whole topic (at its depth) was in scope.
   *
   * On the viewer this is the difference between "we covered Talent" and "we asked three of
   * Talent's ten questions", which is exactly the distinction a challenged report turns on.
   */
  partial?: { asked: number; total: number };
}

/**
 * The interview plan as the admin viewer renders it — Conditional Topics (P17).
 *
 * "Why did this respondent get those topics" is THE question an admin asks about an adaptive
 * instrument, usually months later and usually because a client challenged a report. The plan
 * answers it, so it belongs on the session viewer beside the transcript rather than only in the
 * `AppAiRun` audit table, which no one reads by accident.
 *
 * The excluded topics matter as much as the selected ones: what an interview decided NOT to ask is
 * exactly what a challenge is about.
 */
export interface AdminInterviewPlanView {
  selected: AdminPlannedTopicView[];
  excluded: AdminPlannedTopicView[];
  /** The `light`-depth blind-spot check, when one was added. */
  checkTopicKey: string | null;
  confidence: number;
  source: ScopeDecisionSource;
  /** What the respondent was actually told at the handover. Empty when announcing was off. */
  respondentMessage: string;
  decidedAtTurn: number;
  decidedAt: string;
  /**
   * The time budget this plan was fitted to and what it was estimated to cost (C7b), in seconds.
   *
   * Both null unless the version set a budget — the default. When they are present, "why is this
   * topic missing" has an arithmetic answer, and the viewer can show it beside the topic the budget
   * took back rather than leaving an admin to infer it from a badge.
   */
  budgetSeconds: number | null;
  estimatedSeconds: number | null;
}

/** Metadata for the admin session viewer — gates the surface and renders its header. */
export interface AdminSessionView {
  /** The questionnaire the session's version belongs to (admin ownership check). */
  questionnaireId: string;
  questionnaireTitle: string;
  versionId: string;
  versionNumber: number;
  /** A preview (admin) session is continuable; a real respondent session is read-only. */
  isPreview: boolean;
  status: SessionStatus;
  /** Support reference shown in the header (null for legacy sessions minted before refs). */
  publicRef: string | null;
  anonymous: boolean;
  /** Respondent display name — null in anonymous mode (never even queried), mirroring the export. */
  respondentName: string | null;
  /**
   * Conditional Topics (P17): the plan this interview ran under, or null.
   *
   * Null for every ordinary session AND for an adaptive one whose opening never completed — both
   * are "no decision was made", which is what the viewer says.
   */
  plan: AdminInterviewPlanView | null;
}

/**
 * Load the admin viewer's metadata for one session, or `null` when it doesn't exist. Identity
 * redaction mirrors {@link loadSessionExport}: in anonymous mode the respondent's name is never
 * queried, so an anonymous session's viewer carries no identity.
 */
export async function loadAdminSessionView(sessionId: string): Promise<AdminSessionView | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      isPreview: true,
      publicRef: true,
      versionId: true,
      respondentUserId: true,
      interviewPlan: true,
      version: {
        select: {
          versionNumber: true,
          questionnaireId: true,
          config: { select: { anonymousMode: true } },
          questionnaire: { select: { title: true } },
        },
      },
    },
  });
  if (!row) return null;

  const anonymous = row.version.config?.anonymousMode ?? false;

  // Identity is only ever queried when NOT anonymous — the same hard gate the export applies.
  let respondentName: string | null = null;
  if (!anonymous && row.respondentUserId) {
    const user = await prisma.user.findUnique({
      where: { id: row.respondentUserId },
      select: { name: true },
    });
    respondentName = user?.name ?? null;
  }

  const plan = await resolvePlanView(row.versionId, row.interviewPlan);

  return {
    questionnaireId: row.version.questionnaireId,
    questionnaireTitle: row.version.questionnaire.title,
    versionId: row.versionId,
    versionNumber: row.version.versionNumber,
    isPreview: row.isPreview,
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
    publicRef: row.publicRef,
    anonymous,
    respondentName,
    plan,
  };
}

/**
 * Resolve a stored plan into the viewer shape, labelling every topic key.
 *
 * The topic query is skipped entirely when there is no plan, which is every ordinary session — so
 * this costs nothing for the surface as it existed before P17. A key the version no longer carries
 * falls back to the key itself rather than being dropped: an admin investigating a challenged report
 * needs to see that the interview covered something since deleted, which is precisely the case a
 * silent drop would hide.
 */
async function resolvePlanView(
  versionId: string,
  stored: unknown
): Promise<AdminInterviewPlanView | null> {
  const plan = narrowInterviewPlan(stored);
  if (!plan) return null;

  const topics = await prisma.appQuestionnaireTopic.findMany({
    where: { versionId },
    select: { key: true, label: true, members: true },
  });
  const labelByKey = new Map(topics.map((t) => [t.key, t.label]));
  const label = (key: string): string => labelByKey.get(key) ?? key;
  const membersByKey = new Map(topics.map((t) => [t.key, narrowTopicMembers(t.members)] as const));

  /**
   * The "3 of 10" line, only when the plan actually narrowed the topic.
   *
   * Counted against what the topic contains TODAY. The instrument can be edited after an interview
   * runs, so this can read "3 of 8" on a topic that had ten questions at the time — which is the
   * honest answer to "how much of the topic as it now stands did this interview ask", and the
   * alternative (storing the total on the plan) answers a question nobody puts.
   */
  const partial = (
    t: (typeof plan.topics)[number]
  ): { partial?: { asked: number; total: number } } => {
    if (!t.members) return {};
    const authored = membersByKey.get(t.key);
    if (!authored) return {};
    const total = authored.questionKeys.length + authored.dataSlotKeys.length;
    const wanted = new Set([...t.members.questionKeys, ...t.members.dataSlotKeys]);
    const asked =
      authored.questionKeys.filter((k) => wanted.has(k)).length +
      authored.dataSlotKeys.filter((k) => wanted.has(k)).length;
    if (asked === 0 || asked >= total) return {};
    return { partial: { asked, total } };
  };

  return {
    selected: plan.topics.map((t) => ({
      key: t.key,
      label: label(t.key),
      depth: t.depth,
      source: t.source,
      rationale: t.rationale,
      ...partial(t),
    })),
    excluded: plan.excluded.map((t) => ({
      key: t.key,
      label: label(t.key),
      source: t.source,
      rationale: t.rationale,
    })),
    checkTopicKey: plan.checkTopicKey,
    confidence: plan.confidence,
    source: plan.source,
    respondentMessage: plan.respondentMessage,
    decidedAtTurn: plan.decidedAtTurn,
    decidedAt: plan.decidedAt,
    budgetSeconds: plan.budgetSeconds ?? null,
    estimatedSeconds: plan.estimatedSeconds ?? null,
  };
}

/** Where a support reference resolves to — enough for the lookup UI to navigate to the viewer. */
export interface SessionRefLocation {
  sessionId: string;
  ref: string;
  questionnaireId: string;
  versionId: string;
  versionNumber: number;
  questionnaireTitle: string;
  isPreview: boolean;
  status: SessionStatus;
}

/**
 * Resolve a user-entered support reference to its session's location, or `null` when no session
 * matches. The ref is normalised forgivingly (folds Crockford look-alikes, strips grouping) by
 * {@link normalizeSessionRef}, so a dash / lower-case / O-for-0 slip still resolves.
 */
export async function resolveSessionRefLocation(
  rawRef: string
): Promise<SessionRefLocation | null> {
  const ref = normalizeSessionRef(rawRef);
  if (!ref) return null;

  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { publicRef: ref },
    select: {
      id: true,
      publicRef: true,
      isPreview: true,
      status: true,
      versionId: true,
      version: {
        select: {
          versionNumber: true,
          questionnaireId: true,
          questionnaire: { select: { title: true } },
        },
      },
    },
  });
  if (!row || !row.publicRef) return null;

  return {
    sessionId: row.id,
    ref: row.publicRef,
    questionnaireId: row.version.questionnaireId,
    versionId: row.versionId,
    versionNumber: row.version.versionNumber,
    questionnaireTitle: row.version.questionnaire.title,
    isPreview: row.isPreview,
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
  };
}
