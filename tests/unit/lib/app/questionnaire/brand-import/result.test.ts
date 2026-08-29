/**
 * Unit tests: the brand-import result contract.
 *
 * The outcome is the whole failure design — an admin whose import found nothing has to be told
 * what to try next, and an admin whose import found two fields has to be told the rest are
 * missing rather than left to notice. These tests pin the boundaries between the four outcomes,
 * because a threshold that drifts turns a `partial` into an `ok` and silently stops warning.
 */

import { describe, it, expect } from 'vitest';

import {
  IMPORTABLE_COLOR_FIELDS,
  IMPORTABLE_FIELDS,
  analysedResult,
  blockedResult,
  isImportableColorField,
  type ProposedField,
} from '@/lib/app/questionnaire/brand-import/result';

const proposal = (value: string): ProposedField => ({
  value,
  confidence: 'high',
  source: 'read from the screenshot',
});

describe('analysedResult', () => {
  it('is `empty` with a next step when nothing was proposed', () => {
    const result = analysedResult({
      source: 'url',
      fields: {},
      candidates: [],
      degraded: false,
    });

    expect(result.outcome).toBe('empty');
    // A URL that yielded nothing is exactly the case the screenshot route exists for.
    expect(result.nextStep).toBe('screenshot');
    expect(result.reason).toBeTruthy();
  });

  it('sends an empty screenshot to manual entry, not back to another screenshot', () => {
    const result = analysedResult({
      source: 'screenshot',
      fields: {},
      candidates: [],
      degraded: false,
    });

    expect(result.outcome).toBe('empty');
    expect(result.nextStep).toBe('manual');
  });

  it('points a one-sided partial answer at the source it has not used yet', () => {
    const fromUrl = analysedResult({
      source: 'url',
      fields: { canvasColor: proposal('#ffffff') },
      candidates: [],
      degraded: false,
    });
    const fromScreenshot = analysedResult({
      source: 'screenshot',
      fields: { canvasColor: proposal('#ffffff') },
      candidates: [],
      degraded: false,
    });
    const fromBoth = analysedResult({
      source: 'combined',
      fields: { canvasColor: proposal('#ffffff') },
      candidates: [],
      degraded: false,
    });

    // Naming the missing half is the difference between guidance and a shrug — and a run that used
    // both has no other half to offer.
    expect(fromUrl.reason).toContain('Adding a screenshot');
    expect(fromScreenshot.reason).toContain('address');
    expect(fromBoth.reason).not.toContain('Adding');
    expect(fromBoth.reason).toContain('that site and those screenshots');
  });

  it('sends an empty combined run to manual entry — both sources are already spent', () => {
    const result = analysedResult({
      source: 'combined',
      fields: {},
      candidates: [],
      degraded: false,
    });

    expect(result.outcome).toBe('empty');
    expect(result.nextStep).toBe('manual');
    expect(result.reason).toContain('that site and those screenshots');
  });

  it('is `partial` below the threshold, and says how many fields it managed', () => {
    const result = analysedResult({
      source: 'screenshot',
      fields: { canvasColor: proposal('#ffffff'), inkColor: proposal('#111114') },
      candidates: [],
      degraded: false,
    });

    expect(result.outcome).toBe('partial');
    expect(result.nextStep).toBe('manual');
    expect(result.reason).toContain('2 fields');
  });

  it('is `ok` at the threshold, with no reason and no next step', () => {
    const result = analysedResult({
      source: 'screenshot',
      fields: {
        canvasColor: proposal('#ffffff'),
        inkColor: proposal('#111114'),
        ctaColor: proposal('#5469d4'),
      },
      candidates: [],
      degraded: false,
    });

    expect(result.outcome).toBe('ok');
    expect(result.nextStep).toBeNull();
    expect(result.reason).toBeNull();
  });

  it('keeps the measured palette on a degraded run, and says the run was degraded', () => {
    const candidates = [{ hex: '#5469d4', share: 0.4, neutral: false }];
    const result = analysedResult({
      source: 'screenshot',
      fields: {},
      candidates,
      degraded: true,
      note: 'No AI provider was available.',
    });

    // The colours are the expensive half and they are already measured — throwing them away
    // because the model was unavailable would discard the work and leave the admin nothing.
    expect(result.candidates).toEqual(candidates);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('No AI provider was available.');
  });

  it('carries a note through on an otherwise clean run', () => {
    const result = analysedResult({
      source: 'url',
      fields: {
        canvasColor: proposal('#ffffff'),
        inkColor: proposal('#111114'),
        ctaColor: proposal('#5469d4'),
      },
      candidates: [],
      degraded: false,
      note: 'We stopped after 12 requests.',
    });

    expect(result.outcome).toBe('ok');
    expect(result.reason).toBe('We stopped after 12 requests.');
  });
});

describe('blockedResult', () => {
  it('always offers the screenshot route, because the admin can render what we cannot', () => {
    const result = blockedResult({ source: 'url', reason: 'That site refused our request (403).' });

    expect(result.outcome).toBe('blocked');
    expect(result.nextStep).toBe('screenshot');
    expect(result.reason).toContain('403');
    expect(result.fields).toEqual({});
    expect(result.candidates).toEqual([]);
  });
});

describe('field sets', () => {
  it('proposes both grounds, because the resolver cannot always tell them apart', () => {
    // `resolveTheme` carries an ALREADY-DARK canvas across to dark mode unchanged — a deliberate
    // default for a typed colour, and the wrong outcome for an import: a brand with a deep purple
    // ground got two identical panels and a comparison in which nothing differed.
    expect(IMPORTABLE_FIELDS).toContain('canvasColor');
    expect(IMPORTABLE_FIELDS).toContain('canvasColorDark');
    expect(IMPORTABLE_FIELDS).toContain('inkColor');
    expect(IMPORTABLE_FIELDS).toContain('inkColorDark');
  });

  it('never proposes the banner', () => {
    // `og:image` is ~1.9:1 and is the only banner-shaped image a site reliably exposes, so it
    // would fail the 4:1 banner spec on upload every time.
    expect(IMPORTABLE_FIELDS).not.toContain('bannerUrl');
  });

  it('classifies colour fields apart from image and type fields', () => {
    for (const field of IMPORTABLE_COLOR_FIELDS) {
      expect(isImportableColorField(field)).toBe(true);
    }
    expect(isImportableColorField('logoUrl')).toBe(false);
    expect(isImportableColorField('fontPairing')).toBe(false);
  });
});
