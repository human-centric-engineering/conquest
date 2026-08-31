/**
 * Unit tests: the adviser's guardrails.
 *
 * `applyPicks` is the whole "the adviser cannot invent a colour" guarantee — the sibling of the
 * import's `narrowAssignments`, and tested directly for the same reason: a guarantee exercised only
 * through a mocked provider is a guarantee nobody is really checking.
 *
 * The model returns an INDEX into a list it did not write. Everything it could get wrong therefore
 * has exactly one safe answer — fall back to the deterministic pick — and these tests pin each one,
 * because the failure they prevent is silent: a proposal that looks considered and points at a
 * colour nothing proved would work.
 *
 * @see lib/app/questionnaire/brand-contrast/advise.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The same wiring `assign-roles.test.ts` mocks for the sibling import analyst: Prisma for the
// agent row, the provider/resolver pair, the structured-completion runner, and cost logging.
// `applyPicks` and `recommendDefault` are pure and need none of it — only the `advise()` describe
// block below exercises this mocked wiring.
const prismaMock = vi.hoisted(() => ({ aiAgent: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const providerMock = vi.hoisted(() => ({ getProvider: vi.fn(async () => ({ name: 'test' })) }));
vi.mock('@/lib/orchestration/llm/provider-manager', () => providerMock);

const resolverMock = vi.hoisted(() => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({
    providerSlug: 'openai',
    model: 'gpt-test',
    fallbacks: [],
  })),
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => resolverMock);

const completionMock = vi.hoisted(() => ({ runStructuredCompletion: vi.fn() }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => completionMock);

const costMock = vi.hoisted(() => ({ logAppLlmCost: vi.fn() }));
vi.mock('@/lib/app/questionnaire/llm/log-app-cost', () => costMock);

import {
  advise,
  applyPicks,
  describeRepair,
  recommendDefault,
} from '@/lib/app/questionnaire/brand-contrast/advise';
import type { AuditedPair } from '@/lib/app/questionnaire/brand-contrast/audit';

function audited(over: Partial<AuditedPair['finding']> = {}): AuditedPair {
  return {
    finding: {
      pair: 'canvas-light',
      label: 'Body text on the page',
      ground: '#fffcf5',
      ink: '#9a9a8f',
      ratio: 2.77,
      target: 4.5,
      onDerivedValue: false,
      ...over,
    },
    repairs: [
      {
        field: 'inkColor',
        label: 'Ink colour',
        from: '#9a9a8f',
        current: '#9a9a8f',
        to: '#75756d',
        resultingGround: '#fffcf5',
        resultingInk: '#75756d',
        ratio: 4.53,
        amount: -0.24,
      },
      {
        field: 'canvasColor',
        label: 'Canvas colour',
        from: '#fffcf5',
        current: '#fffcf5',
        to: '#333231',
        resultingGround: '#333231',
        resultingInk: '#9a9a8f',
        ratio: 4.5,
        amount: -0.8,
      },
    ],
  };
}

const AGENT_ROW = {
  id: 'agent-1',
  provider: '',
  model: '',
  fallbackProviders: [],
  systemInstructions: 'You advise on brand colour.',
  temperature: 0.2,
  maxTokens: 900,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
  resolverMock.resolveAgentProviderAndModel.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-test',
    fallbacks: [],
  });
  providerMock.getProvider.mockResolvedValue({ name: 'test' });
});

describe('advise', () => {
  it('short-circuits with no model call when there is nothing to advise on', async () => {
    // Nothing to hand the model a numbered list of — the same guard that keeps the optimiser from
    // asking about a finding with zero repairs.
    const result = await advise({ audited: [] });
    expect(result).toEqual({ proposals: [], degraded: false });
    expect(prismaMock.aiAgent.findUnique).not.toHaveBeenCalled();
  });

  it('throws when the adviser agent is not seeded, for the caller to treat as degraded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    await expect(advise({ audited: [audited()] })).rejects.toThrow('not seeded');
    expect(completionMock.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('turns a valid reply into proposals via applyPicks, not by trusting it directly', async () => {
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: {
        picks: [{ pair: 'canvas-light', repair: 1, why: 'The paper stock is the brand.' }],
      },
      tokenUsage: { input: 10, output: 5 },
    });

    const result = await advise({ audited: [audited()] });

    expect(result.degraded).toBe(false);
    expect(result.proposals[0].chosen).toBe(1);
    expect(result.proposals[0].rationale).toBe('The paper stock is the brand.');
  });

  it('falls back to the deterministic pick when the reply carries no picks at all', async () => {
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: {},
      tokenUsage: { input: 10, output: 5 },
    });

    const result = await advise({ audited: [audited()] });

    expect(result.proposals[0].chosen).toBe(0);
  });

  it('sends the audited findings as a numbered list the model can only choose from', async () => {
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: { picks: [] },
      tokenUsage: null,
    });

    await advise({ audited: [audited()] });

    const call = completionMock.runStructuredCompletion.mock.calls[0][0];
    expect(call.messages[1].content).toContain('canvas-light');
    expect(call.messages[1].content).toContain('0: change Ink colour');
    expect(call.responseSchemaName).toBe('contrast_advice');
  });

  it('logs cost under the app_brand_contrast capability with a null versionId', async () => {
    // Version-less because a theme belongs to a demo client, not to any questionnaire version —
    // the same reasoning the brand import's cost log follows.
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: { picks: [] },
      tokenUsage: { input: 10, output: 5 },
    });

    await advise({ audited: [audited()], demoClientId: 'dc-1' });

    expect(costMock.logAppLlmCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        capability: 'app_brand_contrast',
        versionId: null,
        extra: expect.objectContaining({ demoClientId: 'dc-1', findings: 1 }),
      })
    );
  });
});

describe('recommendDefault', () => {
  it('takes the nearest repair — the smallest change to the brand', () => {
    const proposal = recommendDefault(audited());
    expect(proposal.chosen).toBe(0);
  });

  it('reads the direction off the signed ramp, not off the two hexes', () => {
    // Comparing hexes as strings reads `#ff0000` as lighter than `#00ff00`, which would tell the
    // admin a colour got lighter while they watched it darken.
    expect(recommendDefault(audited()).rationale).toContain('deeper');

    const lightened = audited();
    lightened.repairs[0] = { ...lightened.repairs[0], amount: 0.08, to: '#828282' };
    expect(recommendDefault(lightened).rationale).toContain('lighter');
  });

  it('always supplies a rationale, so a degraded run is never a blank line', () => {
    expect(recommendDefault(audited()).rationale.length).toBeGreaterThan(20);
  });
});

describe('applyPicks', () => {
  const pair = audited();

  it('takes a valid pick', () => {
    const [proposal] = applyPicks(
      [pair],
      [{ pair: 'canvas-light', repair: 1, why: 'The cream page is what this brand is known by.' }]
    );
    expect(proposal.chosen).toBe(1);
    expect(proposal.rationale).toBe('The cream page is what this brand is known by.');
  });

  it('never lets a pick change the repairs themselves', () => {
    // The list is ours. The model picks from it and cannot add to it, which is what makes every
    // colour the admin sees one that was PROVED to fix the pair.
    const [proposal] = applyPicks([pair], [{ pair: 'canvas-light', repair: 1, why: 'Because.' }]);
    expect(proposal.repairs).toEqual(pair.repairs);
  });

  it.each([
    ['an index past the end', 9],
    ['a negative index', -1],
    ['a fractional index', 0.5],
    ['not a number at all', Number.NaN],
  ])('falls back to the deterministic pick for %s', (_label, repair) => {
    const [proposal] = applyPicks([pair], [{ pair: 'canvas-light', repair, why: 'Trust me.' }]);
    expect(proposal.chosen).toBe(0);
    expect(proposal.rationale).toBe(recommendDefault(pair).rationale);
  });

  it('ignores a pick for a finding that was never raised', () => {
    const [proposal] = applyPicks([pair], [{ pair: 'surface', repair: 1, why: 'Whatever.' }]);
    expect(proposal.chosen).toBe(0);
  });

  it('keeps the first pick when the model answers a finding twice', () => {
    const [proposal] = applyPicks(
      [pair],
      [
        { pair: 'canvas-light', repair: 1, why: 'First.' },
        { pair: 'canvas-light', repair: 0, why: 'Second.' },
      ]
    );
    expect(proposal.rationale).toBe('First.');
  });

  it('keeps a valid choice but describes it when the model gave no reason', () => {
    // The sentence IS the advice, so a blank line under the swatch is not an option. Borrowing
    // `recommendDefault`'s sentence is not one either: it describes repair 0, so under a pick of
    // repair 1 it would narrate a change the proposal is not making.
    const [proposal] = applyPicks([pair], [{ pair: 'canvas-light', repair: 1, why: '   ' }]);
    expect(proposal.chosen).toBe(1);
    expect(proposal.rationale).toBe(describeRepair(pair.repairs[1], false));
    expect(proposal.rationale).toContain('the page it sits on');
  });

  it('truncates a runaway rationale rather than letting it fill the dialog', () => {
    const [proposal] = applyPicks(
      [pair],
      [{ pair: 'canvas-light', repair: 0, why: 'x'.repeat(4000) }]
    );
    expect(proposal.rationale.length).toBeLessThanOrEqual(240);
  });

  it('recommends deterministically for every finding the model said nothing about', () => {
    const proposals = applyPicks([pair, audited({ pair: 'surface' })], []);
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.chosen === 0)).toBe(true);
  });
});
