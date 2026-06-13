/**
 * Unit test: the answer-extractor capability's provenance redaction (sensitivity awareness).
 *
 * The disclosure `summary` restates personal/distressing content, so it must NEVER reach the
 * durable provenance audit row. `redactProvenance` may record the severity + category (useful,
 * non-identifying) but not the summary, and never the respondent's message.
 */

import { describe, it, expect } from 'vitest';

import { AppExtractAnswerSlotsCapability } from '@/lib/app/questionnaire/capabilities/extract-answer-slots';
import type { ExtractAnswerSlotsArgs } from '@/lib/app/questionnaire/capabilities/extract-answer-slots';

const capability = new AppExtractAnswerSlotsCapability();

const args: ExtractAnswerSlotsArgs = {
  userMessage: 'I was abused by the CEO',
  activeQuestionKey: 'q1',
  candidateSlots: [{ key: 'q1', prompt: 'How is work?', type: 'free_text' }],
};

describe('AppExtractAnswerSlotsCapability.redactProvenance — sensitivity', () => {
  it('records severity + category but NEVER the summary or the raw message', () => {
    const { args: safeArgs, resultPreview } = capability.redactProvenance(args, {
      success: true,
      data: {
        intents: [],
        dataSlotFills: [],
        droppedCount: 0,
        costUsd: 0,
        sensitivity: {
          detected: true,
          severity: 'high',
          category: 'harassment',
          summary: 'Reports mistreatment by a senior colleague.',
        },
      },
    });

    // Severity + category are safe to record.
    expect(resultPreview).toContain('high');
    expect(resultPreview).toContain('harassment');
    // The summary (restated PII) and the raw message must never appear.
    expect(resultPreview).not.toContain('senior colleague');
    expect(resultPreview).not.toContain('mistreatment');
    expect(JSON.stringify(safeArgs)).not.toContain('abused by the CEO');
  });

  it('omits any sensitivity block when none was detected', () => {
    const { resultPreview } = capability.redactProvenance(args, {
      success: true,
      data: { intents: [], dataSlotFills: [], droppedCount: 0, costUsd: 0 },
    });
    expect(resultPreview).not.toContain('sensitivity');
  });
});
