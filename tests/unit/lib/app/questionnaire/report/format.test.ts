/**
 * Report Formatter second pass — unit tests.
 *
 * Mocks the DB (formatter agent lookup) and the agent/provider resolution; exercises the real
 * structured-completion runner against a fake provider. The load-bearing property under test is the
 * fidelity guard: the formatter must NEVER lose or alter content — on any structural drift, parse
 * failure, provider error, or missing agent it returns the ORIGINAL content unchanged with
 * `formatted: false`. Happy-path checks that structure is preserved and actions pass through verbatim.
 *
 * @see lib/app/questionnaire/report/format.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { formatReportContent } from '@/lib/app/questionnaire/report/format';
import type { RespondentReportContent } from '@/lib/app/questionnaire/report/content';

type Mock = ReturnType<typeof vi.fn>;

/** A fake provider that returns each queued response in turn (so the retry path can be exercised). */
function fakeProvider(responses: string[]) {
  const chat = vi.fn();
  responses.forEach((content) =>
    chat.mockResolvedValueOnce({
      content,
      usage: { inputTokens: 80, outputTokens: 60 },
      model: 'test-model',
      finishReason: 'stop',
    })
  );
  return { provider: { chat }, chat };
}

const ORIGINAL: RespondentReportContent = {
  summary: 'You are engaged. You answered positively. Your mood is good.',
  sections: [
    { heading: 'Strengths', body: 'Consistent positivity across the board — really strong.' },
    { heading: 'Watch-outs', body: 'A couple of areas to keep an eye on over time.' },
  ],
  actions: ['Keep it up', 'Check in monthly'],
};

/** A structurally-faithful reformat: same headings/order, same action count. */
const FORMATTED = {
  summary: 'You are engaged.\n\nYou answered positively. Your mood is good.',
  sections: [
    { heading: 'Strengths', body: 'Consistent positivity across the board. Really strong.' },
    { heading: 'Watch-outs', body: 'A couple of areas to keep an eye on over time.' },
  ],
  // Deliberately reworded to prove the original actions are used, not these.
  actions: ['Keep the momentum going', 'Review each month'],
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    provider: '',
    model: '',
    fallbackProviders: [],
    systemInstructions: 'You are the report formatter.',
    temperature: 0.2,
    maxTokens: 4096,
  });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'openai',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('formatReportContent', () => {
  it('returns the reformatted prose with formatted:true when structure is preserved', async () => {
    const { provider } = fakeProvider([JSON.stringify(FORMATTED)]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.formatted).toBe(true);
    expect(result.content.summary).toBe(FORMATTED.summary);
    expect(result.content.sections).toEqual(FORMATTED.sections);
    // Cost is surfaced (the fake model has no pricing table, so it computes to 0 here).
    expect(typeof result.costUsd).toBe('number');
  });

  it('accepts a legitimate de-slop that trims prose but stays above the length floor', async () => {
    // The prose-length floor must not over-reject normal polish. This reformat shortens every body
    // (em-dash/filler removal) to ~70% of the original — comfortably above MIN_PROSE_RATIO (0.5) —
    // so the guard should ACCEPT it (formatted: true), proving the floor permits real de-slopping,
    // not only that it rejects gross truncation.
    const trimmed = {
      summary: 'You are engaged. You answered positively. Your mood is good.',
      sections: [
        { heading: 'Strengths', body: 'Consistent positivity across the board. Strong work.' },
        { heading: 'Watch-outs', body: 'A few areas to keep an eye on over time.' },
      ],
      actions: FORMATTED.actions,
    };
    // Guard against the fixture silently drifting below the floor: keep this test meaningful.
    const origLen =
      ORIGINAL.summary.length + ORIGINAL.sections.reduce((n, s) => n + s.body.length, 0);
    const trimLen =
      trimmed.summary.length + trimmed.sections.reduce((n, s) => n + s.body.length, 0);
    expect(trimLen / origLen).toBeGreaterThan(0.5);
    expect(trimLen).toBeLessThan(origLen); // it really is a trim, not equal-length

    const { provider } = fakeProvider([JSON.stringify(trimmed)]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.formatted).toBe(true);
    expect(result.content.summary).toBe(trimmed.summary);
    expect(result.content.sections).toEqual(trimmed.sections);
  });

  it('passes the original actions through verbatim (never the reworded ones)', async () => {
    const { provider } = fakeProvider([JSON.stringify(FORMATTED)]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.content.actions).toEqual(ORIGINAL.actions);
  });

  it('falls back to the original when the section COUNT changes', async () => {
    const drift = {
      ...FORMATTED,
      sections: [...FORMATTED.sections, { heading: 'Bonus', body: 'An invented extra section.' }],
    };
    const { provider } = fakeProvider([JSON.stringify(drift)]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
    // On a structural-drift fallback the pass still reports its (real) cost, not a hardcoded 0.
    expect(typeof result.costUsd).toBe('number');
  });

  it('falls back to the original when a HEADING changes', async () => {
    const drift = {
      ...FORMATTED,
      sections: [
        { heading: 'Your Strengths', body: FORMATTED.sections[0].body },
        FORMATTED.sections[1],
      ],
    };
    const { provider } = fakeProvider([JSON.stringify(drift)]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
  });

  it('falls back to the original when the ACTION count changes', async () => {
    const drift = { ...FORMATTED, actions: ['Only one action'] };
    const { provider } = fakeProvider([JSON.stringify(drift)]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
  });

  it('falls back to the original when a body is largely truncated (prose-length floor)', async () => {
    // Structure intact (same headings/counts) but a section body gutted below the 50% prose floor —
    // gross content loss the structural checks alone would miss.
    const gutted = {
      ...FORMATTED,
      summary: 'You are engaged.',
      sections: [
        { heading: 'Strengths', body: 'Good.' },
        { heading: 'Watch-outs', body: 'Ok.' },
      ],
    };
    const { provider } = fakeProvider([JSON.stringify(gutted)]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
  });

  it('falls back (never throws) when the agent lookup itself errors', async () => {
    (prisma.aiAgent.findUnique as Mock).mockRejectedValue(new Error('db pool exhausted'));

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(getProvider).not.toHaveBeenCalled();
    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
  });

  it('falls back to the original when the model output cannot be parsed (both attempts)', async () => {
    // Invalid JSON on the first attempt AND the temp-0 retry → runner throws → guard catches.
    const { provider, chat } = fakeProvider(['not json at all', 'still not json']);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(chat).toHaveBeenCalledTimes(2); // first + retry
    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
  });

  it('falls back (never throws) when the provider errors', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('provider down'));
    (getProvider as Mock).mockResolvedValue({ chat });

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
  });

  it('falls back without a provider call when the formatter agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);

    const result = await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(getProvider).not.toHaveBeenCalled();
    expect(result.formatted).toBe(false);
    expect(result.content).toEqual(ORIGINAL);
  });

  it('resolves the formatter agent at the cheaper chat tier', async () => {
    const { provider } = fakeProvider([JSON.stringify(FORMATTED)]);
    (getProvider as Mock).mockResolvedValue(provider);

    await formatReportContent(ORIGINAL, { format: 'plaintext' });

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(expect.anything(), 'chat');
  });

  it('sends the plaintext convention (no markdown) for the plaintext format', async () => {
    const { provider, chat } = fakeProvider([JSON.stringify(FORMATTED)]);
    (getProvider as Mock).mockResolvedValue(provider);

    await formatReportContent(ORIGINAL, { format: 'plaintext' });
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toMatch(/plain text/i);
    expect(system?.content).toMatch(/preserve meaning exactly/i);
  });

  it('sends the markdown convention for the markdown format', async () => {
    const { provider, chat } = fakeProvider([JSON.stringify(FORMATTED)]);
    (getProvider as Mock).mockResolvedValue(provider);

    await formatReportContent(ORIGINAL, { format: 'markdown' });
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toMatch(/output markdown/i);
  });
});
