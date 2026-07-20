/**
 * Respondent report-ready email send seam — unit tests.
 *
 * @see lib/app/questionnaire/report/notify-send.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appExperienceRun: { findUnique: vi.fn() },
  },
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

    const result = await sendRespondentReportReadyEmail({ sessionId: 'sess-1' }, 'you@example.com');

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

    await sendRespondentReportReadyEmail({ sessionId: 'gone' }, 'you@example.com');

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

    await sendRespondentReportReadyEmail({ sessionId: 'sess-9' }, 'you@example.com');

    // notify-send always passes a resolved theme (the prop is optional only for the default render).
    const theme = emailMock.default.mock.calls[0][0].theme!;
    expect(theme.ctaColor).toBe('#ff0000');
    expect(theme.accentColor).toBe('#00ff00');
    // logoUrl null in → resolveTheme yields no logo (guards against a field-swap in resolution).
    expect(theme.logoUrl).toBeFalsy();
  });
});

describe('sendRespondentReportReadyEmail — run subject (F15.4b)', () => {
  /** A run whose entry leg is `sess-entry`, plus a later leg that must NOT be consulted. */
  function twoLegRun(publicRef: string | null) {
    return { publicRef, legs: [{ sessionId: 'sess-entry' }] };
  }

  beforeEach(() => {
    (prisma.appExperienceRun.findUnique as Mock).mockResolvedValue(twoLegRun('AB12CD'));
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      versionId: 'v-entry',
      version: {
        questionnaire: {
          title: 'Onboarding',
          demoClient: { ctaColor: '#123456', accentColor: '#654321', logoUrl: null },
        },
      },
    });
  });

  it('sends for a run — the scope that previously discarded the address entirely', async () => {
    const result = await sendRespondentReportReadyEmail({ runId: 'run-1' }, 'you@example.com');

    expect(result).toEqual({ success: true, status: 'sent', id: 'e1' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail as Mock).mock.calls[0][0].to).toBe('you@example.com');
  });

  it('points the run email at the journey address, not one leg’s questionnaire', async () => {
    await sendRespondentReportReadyEmail({ runId: 'run-1' }, 'you@example.com');

    // `/x/<publicRef>` survives the run moving between legs; `/q/v-entry` would strand the
    // respondent on whichever leg happened to be first.
    expect(emailMock.default.mock.calls[0][0].reportUrl).toBe('https://app.example.com/x/AB12CD');
  });

  it('takes title + branding from the ENTRY leg', async () => {
    await sendRespondentReportReadyEmail({ runId: 'run-1' }, 'you@example.com');

    expect(prisma.appQuestionnaireSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-entry' } })
    );
    const props = emailMock.default.mock.calls[0][0];
    expect(props.questionnaireTitle).toBe('Onboarding');
    expect((sendEmail as Mock).mock.calls[0][0].subject).toBe(
      'Your personalised report for Onboarding is ready'
    );
    expect(props.theme!.ctaColor).toBe('#123456');
  });

  it('falls back to the entry leg’s own surface when the run has no public ref', async () => {
    (prisma.appExperienceRun.findUnique as Mock).mockResolvedValue(twoLegRun(null));

    await sendRespondentReportReadyEmail({ runId: 'run-1' }, 'you@example.com');

    // A real surface the respondent recognises beats dumping them on the home page.
    expect(emailMock.default.mock.calls[0][0].reportUrl).toBe('https://app.example.com/q/v-entry');
  });

  it('still sends a generic email when the run is gone, rather than throwing at the worker', async () => {
    (prisma.appExperienceRun.findUnique as Mock).mockResolvedValue(null);

    await sendRespondentReportReadyEmail({ runId: 'gone' }, 'you@example.com');

    // The session read is skipped entirely — there is no entry leg to read from.
    expect(prisma.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
    const arg = (sendEmail as Mock).mock.calls[0][0];
    expect(arg.subject).toBe('Your personalised report for your questionnaire is ready');
    expect(emailMock.default.mock.calls[0][0].reportUrl).toBe('https://app.example.com');
  });
});
