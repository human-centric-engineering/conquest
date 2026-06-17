/**
 * Unit test: extraction candidate pre-filter (answer-mapping at scale).
 *
 * Mocks the embedder + the two pgvector rankers. Asserts the hard safety rails (active keys; every
 * filled slot incl. cross-theme; same-theme unfilled; mapped questions of KEPT slots only), the
 * threshold no-op, the fail-soft paths (no message / embed error / un-embedded → full set), and that
 * the output preserves input order/identity and reports accurate diagnostics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({ embedText: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => ({
  rankSlotsByVector: vi.fn(),
  rankSlotsByText: vi.fn(),
  findDuplicateSlotIds: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings', () => ({
  rankDataSlotsByVector: vi.fn(),
  rankDataSlotsByText: vi.fn(),
}));

import {
  narrowExtractionCandidates,
  type DataSlotCandidateInput,
  type ExtractionCandidateInput,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/extraction-candidates';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import {
  rankSlotsByVector,
  rankSlotsByText,
  findDuplicateSlotIds,
} from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import {
  rankDataSlotsByVector,
  rankDataSlotsByText,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import type { CapabilitySlotView } from '@/app/api/v1/app/questionnaires/_lib/turn-context';

type Mock = ReturnType<typeof vi.fn>;

function q(id: string): CapabilitySlotView {
  return {
    id,
    key: id,
    sectionId: 's1',
    prompt: `Prompt ${id}`,
    type: 'free_text',
    required: false,
  };
}
function ds(
  id: string,
  theme: string,
  over: Partial<DataSlotCandidateInput> = {}
): DataSlotCandidateInput {
  return {
    id,
    key: id,
    name: `Name ${id}`,
    description: `Desc ${id}`,
    theme,
    hasCurrentFill: false,
    ...over,
  };
}

// 40 question slots + 12 data slots → comfortably over the default size threshold (30).
const QUESTIONS = Array.from({ length: 40 }, (_, i) => q(`q${i}`));
const DATA = [
  ds('d0', 'A'),
  ds('d1', 'A'),
  ds('d2', 'A'),
  ds('d3', 'B'),
  ds('d4', 'B'),
  ds('d5', 'C', { hasCurrentFill: true }), // filled, theme C (cross-theme enrichment case)
  ds('d6', 'C'),
  ds('d7', 'D', { mappedQuestionKeys: ['q30', 'q31'] }),
  ds('d8', 'D'),
  ds('d9', 'E'),
  ds('d10', 'E'),
  ds('d11', 'F'),
];

function input(over: Partial<ExtractionCandidateInput> = {}): ExtractionCandidateInput {
  return {
    questionSlots: QUESTIONS,
    dataSlots: DATA,
    activeQuestionKey: null,
    activeDataSlotKey: null,
    activeTheme: null,
    recentMessages: ['the respondent just said something'],
    sessionId: 's1',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (embedText as unknown as Mock).mockResolvedValue({
    embedding: [0.1, 0.2],
    model: 'text-embedding-3-small',
    provider: 'openai',
    dimensions: 1536,
    inputTokens: 12,
    costUsd: 0.0000012,
  });
  // Default: similarity ranks a couple of slots that are NOT otherwise forced.
  (rankSlotsByVector as unknown as Mock).mockResolvedValue(['q5', 'q6']);
  (rankDataSlotsByVector as unknown as Mock).mockResolvedValue(['d9', 'd10']);
  // Hybrid lexical rankers + twin rail default to empty (no lexical hits, no duplicates) so the
  // existing dense-only assertions are unaffected; per-test overrides exercise them.
  (rankSlotsByText as unknown as Mock).mockResolvedValue([]);
  (rankDataSlotsByText as unknown as Mock).mockResolvedValue([]);
  (findDuplicateSlotIds as unknown as Mock).mockResolvedValue([]);
});

describe('narrowExtractionCandidates — safety rails', () => {
  it('always keeps the active question even when it is not in the top-K ranking', async () => {
    const r = await narrowExtractionCandidates(input({ activeQuestionKey: 'q39' }));
    expect(r.applied).toBe(true);
    expect(r.questionSlots.map((s) => s.key)).toContain('q39');
  });

  it('always keeps the active data slot even when ranked out', async () => {
    const r = await narrowExtractionCandidates(input({ activeDataSlotKey: 'd11' }));
    expect(r.dataSlots.map((s) => s.key)).toContain('d11');
  });

  it('always keeps a filled data slot from another theme (cross-turn enrichment)', async () => {
    // d5 is filled (theme C), active theme is A, and it is NOT in the ranked ids → still kept.
    const r = await narrowExtractionCandidates(input({ activeTheme: 'A' }));
    expect(r.dataSlots.map((s) => s.key)).toContain('d5');
  });

  it('always keeps same-theme unfilled data slots (topic-local rhythm)', async () => {
    // active theme A → d0, d1, d2 (all theme A, unfilled) kept even though not ranked.
    const r = await narrowExtractionCandidates(input({ activeTheme: 'A' }));
    const keys = r.dataSlots.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['d0', 'd1', 'd2']));
  });

  it('keeps the mapped questions of a KEPT data slot, but not of a dropped one', async () => {
    // d7 (mapped → q30, q31) is kept by ranking; assert its mapped questions are force-included.
    (rankDataSlotsByVector as unknown as Mock).mockResolvedValue(['d7']);
    const r = await narrowExtractionCandidates(input());
    const qKeys = r.questionSlots.map((s) => s.key);
    expect(qKeys).toEqual(expect.arrayContaining(['q30', 'q31']));

    // Now d7 is NOT kept (ranking returns a different slot) → q30/q31 not force-included by rail 4.
    (rankDataSlotsByVector as unknown as Mock).mockResolvedValue(['d9']);
    (rankSlotsByVector as unknown as Mock).mockResolvedValue(['q0']);
    const r2 = await narrowExtractionCandidates(input());
    const qKeys2 = r2.questionSlots.map((s) => s.key);
    expect(qKeys2).not.toContain('q30');
    expect(qKeys2).not.toContain('q31');
  });

  it('includes the top-K similar slots beyond the forced set', async () => {
    const r = await narrowExtractionCandidates(input());
    expect(r.questionSlots.map((s) => s.key)).toEqual(expect.arrayContaining(['q5', 'q6']));
    expect(r.dataSlots.map((s) => s.key)).toEqual(expect.arrayContaining(['d9', 'd10']));
  });

  it('preserves input order and object identity, and reports accurate diagnostics', async () => {
    const r = await narrowExtractionCandidates(input({ activeTheme: 'A' }));
    // Order preserved (subset of the source array order).
    const keys = r.dataSlots.map((s) => s.key);
    expect(keys).toEqual(
      [...keys].sort(
        (a, b) => DATA.findIndex((d) => d.key === a) - DATA.findIndex((d) => d.key === b)
      )
    );
    // Same object references (no rebuild).
    expect(DATA).toContain(r.dataSlots[0]);
    expect(r.questionsIn).toBe(40);
    expect(r.dataSlotsIn).toBe(12);
    expect(r.questionsOut).toBe(r.questionSlots.length);
    expect(r.dataSlotsOut).toBe(r.dataSlots.length);
  });
});

describe('narrowExtractionCandidates — no-op + fail-soft', () => {
  it('is a no-op below the size threshold (returns the full set unchanged)', async () => {
    const r = await narrowExtractionCandidates({
      ...input(),
      questionSlots: QUESTIONS.slice(0, 10),
      dataSlots: DATA.slice(0, 5), // 15 total < 30
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('below_threshold');
    expect(r.questionsOut).toBe(10);
    expect(r.dataSlotsOut).toBe(5);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('returns the full set when there is no last message', async () => {
    const r = await narrowExtractionCandidates(input({ recentMessages: [] }));
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('no_message');
    expect(embedText).not.toHaveBeenCalled();
  });

  it('returns the full set when the embed call throws (fail-soft)', async () => {
    (embedText as unknown as Mock).mockRejectedValue(new Error('embedder down'));
    const r = await narrowExtractionCandidates(input());
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('embed_failed');
    expect(r.dataSlotsOut).toBe(12);
  });

  it('returns the full set when data slots exist but none are embedded', async () => {
    (rankDataSlotsByVector as unknown as Mock).mockResolvedValue([]);
    const r = await narrowExtractionCandidates(input());
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('no_embeddings');
    expect(r.questionsOut).toBe(40);
  });

  it('still narrows questions when the version has NO data slots', async () => {
    (rankDataSlotsByVector as unknown as Mock).mockResolvedValue([]);
    const r = await narrowExtractionCandidates(
      input({ dataSlots: [], questionSlots: QUESTIONS, activeQuestionKey: 'q0' })
    );
    expect(r.applied).toBe(true);
    expect(r.questionSlots.map((s) => s.key)).toEqual(expect.arrayContaining(['q0', 'q5', 'q6']));
    expect(r.dataSlotsOut).toBe(0);
  });
});

describe('narrowExtractionCandidates — hybrid retrieval (BM25) + twin rail', () => {
  it('UNIONs the lexical (BM25) hits with the dense top-K for questions and data slots', async () => {
    // A question/data slot the DENSE vector ranked out, but the lexical search surfaced.
    (rankSlotsByText as unknown as Mock).mockResolvedValue(['q20']);
    (rankDataSlotsByText as unknown as Mock).mockResolvedValue(['d3']);

    const r = await narrowExtractionCandidates(input());
    // Dense (q5/q6) ∪ lexical (q20) are all kept.
    expect(r.questionSlots.map((s) => s.key)).toEqual(expect.arrayContaining(['q5', 'q6', 'q20']));
    expect(r.dataSlots.map((s) => s.key)).toEqual(expect.arrayContaining(['d9', 'd10', 'd3']));
    // The lexical ranker was queried with the respondent's last message.
    expect(rankSlotsByText).toHaveBeenCalledWith(
      'the respondent just said something',
      expect.any(Array),
      expect.any(Number)
    );
  });

  it('pulls in near-duplicate questions of the kept set (twin-inclusion rail)', async () => {
    // q7 is a near-duplicate of a kept question (not dense-ranked, not forced) → still kept.
    (findDuplicateSlotIds as unknown as Mock).mockResolvedValue(['q7']);

    const r = await narrowExtractionCandidates(input());
    expect(r.questionSlots.map((s) => s.key)).toEqual(expect.arrayContaining(['q5', 'q6', 'q7']));
    // The rail searches for duplicates of the KEPT question ids (dense q5/q6 by default).
    expect(findDuplicateSlotIds).toHaveBeenCalledWith(
      expect.arrayContaining(['q5', 'q6']),
      expect.any(Array),
      expect.any(Number)
    );
  });

  it('still bails to the full set on an un-embedded version even when lexical has hits', async () => {
    // Dense empty (un-embedded) but lexical finds something — the fail-soft bail keys on DENSE,
    // because lexical alone is too sparse to safely narrow on.
    (rankDataSlotsByVector as unknown as Mock).mockResolvedValue([]);
    (rankDataSlotsByText as unknown as Mock).mockResolvedValue(['d9']);

    const r = await narrowExtractionCandidates(input());
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('no_embeddings');
    expect(r.dataSlotsOut).toBe(12);
  });
});

describe('narrowExtractionCandidates — inspector capture', () => {
  it('records exactly one embedding trace (carrying the embed provenance) on the narrowed path', async () => {
    const recordInspectorCall = vi.fn();
    await narrowExtractionCandidates(input({ recordInspectorCall }));

    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.kind).toBe('embedding');
    expect(trace.label).toBe('Extraction candidate ranking');
    expect(trace.model).toBe('text-embedding-3-small');
    expect(trace.provider).toBe('openai');
    expect(trace.dimensions).toBe(1536);
    expect(trace.tokensIn).toBe(12);
    expect(trace.tokensOut).toBeUndefined();
    // The respondent's last message is echoed; the ranking summary reports kept counts.
    expect(trace.prompt[0].content).toContain('the respondent just said something');
    expect(trace.response).toMatch(/Ranked \d+ questions → kept/);
  });

  it('records no trace on the fail-soft paths (no message, below threshold, embed throws)', async () => {
    const recordInspectorCall = vi.fn();
    await narrowExtractionCandidates(input({ recordInspectorCall, recentMessages: [] }));
    await narrowExtractionCandidates({
      ...input({ recordInspectorCall }),
      questionSlots: QUESTIONS.slice(0, 10),
      dataSlots: DATA.slice(0, 5),
    });
    (embedText as unknown as Mock).mockRejectedValueOnce(new Error('embedder down'));
    await narrowExtractionCandidates(input({ recordInspectorCall }));

    expect(recordInspectorCall).not.toHaveBeenCalled();
  });
});
