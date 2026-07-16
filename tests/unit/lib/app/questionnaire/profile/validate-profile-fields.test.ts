/**
 * Unit test: per-field respondent profile validation (F-capture).
 *
 * Covers the three validation modes (deterministic / agentic / hybrid): deterministic format checks,
 * the batched agentic normalise-and-flag LLM pass, hybrid ordering (deterministic gate first), and —
 * critically — the non-fatal fallback (an LLM outage must never block a respondent). The provider
 * lookup, provider, `runStructuredCompletion`, and `logCost` are all mocked so no real I/O runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: vi.fn() }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: loggerMock }));

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

import {
  validateProfileSubmission,
  parseAgentic,
} from '@/lib/app/questionnaire/profile/validate-profile-fields';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';

function field(overrides: Partial<ProfileFieldConfig> & { key: string }): ProfileFieldConfig {
  return {
    label: overrides.key,
    type: 'text',
    required: false,
    validation: 'deterministic',
    ...overrides,
  };
}

/** Build a `runStructuredCompletion` resolved value for the agentic pass. */
function agenticResult(
  results: Array<{ key: string; plausible: boolean; normalized: string; reason?: string }>
) {
  return { value: { results }, tokenUsage: { input: 10, output: 5 }, costUsd: 0.001 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-test',
    fallbacks: [],
  });
  vi.mocked(getProvider).mockResolvedValue({} as never);
  vi.mocked(logCost).mockResolvedValue(null);
});

describe('validateProfileSubmission — deterministic mode', () => {
  it('accepts valid values and never calls the LLM', async () => {
    const fields = [
      field({ key: 'name', type: 'text', required: true }),
      field({ key: 'email', type: 'email' }),
    ];
    const result = await validateProfileSubmission({
      fields,
      raw: { name: 'Ada', email: 'ada@example.com' },
      sessionId: 's1',
    });
    expect(result).toEqual({ ok: true, values: { name: 'Ada', email: 'ada@example.com' } });
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('rejects a missing required field and a malformed email with per-field errors', async () => {
    const fields = [
      field({ key: 'name', type: 'text', required: true }),
      field({ key: 'email', type: 'email', required: true }),
    ];
    const result = await validateProfileSubmission({
      fields,
      raw: { email: 'nope' },
      sessionId: 's1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fieldErrors.name).toBeDefined();
    expect(result.fieldErrors.email).toBeDefined();
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });
});

describe('validateProfileSubmission — agentic mode', () => {
  it('normalises the value the LLM returns and logs cost', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([{ key: 'name', plausible: true, normalized: 'Ada Lovelace' }])
    );
    const fields = [field({ key: 'name', type: 'text', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { name: 'ada   lovelace' },
      sessionId: 's1',
    });
    expect(result).toEqual({ ok: true, values: { name: 'Ada Lovelace' } });
    await flushMicrotasks();
    expect(logCost).toHaveBeenCalledTimes(1);
  });

  it('rejects an implausible value flagged by the LLM', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([
        {
          key: 'name',
          plausible: false,
          normalized: 'asdf',
          reason: 'Looks like placeholder text',
        },
      ])
    );
    const fields = [field({ key: 'name', type: 'text', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { name: 'asdf' },
      sessionId: 's1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fieldErrors.name).toBe('Looks like placeholder text');
  });

  it('is NON-FATAL: an LLM throw falls back to the deterministic value and does not block', async () => {
    vi.mocked(runStructuredCompletion).mockRejectedValue(new Error('provider down'));
    const fields = [field({ key: 'name', type: 'text', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { name: 'Ada Lovelace' },
      sessionId: 's1',
    });
    expect(result).toEqual({ ok: true, values: { name: 'Ada Lovelace' } });
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});

describe('validateProfileSubmission — hybrid mode', () => {
  it('rejects on the deterministic gate WITHOUT spending an LLM call', async () => {
    const fields = [field({ key: 'email', type: 'email', required: true, validation: 'hybrid' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { email: 'not-an-email' },
      sessionId: 's1',
    });
    expect(result.ok).toBe(false);
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('runs the agentic pass only after the deterministic gate passes', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([
        { key: 'email', plausible: false, normalized: '', reason: 'Disposable domain' },
      ])
    );
    const fields = [field({ key: 'email', type: 'email', required: true, validation: 'hybrid' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { email: 'a@test.test' }, // valid shape → passes deterministic → agentic judges it
      sessionId: 's1',
    });
    expect(runStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});

describe('validateProfileSubmission — batching & selection', () => {
  it('sends only agentic/hybrid non-select fields to the LLM in a single call', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([
        { key: 'name', plausible: true, normalized: 'Ada' },
        { key: 'org', plausible: true, normalized: 'Acme' },
      ])
    );
    const fields = [
      field({ key: 'name', type: 'text', validation: 'agentic' }),
      field({ key: 'org', type: 'text', validation: 'hybrid' }),
      field({ key: 'plan', type: 'select', options: ['a', 'b'], validation: 'agentic' }), // select: skipped
      field({ key: 'note', type: 'text', validation: 'deterministic' }), // deterministic: skipped
    ];
    const result = await validateProfileSubmission({
      fields,
      raw: { name: 'ada', org: 'acme', plan: 'a', note: 'hello' },
      sessionId: 's1',
    });
    expect(runStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      values: { name: 'Ada', org: 'Acme', plan: 'a', note: 'hello' },
    });
  });

  it('rejects a number/select field structurally in agentic mode WITHOUT calling the LLM', async () => {
    // agentic softens only text/email to the LLM; number/select stay deterministic.
    const fields = [field({ key: 'size', type: 'number', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { size: 'not-a-number' },
      sessionId: 's1',
    });
    expect(result.ok).toBe(false);
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });
});

describe('validateProfileSubmission — agentic normalisation merge', () => {
  it('keeps the deterministic-coerced NUMBER when the LLM returns a non-numeric normalisation', async () => {
    // Regression: a "tidy" like "1,000"/"42 people" must NOT clobber the coerced number with a string.
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([{ key: 'size', plausible: true, normalized: '1,000 people' }])
    );
    const fields = [field({ key: 'size', type: 'number', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { size: '1000' },
      sessionId: 's1',
    });
    expect(result).toEqual({ ok: true, values: { size: 1000 } }); // stays the coerced number, not a string
  });

  it('accepts a numeric normalisation for a number field', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([{ key: 'size', plausible: true, normalized: '1200' }])
    );
    const fields = [field({ key: 'size', type: 'number', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { size: '1000' },
      sessionId: 's1',
    });
    expect(result).toEqual({ ok: true, values: { size: 1200 } });
  });

  it('keeps the deterministic value when the LLM returns an empty normalisation', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([{ key: 'name', plausible: true, normalized: '   ' }])
    );
    const fields = [field({ key: 'name', type: 'text', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { name: 'Ada' },
      sessionId: 's1',
    });
    expect(result).toEqual({ ok: true, values: { name: 'Ada' } });
  });

  it('keeps the deterministic value when the LLM drops a submitted field from its results', async () => {
    // Two agentic candidates sent; the model returns only one → the other keeps its deterministic value.
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      agenticResult([{ key: 'name', plausible: true, normalized: 'Ada Lovelace' }])
    );
    const fields = [
      field({ key: 'name', type: 'text', validation: 'agentic' }),
      field({ key: 'org', type: 'text', validation: 'agentic' }),
    ];
    const result = await validateProfileSubmission({
      fields,
      raw: { name: 'ada lovelace', org: 'Acme Corp' },
      sessionId: 's1',
    });
    expect(result).toEqual({ ok: true, values: { name: 'Ada Lovelace', org: 'Acme Corp' } });
  });
});

describe('validateProfileSubmission — value length bound', () => {
  it('rejects an oversized agentic text value BEFORE the LLM (cost/DoS guard)', async () => {
    const fields = [field({ key: 'bio', type: 'text', required: true, validation: 'agentic' })];
    const result = await validateProfileSubmission({
      fields,
      raw: { bio: 'x'.repeat(2001) }, // over the 2000-char agentic text ceiling
      sessionId: 's1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fieldErrors.bio).toMatch(/too long/i);
    // The oversized value never reached the paid LLM.
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });
});

describe('parseAgentic (LLM response parser)', () => {
  it('parses a clean JSON response', () => {
    expect(
      parseAgentic('{"results":[{"key":"name","plausible":true,"normalized":"Ada"}]}')
    ).toEqual({
      results: [{ key: 'name', plausible: true, normalized: 'Ada' }],
    });
  });

  it('strips a ```json code fence before parsing', () => {
    const raw =
      '```json\n{"results":[{"key":"n","plausible":false,"normalized":"x","reason":"bad"}]}\n```';
    expect(parseAgentic(raw)?.results[0]?.reason).toBe('bad');
  });

  it('returns null on non-JSON (triggers the retry)', () => {
    expect(parseAgentic('not json at all')).toBeNull();
  });

  it('returns null when the shape fails the schema', () => {
    expect(parseAgentic('{"results":[{"key":"n"}]}')).toBeNull(); // missing plausible/normalized
  });
});
