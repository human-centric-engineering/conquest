/**
 * The opening-routability check (G03 / F17.17) — the fail-soft contract.
 *
 * Only one property here is load-bearing, and it is the one that would be silently wrong: every
 * failure returns `null`, and `null` is not `false` and certainly not `true`. The caller spends the
 * probe on a null, which is what it would have done before this check existed — so a missing agent,
 * a dead provider or a garbled reply can only ever leave the interview asking its follow-up, never
 * skipping one.
 *
 * @see lib/app/questionnaire/scope/routability.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { assessOpeningRoutability } from '@/lib/app/questionnaire/scope/routability';

const CANDIDATES = [
  { key: 'pipeline', label: 'Pipeline', criteria: 'when deals stall before procurement' },
];

const params = {
  sessionId: 's1',
  candidates: CANDIDATES,
  evidence: [
    { asked: 'What is getting in the way?', said: 'We need a predictable revenue engine.' },
  ],
};

const agentRow = { id: 'a1', provider: 'openai', model: 'gpt-x', fallbackProviders: [] };

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(agentRow);
  (resolveAgentProviderAndModel as ReturnType<typeof vi.fn>).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-x',
    fallbacks: [],
  });
  (getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (logCost as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe('assessOpeningRoutability', () => {
  it('returns the verdict and its cost when the check runs', async () => {
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: true, reason: 'They named the section outright.' },
      tokenUsage: { input: 10, output: 5 },
      costUsd: 0.0002,
    });

    await expect(assessOpeningRoutability(params)).resolves.toEqual({
      routable: true,
      reason: 'They named the section outright.',
      costUsd: 0.0002,
    });
  });

  it('never calls a model when there are no criteria to be routable against', async () => {
    await expect(assessOpeningRoutability({ ...params, candidates: [] })).resolves.toBeNull();
    expect(prisma.aiAgent.findUnique).not.toHaveBeenCalled();
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('returns null — not a verdict — when the planner agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(assessOpeningRoutability(params)).resolves.toBeNull();
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('returns null when the agent lookup itself throws', async () => {
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    await expect(assessOpeningRoutability(params)).resolves.toBeNull();
  });

  it('returns null when no provider resolves', async () => {
    (resolveAgentProviderAndModel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no provider')
    );
    await expect(assessOpeningRoutability(params)).resolves.toBeNull();
  });

  it('returns null when the call times out or comes back unparseable', async () => {
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));
    await expect(assessOpeningRoutability(params)).resolves.toBeNull();
  });

  it('asks the planner’s own binding, at the routing tier', async () => {
    // Same agent as the planner deliberately: the check anticipates the planner's own judgement,
    // and a second agent could disagree with it about the very question this exists to predict.
    // The tier differs because this one runs inside a live turn.
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: false, reason: 'A slogan, not a situation.' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0,
    });
    await assessOpeningRoutability(params);
    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'app-scope-planner' } })
    );
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(agentRow, 'routing');
  });

  it('says plainly that nothing was captured rather than sending an empty evidence block', async () => {
    // A model handed an empty section will invent what it thinks should be there. The one honest
    // answer for an opening with nothing in it is "not routable", and it needs to be told why.
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: false, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0,
    });
    await assessOpeningRoutability({ ...params, evidence: [] });

    const system = (runStructuredCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .messages[0].content;
    expect(system).toContain('(nothing has been captured yet)');
  });

  it('skips a blank answer, and omits the goal block when there is no goal', async () => {
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: false, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0,
    });
    await assessOpeningRoutability({
      ...params,
      evidence: [{ asked: 'What is in the way?', said: '   ' }],
      candidates: [{ key: 'k', label: 'Untargeted', criteria: null }],
    });

    const system = (runStructuredCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .messages[0].content;
    expect(system).toContain('(nothing has been captured yet)');
    expect(system).not.toContain('questionnaire_goal');
    // A topic with no criteria still has to be listed — it is a candidate either way.
    expect(system).toContain('Untargeted');
    expect(system).not.toContain('choose when:');
  });

  it('caps the evidence it inlines without letting blanks crowd out real answers', async () => {
    // Slicing before filtering would spend the whole budget on the blanks and render "nothing
    // captured" over an opening that was in fact answered — the check would then decide on the
    // latest message alone, which is precisely the thin evidence it exists to compensate for.
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: false, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0,
    });
    const blanks = Array.from({ length: 25 }, (_, i) => ({ asked: `Blank ${i}`, said: '  ' }));
    await assessOpeningRoutability({
      ...params,
      evidence: [...blanks, { asked: 'What is in the way?', said: 'Deals stall at procurement.' }],
    });

    const system = (runStructuredCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .messages[0].content;
    expect(system).toContain('Deals stall at procurement.');
    expect(system).not.toContain('(nothing has been captured yet)');
  });

  it('frames the goal when it has one', async () => {
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: true, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0,
    });
    await assessOpeningRoutability({ ...params, goal: 'Find the growth constraint' });

    const system = (runStructuredCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .messages[0].content;
    expect(system).toContain('Find the growth constraint');
  });

  it('reports zero cost when the completion carries none', async () => {
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: true, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: undefined,
    });
    await expect(assessOpeningRoutability(params)).resolves.toMatchObject({ costUsd: 0 });
  });

  it('accepts only a well-formed verdict from the parse callback', async () => {
    // The callback is what stands between a garbled reply and a verdict acted on as if it were one.
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: true, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0,
    });
    await assessOpeningRoutability(params);

    const call = (runStructuredCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // `tryParseJson` is mocked through to its real behaviour here only in shape: drive the inner
    // validator directly by handing the callback a raw JSON string.
    expect(call.parse('{"routable":true,"reason":"ok"}')).toEqual({
      routable: true,
      reason: 'ok',
    });
    expect(call.parse('{"routable":"yes"}')).toBeNull();
    expect(call.parse('not json at all')).toBeNull();
    expect(call.onFinalFailure()).toBeInstanceOf(Error);
  });

  it('does not let a cost-logging outage take the verdict down with it', async () => {
    // `logCost` is fire-and-forget. A rejected promise must be reported, not swallowed and not
    // allowed to reject the turn the respondent is waiting on.
    (logCost as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ledger down'));
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: true, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0.001,
    });

    await expect(assessOpeningRoutability(params)).resolves.toMatchObject({ routable: true });
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs a non-Error rejection without stringifying it into nothing', async () => {
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue('db exploded');
    await expect(assessOpeningRoutability(params)).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'db exploded' })
    );
  });

  it('puts the criteria and the latest message in front of the model', async () => {
    (runStructuredCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { routable: false, reason: 'x' },
      tokenUsage: { input: 1, output: 1 },
      costUsd: 0,
    });
    await assessOpeningRoutability({ ...params, latestMessage: 'Deals go dark at procurement.' });

    const call = (runStructuredCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const system = call.messages[0].content;
    // The author's criteria ARE the test — without them the question is unanswerable.
    expect(system).toContain('when deals stall before procurement');
    // And the answer the follow-up would be aimed at, which extraction may not have folded in yet.
    expect(system).toContain('Deals go dark at procurement.');
  });
});
