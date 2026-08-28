// @vitest-environment happy-dom

/**
 * The footer a respondent sees, and the three things it must not become.
 *
 * `full` chrome used to close with the platform's `PublicFooter`, which is a marketing footer: it
 * restates the header's nav, adds the legal cluster, and (since Sunrise 0.11.1) an attribution
 * line. On a questionnaire each of those is a defect rather than a preference — the nav is printed
 * twice on the same screen, every one of its links leads away mid-answer, and the attribution is a
 * claim about our site made to someone answering a client's questions.
 *
 * So the assertions are the complaint, inverted: the header's links are ABSENT, the attribution is
 * ABSENT, and Cookie Preferences is present — because a frame that opts out of `PublicFooter`
 * inherits the consent obligation rather than permission to drop it (CUSTOMIZATION.md §4). That
 * last one is the assertion that must not rot: it is a legal requirement in several jurisdictions,
 * and it is the reason this file exists rather than a snapshot.
 *
 * @see components/app/questionnaire/chrome/respondent-footer.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openPreferences = vi.fn();

vi.mock('@/lib/consent', () => ({
  useConsent: () => ({ openPreferences }),
}));

import { RespondentFooter } from '@/components/app/questionnaire/chrome/respondent-footer';

describe('RespondentFooter', () => {
  it('carries the legal cluster', () => {
    render(<RespondentFooter />);
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy'
    );
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '/terms'
    );
  });

  it('renders Cookie Preferences and opens the consent panel', async () => {
    render(<RespondentFooter />);
    await userEvent.click(screen.getByRole('button', { name: /cookie preferences/i }));
    expect(openPreferences).toHaveBeenCalledTimes(1);
  });

  it('does NOT restate the header nav — that was the whole complaint', () => {
    // `full` chrome renders `PublicNav` above this with exactly these links. Printing them again at
    // the foot of a conversation is duplication the respondent reads past, and three more ways to
    // leave half-way through answering.
    render(<RespondentFooter />);
    for (const label of ['Home', 'Capabilities', 'Pricing', 'Contact']) {
      expect(screen.queryByRole('link', { name: label })).toBeNull();
    }
  });

  it('carries no attribution line', () => {
    // Not "no © this year" — no attribution row at all. A respondent is not reading our marketing
    // site, and a second footer line is pure vertical cost on a fixed-height reading surface.
    const { container } = render(<RespondentFooter />);
    expect(container.textContent).not.toMatch(/©|All rights reserved/i);
  });

  it('is one line: every child sits in a single nav', () => {
    // The height is the point. If a future edit adds a second row it will show up here before it
    // shows up as a squeezed conversation.
    const { container } = render(<RespondentFooter />);
    const footer = container.querySelector('footer');
    expect(footer?.children).toHaveLength(1);
    expect(footer?.firstElementChild?.tagName).toBe('NAV');
  });
});
