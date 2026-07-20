/**
 * Respondent report-ready email — the send seam the worker calls on status→ready.
 *
 * Resolves the report's questionnaire title + attributed demo-client theme, builds an absolute URL
 * back to the respondent completion/report surface, and sends the themed report-ready email.
 * Best-effort by contract: the worker treats a failure as non-fatal (the report is already
 * generated), so this returns a result rather than throwing.
 *
 * ## Two subjects, one resolution
 *
 * A report is about a SESSION or about a RUN (F15.4b) — the owner is polymorphic, and a run-scope
 * row has no `sessionId` at all. Both share this sender rather than growing a second one, because
 * they share everything that matters: a run's branding and title come from its ENTRY leg, the same
 * leg whose config decided the report's settings (see `run-report.ts`) and the same leg
 * `run-view.ts` builds the on-screen chrome from. Only the destination differs — a session points
 * at `/q/<versionId>`, a run at its stable `/x/<publicRef>` journey address.
 *
 * Theme resolution is done locally (a demo-client column read + `resolveTheme`) to keep this in the
 * `lib` layer rather than importing the invitation send helper from `app/api`.
 */

import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { sendEmail, type SendEmailResult } from '@/lib/email/send';
import { resolveTheme } from '@/lib/app/questionnaire/theming';
import {
  experienceRunPublicPath,
  respondentPublicPath,
} from '@/lib/app/questionnaire/respondent-url';
import RespondentReportReadyEmail from '@/emails/respondent-report-ready';

/**
 * What a report-ready email is ABOUT. Exactly one arm, mirroring the polymorphic owner on
 * `AppRespondentReport` — a session-scope row carries a `sessionId`, a run-scope row a `runId`.
 */
export type ReportReadySubject = { sessionId: string } | { runId: string };

/** The presentation material an email needs, however the subject was addressed. */
interface ReportEmailContext {
  questionnaireTitle: string;
  theme: ReturnType<typeof resolveTheme>;
  /** Path back to the respondent surface, or null when there is nothing better than the base URL. */
  path: string | null;
}

/** Resolve title + branding + destination from a single session. */
async function sessionContext(sessionId: string): Promise<ReportEmailContext> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      versionId: true,
      version: {
        select: {
          questionnaire: {
            select: {
              title: true,
              demoClient: {
                select: {
                  ctaColor: true,
                  accentColor: true,
                  logoUrl: true,
                  welcomeCopy: true,
                  surfaceColor: true,
                  ctaColorEnd: true,
                  logoBackgroundColor: true,
                  logoBackgroundEnabled: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return {
    questionnaireTitle: session?.version?.questionnaire?.title ?? 'your questionnaire',
    theme: resolveTheme(session?.version?.questionnaire?.demoClient ?? null),
    path: session?.versionId ? respondentPublicPath(session.versionId) : null,
  };
}

/**
 * Resolve title + branding from the run's ENTRY leg, and the destination from the run itself.
 *
 * A run has no session of its own, so the chrome has to come from a leg, and the entry leg is the
 * only leg every run has — anchoring on the last would mean two respondents on one experience
 * receiving differently-branded emails purely because the selector routed them differently.
 */
async function runContext(runId: string): Promise<ReportEmailContext> {
  const run = await prisma.appExperienceRun.findUnique({
    where: { id: runId },
    select: {
      publicRef: true,
      legs: { orderBy: { ordinal: 'asc' }, take: 1, select: { sessionId: true } },
    },
  });

  const entrySessionId = run?.legs[0]?.sessionId;
  const base = entrySessionId
    ? await sessionContext(entrySessionId)
    : { questionnaireTitle: 'your questionnaire', theme: resolveTheme(null), path: null };

  // `/x/<publicRef>` addresses the whole journey and survives the run moving between legs. Falling
  // back to the entry leg's own `/q/<versionId>` is deliberate for the (unminted-ref) edge: a real
  // surface the respondent recognises beats dumping them on the marketing home page.
  return { ...base, path: run?.publicRef ? experienceRunPublicPath(run.publicRef) : base.path };
}

/**
 * Send the "your report is ready" email for a completed session or run to `email`. Returns a
 * disabled/failed result (never throws) so the worker's terminal write is unaffected.
 */
export async function sendRespondentReportReadyEmail(
  subject: ReportReadySubject,
  email: string
): Promise<SendEmailResult> {
  const { questionnaireTitle, theme, path } =
    'runId' in subject ? await runContext(subject.runId) : await sessionContext(subject.sessionId);

  const origin = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  const reportUrl = path ? `${origin}${path}` : origin;

  return sendEmail({
    to: email,
    subject: `Your personalised report for ${questionnaireTitle} is ready`,
    react: RespondentReportReadyEmail({ questionnaireTitle, reportUrl, theme }),
  });
}
