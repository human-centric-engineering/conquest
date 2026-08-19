/**
 * ConQuest's subject-data source manifest (GDPR Art. 15).
 *
 * The app-tier mirror of `lib/privacy/export-sources.ts`. Sunrise 0.8.0 (#467)
 * shipped the export service, the `collectAppSubjectData` seam and a coverage
 * guard that fails the build when a *platform* table relating to `User` has no
 * declared disposition. The guard cannot see app tables, and the seam's own
 * docs say so — "core cannot write it for you … the pattern worth copying is a
 * constant listing the tables you export plus a test that greps your own
 * schema". This file is that constant;
 * `tests/unit/lib/app/privacy/export-sources.test.ts` is that test.
 *
 * The reasoning is identical to the platform manifest's, and worth restating
 * because it is the whole point: an export that omits a table looks exactly
 * like a complete answer to the person reading it. Erasure fails loudly (a
 * missing `onDelete` throws `P2003`); access fails silently. So every
 * `app_*` table carrying a user id is declared here exactly once, with a
 * disposition, or is listed in {@link APP_EXCLUDED_SOURCES} with a written
 * reason the subject gets to read.
 *
 * ## The two dispositions, applied to this schema
 *
 * ConQuest has two populations, and almost every table belongs cleanly to one:
 *
 *   • **Respondents** — the people who answer questionnaires. Most of their
 *     rows hang off `AppQuestionnaireSession` and cascade from it, so they are
 *     reached through the session rather than by a user id of their own. The
 *     four that DO carry a respondent's id are declared `export` below: the
 *     session itself, an experience run, a profile snapshot, and an invitation.
 *   • **Admins** — the people who author questionnaires, cohorts, rounds and
 *     scoring. Their link to those rows is `createdBy`, which is *attribution,
 *     not ownership* — erasure retains the row and nulls the link. So the
 *     personal data is the fact of authorship, and `attribution` returns
 *     id + label + date, never the configured content.
 *
 * ## What is deliberately NOT here
 *
 * Tables with no user-id column at all (question slots, versions, turn rows,
 * scores, transcripts) are respondent data reached through the session, and
 * belong to whoever ran that session — not to any account. They are covered by
 * the session-scoped export below rather than by a `User` match, and the app
 * coverage guard asserts that the set of tables with a user id is exactly the
 * set declared here.
 *
 * @see lib/privacy/export-sources.ts — the platform manifest this mirrors
 * @see lib/app/data-export.ts — the seam that consumes this
 * @see .context/privacy/data-export.md
 */

import { prisma } from '@/lib/db/client';

/** How an app model is represented in a subject export. Mirrors the platform type. */
export type AppSourceDisposition = 'export' | 'attribution';

/** Identity of the subject being exported. */
export interface AppSubjectRef {
  userId: string;
  email: string;
}

/** One row of "you created this", with none of the created thing's content. */
export interface AppAttributionRow {
  id: string;
  label: string | null;
  createdAt: Date;
}

/** An app model and how it is exported. */
export interface AppSubjectDataSource {
  /** Prisma model name, exactly as written in `prisma/schema/app*.prisma`. The guard matches on this. */
  model: string;
  /** Key this source lands under in the export bundle's `app` section. */
  section: string;
  disposition: AppSourceDisposition;
  /** One line on why this is the subject's data — surfaced in the export's `meta`. */
  description: string;
  /** Set when this source returns only SOME of the rows matching the subject, and why. */
  scopeNote?: string;
  fetch: (subject: AppSubjectRef) => Promise<unknown[]>;
}

/** A model deliberately left out, with the reason the subject is shown. */
export interface AppExcludedSource {
  model: string;
  reason: string;
}

/**
 * Narrow rows already fetched with a `{ id, createdAt, <label> }` select down to
 * the attribution shape.
 *
 * Deliberately a mapper over rows rather than a wrapper around a Prisma
 * delegate: Prisma 7's delegate types are per-model and generic over the args,
 * so a shared `delegate.findMany` parameter can only be typed loosely, which
 * costs the `select` its type-checking and pushes the label read through a
 * `Record<string, unknown>` cast. Each source below therefore issues its own
 * fully-typed query and hands the rows here.
 *
 * A model with no human-readable column passes `() => null`, which is honest —
 * the subject learns they authored a row and when, and that *is* the entirety
 * of the personal data in an attribution.
 */
function toAttribution<T extends { id: string; createdAt: Date }>(
  rows: T[],
  label: (row: T) => string | null
): AppAttributionRow[] {
  return rows.map((row) => ({ id: row.id, label: label(row), createdAt: row.createdAt }));
}

/** Shared `select`/`orderBy` for an attribution query with no label column. */
const ATTRIBUTION_BARE = {
  select: { id: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
} as const;

/**
 * Every `app_*` model carrying a user id, exactly once.
 *
 * Order is presentational — it is the order the sections appear in the bundle.
 * Respondent-owned data first, since that is what a subject-access request is
 * usually about; admin attribution after.
 */
export const APP_SUBJECT_DATA_SOURCES: AppSubjectDataSource[] = [
  // ── Respondent-owned ──────────────────────────────────────────────────────
  {
    model: 'AppQuestionnaireSession',
    section: 'questionnaireSessions',
    disposition: 'export',
    description:
      'Every questionnaire you took while signed in — status, timings, the persona you were given, and the flags the conversation recorded about it.',
    scopeNote:
      'The rows hanging off a session (your turns and answers, transcripts, scores and generated report) are not repeated here; they are reached through the session and included with it. A session taken without signing in has no account to match, so it cannot appear in an account export.',
    // `omit` rather than `select`: a column added tomorrow is exported by
    // default. `publicRef` is a human-readable admin lookup reference, not a
    // bearer token, so it stays in — it is how the subject can cite a specific
    // session back to an operator.
    fetch: ({ userId }) =>
      prisma.appQuestionnaireSession.findMany({
        where: { respondentUserId: userId },
        orderBy: { createdAt: 'desc' },
      }),
  },
  {
    model: 'AppExperienceRun',
    section: 'experienceRuns',
    disposition: 'export',
    description:
      'Your progress through any multi-step experience — which step you reached, what was carried between steps, and how you were routed.',
    fetch: ({ userId }) =>
      prisma.appExperienceRun.findMany({
        where: { respondentUserId: userId },
        orderBy: { createdAt: 'desc' },
      }),
  },
  {
    model: 'AppRespondentProfileSnapshot',
    section: 'respondentProfileSnapshots',
    disposition: 'export',
    description:
      'The profile detail captured about you when you took a questionnaire while signed in — the answers behind any personalisation applied to your session.',
    // `omit` rather than `select`, so a column added tomorrow is exported by
    // default. Nothing here is credential material, so nothing is omitted.
    fetch: ({ userId }) =>
      prisma.appRespondentProfileSnapshot.findMany({
        where: { respondentUserId: userId },
      }),
  },
  {
    model: 'AppQuestionnaireInvitation',
    section: 'questionnaireInvitations',
    disposition: 'export',
    description:
      'Invitations addressed to you — the address and name they were sent to, any per-invitee detail captured with them, and when they were sent, opened and accepted.',
    scopeNote:
      'The invitation token hash is withheld: it is live credential material that grants access to a questionnaire session, and disclosing it would let anyone holding this export impersonate the invitation. Invitations you SENT as an administrator are not listed here — those are covered as attribution, since the personal data in them belongs to the recipient.',
    fetch: ({ userId, email }) =>
      prisma.appQuestionnaireInvitation.findMany({
        // Matched on both: `userId` is only stamped once an invitee registers,
        // so an invitation that was sent and never redeemed is reachable by
        // address alone — and that unredeemed row is still the subject's data.
        where: { OR: [{ userId }, { email }] },
        omit: { tokenHash: true },
        orderBy: { createdAt: 'desc' },
      }),
  },

  // ── Admin attribution ─────────────────────────────────────────────────────
  // `createdBy` is a plain String with no FK by design (UG-1), so none of these
  // are visible to a relation scan — which is exactly why they are listed by
  // hand and why the app guard scans for the column name too.
  {
    model: 'AppCohort',
    section: 'cohortsCreated',
    disposition: 'attribution',
    description:
      'Cohorts you created. The roster and its members’ data are not yours and are not included.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appCohort.findMany({
          where: { createdBy: userId },
          select: { id: true, name: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.name
      ),
  },
  {
    model: 'AppCohortSubgroup',
    section: 'cohortSubgroupsCreated',
    disposition: 'attribution',
    description: 'Cohort subgroups you created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appCohortSubgroup.findMany({
          where: { createdBy: userId },
          select: { id: true, name: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.name
      ),
  },
  {
    model: 'AppCohortReport',
    section: 'cohortReportsCreated',
    disposition: 'attribution',
    description:
      'Cohort reports you generated. The report content synthesises other people’s responses, so it is not included.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appCohortReport.findMany({
          where: { createdBy: userId },
          select: { id: true, title: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.title
      ),
  },
  {
    model: 'AppCohortReportRevision',
    section: 'cohortReportRevisionsCreated',
    disposition: 'attribution',
    description: 'Re-runs of a cohort report that you triggered.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appCohortReportRevision.findMany({
          where: { createdBy: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    model: 'AppRespondentReportRevision',
    section: 'respondentReportRevisionsCreated',
    disposition: 'attribution',
    description:
      'Re-runs of a respondent’s report that you triggered as an administrator. The report is about the respondent, not about you, so its content is not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appRespondentReportRevision.findMany({
          where: { createdBy: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    model: 'AppExperience',
    section: 'experiencesCreated',
    disposition: 'attribution',
    description: 'Experiences (multi-step journeys) you authored.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appExperience.findMany({
          where: { createdBy: userId },
          select: { id: true, title: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.title
      ),
  },
  {
    model: 'AppExperienceSynthesis',
    section: 'experienceSynthesesCreated',
    disposition: 'attribution',
    description:
      'Experience-wide syntheses you generated. The synthesis is drawn from other people’s responses and is not included.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appExperienceSynthesis.findMany({
          where: { createdBy: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    model: 'AppQuestionnaireRound',
    section: 'roundsCreated',
    disposition: 'attribution',
    description: 'Questionnaire rounds you created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnaireRound.findMany({
          where: { createdBy: userId },
          select: { id: true, name: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.name
      ),
  },
  {
    model: 'AppRoundPhase',
    section: 'roundPhasesCreated',
    disposition: 'attribution',
    description: 'Round phases you created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appRoundPhase.findMany({ where: { createdBy: userId }, ...ATTRIBUTION_BARE }),
        () => null
      ),
  },
  {
    model: 'AppRoundContextEntry',
    section: 'roundContextEntriesCreated',
    disposition: 'attribution',
    description: 'Briefing/context entries you added to a round.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appRoundContextEntry.findMany({
          where: { createdBy: userId },
          select: { id: true, title: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.title
      ),
  },
  {
    model: 'AppGlossaryTerm',
    section: 'glossaryTermsCreated',
    disposition: 'attribution',
    description: 'Glossary terms you added to a questionnaire.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appGlossaryTerm.findMany({
          where: { createdBy: userId },
          select: { id: true, term: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.term
      ),
  },
  {
    model: 'AppGlossaryDocument',
    section: 'glossaryDocumentsUploaded',
    disposition: 'attribution',
    description: 'Definitions documents you uploaded to a questionnaire.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appGlossaryDocument.findMany({
          where: { uploadedBy: userId },
          select: { id: true, fileName: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.fileName
      ),
  },
  {
    model: 'AppScoringSchema',
    section: 'scoringSchemasCreated',
    disposition: 'attribution',
    description: 'Scoring schemas you authored.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appScoringSchema.findMany({
          where: { createdBy: userId },
          select: { id: true, name: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        (row) => row.name
      ),
  },
  {
    model: 'AppQuestionnaireScopeEvaluationRun',
    section: 'scopeEvaluationRunsTriggered',
    disposition: 'attribution',
    description:
      'Adaptive Scope evaluation runs you triggered. The judges’ findings about the questionnaire are not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnaireScopeEvaluationRun.findMany({
          where: { triggeredByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    model: 'AppQuestionnaireScopeEvaluationFinding',
    section: 'scopeEvaluationFindingsDecided',
    disposition: 'attribution',
    description:
      'Adaptive Scope evaluation findings you accepted, declined, edited, or applied. The finding’s content is not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnaireScopeEvaluationFinding.findMany({
          where: { decidedByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
];

/**
 * App models deliberately left out of the export, each with the reason the
 * subject is shown in `meta`.
 *
 * Empty by design: every app table carrying a user id is currently exportable
 * or attributable. The constant exists so that the first table which genuinely
 * should be withheld has a place to go with its reason attached, rather than
 * being dropped from the manifest.
 */
export const APP_EXCLUDED_SOURCES: AppExcludedSource[] = [];
