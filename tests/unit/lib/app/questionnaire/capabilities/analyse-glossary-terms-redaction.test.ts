/**
 * Unit test: the Glossary Analyst capability's provenance redaction (P16).
 *
 * The capability is `processesPii = true` because BOTH of its inputs can carry personal content:
 * the questionnaire's own question wording, and — more importantly — an admin-uploaded definitions
 * document, which is an arbitrary file this system never inspected. Its OUTPUT quotes spans from
 * both.
 *
 * So the durable provenance row may record shapes and counts, and never text.
 *
 * @see lib/app/questionnaire/capabilities/analyse-glossary-terms.ts
 */

import { describe, it, expect } from 'vitest';

import { AppAnalyseGlossaryTermsCapability } from '@/lib/app/questionnaire/capabilities/analyse-glossary-terms';
import type { AnalyseGlossaryTermsArgs } from '@/lib/app/questionnaire/capabilities/analyse-glossary-terms';

const capability = new AppAnalyseGlossaryTermsCapability();

const args: AnalyseGlossaryTermsArgs = {
  questions: [
    { key: 'q1', prompt: 'How connected do you feel to your higher self?' },
    { key: 'q2', prompt: 'Describe a time your ego caused harm at work.' },
  ],
  goal: 'Assess spiritual development',
  documentText: 'CONFIDENTIAL HANDBOOK: staff disciplinary notes for Jane Doe, ref 44821.',
  documentFileName: 'house-glossary.pdf',
  existingTerms: ['shadow'],
};

describe('AppAnalyseGlossaryTermsCapability.redactProvenance', () => {
  it('records counts and the file name, never the document text', () => {
    const { args: safeArgs } = capability.redactProvenance(args, {
      success: true,
      data: undefined,
    });
    const serialised = JSON.stringify(safeArgs);

    expect(serialised).toContain('house-glossary.pdf');
    expect(serialised).toContain('2'); // questionCount
    // The uploaded document is an arbitrary admin file — it must never land in an audit row.
    expect(serialised).not.toContain('CONFIDENTIAL');
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('44821');
  });

  it('never records the question wording itself', () => {
    const { args: safeArgs } = capability.redactProvenance(args, {
      success: true,
      data: undefined,
    });
    const serialised = JSON.stringify(safeArgs);

    expect(serialised).not.toContain('higher self');
    expect(serialised).not.toContain('caused harm at work');
  });

  it('summarises the result as counts, never the proposed definitions or their quotes', () => {
    const { resultPreview } = capability.redactProvenance(args, {
      success: true,
      data: {
        result: {
          terms: [
            {
              term: 'higher self',
              aliases: [],
              rationale: 'Contested across traditions.',
              definitions: [
                { text: 'The observing part of you.' },
                { text: 'Drawn from the handbook.', sourceQuote: 'staff disciplinary notes' },
              ],
            },
          ],
        },
      },
    });

    // Shape is useful and non-identifying.
    expect(resultPreview).toContain('"termCount":1');
    expect(resultPreview).toContain('"definitionCount":2');
    // The definitions and — critically — the quoted document span must not appear.
    expect(resultPreview).not.toContain('observing part');
    expect(resultPreview).not.toContain('disciplinary notes');
    expect(resultPreview).not.toContain('Contested across traditions');
  });

  it('omits the document markers entirely when no document was supplied', () => {
    const { args: safeArgs } = capability.redactProvenance(
      { questions: args.questions },
      { success: true, data: undefined }
    );
    const serialised = JSON.stringify(safeArgs);

    expect(serialised).not.toContain('documentFileName');
    expect(serialised).not.toContain('documentText');
    expect(serialised).toContain('"existingTermCount":0');
  });

  it('passes a failed result through without inventing a preview', () => {
    const { resultPreview } = capability.redactProvenance(args, {
      success: false,
      error: { code: 'provider_unavailable', message: 'No provider configured.' },
    });
    expect(resultPreview).toContain('provider_unavailable');
  });
});
