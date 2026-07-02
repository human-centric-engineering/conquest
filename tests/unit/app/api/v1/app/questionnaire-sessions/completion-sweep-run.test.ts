/**
 * runCompletionSweep — the submit-time contradiction detector dispatch (F7.3).
 *
 * Prisma (agent lookup), the capability dispatcher, and the registration flush are mocked, so this
 * pins the gating (≥2 answers floor), the fail-soft paths (agent missing / dispatch error → clean),
 * and the success path (findings + cost returned) without an LLM call.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/completion-sweep-run.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

import { runCompletionSweep } from '@/app/api/v1/app/questionnaire-sessions/_lib/completion-sweep-run';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import type { CapabilitySlotView } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import type { ExistingAnswerView } from '@/lib/app/questionnaire/orchestrator';

type Mock = ReturnType<typeof vi.fn>;

const slot = (key: string): CapabilitySlotView => ({
  id: `id-${key}`,
  key,
  sectionId: 's1',
  prompt: `Prompt ${key}`,
  type: 'free_text',
  required: false,
});
const answer = (slotKey: string): ExistingAnswerView => ({
  slotKey,
  value: 'v',
  provenance: 'direct',
  confidence: 0.9,
});

const input = (over: Partial<Parameters<typeof runCompletionSweep>[0]> = {}) => ({
  sessionId: 'sess-1',
  userId: 'user-1',
  slots: [slot('a'), slot('b')],
  answers: [answer('a'), answer('b')],
  mode: 'probe' as const,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    id: 'agent-1',
    provider: 'openai',
    model: 'gpt',
    fallbackProviders: [],
  });
});

describe('runCompletionSweep', () => {
  it('no-ops (clean) with fewer than two answered slots — never dispatches', async () => {
    const out = await runCompletionSweep(input({ answers: [answer('a')], slots: [slot('a')] }));
    expect(out).toEqual({ findings: [], costUsd: 0 });
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('treats a missing detector agent as clean (fail-soft) — never dispatches', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const out = await runCompletionSweep(input());
    expect(out).toEqual({ findings: [], costUsd: 0 });
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns the detector findings + cost on a successful dispatch (windowN 0, no currentStatement)', async () => {
    const findings = [
      { slotKeys: ['a', 'b'], explanation: 'x', severity: 'medium', confidence: 0.8 },
    ];
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { findings, costUsd: 0.0031 },
    });

    const out = await runCompletionSweep(input());

    expect(out).toEqual({ findings, costUsd: 0.0031 });
    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    // The sweep compares ALL answers and has no triggering message.
    expect(args.windowN).toBe(0);
    expect(args.currentStatement).toBeUndefined();
    expect(args.answers).toHaveLength(2);
  });

  it('treats a failed dispatch as clean (fail-soft)', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable' },
    });
    const out = await runCompletionSweep(input());
    expect(out).toEqual({ findings: [], costUsd: 0 });
  });

  it('trims slots to only the answered ones before dispatch', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { findings: [], costUsd: 0 },
    });
    // Three slots defined, only two answered → the unanswered slot is not sent.
    await runCompletionSweep(input({ slots: [slot('a'), slot('b'), slot('c')] }));
    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(args.slots.map((s: { key: string }) => s.key)).toEqual(['a', 'b']);
  });
});
