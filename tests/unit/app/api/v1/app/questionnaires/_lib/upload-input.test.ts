import { describe, it, expect } from 'vitest';

import {
  ALLOWED_EXTENSIONS,
  hasAllowedExtension,
  parseAdminMetadata,
  parseExtractTablesFlag,
  MAX_INSTRUCTIONS_LENGTH,
} from '@/app/api/v1/app/questionnaires/_lib/upload-input';
import { ValidationError } from '@/lib/api/errors';

/**
 * Tests for the upload-input parser, focused on the spreadsheet allowlist and
 * the free-text extraction-instructions field added for spreadsheet ingestion.
 */

describe('ALLOWED_EXTENSIONS', () => {
  it('accepts .xlsx alongside the document formats', () => {
    expect(ALLOWED_EXTENSIONS).toContain('.xlsx');
    expect(hasAllowedExtension('GA Questions Breakout 02.xlsx')).toBe(true);
    expect(hasAllowedExtension('REPORT.XLSX')).toBe(true);
  });

  it('still rejects unrelated formats', () => {
    expect(hasAllowedExtension('data.xls')).toBe(false); // legacy binary — exceljs reads .xlsx only
    expect(hasAllowedExtension('image.png')).toBe(false);
  });
});

describe('parseAdminMetadata — instructions', () => {
  it('carries trimmed instructions through', () => {
    const form = new FormData();
    form.set('instructions', "  Questions are in the Activities tab. Replace 'HPE'.  ");
    const meta = parseAdminMetadata(form);
    expect(meta.instructions).toBe("Questions are in the Activities tab. Replace 'HPE'.");
  });

  it('omits the field when blank or absent (blank = not supplied)', () => {
    expect(parseAdminMetadata(new FormData()).instructions).toBeUndefined();
    const blank = new FormData();
    blank.set('instructions', '   ');
    expect(parseAdminMetadata(blank).instructions).toBeUndefined();
  });

  it('rejects instructions over the length cap with a precise error', () => {
    const form = new FormData();
    form.set('instructions', 'x'.repeat(MAX_INSTRUCTIONS_LENGTH + 1));
    expect(() => parseAdminMetadata(form)).toThrow(ValidationError);
  });

  it('accepts instructions exactly at the cap', () => {
    const form = new FormData();
    form.set('instructions', 'x'.repeat(MAX_INSTRUCTIONS_LENGTH));
    expect(parseAdminMetadata(form).instructions).toHaveLength(MAX_INSTRUCTIONS_LENGTH);
  });
});

describe('parseExtractTablesFlag', () => {
  it('defaults to true when the field is absent (questionnaires are table-dense)', () => {
    expect(parseExtractTablesFlag(new FormData())).toBe(true);
  });

  it('defaults to true when the field is present but blank (un-filled, not an override)', () => {
    const form = new FormData();
    form.set('extractTables', '   ');
    expect(parseExtractTablesFlag(form)).toBe(true);
  });

  it('reads explicit truthy values as true', () => {
    for (const value of ['true', '1', 'on', 'yes']) {
      const form = new FormData();
      form.set('extractTables', value);
      expect(parseExtractTablesFlag(form)).toBe(true);
    }
  });

  it('treats an explicit non-truthy value as an admin override to false', () => {
    for (const value of ['false', '0', 'off', 'no']) {
      const form = new FormData();
      form.set('extractTables', value);
      expect(parseExtractTablesFlag(form)).toBe(false);
    }
  });
});
