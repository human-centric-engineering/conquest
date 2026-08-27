import { describe, it, expect } from 'vitest';

import {
  themeFieldsSchema,
  HEX_COLOR_PATTERN,
  WELCOME_COPY_MAX,
} from '@/lib/app/questionnaire/theming';

describe('HEX_COLOR_PATTERN', () => {
  it('accepts #rgb and #rrggbb (case-insensitive)', () => {
    for (const hex of ['#fff', '#5469d4', '#ABCDEF', '#0a0']) {
      expect(HEX_COLOR_PATTERN.test(hex)).toBe(true);
    }
  });

  it('rejects non-hex shapes', () => {
    for (const bad of ['5469d4', '#12', '#1234', 'rgb(0,0,0)', '#ggg']) {
      expect(HEX_COLOR_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('themeFieldsSchema — colours', () => {
  it('coerces empty / whitespace colour fields to null', () => {
    const parsed = themeFieldsSchema.parse({ ctaColor: '   ', accentColor: '' });
    expect(parsed.ctaColor).toBeNull();
    expect(parsed.accentColor).toBeNull();
  });

  it('keeps a valid hex colour and rejects an invalid one', () => {
    expect(themeFieldsSchema.parse({ ctaColor: '#5469d4' }).ctaColor).toBe('#5469d4');
    expect(themeFieldsSchema.safeParse({ ctaColor: 'red' }).success).toBe(false);
  });
});

describe('themeFieldsSchema — logoUrl', () => {
  it('accepts an absolute https URL', () => {
    const parsed = themeFieldsSchema.parse({ logoUrl: 'https://acme.example/logo.png' });
    expect(parsed.logoUrl).toBe('https://acme.example/logo.png');
  });

  it('coerces empty to null', () => {
    expect(themeFieldsSchema.parse({ logoUrl: '  ' }).logoUrl).toBeNull();
  });

  it('rejects http and non-URL values (logos must be https)', () => {
    expect(themeFieldsSchema.safeParse({ logoUrl: 'http://acme.example/logo.png' }).success).toBe(
      false
    );
    expect(themeFieldsSchema.safeParse({ logoUrl: 'not-a-url' }).success).toBe(false);
  });
});

describe('themeFieldsSchema — welcomeCopy', () => {
  it('trims and keeps a non-empty line, coerces empty to null', () => {
    expect(themeFieldsSchema.parse({ welcomeCopy: '  hello  ' }).welcomeCopy).toBe('hello');
    expect(themeFieldsSchema.parse({ welcomeCopy: '   ' }).welcomeCopy).toBeNull();
  });

  it(`rejects copy longer than ${WELCOME_COPY_MAX} characters`, () => {
    expect(
      themeFieldsSchema.safeParse({ welcomeCopy: 'x'.repeat(WELCOME_COPY_MAX + 1) }).success
    ).toBe(false);
  });
});

describe('themeFieldsSchema — all fields optional', () => {
  it('accepts an empty object (every field omitted)', () => {
    const parsed = themeFieldsSchema.parse({});
    expect(parsed).toEqual({});
  });
});

describe('themeFieldsSchema — the brand-kit fields', () => {
  it.each(['canvasColor', 'inkColor', 'canvasColorDark', 'inkColorDark', 'accentColorEnd'])(
    '%s validates as a hex colour',
    (field) => {
      expect(themeFieldsSchema.parse({ [field]: '#0b1f3a' })[field as 'canvasColor']).toBe(
        '#0b1f3a'
      );
      expect(themeFieldsSchema.parse({ [field]: '  ' })[field as 'canvasColor']).toBeNull();
      expect(themeFieldsSchema.safeParse({ [field]: 'navy' }).success).toBe(false);
    }
  );

  it.each(['logoMarkUrl', 'logoDarkUrl'])('%s takes an https URL or an upload path', (field) => {
    expect(themeFieldsSchema.safeParse({ [field]: 'https://acme.example/m.png' }).success).toBe(
      true
    );
    expect(
      themeFieldsSchema.safeParse({ [field]: '/uploads/demo-clients/x/mark.png' }).success
    ).toBe(true);
    expect(themeFieldsSchema.safeParse({ [field]: 'http://acme.example/m.png' }).success).toBe(
      false
    );
  });

  it('accepts the three known font pairings and clears an empty one to null', () => {
    for (const pairing of ['neutral', 'editorial', 'contemporary']) {
      expect(themeFieldsSchema.parse({ fontPairing: pairing }).fontPairing).toBe(pairing);
    }
    expect(themeFieldsSchema.parse({ fontPairing: '' }).fontPairing).toBeNull();
  });

  it('REJECTS an unknown pairing, unlike the read path which resolves it to neutral', () => {
    // Strict on write, forgiving on read, deliberately: a typo from an admin should be told,
    // while a value already sitting in the column (a rollback, a seed) must still render.
    expect(themeFieldsSchema.safeParse({ fontPairing: 'gothic' }).success).toBe(false);
    expect(themeFieldsSchema.safeParse({ fontPairing: 'Editorial' }).success).toBe(false);
  });
});
