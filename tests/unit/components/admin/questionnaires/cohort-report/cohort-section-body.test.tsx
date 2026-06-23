/**
 * CohortSectionBody tests (F14.5).
 *
 * Asserts an HTML body renders its rich markup and a markdown body falls back to the markdown
 * renderer. (dompurify only sanitises against a live DOM at runtime — it is a passthrough under the
 * test's happy-dom — so the tag-stripping itself is dompurify's own well-tested behaviour, exercised
 * in the browser; here we verify the component routes HTML vs markdown correctly.)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CohortSectionBody } from '@/components/admin/questionnaires/cohort-report/cohort-section-body';

describe('CohortSectionBody', () => {
  it('renders an HTML body as rich markup', () => {
    const { container } = render(
      <CohortSectionBody body={'<p>Safe <strong>bold</strong></p>'} format="html" />
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('falls back to the markdown renderer for a markdown body', () => {
    render(<CohortSectionBody body={'Plain **markdown** body'} format="markdown" />);
    expect(screen.getByText(/markdown/)).toBeInTheDocument();
  });
});
