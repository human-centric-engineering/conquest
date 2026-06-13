/**
 * Unit tests for `generateAndSaveDataSlots` — the headless generate→save-live seam the demo
 * seed and the backfill script use.
 *
 * Every collaborator is mocked at the module boundary: the version-structure loader, the agent
 * lookup, the capability dispatcher, the capability-registration flush, and the live writer.
 * Tests pin the five outcomes the callers branch on:
 *   - skipped/no_questions  — version has no questions (or wrong questionnaire)
 *   - skipped/agent_missing  — generator agent not seeded
 *   - failed                 — dispatch returns an error (provider/timeout/parse)
 *   - empty                  — dispatch succeeds but proposes no slots (nothing written)
 *   - saved                  — slots written live via replaceDataSlots
 * Plus: the generated→DataSlotInput mapping drops confidence, and replaceDataSlots is NOT
 * called on the non-saved paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-routes', () => ({
  buildDataSlotStructure: vi.fn(),
  replaceDataSlots: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  registerBuiltInCapabilities: vi.fn(),
}));

const { buildDataSlotStructure, replaceDataSlots } =
  await import('@/app/api/v1/app/questionnaires/_lib/data-slot-routes');
const { prisma } = await import('@/lib/db/client');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const { registerBuiltInCapabilities } = await import('@/lib/orchestration/capabilities');
const { generateAndSaveDataSlots } =
  await import('@/app/api/v1/app/questionnaires/_lib/generate-data-slots');

type Mock = ReturnType<typeof vi.fn>;

const STRUCTURE = {
  goal: 'Understand onboarding friction',
  questions: [
    { key: 'q1', prompt: 'How easy was onboarding?', type: 'likert', sectionTitle: 'Start' },
    { key: 'q2', prompt: 'What slowed you down?', type: 'free_text', sectionTitle: 'Start' },
  ],
};

const AGENT = {
  id: 'agent-1',
  provider: 'openai',
  model: 'gpt-4o',
  fallbackProviders: ['anthropic'],
};

const GENERATED_SLOTS = [
  {
    name: 'Onboarding ease',
    description: 'How smoothly the user got started.',
    theme: 'Friction',
    questionKeys: ['q1'],
    confidence: 0.9,
  },
  {
    name: 'Blockers',
    description: 'What prevented progress.',
    theme: 'Friction',
    questionKeys: ['q2'],
    confidence: 0.8,
  },
];

function mockAgentFound(): void {
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateAndSaveDataSlots', () => {
  it('skips with no_questions when the version has no question structure', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(null);

    const result = await generateAndSaveDataSlots('q-1', 'v-1');

    expect(result).toEqual({ status: 'skipped', slotCount: 0, diagnostic: 'no_questions' });
    // Bails before touching the agent / dispatcher / writer.
    expect(prisma.aiAgent.findUnique).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('skips with agent_missing when the generator agent is not seeded', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(STRUCTURE);
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);

    const result = await generateAndSaveDataSlots('q-1', 'v-1');

    expect(result).toEqual({ status: 'skipped', slotCount: 0, diagnostic: 'agent_missing' });
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns failed (with the diagnostic + message) when dispatch errors, writing nothing', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(STRUCTURE);
    mockAgentFound();
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'No provider configured' },
    });

    const result = await generateAndSaveDataSlots('q-1', 'v-1');

    expect(result).toEqual({
      status: 'failed',
      slotCount: 0,
      diagnostic: 'provider_unavailable',
      message: 'No provider configured',
    });
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns empty (writing nothing) when the generator proposes no slots', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(STRUCTURE);
    mockAgentFound();
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { slots: [] },
    });

    const result = await generateAndSaveDataSlots('q-1', 'v-1');

    expect(result).toEqual({ status: 'empty', slotCount: 0 });
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('saves live and reports the persisted count on success', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(STRUCTURE);
    mockAgentFound();
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { slots: GENERATED_SLOTS },
    });
    // replaceDataSlots resolves with the persisted views (count is what the helper reports).
    (replaceDataSlots as Mock).mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    const result = await generateAndSaveDataSlots('q-1', 'v-1');

    expect(result).toEqual({ status: 'saved', slotCount: 2 });

    // Mapping: generated slots → DataSlotInput, dropping `confidence`.
    expect(replaceDataSlots).toHaveBeenCalledWith('v-1', [
      {
        name: 'Onboarding ease',
        description: 'How smoothly the user got started.',
        theme: 'Friction',
        questionKeys: ['q1'],
      },
      {
        name: 'Blockers',
        description: 'What prevented progress.',
        theme: 'Friction',
        questionKeys: ['q2'],
      },
    ]);
  });

  it('flushes capability handlers and threads the agent binding into the dispatch', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(STRUCTURE);
    mockAgentFound();
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { slots: GENERATED_SLOTS },
    });
    (replaceDataSlots as Mock).mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    await generateAndSaveDataSlots('q-1', 'v-1', { granularity: 'granular' });

    expect(registerBuiltInCapabilities).toHaveBeenCalledOnce();

    const [slug, args, context] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(slug).toBe('app_generate_data_slots');
    expect(args).toEqual({ structure: STRUCTURE, versionId: 'v-1', granularity: 'granular' });
    expect(context).toEqual({
      userId: null,
      agentId: 'agent-1',
      entityContext: {
        dataSlotsAgent: {
          provider: 'openai',
          model: 'gpt-4o',
          fallbackProviders: ['anthropic'],
        },
      },
    });
  });

  it('defaults granularity to balanced when none is given', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(STRUCTURE);
    mockAgentFound();
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { slots: GENERATED_SLOTS },
    });
    (replaceDataSlots as Mock).mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    await generateAndSaveDataSlots('q-1', 'v-1');

    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(args.granularity).toBe('balanced');
  });
});
