import { describe, it, expect } from 'vitest';

import {
  ALLOWED_EXTENSIONS,
  hasAllowedExtension,
  hasParseableExtension,
  parseAdminMetadata,
  parseExtractTablesFlag,
  MAX_INSTRUCTIONS_LENGTH,
} from '@/app/api/v1/app/questionnaires/_lib/upload-input';
import {
  PARSEABLE_ACCEPT_ATTR,
  PARSEABLE_UPLOAD_EXTENSIONS,
  UPLOAD_ACCEPT_ATTR,
} from '@/lib/app/questionnaire/constants';
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

  // The routing corpus' easiest document is a .csv and could not be ingested at all: the parser
  // router has always had a `.csv` branch, but this allowlist never listed it.
  it('accepts .csv, which the parser router has always been able to read', () => {
    expect(ALLOWED_EXTENSIONS).toContain('.csv');
    expect(hasAllowedExtension('01-medication-review.csv')).toBe(true);
    expect(hasAllowedExtension('EXPORT.CSV')).toBe(true);
  });
});

describe('hasParseableExtension', () => {
  // Guards the three routes that hand the buffer straight to `parseDocument` (intro-background
  // parse, scoring-schema extract, round-context parse). `parseDocument` THROWS on a workbook, so
  // accepting one there produced a thrown parse error instead of a clean 415.
  it('rejects .xlsx, which parseDocument cannot read', () => {
    expect(hasAllowedExtension('workbook.xlsx')).toBe(true);
    expect(hasParseableExtension('workbook.xlsx')).toBe(false);
  });

  it('accepts every other allowed format', () => {
    for (const ext of PARSEABLE_UPLOAD_EXTENSIONS) {
      expect(hasParseableExtension(`document${ext}`)).toBe(true);
    }
  });

  it('still rejects unrelated formats', () => {
    expect(hasParseableExtension('image.png')).toBe(false);
  });
});

/**
 * The drift guard. Six admin file pickers used to hand-maintain their own `accept` literal and
 * they disagreed with each other and with the server — one offered `.csv` the server rejected.
 * These assert the pickers' strings stay DERIVED from the allowlist, so re-introducing a
 * hardcoded literal fails here rather than in a user's upload.
 */
describe('accept attributes stay derived from the allowlist', () => {
  it('UPLOAD_ACCEPT_ATTR lists exactly the allowed extensions', () => {
    expect(UPLOAD_ACCEPT_ATTR.split(',')).toEqual([...ALLOWED_EXTENSIONS]);
  });

  it('PARSEABLE_ACCEPT_ATTR is the same list minus .xlsx', () => {
    expect(PARSEABLE_ACCEPT_ATTR.split(',')).toEqual(
      ALLOWED_EXTENSIONS.filter((ext) => ext !== '.xlsx')
    );
    expect(PARSEABLE_ACCEPT_ATTR).not.toContain('.xlsx');
  });

  it('every extension a picker offers passes the matching server guard', () => {
    for (const ext of UPLOAD_ACCEPT_ATTR.split(',')) {
      expect(hasAllowedExtension(`file${ext}`)).toBe(true);
    }
    for (const ext of PARSEABLE_ACCEPT_ATTR.split(',')) {
      expect(hasParseableExtension(`file${ext}`)).toBe(true);
    }
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
