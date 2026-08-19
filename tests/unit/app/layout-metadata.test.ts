/**
 * Unit Tests: Root layout metadata (#519)
 *
 * The root `metadata` used to hardcode `"${BRAND.name} - Next.js Starter"` and
 * a description advertising "a production-ready Next.js starter template". Both
 * shipped from every fork on any page that does not set its own title — the
 * account dashboard, admin pages, auth pages — and neither could be removed
 * without editing this platform-owned file, which is exactly what the BRAND
 * seam exists to avoid.
 *
 * These assert on the *shape and absence*, not on the literal strings a fork
 * would set, so they stay meaningful under any brand.
 *
 * @see app/layout.tsx
 * @see lib/brand.ts
 */

import { describe, it, expect } from 'vitest';
import { metadata } from '@/app/layout';

/** `title` is a `Metadata['title']`; narrow to the object form these tests need. */
function titleObject() {
  const title = metadata.title;
  if (title === null || typeof title !== 'object' || !('default' in title)) {
    throw new Error(
      `root metadata.title should be an object with a default, got: ${JSON.stringify(title)}`
    );
  }
  return title;
}

describe('root layout metadata', () => {
  it('does not advertise the starter template in the description', () => {
    expect(metadata.description).toBeDefined();
    expect(metadata.description).not.toMatch(/starter template/i);
    expect(metadata.description).not.toMatch(/Next\.js/i);
  });

  it('does not hardcode a "- Next.js Starter" suffix in the title', () => {
    const { default: fallback, template } = titleObject();
    expect(fallback).not.toMatch(/Next\.js/i);
    expect(template).not.toMatch(/Next\.js/i);
    expect(template).not.toMatch(/starter/i);
  });

  it('uses a title template so un-templated pages still get branded', () => {
    // The template is what gives the account/admin/auth pages consistent
    // branding without each declaring its own. A route group that declares
    // `title.template` still wins, so there is no double-branding.
    expect(titleObject().template).toContain('%s');
  });

  it('drives both title and description from the BRAND seam', async () => {
    const { BRAND } = await import('@/lib/brand');
    const { default: fallback, template } = titleObject();

    expect(fallback).toBe(BRAND.name);
    expect(template).toContain(BRAND.name);
    expect(metadata.description).toBe(BRAND.description);
  });
});
