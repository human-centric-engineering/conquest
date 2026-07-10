/**
 * Unit tests for ingestion upload parsing/validation (F1.1 / PR4, T1.4.1).
 *
 * Pure form parsing — no HTTP, no mocks. Covers the extension allowlist, the
 * empty-string-as-absent boundary rule for admin metadata, audience validation,
 * dotted-key collection, and the extractTables flag.
 */

import { describe, it, expect } from 'vitest';

import { ValidationError } from '@/lib/api/errors';
import {
  ALLOWED_EXTENSIONS,
  getExtension,
  hasAllowedExtension,
  MAX_TITLE_LENGTH,
  parseAdminMetadata,
  parseExtractTablesFlag,
  parseRequiredMode,
} from '@/app/api/v1/app/questionnaires/_lib/upload-input';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('extension allowlist', () => {
  it('accepts the four supported extensions, case-insensitively', () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      expect(hasAllowedExtension(`doc${ext}`)).toBe(true);
      expect(hasAllowedExtension(`DOC${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it('rejects unsupported extensions', () => {
    expect(hasAllowedExtension('image.png')).toBe(false);
    expect(hasAllowedExtension('book.epub')).toBe(false);
    expect(hasAllowedExtension('noextension')).toBe(false);
  });

  it('reads the lowercased extension', () => {
    expect(getExtension('Report.PDF')).toBe('.pdf');
    expect(getExtension('plain')).toBe('');
  });
});

describe('parseAdminMetadata — title', () => {
  it('captures a non-empty name override', () => {
    expect(parseAdminMetadata(form({ title: 'Customer onboarding' })).title).toBe(
      'Customer onboarding'
    );
  });

  it('treats an empty/whitespace title as absent (falls back to the derived title)', () => {
    expect(parseAdminMetadata(form({ title: '   ' })).title).toBeUndefined();
    expect(parseAdminMetadata(form({})).title).toBeUndefined();
  });

  it('accepts a title exactly at the length cap', () => {
    const atCap = 'x'.repeat(MAX_TITLE_LENGTH);
    expect(parseAdminMetadata(form({ title: atCap })).title).toBe(atCap);
  });

  it('throws ValidationError when the title exceeds the length cap', () => {
    const tooLong = 'x'.repeat(MAX_TITLE_LENGTH + 1);
    expect(() => parseAdminMetadata(form({ title: tooLong }))).toThrow(ValidationError);
  });
});

describe('parseAdminMetadata — demoClientId', () => {
  it('captures a non-empty demo client id', () => {
    expect(parseAdminMetadata(form({ demoClientId: 'client-1' })).demoClientId).toBe('client-1');
  });

  it('treats an empty/whitespace demo client id as absent', () => {
    expect(parseAdminMetadata(form({ demoClientId: '  ' })).demoClientId).toBeUndefined();
    expect(parseAdminMetadata(form({})).demoClientId).toBeUndefined();
  });
});

describe('parseAdminMetadata — goal', () => {
  it('captures a non-empty goal', () => {
    expect(parseAdminMetadata(form({ goal: 'Understand churn' })).goal).toBe('Understand churn');
  });

  it('treats an empty/whitespace goal as absent (not a suppression signal)', () => {
    expect(parseAdminMetadata(form({ goal: '   ' })).goal).toBeUndefined();
    expect(parseAdminMetadata(form({})).goal).toBeUndefined();
  });
});

describe('parseAdminMetadata — audience', () => {
  it('collects dotted audience.* fields into one object, coercing duration', () => {
    const meta = parseAdminMetadata(
      form({
        'audience.role': 'new hire',
        'audience.expertiseLevel': 'novice',
        'audience.estimatedDurationMinutes': '15',
      })
    );
    expect(meta.audience).toEqual({
      role: 'new hire',
      expertiseLevel: 'novice',
      estimatedDurationMinutes: 15,
    });
  });

  it('omits empty audience fields and yields no audience object when all are empty', () => {
    const meta = parseAdminMetadata(form({ 'audience.role': '  ', 'audience.notes': '' }));
    expect(meta.audience).toBeUndefined();
  });

  it('throws ValidationError with a field path for an invalid enum value', () => {
    expect(() => parseAdminMetadata(form({ 'audience.expertiseLevel': 'wizard' }))).toThrow(
      ValidationError
    );
  });

  it('throws ValidationError for an unknown audience key (.strict)', () => {
    expect(() => parseAdminMetadata(form({ 'audience.favouriteColour': 'blue' }))).toThrow(
      ValidationError
    );
  });

  it('throws ValidationError for a non-positive duration', () => {
    expect(() => parseAdminMetadata(form({ 'audience.estimatedDurationMinutes': '0' }))).toThrow(
      ValidationError
    );
  });
});

describe('parseRequiredMode', () => {
  it("defaults to 'all' when the form omits requiredMode", () => {
    expect(parseRequiredMode(form({}))).toBe('all');
  });

  it("treats an empty/whitespace requiredMode as absent (defaults to 'all')", () => {
    expect(parseRequiredMode(form({ requiredMode: '   ' }))).toBe('all');
  });

  it("captures an explicit 'source' choice", () => {
    expect(parseRequiredMode(form({ requiredMode: 'source' }))).toBe('source');
  });

  it("captures an explicit 'all' choice", () => {
    expect(parseRequiredMode(form({ requiredMode: 'all' }))).toBe('all');
  });

  it('throws ValidationError for an unrecognised requiredMode', () => {
    expect(() => parseRequiredMode(form({ requiredMode: 'maybe' }))).toThrow(ValidationError);
  });
});

describe('parseExtractTablesFlag', () => {
  it('is true for truthy string values', () => {
    for (const v of ['true', '1', 'on', 'yes', 'YES']) {
      expect(parseExtractTablesFlag(form({ extractTables: v }))).toBe(true);
    }
  });

  // Defaults to ON: questionnaires are table-dense (rating grids, scales, option
  // lists render as tables), and the table pass self-detects, so it's harmless on
  // prose-only PDFs. An absent/blank field is "un-filled", not an admin override.
  it('defaults to true when absent or blank (not an explicit override)', () => {
    expect(parseExtractTablesFlag(form({}))).toBe(true);
    expect(parseExtractTablesFlag(form({ extractTables: '   ' }))).toBe(true);
  });

  it('is false for an explicit non-truthy value (the admin override)', () => {
    for (const v of ['false', '0', 'off', 'no']) {
      expect(parseExtractTablesFlag(form({ extractTables: v }))).toBe(false);
    }
  });
});
