/**
 * Integration test: the refinement read-context builder (F4.4).
 *
 * `buildRefinementContext` is the read-side DB seam — it maps a version's persisted
 * slots into the in-memory `RefinementContext` the refiner reads. Prisma is mocked
 * (house convention). The refine-answer route test exercises the common paths; this
 * pins the ones the route body can't reach (caller-supplied `refinementHistory` /
 * `recentMessages`, a defensively-narrowed stored slot type) plus the two failure
 * modes, so the builder's branches are covered without routing through HTTP.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { buildRefinementContext } from '@/app/api/v1/app/questionnaires/_lib/refinement-context';

type Mock = ReturnType<typeof vi.fn>;

function versionRow(typeOverride?: string) {
  return {
    id: 'v1',
    sections: [
      {
        id: 's1',
        questions: [
          {
            id: 'q-color',
            key: 'color',
            type: typeOverride ?? 'single_choice',
            typeConfig: { choices: [{ value: 'red' }, { value: 'green' }] },
            prompt: 'Favourite colour?',
            guidelines: 'pick one',
            required: true,
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(versionRow());
});

describe('buildRefinementContext', () => {
  it('returns version_not_found when the id/versionId pair does not resolve', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(null);
    const result = await buildRefinementContext('qn-1', 'v1', {
      existingAnswers: [{ key: 'color', value: 'red', provenance: 'direct' }],
    });
    expect(result).toEqual({ ok: false, reason: 'version_not_found' });
  });

  it('returns no_resolvable_answers when every supplied answer has a stale key', async () => {
    const result = await buildRefinementContext('qn-1', 'v1', {
      existingAnswers: [{ key: 'ghost', value: 'x', provenance: 'direct' }],
    });
    expect(result).toEqual({ ok: false, reason: 'no_resolvable_answers' });
  });

  it('projects slots (carrying ids + guidelines) and threads all caller-supplied optionals', async () => {
    const result = await buildRefinementContext('qn-1', 'v1', {
      existingAnswers: [
        {
          key: 'color',
          value: 'red',
          provenance: 'inferred',
          rationale: 'guessed',
          confidence: 0.6,
          turnIndex: 3,
          refinementHistory: [
            {
              previousValue: 'blue',
              previousProvenance: 'direct',
              newValue: 'red',
              rationale: 'first refine',
              source: 'clarification',
            },
          ],
        },
      ],
      userMessage: 'actually green',
      triggeringContradiction: {
        slotKeys: ['color'],
        explanation: 'blue then red',
        suggestedProbe: 'which?',
      },
      recentMessages: ['user: red', 'user: actually green'],
      sessionId: 'sess-supplied',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { context } = result;
    // Slot projection carries the id (for the write path) and guidelines.
    expect(context.slots[0]).toMatchObject({ id: 'q-color', key: 'color', guidelines: 'pick one' });
    // Every optional on the answer is threaded through.
    expect(context.existingAnswers[0]).toMatchObject({
      slotKey: 'color',
      provenance: 'inferred',
      rationale: 'guessed',
      confidence: 0.6,
      turnIndex: 3,
    });
    expect(context.existingAnswers[0]?.refinementHistory).toHaveLength(1);
    // Context-level optionals.
    expect(context.userMessage).toBe('actually green');
    expect(context.triggeringContradiction?.explanation).toBe('blue then red');
    expect(context.recentMessages).toHaveLength(2);
    expect(context.sessionId).toBe('sess-supplied');
  });

  it('defaults the sessionId to a per-version preview id when none is supplied', async () => {
    const result = await buildRefinementContext('qn-1', 'v1', {
      existingAnswers: [{ key: 'color', value: 'red', provenance: 'direct' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.sessionId).toBe('preview-v1');
  });

  it('defensively narrows an unknown stored slot type to free_text', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(
      versionRow('bogus_type')
    );
    const result = await buildRefinementContext('qn-1', 'v1', {
      existingAnswers: [{ key: 'color', value: 'red', provenance: 'direct' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.slots[0]?.type).toBe('free_text');
  });
});
