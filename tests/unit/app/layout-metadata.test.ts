/**
 * Unit Tests: metadata does not leak the starter identity (#519)
 *
 * The root layout used to hardcode `"${BRAND.name} - Next.js Starter"` and a
 * description advertising "a production-ready Next.js starter template".
 *
 * **The first version of this test asserted only on the root `metadata` object,
 * and that was not good enough.** Next resolves metadata at the *nearest*
 * segment that defines a field, and all four route groups declare their own
 * `description` — so fixing the root reached almost nothing, while
 * `app/(public)/layout.tsx` went on hardcoding the exact blurb the fix was
 * about. A green suite said otherwise. Caught by `/code-review`, not by here.
 *
 * So this scans the metadata a fork actually ships, across every layout and
 * page. A hand-listed set of files would have the same blind spot the first
 * version had: it can only see what someone thought to list.
 *
 * @see app/layout.tsx · lib/brand.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join } from 'node:path';
import { metadata } from '@/app/layout';

const REPO_ROOT = process.cwd();

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

/** Every `export const metadata = { … }` block under `app/`, with its file. */
function metadataBlocks(): Array<{ file: string; block: string }> {
  const out: Array<{ file: string; block: string }> = [];
  for (const file of globSync('app/**/*.tsx', { cwd: REPO_ROOT })) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const match of src.matchAll(/export const metadata[^;]*?;/gs)) {
      out.push({ file, block: match[0] });
    }
  }
  return out;
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

describe('no metadata block under app/ leaks the starter identity', () => {
  it('finds metadata blocks to check (guards against a vacuous pass)', () => {
    // Without this floor a broken glob turns every assertion below into
    // `[].filter(…)` and the suite reports success having checked nothing.
    expect(metadataBlocks().length).toBeGreaterThanOrEqual(5);
  });

  it('no block hardcodes the product name instead of BRAND.name', () => {
    const offenders = metadataBlocks()
      .filter(({ block }) => /['"`][^'"`]*\bSunrise\b/.test(block))
      .map(({ file }) => file);

    expect(
      offenders,
      'Metadata is what a fork ships to search results and social cards without ever ' +
        'seeing it, so it must come from `${BRAND.name}` rather than a literal. Page ' +
        '*body copy* is fork-owned and deliberately out of scope — see lib/brand.ts, ' +
        '"Scope: the brand name only".'
    ).toEqual([]);
  });

  it('no block advertises the starter template', () => {
    const offenders = metadataBlocks()
      .filter(({ block }) => /starter template/i.test(block))
      .map(({ file }) => file);

    expect(
      offenders,
      'A route group declaring `description` overrides the root outright, so this ' +
        'cannot be fixed from app/layout.tsx alone — which is exactly how #519 first ' +
        'shipped as a no-op.'
    ).toEqual([]);
  });
});
