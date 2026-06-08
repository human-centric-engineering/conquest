/**
 * Unit test: result-export query contract (F8.2).
 *
 * The export route reuses the F8.1 analytics filter and adds a `format` selector. Pin
 * the additions: format defaults to JSON, only csv/json are accepted, and the inherited
 * date/tag fields still validate (a bad date is rejected).
 */

import { describe, it, expect } from 'vitest';

import {
  RESULTS_EXPORT_FORMATS,
  resultsExportQuerySchema,
} from '@/lib/app/questionnaire/export/results-query';

describe('resultsExportQuerySchema', () => {
  it('defaults format to json when omitted', () => {
    const parsed = resultsExportQuerySchema.parse({});
    expect(parsed.format).toBe('json');
  });

  it('accepts each supported format', () => {
    for (const format of RESULTS_EXPORT_FORMATS) {
      expect(resultsExportQuerySchema.parse({ format }).format).toBe(format);
    }
  });

  it('rejects an unsupported format', () => {
    expect(resultsExportQuerySchema.safeParse({ format: 'pdf' }).success).toBe(false);
  });

  it('still inherits and validates the analytics date/tag filter', () => {
    const ok = resultsExportQuerySchema.parse({ from: '2026-01-01', tagIds: 't1,t2' });
    expect(ok.from).toBe('2026-01-01');
    expect(ok.tagIds).toBe('t1,t2');
    expect(resultsExportQuerySchema.safeParse({ from: 'not-a-date' }).success).toBe(false);
  });
});
