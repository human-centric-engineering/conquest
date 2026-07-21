import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';

import QuestionnaireInvitationEmail from '@/emails/questionnaire-invitation';
import { resolveTheme, CONQUEST_THEME_DEFAULTS } from '@/lib/app/questionnaire/theming';

/**
 * Render tests for the F3.4 themed invitation email. The key contract: with no theme
 * (or null fields) it renders the Sunrise defaults exactly as pre-F3.4; with a brand
 * it renders that brand's CTA colour, logo, and welcome copy.
 */

const baseProps = {
  inviteeName: 'Bob Jones',
  questionnaireTitle: 'Customer Satisfaction',
  invitationUrl: 'https://example.com/questionnaire-invite?token=abc123',
  expiresAt: new Date('2026-12-31T23:59:59Z'),
};

describe('QuestionnaireInvitationEmail — unthemed (Sunrise default)', () => {
  it('renders the recipient, title, and link', async () => {
    const html = await render(<QuestionnaireInvitationEmail {...baseProps} />);
    expect(html).toContain('Bob Jones');
    expect(html).toContain('Customer Satisfaction');
    expect(html).toContain('https://example.com/questionnaire-invite?token=abc123');
  });

  it('falls back to the Sunrise CTA colour and default welcome copy when no theme is passed', async () => {
    const html = await render(<QuestionnaireInvitationEmail {...baseProps} />);
    expect(html).toContain(CONQUEST_THEME_DEFAULTS.ctaColor);
    // The default tagline appears verbatim (HTML-escaped apostrophes).
    expect(html).toContain('answer in your own words');
  });

  it('renders no logo when the theme has none', async () => {
    const html = await render(
      <QuestionnaireInvitationEmail {...baseProps} theme={resolveTheme(null)} />
    );
    // Greeting/CTA present, but no <img> tag (no logo configured).
    expect(html).toContain('You&#x27;re invited');
    expect(html).not.toContain('<img');
  });

  it('greets "there" when no invitee name is given', async () => {
    const html = await render(<QuestionnaireInvitationEmail {...baseProps} inviteeName={null} />);
    // The renderer injects HTML comments between text nodes ("Hi <!-- -->there<!-- -->,").
    expect(html).toMatch(/Hi (<!-- -->)?there/);
  });
});

describe('QuestionnaireInvitationEmail — themed', () => {
  const themed = resolveTheme({
    ctaColor: '#ff0000',
    accentColor: '#00ff00',
    logoUrl: 'https://acme.example/logo.png',
    welcomeCopy: 'Welcome to the Acme demo — this will only take a minute.',
  });

  it('renders the brand CTA colour on the button', async () => {
    const html = await render(<QuestionnaireInvitationEmail {...baseProps} theme={themed} />);
    expect(html).toContain('#ff0000');
  });

  it('renders the brand accent colour on the fallback link', async () => {
    const html = await render(<QuestionnaireInvitationEmail {...baseProps} theme={themed} />);
    // accentColor colours the "copy and paste this link" anchor — guards against a
    // field-swap (e.g. ctaColor wired to the link instead).
    expect(html).toContain('#00ff00');
  });

  it('renders the logo image when a logoUrl is set', async () => {
    const html = await render(<QuestionnaireInvitationEmail {...baseProps} theme={themed} />);
    expect(html).toContain('<img');
    expect(html).toContain('https://acme.example/logo.png');
  });

  it('renders the brand welcome copy in place of the default tagline', async () => {
    const html = await render(<QuestionnaireInvitationEmail {...baseProps} theme={themed} />);
    expect(html).toContain('Welcome to the Acme demo');
    expect(html).not.toContain('answer in your own words');
  });

  it('renders without throwing', async () => {
    // render() is async — assert the resolved Promise so an async SSR rejection is
    // actually observed (a sync `.not.toThrow()` wrapper would pass regardless).
    await expect(
      render(<QuestionnaireInvitationEmail {...baseProps} theme={themed} />)
    ).resolves.toBeTruthy();
  });
});
