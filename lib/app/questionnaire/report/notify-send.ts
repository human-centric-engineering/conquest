/**
 * Respondent report-ready email — the send seam the worker calls on status→ready.
 *
 * Resolves the session's questionnaire title + attributed demo-client theme, builds an absolute URL
 * back to the respondent completion/report surface (`/q/<versionId>`), and sends the themed
 * report-ready email. Best-effort by contract: the worker treats a failure as non-fatal (the report
 * is already generated), so this returns a result rather than throwing.
 *
 * Theme resolution is done locally (a demo-client column read + `resolveTheme`) to keep this in the
 * `lib` layer rather than importing the invitation send helper from `app/api`.
 */

import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { sendEmail, type SendEmailResult } from '@/lib/email/send';
import { resolveTheme } from '@/lib/app/questionnaire/theming';
import { respondentPublicPath } from '@/lib/app/questionnaire/respondent-url';
import RespondentReportReadyEmail from '@/emails/respondent-report-ready';

/**
 * Send the "your report is ready" email for a completed session to `email`. Returns a disabled/failed
 * result (never throws) so the worker's terminal write is unaffected.
 */
export async function sendRespondentReportReadyEmail(
  sessionId: string,
  email: string
): Promise<SendEmailResult> {
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

  const questionnaireTitle = session?.version?.questionnaire?.title ?? 'your questionnaire';
  const theme = resolveTheme(session?.version?.questionnaire?.demoClient ?? null);
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  const reportUrl = session?.versionId ? `${base}${respondentPublicPath(session.versionId)}` : base;

  return sendEmail({
    to: email,
    subject: `Your personalised report for ${questionnaireTitle} is ready`,
    react: RespondentReportReadyEmail({ questionnaireTitle, reportUrl, theme }),
  });
}
