import { describe, it, expect } from 'vitest';

import {
  DEMO_CLIENT_SLUG_MAX_LENGTH,
  DEMO_CLIENT_SLUG_PATTERN,
  slugifyDemoClient,
} from '@/lib/app/questionnaire/demo-clients/slug';

describe('slugifyDemoClient', () => {
  it('kebab-cases a normal name', () => {
    expect(slugifyDemoClient('Acme Bank Demo')).toBe('acme-bank-demo');
  });

  it('strips accents via NFKD', () => {
    expect(slugifyDemoClient('Café Société')).toBe('cafe-societe');
  });

  it('collapses any run of non-alphanumerics to a single hyphen', () => {
    expect(slugifyDemoClient('Acme   &   Co. (2026)!!')).toBe('acme-co-2026');
  });

  it('trims leading and trailing separators', () => {
    expect(slugifyDemoClient('  --Acme--  ')).toBe('acme');
  });

  it('falls back when nothing slug-able remains', () => {
    expect(slugifyDemoClient('—  !!! —')).toBe('demo-client');
  });

  it('truncates to the max length without leaving a trailing hyphen', () => {
    const long = 'a'.repeat(80);
    const slug = slugifyDemoClient(long);
    expect(slug.length).toBeLessThanOrEqual(DEMO_CLIENT_SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('produces output that satisfies the validation pattern', () => {
    for (const name of ['Acme Bank', 'Café Société', 'Acme & Co. (2026)']) {
      expect(DEMO_CLIENT_SLUG_PATTERN.test(slugifyDemoClient(name))).toBe(true);
    }
  });
});

describe('DEMO_CLIENT_SLUG_PATTERN', () => {
  it('accepts valid kebab-case slugs', () => {
    for (const slug of ['acme', 'acme-bank', 'a1-b2-c3', 'x']) {
      expect(DEMO_CLIENT_SLUG_PATTERN.test(slug)).toBe(true);
    }
  });

  it('rejects uppercase, leading/trailing/double hyphens, and spaces', () => {
    for (const slug of ['Acme', 'acme-', '-acme', 'acme--bank', 'acme bank', 'acme_bank', '']) {
      expect(DEMO_CLIENT_SLUG_PATTERN.test(slug)).toBe(false);
    }
  });
});
