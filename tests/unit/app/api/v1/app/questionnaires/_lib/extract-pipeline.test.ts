/**
 * Unit tests for the shared ingest-pipeline helpers.
 *
 * `parseAndGuardUpload` / `extractFromDocument` are exercised end-to-end by the
 * route integration tests (both the synchronous and the streaming ingest routes go
 * through them). Here we pin the pure `deriveTitle` helper, which both routes call to
 * name a new questionnaire from the parsed document title, falling back to the file name.
 *
 * @see app/api/v1/app/questionnaires/_lib/extract-pipeline.ts
 */

import { describe, it, expect } from 'vitest';

import { deriveTitle } from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';

describe('deriveTitle', () => {
  it('uses the parsed document title when present', () => {
    expect(deriveTitle('The Car Decision Questionnaire', 'car.pdf')).toBe(
      'The Car Decision Questionnaire'
    );
  });

  it('trims surrounding whitespace from the parsed title', () => {
    expect(deriveTitle('  Employee Survey  ', 'survey.docx')).toBe('Employee Survey');
  });

  it('falls back to the file name without its extension when the parsed title is blank', () => {
    expect(deriveTitle('', 'Car Purchase Decision Questionnaire.pdf')).toBe(
      'Car Purchase Decision Questionnaire'
    );
    expect(deriveTitle('   ', 'my-questionnaire.docx')).toBe('my-questionnaire');
  });

  it('strips only the final extension segment', () => {
    expect(deriveTitle('', 'annual.review.2026.pdf')).toBe('annual.review.2026');
  });

  it('falls back to the raw file name when stripping the extension leaves nothing', () => {
    // A dotfile-style name whose only content is the extension has no stem to use.
    expect(deriveTitle('', '.pdf')).toBe('.pdf');
  });
});
