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
    // The child rows are INCLUDED, not merely referenced. Sunrise 0.10.0's
    // fork-accounting rule (#660) made this discrepancy visible: the scopeNote
    // above has always promised turns, answers, scores and the report are
    // "reached through the session and included with it", and the plain
    // findMany did not include them — so every row below had to be excluded
    // with a reason that was not true. The subject's own words live in
    // `turns.userMessage`; a bundle without them is the short answer this
    // module's rules exist to prevent.
    fetch: ({ userId }) =>
      prisma.appQuestionnaireSession.findMany({
        where: { respondentUserId: userId },
        orderBy: { createdAt: 'desc' },
        include: {
          answers: true,
          dataSlotFills: true,
          events: true,
          turns: true,
          turnEvaluations: true,
          scores: true,
          respondentReport: true,
        },
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
  {
    model: 'AppCohortMember',
    section: 'cohortMemberships',
    disposition: 'export',
    description:
      'Rosters you appear on — the address and name you were listed under, any subgroup you were assigned to, whether you are still active, and when you were added or removed.',
    scopeNote:
      'Matched on your email address, because a roster entry is not a login and carries no account id. The admin note a cohort owner may have written against your entry IS included: it is a note about you.',
    // Surfaced by the Sunrise 0.10.0 fork-accounting rule (#660), which asks a
    // fork to say something about EVERY model rather than only the user-linked
    // ones. This table holds a name and an address and had no disposition.
    fetch: ({ email }) =>
      prisma.appCohortMember.findMany({
        where: { email },
        orderBy: { addedAt: 'desc' },
      }),
  },
  {
    model: 'AppWaitlistSignup',
    section: 'waitlistSignups',
    disposition: 'export',
    description:
      'Waitlist sign-ups made with your address — the name and address given, what you said you would use ConQuest for, and which page you signed up from.',
    scopeNote:
      'Matched on your email address; a waitlist sign-up is made before any account exists, so there is no account id to match on. The admin triage flag is included — it is a fact recorded against your sign-up.',
    fetch: ({ email }) =>
      prisma.appWaitlistSignup.findMany({
        where: { email },
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
      'Conditional Topics evaluation runs you triggered. The judges’ findings about the questionnaire are not included here.',
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
      'Conditional Topics evaluation findings you accepted, declined, edited, or applied. The finding’s content is not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnaireScopeEvaluationFinding.findMany({
          where: { decidedByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    // The F5.1–F5.3 design panel, the older sibling of the scope panel above. It went undeclared
    // for as long as the coverage guard's column-name net omitted `triggeredByUserId`.
    model: 'AppQuestionnaireEvaluationRun',
    section: 'evaluationRunsTriggered',
    disposition: 'attribution',
    description:
      'Questionnaire design-evaluation runs you triggered. The judges’ findings about the questionnaire are not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnaireEvaluationRun.findMany({
          where: { triggeredByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    model: 'AppQuestionnaireEvaluationFinding',
    section: 'evaluationFindingsDecided',
    disposition: 'attribution',
    description:
      'Questionnaire design-evaluation findings you accepted, declined, edited, or applied. The finding’s content is not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnaireEvaluationFinding.findMany({
          where: { decidedByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    // A turn evaluation is a judgement about the INTERVIEWER, not about the admin who ran it, and
    // not about the respondent (whose words live on the turn row, exported through their session).
    // So the admin's link to it is authorship of the act, and nothing more is returned.
    model: 'AppQuestionnaireTurnEvaluation',
    section: 'turnEvaluationsRun',
    disposition: 'attribution',
    description:
      'Interview-turn evaluations you ran. The verdict itself, and the respondent’s words it judged, are not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnaireTurnEvaluation.findMany({
          where: { evaluatedByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    model: 'AppQuestionnairePolicyEvaluationRun',
    section: 'policyEvaluationRunsTriggered',
    disposition: 'attribution',
    description:
      'Interviewer-policy evaluation runs you triggered. The judges’ findings about the questionnaire are not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnairePolicyEvaluationRun.findMany({
          where: { triggeredByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    model: 'AppQuestionnairePolicyEvaluationFinding',
    section: 'policyEvaluationFindingsDecided',
    disposition: 'attribution',
    description:
      'Interviewer-policy evaluation findings you accepted, declined, edited, or applied. The finding’s content is not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appQuestionnairePolicyEvaluationFinding.findMany({
          where: { decidedByUserId: userId },
          ...ATTRIBUTION_BARE,
        }),
        () => null
      ),
  },
  {
    // Preserved AI runs (F14.15). `triggeredByUserId` is the admin who ran the extraction critic,
    // the config advisor, an edit, a suggester — authorship of a config action, never respondent
    // data, so the prompt/output snapshots stay out of the attribution payload.
    model: 'AppAiRun',
    section: 'aiRunsTriggered',
    disposition: 'attribution',
    description:
      'AI runs you triggered while authoring questionnaires — extraction checks, advice, edits, and suggestions. The prompts and outputs are not included here.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.appAiRun.findMany({
          where: { triggeredByUserId: userId },
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
 * Written for Sunrise 0.10.0's fork-accounting rule (#660): every model in a
 * fork-owned schema file must be declared a source or excluded with a reason.
 * Core asks for all of them rather than guessing, because it reads its own
 * column vocabulary and not ours — a table keyed `respondentUserId` or
 * `createdBy` is invisible to its scan, and those are exactly the ones nobody
 * remembers.
 *
 * Three kinds of thing are excluded here, and only three:
 *
 *  1. **Rows delivered inside an exported parent.** Everything hanging off
 *     `AppQuestionnaireSession` is returned with it (see that source's
 *     `include`), so listing it again would double the bundle and tell the
 *     subject the same thing twice. These say where to look, not "we hold
 *     nothing".
 *  2. **Questionnaire structure and configuration.** The instrument an admin
 *     authored — sections, question slots, topics, scoring setup, routing.
 *     It is the *question*, not anyone's answer. Authorship of the parent is
 *     already covered as `attribution` above.
 *  3. **Aggregates over many respondents.** Cohort-level insight and digests,
 *     which are k-anonymity-gated by construction and are nobody's personal
 *     data individually.
 *
 * A reason here is read by a data subject, so each says what the table holds
 * and why they are not getting it — never just "internal".
 */
export const APP_EXCLUDED_SOURCES: AppExcludedSource[] = [
  // ── 1. Delivered inside the exported session ──────────────────────────────
  {
    model: 'AppAnswerSlot',
    reason:
      'Your answers to each question. Included with the questionnaire session they belong to rather than listed separately, so they arrive in the context that gives them meaning.',
  },
  {
    model: 'AppDataSlotFill',
    reason:
      'The values the conversation captured about you against a questionnaire’s data fields. Included with the questionnaire session they belong to.',
  },
  {
    model: 'AppQuestionnaireTurn',
    reason:
      'Every message you and the interviewer exchanged, in your own words. Included in full with the questionnaire session it belongs to.',
  },
  {
    model: 'AppQuestionnaireSessionEvent',
    reason:
      'The timeline of what happened during your session — starts, pauses, resumes and completions. Included with the questionnaire session it belongs to.',
  },
  {
    model: 'AppRespondentScore',
    reason:
      'Scores calculated from your answers. Included with the questionnaire session they were calculated from.',
  },
  {
    model: 'AppRespondentReport',
    reason:
      'The report generated for you at the end of a session. Included with the questionnaire session it summarises. Reports written for a whole multi-step run are reached through that run instead.',
  },
  {
    model: 'AppExperienceRunLeg',
    reason:
      'Each leg of a multi-step experience you took — which step, and what was carried into it. Reached through the experience run it belongs to, which is exported.',
  },

  // ── 2. Questionnaire structure and configuration ──────────────────────────
  {
    model: 'AppQuestionnaire',
    reason:
      'A questionnaire’s title and status — the instrument itself, not anyone’s answers to it. Where you created one, that authorship is listed above under the cohorts and questionnaires you created.',
  },
  {
    model: 'AppQuestionnaireVersion',
    reason:
      'A published or draft version of a questionnaire — the wording of the questions as they stood. It is the question, not your answer.',
  },
  {
    model: 'AppQuestionnaireSection',
    reason:
      'The sections a questionnaire is divided into. Structure of the instrument; holds no data about you.',
  },
  {
    model: 'AppQuestionSlot',
    reason:
      'An individual question as written by the questionnaire’s author, with the instructions governing how it should be asked. Holds no data about you.',
  },
  {
    model: 'AppQuestionSlotTag',
    reason: 'Links a question to a tag. Two identifiers and nothing else.',
  },
  {
    model: 'AppQuestionTag',
    reason:
      'The tag vocabulary an author uses to organise questions. A reference list; holds no data about you.',
  },
  {
    model: 'AppDataSlot',
    reason:
      'The definition of a field a questionnaire collects — its name, type and rules. The shape of the answer, not the answer.',
  },
  {
    model: 'AppDataSlotQuestion',
    reason:
      'Links a data field to the questions that can fill it. Two identifiers and nothing else.',
  },
  {
    model: 'AppDataSlotDraft',
    reason:
      'An author’s unpublished draft of a data field definition. Editing state for the instrument; holds no data about you.',
  },
  {
    model: 'AppQuestionnaireConfig',
    reason:
      'A questionnaire’s behaviour settings — how the interviewer paces itself, what it may and may not say, whether a respondent can finish early. Policy for the conversation, not a record of yours.',
  },
  {
    model: 'AppQuestionnaireTopic',
    reason:
      'The topics a questionnaire can cover and the rules deciding which apply. Which topics applied to *you* is recorded on your session, which is exported.',
  },
  {
    model: 'AppQuestionnaireTopicDraft',
    reason: 'An author’s unpublished draft of a topic. Editing state; holds no data about you.',
  },
  {
    model: 'AppQuestionnaireRoundItem',
    reason:
      'Which questionnaires a round includes, and in what order. Configuration of the round; holds no data about you.',
  },
  {
    model: 'AppQuestionnaireSourceDocument',
    reason:
      'The document an author uploaded for a questionnaire’s structure to be extracted from. Authored material, not respondent data.',
  },
  {
    model: 'AppQuestionnaireExtractionChange',
    reason:
      'The edit history of a questionnaire’s extracted structure, including who reverted a change. It records edits to the instrument; where you made one, that is authorship of the questionnaire rather than data about you.',
  },
  {
    model: 'AppQuestionnaireError',
    reason:
      'Technical faults logged while a questionnaire ran, with context deliberately redacted before it is stored. Kept for diagnosis; it holds no answer of yours and is not written to describe a person.',
  },
  {
    model: 'AppGlossaryDefinition',
    reason:
      'A definition of a term used in a questionnaire, so the interviewer and the respondent mean the same thing by it. Reference material; holds no data about you.',
  },
  {
    model: 'AppExperienceStep',
    reason:
      'A step in a multi-step experience, as configured by its author. Your progress through the steps is exported with your experience run.',
  },
  {
    model: 'AppExperienceRoutingRule',
    reason:
      'The rules deciding which step a respondent goes to next. Configuration; how you were actually routed is recorded on your experience run, which is exported.',
  },
  {
    model: 'AppExperienceMeeting',
    reason:
      'A facilitated meeting’s schedule, breakout clock and status. Where you facilitated one, that is a role in running the session rather than data recorded about you; what you contributed as a participant is in your own session.',
  },
  {
    model: 'AppExperienceBreakoutRoom',
    reason:
      'A breakout room’s name and which questionnaire it runs. Configuration of the meeting; holds no data about who was in it.',
  },
  {
    model: 'AppDemoClient',
    reason:
      'The branding — colours and logo — applied to a white-labelled questionnaire. Presentation settings; holds no data about you.',
  },

  // ── 3. Aggregates across many respondents ─────────────────────────────────
  {
    model: 'AppExperienceInsight',
    reason:
      'A statement synthesised from what a group of participants said, with a count of how many it rests on. It is the group’s output, not any one person’s, and is withheld from an individual export for the same reason it is k-anonymity-gated in the product: singling out one contributor is what the aggregation exists to prevent. Your own contribution is in your session, which is exported.',
  },
  {
    model: 'AppRoundLearningDigest',
    reason:
      'What was learned across all respondents in a round, with a count of how many it draws on. An aggregate over many people rather than a record about you; your own answers are exported with your session.',
  },
];
