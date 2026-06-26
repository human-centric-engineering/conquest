/**
 * BrandMark slot (issue #347) — ConQuest override.
 *
 * Sunrise ships the scaffold rendering `BRAND.name` as a bare string. ConQuest
 * replaces the body with its styled two-tone wordmark ({@link ConquestWordmark}),
 * so these assertions track the fork's override, not the platform default. The
 * brand seam (`NEXT_PUBLIC_APP_NAME` → `BRAND.name`) still drives page titles,
 * footer copyright, and emails — the wordmark is the header/footer lockup only.
 *
 * @see components/brand/brand-mark.tsx · components/app/questionnaire/conquest-wordmark.tsx
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

import { BrandMark } from '@/components/brand/brand-mark';

describe('BrandMark (ConQuest wordmark override)', () => {
  it('renders the ConQuest wordmark lockup text', () => {
    const { container } = render(React.createElement(BrandMark));
    expect(container.textContent).toBe('ConQuest');
  });

  it('exposes an accessible "ConQuest" label on the lockup', () => {
    const { container } = render(React.createElement(BrandMark));
    expect(container.querySelector('[aria-label="ConQuest"]')).not.toBeNull();
  });
});
