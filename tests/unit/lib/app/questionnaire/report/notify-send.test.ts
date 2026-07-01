/**
 * Respondent report-ready email send seam — unit tests.
 *
 * @see lib/app/questionnaire/report/notify-send.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
// Mock the email component so we can read the props notify-send passes to it (calling the real
// component returns a rendered <Html> tree, hiding the input props).
import type { RespondentReportReadyEmailProps } from '@/emails/respondent-report-ready';
const emailMock = vi.hoisted(() => ({
  default: vi.fn((_props: RespondentReportReadyEmailProps) => null),
}));
vi.mock('@/emails/respondent-report-ready', () => emailMock);

import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { sendRespondentReportReadyEmail } from '@/lib/app/questionnaire/report/notify-send';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  (sendEmail as Mock).mockResolvedValue({ success: true, status: 'sent', id: 'e1' });
});

describe('sendRespondentReportReadyEmail', () => {
  it('resolves the title + report URL from the session and sends to the given email', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      versionId: 'v-123',
      version: { questionnaire: { title: 'Wellbeing Check', demoClient: null } },
    });

    const result = await sendRespondentReportReadyEmail('sess-1', 'you@example.com');

    expect(result).toEqual({ success: true, status: 'sent', id: 'e1' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEmail as Mock).mock.calls[0][0];
    expect(arg.to).toBe('you@example.com');
    expect(arg.subject).toBe('Your personalised report for Wellbeing Check is ready');
    // The email component received the resolved title + report URL (base + /q/<versionId>).
    const emailProps = emailMock.default.mock.calls[0][0];
    expect(emailProps.reportUrl).toBe('https://app.example.com/q/v-123');
    expect(emailProps.questionnaireTitle).toBe('Wellbeing Check');
  });

  it('falls back to a generic title + base URL when the session is missing', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);

    await sendRespondentReportReadyEmail('gone', 'you@example.com');

    const arg = (sendEmail as Mock).mock.calls[0][0];
    expect(arg.subject).toBe('Your personalised report for your questionnaire is ready');
    expect(emailMock.default.mock.calls[0][0].reportUrl).toBe('https://app.example.com');
  });

  it('passes the demo-client theme through to the email', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      versionId: 'v-9',
      version: {
        questionnaire: {
          title: 'Branded',
          demoClient: { ctaColor: '#ff0000', accentColor: '#00ff00', logoUrl: null },
        },
      },
    });

    await sendRespondentReportReadyEmail('sess-9', 'you@example.com');

    // notify-send always passes a resolved theme (the prop is optional only for the default render).
    const theme = emailMock.default.mock.calls[0][0].theme!;
    expect(theme.ctaColor).toBe('#ff0000');
    expect(theme.accentColor).toBe('#00ff00');
    // logoUrl null in → resolveTheme yields no logo (guards against a field-swap in resolution).
    expect(theme.logoUrl).toBeFalsy();
  });
});
