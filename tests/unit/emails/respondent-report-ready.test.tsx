import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';

import RespondentReportReadyEmail from '@/emails/respondent-report-ready';
import { resolveTheme, CONQUEST_THEME_DEFAULTS } from '@/lib/app/questionnaire/theming';

/**
 * Render tests for the report-ready email. Contract: it shows the questionnaire title + a link back
 * to the report, defaults to the Sunrise theme when unthemed, and applies a brand's CTA/accent/logo
 * when themed (mirrors questionnaire-invitation.test.tsx).
 */

const baseProps = {
  questionnaireTitle: 'Customer Satisfaction',
  reportUrl: 'https://example.com/q/version-123',
};

describe('RespondentReportReadyEmail — unthemed (Sunrise default)', () => {
  it('renders the title and report link', async () => {
    const html = await render(<RespondentReportReadyEmail {...baseProps} />);
    expect(html).toContain('Customer Satisfaction');
    expect(html).toContain('https://example.com/q/version-123');
    expect(html).toContain('Your report is ready');
  });

  it('falls back to the Sunrise CTA colour and renders no logo when no theme is passed', async () => {
    const html = await render(<RespondentReportReadyEmail {...baseProps} />);
    expect(html).toContain(CONQUEST_THEME_DEFAULTS.ctaColor);
    expect(html).not.toContain('<img');
  });
});

describe('RespondentReportReadyEmail — themed', () => {
  const themed = resolveTheme({
    ctaColor: '#ff0000',
    accentColor: '#00ff00',
    logoUrl: 'https://acme.example/logo.png',
    welcomeCopy: 'Welcome to the Acme demo.',
  });

  it('renders the brand CTA colour on the button', async () => {
    const html = await render(<RespondentReportReadyEmail {...baseProps} theme={themed} />);
    expect(html).toContain('#ff0000');
  });

  it('renders the brand accent colour on the fallback link', async () => {
    const html = await render(<RespondentReportReadyEmail {...baseProps} theme={themed} />);
    expect(html).toContain('#00ff00');
  });

  it('renders the logo image when a logoUrl is set', async () => {
    const html = await render(<RespondentReportReadyEmail {...baseProps} theme={themed} />);
    expect(html).toContain('<img');
    expect(html).toContain('https://acme.example/logo.png');
  });

  it('renders without throwing', async () => {
    await expect(
      render(<RespondentReportReadyEmail {...baseProps} theme={themed} />)
    ).resolves.toBeTruthy();
  });
});
