/**
 * Unit test: the Adaptive Scope arm of `loadLaunchReadiness`.
 *
 * Scoped deliberately. The module resolves nine readiness facts and the other eight are pinned by
 * `launchReadinessChecks`' own tests; what has never had coverage is the **scope** arm — the one
 * that decides whether a version's routing setup blocks launch. F17.15 widened it (the scoring
 * schema is now loaded and threaded into `validateAdaptiveScope`), and the failure mode if that
 * thread breaks is silent: the Adaptive scope tab reports an error the launch gate does not, and
 * the two surfaces disagree about whether a version may go live.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findUnique: vi.fn() },
  appQuestionnaireSection: { count: vi.fn() },
  appQuestionSlot: { count: vi.fn(), findMany: vi.fn() },
  appQuestionnaireConfig: { findUnique: vi.fn() },
  appDataSlot: { count: vi.fn(), findMany: vi.fn() },
  appScoringSchema: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const topicMock = vi.hoisted(() => ({
  loadAdaptiveScopeSettings: vi.fn(),
  loadTopics: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/topic-routes')>()),
  ...topicMock,
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => ({
  slotEmbeddingCoverage: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings', () => ({
  dataSlotEmbeddingCoverage: vi.fn(),
}));

import { loadLaunchReadiness } from '@/app/api/v1/app/questionnaires/_lib/launchability';
import { slotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { dataSlotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type AdaptiveScopeSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';

type Mock = ReturnType<typeof vi.fn>;

function topic(key: string, questionKeys: string[]): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase: 'core',
    criteria: null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys },
    ordinal: 0,
    source: 'manual',
  };
}

function settings(overrides: Partial<AdaptiveScopeSettings> = {}): AdaptiveScopeSettings {
  return { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true, ...overrides };
}

/** An otherwise launch-ready version, so any failure the test sees comes from the scope arm. */
beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
    goal: 'Understand readiness',
    audience: { who: 'Sales leaders at mid-market firms' },
  });
  prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
  prismaMock.appQuestionSlot.count.mockResolvedValue(1);
  prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);
  prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({ selectionStrategy: 'weighted' });
  prismaMock.appDataSlot.count.mockResolvedValue(1);
  prismaMock.appDataSlot.findMany.mockResolvedValue([]);
  prismaMock.appScoringSchema.findUnique.mockResolvedValue(null);
  (slotEmbeddingCoverage as unknown as Mock).mockResolvedValue({
    total: 1,
    embedded: 1,
    missing: 0,
  });
  (dataSlotEmbeddingCoverage as unknown as Mock).mockResolvedValue({
    total: 1,
    embedded: 1,
    missing: 0,
  });
  topicMock.loadAdaptiveScopeSettings.mockResolvedValue(DEFAULT_ADAPTIVE_SCOPE_SETTINGS);
  topicMock.loadTopics.mockResolvedValue([topic('spine', ['q1'])]);
});

function scopeCheck(checks: { key: string; ok: boolean }[]) {
  return checks.find((c) => c.key === 'adaptiveScope');
}

describe('loadLaunchReadiness — the Adaptive Scope arm', () => {
  it('does not check scope coherence at all while the feature is off', async () => {
    // The topic set of a version that never opted in is not a launch concern, and re-reading it
    // would cost three queries on every launch check for nothing.
    const result = await loadLaunchReadiness('ver-1');

    expect(result.ready).toBe(true);
    expect(topicMock.loadTopics).not.toHaveBeenCalled();
    expect(prismaMock.appScoringSchema.findUnique).not.toHaveBeenCalled();
  });

  it('passes once the topic set is coherent', async () => {
    topicMock.loadAdaptiveScopeSettings.mockResolvedValue(settings());
    topicMock.loadTopics.mockResolvedValue([
      { ...topic('open', ['q1']), phase: 'opening' as const },
      { ...topic('cond', []), phase: 'conditional' as const, criteria: 'when it fits' },
    ]);

    const result = await loadLaunchReadiness('ver-1');

    expect(scopeCheck(result.checks)?.ok).toBe(true);
  });

  it('blocks launch on a question that belongs to no topic', async () => {
    topicMock.loadAdaptiveScopeSettings.mockResolvedValue(settings());
    topicMock.loadTopics.mockResolvedValue([{ ...topic('open', []), phase: 'opening' as const }]);
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);

    const result = await loadLaunchReadiness('ver-1');

    expect(scopeCheck(result.checks)?.ok).toBe(false);
    expect(result.ready).toBe(false);
  });

  it('blocks launch when a scored question exists but belongs to no topic (F17.15)', async () => {
    // The thread that must not break: with Adaptive Scope on, `q_orphan` can never be asked, so the
    // scale silently loses an item. The Topics tab says so and the gate has to agree.
    topicMock.loadAdaptiveScopeSettings.mockResolvedValue(settings());
    topicMock.loadTopics.mockResolvedValue([
      { ...topic('open', ['q1']), phase: 'opening' as const },
    ]);
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }, { key: 'q_orphan' }]);
    prismaMock.appScoringSchema.findUnique.mockResolvedValue({
      content: {
        scales: [{ key: 'trust', name: 'Trust' }],
        items: [
          { source: 'question', ref: 'q_orphan', scaleKey: 'trust', weight: 1, reverse: false },
        ],
        bands: [],
        method: 'mean',
      },
    });

    const result = await loadLaunchReadiness('ver-1');

    expect(prismaMock.appScoringSchema.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'ver-1' } })
    );
    expect(scopeCheck(result.checks)?.ok).toBe(false);
    expect(result.ready).toBe(false);
  });

  it('does NOT block launch on a stale scoring reference the admin cannot fix here (F17.15)', async () => {
    // Deleting a question leaves its scoring item behind. Blocking launch on that would strand the
    // admin: the gate points at the Topics tab, and the key is not there to be re-homed.
    topicMock.loadAdaptiveScopeSettings.mockResolvedValue(settings());
    topicMock.loadTopics.mockResolvedValue([
      { ...topic('open', ['q1']), phase: 'opening' as const },
    ]);
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);
    prismaMock.appScoringSchema.findUnique.mockResolvedValue({
      content: {
        scales: [{ key: 'trust', name: 'Trust' }],
        items: [
          { source: 'question', ref: 'q_deleted', scaleKey: 'trust', weight: 1, reverse: false },
        ],
        bands: [],
        method: 'mean',
      },
    });

    const result = await loadLaunchReadiness('ver-1');

    expect(scopeCheck(result.checks)?.ok).toBe(true);
    expect(result.ready).toBe(true);
  });
});
