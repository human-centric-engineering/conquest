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
import { membersAtDepth } from '@/lib/app/questionnaire/scope/resolve';
import {
  narrowInterviewPlan,
  narrowTopicMembers,
  type ScopeDecisionSource,
  type TopicDepth,
} from '@/lib/app/questionnaire/scope/types';
import { resolveSessionSections } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-sections';
import { narrowSectionRun, sectionEntry } from '@/lib/app/questionnaire/sections/run';
import type { SectionCloseReason, SectionStatus } from '@/lib/app/questionnaire/sections/types';

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

/**
 * One section on the admin timeline — Sectioned interviews (P21).
 *
 * The operator's question here is not "what did they answer" (the transcript says that) but "where
 * did this run get stuck". A section that was opened twenty turns ago, never closed, and cost more
 * than the six after it is the shape of a stalled interview, and until this existed the only record
 * of it was a Json blob nobody reads by accident.
 */
export interface AdminSectionTimelineEntry {
  key: string;
  /** The section's respondent-facing label, or the key when the version no longer carries it. */
  label: string;
  /** 1-based position in the run. */
  position: number;
  status: SectionStatus;
  /** Turn the section was first opened at; 0 before any turn landed in it. */
  openedAtTurn: number;
  /** Turn it was closed at, or null while open. */
  closedAtTurn: number | null;
  closeReason: SectionCloseReason | null;
  reopenCount: number;
  /**
   * Turns charged to this section's budget, across every visit.
   *
   * The counted figure off the run, NOT a count of tagged rows: it is what `maxTurnsPerSection`
   * measures against, so it is the number that explains why a capped section released when it did.
   */
  turnsSpent: number;
  /** Summed spend across the turns tagged with this section; null when no turn recorded a cost. */
  costUsd: number | null;
  /**
   * True when this section no longer resolves on the version — it was renamed away, or the topic
   * behind it was deleted after this interview ran.
   *
   * Kept and shown rather than dropped, for the reason the run reconciler keeps the entry: turns
   * were tagged with it, and a timeline that omitted it would leave those turns belonging to
   * nothing while claiming to account for the whole run.
   */
  stale: boolean;
}

/** The section timeline for one session, or absent when the interview was not sectioned. */
export interface AdminSectionTimelineView {
  entries: AdminSectionTimelineEntry[];
  /** The section the run was in when it stopped, or null when it never started / all closed. */
  activeKey: string | null;
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
  /**
   * Sectioned interviews (P21): what happened in each part of the interview, or null.
   *
   * Null for every unsectioned session, which is every session that predates the feature and every
   * version that never opted in — so the viewer renders exactly what it rendered before by
   * construction rather than by a branch someone has to remember. Also null when the caller passed
   * `sectionTimeline: false`, meaning it never asked rather than that there was nothing to find.
   */
  sectionTimeline: AdminSectionTimelineView | null;
}

/** What a caller wants loaded beyond the metadata every caller needs. */
export interface AdminSessionViewOptions {
  /**
   * Resolve the section timeline (P21). Default true, for the viewer page that renders it.
   *
   * Opt OUT when the caller only needs the ownership check and the redaction fields. Resolving a
   * timeline costs a full `buildTurnContext` plus a grouped read over the turns, and a caller that
   * discards the result pays all of it — which is the same defect, pointed the other way, that
   * gating on `sectionRun` was added to fix. Explicit rather than inferred: a default of false
   * would silently empty the viewer the first time someone forgot to ask.
   */
  sectionTimeline?: boolean;
}

/**
 * Load the admin viewer's metadata for one session, or `null` when it doesn't exist. Identity
 * redaction mirrors {@link loadSessionExport}: in anonymous mode the respondent's name is never
 * queried, so an anonymous session's viewer carries no identity.
 */
export async function loadAdminSessionView(
  sessionId: string,
  options: AdminSessionViewOptions = {}
): Promise<AdminSessionView | null> {
  const { sectionTimeline: wantSectionTimeline = true } = options;
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      isPreview: true,
      publicRef: true,
      versionId: true,
      respondentUserId: true,
      interviewPlan: true,
      // Sectioned interviews (P21): the CHEAP GATE on the timeline below, not the timeline's data.
      // Null on every unsectioned session, so an ordinary session never pays the context build that
      // resolving the labels costs. Phase C learned this the expensive way, when the respondent
      // strip fetched on mount to be told the feature was off.
      sectionRun: true,
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
  // Only a session that actually banked a run can have a timeline, only that session pays for one
  // to be resolved, and only a caller that will render it asks in the first place.
  const sectionTimeline =
    wantSectionTimeline && narrowSectionRun(row.sectionRun)
      ? await resolveSectionTimeline(sessionId)
      : null;

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
    sectionTimeline,
  };
}

/**
 * Resolve the section timeline for one session, or null when it was not sectioned.
 *
 * Goes through {@link resolveSessionSections} rather than reading `sectionRun` directly: the run
 * stores keys, and labels + order live on the version. See that module for why paying a context
 * build is the right trade here.
 *
 * The cost figures come from the TURN ROWS, not from the run, because the run has no notion of
 * spend. A section whose turns all predate cost capture reads null rather than zero — "we did not
 * record it" and "it was free" are different claims, and only one of them is true.
 */
async function resolveSectionTimeline(sessionId: string): Promise<AdminSectionTimelineView | null> {
  const resolved = await resolveSessionSections(sessionId);
  if (!resolved.active || resolved.run === null) return null;

  const run = resolved.run;

  // One grouped read for every section's spend. Turns with a null `sectionKey` (an exchange
  // belonging to no section) group under null and are simply never looked up.
  const spend = await prisma.appQuestionnaireTurn.groupBy({
    by: ['sectionKey'],
    where: { sessionId },
    _sum: { costUsd: true },
  });
  const costByKey = new Map<string, number | null>();
  for (const group of spend) {
    if (group.sectionKey === null) continue;
    costByKey.set(group.sectionKey, group._sum.costUsd);
  }

  const entries: AdminSectionTimelineEntry[] = resolved.sections.map((section, index) => {
    const entry = sectionEntry(run, section.key);
    return {
      key: section.key,
      label: section.label,
      position: index + 1,
      status: entry?.status ?? 'not_started',
      openedAtTurn: entry?.openedAtTurn ?? 0,
      closedAtTurn: entry?.closedAtTurn ?? null,
      closeReason: entry?.closeReason ?? null,
      reopenCount: entry?.reopenCount ?? 0,
      turnsSpent: entry?.turnsSpent ?? 0,
      costUsd: costByKey.get(section.key) ?? null,
      stale: false,
    };
  });

  // Entries the reconciler kept for sections that stopped resolving. Appended in run order after
  // the live ones, which is where the reconciler itself puts them.
  const live = new Set(resolved.sections.map((s) => s.key));
  for (const entry of run.sections) {
    if (live.has(entry.key)) continue;
    entries.push({
      key: entry.key,
      label: entry.key,
      position: entries.length + 1,
      status: entry.status,
      openedAtTurn: entry.openedAtTurn,
      closedAtTurn: entry.closedAtTurn,
      closeReason: entry.closeReason,
      reopenCount: entry.reopenCount,
      turnsSpent: entry.turnsSpent,
      costUsd: costByKey.get(entry.key) ?? null,
      stale: true,
    });
  }

  return { entries, activeKey: run.activeKey };
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
/**
 * How many of one half of a topic an interview asked.
 *
 * A named subset is intersected with what the topic contains today; an un-named half falls to the
 * topic's depth, exactly as `plannedMembers` resolves it at run time. Only the COUNT is needed
 * here, so no weights are loaded — `membersAtDepth` picks which two a `light` topic samples, but
 * how many it samples is the same either way.
 */
export function askedCount(
  authored: readonly string[],
  named: readonly string[] | undefined,
  depth: TopicDepth
): number {
  if (named && named.length > 0) {
    const kept = authored.filter((key) => named.includes(key));
    if (kept.length > 0) return kept.length;
  }
  return membersAtDepth(authored, depth, undefined).length;
}

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
    // A plan narrows one half and leaves the other to the depth, so the halves are counted
    // separately. Counting a `new Set` of both at once would read the un-named half — stored
    // empty, meaning "the depth decides" — as nothing asked at all.
    const asked =
      askedCount(authored.questionKeys, t.members.questionKeys, t.depth) +
      askedCount(authored.dataSlotKeys, t.members.dataSlotKeys, t.depth);
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
