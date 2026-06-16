/**
 * PreviewRespondentButton Component Tests
 *
 * A plain Next.js `<Link>`-based button rendered in the admin workspace header
 * that opens the respondent preview surface in a new tab. It takes a `versionId`
 * prop and an optional `className`. No client JS is required — it is a pure
 * rendering component.
 *
 * Test coverage:
 * - Renders the button with its visible "Preview" label
 * - Renders the Eye icon (aria-hidden)
 * - Builds the correct preview href: `/q/{versionId}?preview=1`
 * - Opens in a new tab (`target="_blank"`)
 * - Sets `rel="noopener noreferrer"` for security
 * - Renders the accessible title attribute describing the action
 * - Applies an additional `className` when supplied
 * - Applies the base `shrink-0` class regardless of extra className
 *
 * `next/link` is mocked to a plain `<a>` tag so prop assertions work without
 * the real Next.js router infrastructure.
 *
 * @see components/admin/questionnaires/workspace/preview-respondent-button.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── next/link mock ──────────────────────────────────────────────────────────
// Render as a plain <a> so we can assert href/target/rel without Next.js infra.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ─── Imports (after mock declarations) ───────────────────────────────────────
import { PreviewRespondentButton } from '@/components/admin/questionnaires/workspace/preview-respondent-button';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VERSION_ID = 'ver-abc-123';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PreviewRespondentButton', () => {
  describe('label and icon', () => {
    it('renders the "Preview" label', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} />);
      // The component must show "Preview" text — it's the call-to-action
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });

    it('renders an Eye icon that is hidden from assistive technology', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} />);
      // The lucide Eye SVG is decorative; it must be aria-hidden so screen readers
      // don't announce redundant icon names alongside the "Preview" text
      const svg = document.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('link href construction', () => {
    it('builds the preview URL using the supplied versionId', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} />);
      // The component encodes versionId into the path and appends ?preview=1 so the
      // respondent surface can distinguish analytics-excluded preview runs
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', `/q/${VERSION_ID}?preview=1`);
    });

    it('uses the versionId in the path segment, not as a query param', () => {
      const VID = 'ver-xyz-789';
      render(<PreviewRespondentButton versionId={VID} />);
      const link = screen.getByRole('link');
      // Path must start with /q/{versionId} — the version must be the path segment
      expect(link.getAttribute('href')).toMatch(`/q/${VID}`);
    });

    it('always includes the ?preview=1 flag regardless of versionId', () => {
      render(<PreviewRespondentButton versionId="ver-any" />);
      const link = screen.getByRole('link');
      expect(link.getAttribute('href')).toContain('?preview=1');
    });
  });

  describe('new-tab and security attributes', () => {
    it('opens in a new tab via target="_blank"', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} />);
      // Admin should not lose the workspace context when previewing — new tab is required
      expect(screen.getByRole('link')).toHaveAttribute('target', '_blank');
    });

    it('sets rel="noopener noreferrer" for opener isolation', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} />);
      // Opening a new tab without noopener gives the target page a reference back to the
      // opener (window.opener) — a security risk that must be mitigated
      expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('accessible title attribute', () => {
    it('renders a descriptive title explaining the preview action', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} />);
      // The title is visible on hover and read by some AT as a tooltip
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute(
        'title',
        'Walk through the questionnaire as a respondent (opens in a new tab; not recorded in analytics)'
      );
    });
  });

  describe('className handling', () => {
    it('applies the base shrink-0 class without extra className', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} />);
      // The Button wrapper must always apply shrink-0 so the header layout stays stable
      // in flex containers — the underlying element is the <a> tag
      const link = screen.getByRole('link');
      expect(link.className).toContain('shrink-0');
    });

    it('merges an additional className alongside the base class', () => {
      render(<PreviewRespondentButton versionId={VERSION_ID} className="ml-2" />);
      // When a caller passes className, it must be merged in (cn merges classes)
      const link = screen.getByRole('link');
      expect(link.className).toContain('shrink-0');
      expect(link.className).toContain('ml-2');
    });
  });
});
