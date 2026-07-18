/**
 * Report method summary — the meta-agent that narrates a method record, and the guard that decides
 * whether to trust it.
 *
 * `rejectSummary` is the single check standing between a respondent and a fluent, confident, invented
 * account of how their report was produced. It is tested directly and hard: the failure mode this
 * feature must never have is an explanation that claims diligence the run did not perform.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ calculateCost: vi.fn() }));
vi.mock('@/lib/logging', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import {
  rejectSummary,
  allowedNumbers,
  summariseReportMethod,
  REPORT_METHOD_SUMMARY_MAX,
} from '@/lib/app/questionnaire/report/method-summary';
import {
  MethodRecorder,
  renderMethodSummaryTemplate,
  type ReportMethodRecord,
} from '@/lib/app/questionnaire/report/method-record';

const findUnique = vi.mocked(prisma.aiAgent.findUnique);
const chat = vi.fn();

/** A record with known counts: 34/40 answers, 6 gaps, 1 document, 2 searches, 3 sources. */
function record(): ReportMethodRecord {
  const rec = new MethodRecorder('narrative', false, () => 0);
  rec.recordAnswers({
    answered: 34,
    total: 40,
    completionPct: 85,
    unansweredListed: 6,
    confidenceWeighted: true,
    usedDataSlots: false,
  });
  rec.recordKnowledge({
    consulted: true,
    documentsInScope: 9,
    documentsUsed: [{ id: 'd1', name: 'Handbook', snippets: 2 }],
    snippetCount: 2,
  });
  rec.recordSearches('before', [
    { query: 'a', resultCount: 5 },
    { query: 'b', resultCount: 4 },
  ]);
  rec.recordSources(
    [
      { title: 'One', url: 'https://one.test' },
      { title: 'Two', url: 'https://two.test' },
      { title: 'Three', url: 'https://three.test' },
    ],
    true
  );
  return rec.build();
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({
    provider: '',
    model: '',
    fallbackProviders: [],
    systemInstructions: 'You are the explainer.',
    temperature: 0.2,
    maxTokens: 1024,
  } as never);
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-5.4-mini',
    fallbacks: [],
  });
  vi.mocked(getProvider).mockResolvedValue({ chat } as never);
  vi.mocked(calculateCost).mockReturnValue({
    totalCostUsd: 0.0001,
    inputCostUsd: 0.00008,
    outputCostUsd: 0.00002,
    isLocal: false,
  });
  chat.mockResolvedValue({
    content: 'We read the answers you gave and noted the ones you skipped.',
    usage: { inputTokens: 100, outputTokens: 40 },
  });
});

describe('allowedNumbers', () => {
  it('admits every count the record actually observed', () => {
    const allowed = allowedNumbers(record());
    // answered, total, completionPct, gaps, docs in scope, docs used, snippets, searches, sources
    expect([...allowed].sort((a, b) => a - b)).toEqual([1, 2, 3, 6, 9, 34, 40, 85]);
  });
});

describe('rejectSummary', () => {
  const rec = record();

  it('accepts prose whose numbers all appear in the record', () => {
    expect(rejectSummary('We read 34 of your 40 answers and kept 3 sources.', rec)).toBeNull();
  });

  it('accepts prose with no numbers at all', () => {
    expect(rejectSummary('We read all of your answers and checked a few sources.', rec)).toBeNull();
  });

  it('rejects a fabricated count', () => {
    // The signature failure: invented rigour shows up as an invented tally.
    expect(rejectSummary('We cross-checked 12 clinical sources.', rec)).toBe(
      'ungrounded_number:12'
    );
  });

  it('rejects a number that is merely plausible arithmetic on real ones', () => {
    // 40 - 34 = 6 is in the record, but 34 + 40 = 74 is not — the guard admits observed values only,
    // it does not let the model derive new ones.
    expect(rejectSummary('We considered 74 items.', rec)).toBe('ungrounded_number:74');
  });

  it('rejects empty or whitespace-only output', () => {
    expect(rejectSummary('', rec)).toBe('empty');
    expect(rejectSummary('   \n  ', rec)).toBe('empty');
  });

  it('rejects output beyond the length cap', () => {
    expect(rejectSummary('a'.repeat(REPORT_METHOD_SUMMARY_MAX + 1), rec)).toBe('too_long');
  });

  it('rejects a URL in the prose', () => {
    // Sources are rendered from the record, verifiably; a narrated URL is either invented or a
    // less-checkable duplicate of data already displayed.
    expect(rejectSummary('See https://madeup.test for details.', rec)).toBe('contains_citation');
  });

  it('rejects bracketed citation markers', () => {
    expect(rejectSummary('Evidence supports this [1].', rec)).toBe('contains_citation');
  });

  it('handles thousands separators without treating them as separate numbers', () => {
    // "1,234" must be read as one ungrounded number, not as a grounded 1 and 234.
    expect(rejectSummary('We reviewed 1,234 records.', rec)).toBe('ungrounded_number:1234');
  });

  it('rejects a decimal that is not in the record', () => {
    expect(rejectSummary('Confidence averaged 0.87.', rec)).toBe('ungrounded_number:0.87');
  });
});

describe('summariseReportMethod', () => {
  it('returns the agent text when it passes every check', async () => {
    const result = await summariseReportMethod(record());
    expect(result.source).toBe('agent');
    expect(result.text).toBe('We read the answers you gave and noted the ones you skipped.');
    expect(result.costUsd).toBeCloseTo(0.0001, 6);
  });

  it('falls back to the deterministic template when the agent invents a number', async () => {
    chat.mockResolvedValue({
      content: 'We rigorously cross-checked 17 independent sources.',
      usage: { inputTokens: 100, outputTokens: 40 },
    });
    const rec = record();
    const result = await summariseReportMethod(rec);

    expect(result.source).toBe('template');
    expect(result.text).toBe(renderMethodSummaryTemplate(rec));
    // The wasted call is still charged — the cost was genuinely incurred.
    expect(result.costUsd).toBeCloseTo(0.0001, 6);
  });

  it('falls back to the template when the agent is not seeded, without calling a provider', async () => {
    findUnique.mockResolvedValue(null);
    const rec = record();
    const result = await summariseReportMethod(rec);

    expect(result).toEqual({
      text: renderMethodSummaryTemplate(rec),
      source: 'template',
      costUsd: 0,
    });
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('falls back to the template when the provider throws, and never propagates', async () => {
    chat.mockRejectedValue(new Error('upstream exploded'));
    const rec = record();
    const result = await summariseReportMethod(rec);

    expect(result.source).toBe('template');
    expect(result.text).toBe(renderMethodSummaryTemplate(rec));
    expect(result.costUsd).toBe(0);
  });

  it('never calls the agent for a preview run, and leads with the sample disclaimer', async () => {
    // Regression: live testing showed the agent describing a synthesised sample as "all of your
    // answers to the 12 questions you completed". The record flags a preview, but instruction-
    // following is not a guarantee — so a preview never reaches the agent at all.
    const rec = new MethodRecorder('narrative', true, () => 0);
    rec.recordAnswers({
      answered: 12,
      total: 12,
      completionPct: 100,
      unansweredListed: 0,
      confidenceWeighted: true,
      usedDataSlots: false,
    });
    const previewRecord = rec.build();

    const result = await summariseReportMethod(previewRecord);

    expect(chat).not.toHaveBeenCalled();
    expect(result.source).toBe('template');
    expect(result.costUsd).toBe(0);
    expect(result.text).toMatch(/^This is a sample report/);
  });

  it('never hands the agent the source URLs or search queries', async () => {
    await summariseReportMethod(record());
    const prompt = JSON.stringify(chat.mock.calls[0]?.[0]);

    // The agent describes the process; it has no need for retrieved third-party text, and feeding it
    // attacker-influenceable strings would taint prose we present as a statement about our own system.
    expect(prompt).not.toContain('one.test');
    expect(prompt).not.toContain('https://');
    expect(prompt).not.toContain('Handbook');
  });

  it('resolves the cheap chat tier rather than the reasoning tier', async () => {
    await summariseReportMethod(record());
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(expect.anything(), 'chat');
  });
});
