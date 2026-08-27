/**
 * Unit test: the Conditional Topics arm of `loadLaunchReadiness`.
 *
 * Scoped deliberately. The module resolves nine readiness facts and the other eight are pinned by
 * `launchReadinessChecks`' own tests; what has never had coverage is the **scope** arm — the one
 * that decides whether a version's routing setup blocks launch. F17.15 widened it (the scoring
 * schema is now loaded and threaded into `validateConditionalTopics`), and the failure mode if that
 * thread breaks is silent: the Conditional topics tab reports an error the launch gate does not, and
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
  appQuestionnaireTopic: { count: vi.fn(), findFirst: vi.fn() },
  appQuestionnaireTopicDraft: { findUnique: vi.fn() },
  appAiRun: { findFirst: vi.fn(), count: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const topicMock = vi.hoisted(() => ({
  loadConditionalTopicsSettings: vi.fn(),
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

// The seeded-analyst check behind the unreviewed-proposal row. Seeded by default, so the tests
// that are not about it see the row they are about.
vi.mock('@/app/api/v1/app/questionnaires/_lib/routing-analysis', () => ({
  loadRoutingAnalystAgent: vi.fn(),
}));

import { loadLaunchReadiness } from '@/app/api/v1/app/questionnaires/_lib/launchability';
import { slotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { dataSlotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import { loadRoutingAnalystAgent } from '@/app/api/v1/app/questionnaires/_lib/routing-analysis';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
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
    trigger: null,
  };
}

function settings(overrides: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true, ...overrides };
}

/** An otherwise launch-ready version, so any failure the test sees comes from the scope arm. */
beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
    goal: 'Understand readiness',
    audience: { who: 'Sales leaders at mid-market firms' },
    conditionalTopicsCandidate: null,
  });
  prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
  prismaMock.appQuestionSlot.count.mockResolvedValue(1);
  prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);
  prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({ selectionStrategy: 'weighted' });
  prismaMock.appDataSlot.count.mockResolvedValue(1);
  prismaMock.appDataSlot.findMany.mockResolvedValue([]);
  prismaMock.appScoringSchema.findUnique.mockResolvedValue(null);
  prismaMock.appQuestionnaireTopic.count.mockResolvedValue(0);
  prismaMock.appQuestionnaireTopic.findFirst.mockResolvedValue(null);
  prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(null);
  prismaMock.appAiRun.findFirst.mockResolvedValue(null);
  prismaMock.appAiRun.count.mockResolvedValue(0);
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
  (loadRoutingAnalystAgent as unknown as Mock).mockResolvedValue({
    id: 'agent-1',
    provider: 'openai',
    model: 'gpt-5.4',
    fallbackProviders: [],
  });
  topicMock.loadConditionalTopicsSettings.mockResolvedValue(DEFAULT_CONDITIONAL_TOPICS_SETTINGS);
  topicMock.loadTopics.mockResolvedValue([topic('spine', ['q1'])]);
});

function scopeCheck(checks: { key: string; ok: boolean }[]) {
  return checks.find((c) => c.key === 'conditionalTopics');
}

function scopeOffCheck(checks: { key: string; ok: boolean; label: string }[]) {
  return checks.find((c) => c.key === 'conditionalTopicsOff');
}

describe('loadLaunchReadiness — the Conditional Topics arm', () => {
  it('does not check scope coherence at all while the feature is off', async () => {
    // The topic set of a version that never opted in is not a launch concern, and re-reading it
    // would cost three queries on every launch check for nothing.
    const result = await loadLaunchReadiness('ver-1');

    expect(result.ready).toBe(true);
    expect(topicMock.loadTopics).not.toHaveBeenCalled();
    expect(prismaMock.appScoringSchema.findUnique).not.toHaveBeenCalled();
  });

  it('passes once the topic set is coherent', async () => {
    topicMock.loadConditionalTopicsSettings.mockResolvedValue(settings());
    topicMock.loadTopics.mockResolvedValue([
      { ...topic('open', ['q1']), phase: 'opening' as const },
      { ...topic('cond', []), phase: 'conditional' as const, criteria: 'when it fits' },
    ]);

    const result = await loadLaunchReadiness('ver-1');

    expect(scopeCheck(result.checks)?.ok).toBe(true);
  });

  it('blocks launch on a question that belongs to no topic', async () => {
    topicMock.loadConditionalTopicsSettings.mockResolvedValue(settings());
    topicMock.loadTopics.mockResolvedValue([{ ...topic('open', []), phase: 'opening' as const }]);
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);

    const result = await loadLaunchReadiness('ver-1');

    expect(scopeCheck(result.checks)?.ok).toBe(false);
    expect(result.ready).toBe(false);
  });

  it('blocks launch when a scored question exists but belongs to no topic (F17.15)', async () => {
    // The thread that must not break: with Conditional Topics on, `q_orphan` can never be asked, so the
    // scale silently loses an item. The Topics tab says so and the gate has to agree.
    topicMock.loadConditionalTopicsSettings.mockResolvedValue(settings());
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
    topicMock.loadConditionalTopicsSettings.mockResolvedValue(settings());
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

describe('loadLaunchReadiness — conditional topics with the feature off', () => {
  it('warns without blocking, and still calls the version ready', async () => {
    // The state F17.22 was written for: the analyst proposed conditional topics, an admin accepted
    // them, and nothing between here and the respondent is choosing between them.
    prismaMock.appQuestionnaireTopic.count.mockResolvedValue(3);

    const result = await loadLaunchReadiness('ver-1');

    expect(scopeOffCheck(result.checks)?.ok).toBe(false);
    expect(scopeOffCheck(result.checks)?.label).toContain('3 conditional topics');
    // The whole point: a warning row must not make a launchable version report itself unready.
    expect(result.ready).toBe(true);
  });

  it('says nothing when the version has no conditional topics', async () => {
    const result = await loadLaunchReadiness('ver-1');

    expect(scopeOffCheck(result.checks)).toBeUndefined();
    expect(result.ready).toBe(true);
  });

  it('says nothing once the feature is on, however many conditional topics there are', async () => {
    prismaMock.appQuestionnaireTopic.count.mockResolvedValue(3);
    topicMock.loadConditionalTopicsSettings.mockResolvedValue(settings());
    topicMock.loadTopics.mockResolvedValue([
      { ...topic('open', ['q1']), phase: 'opening' as const },
      { ...topic('cond', []), phase: 'conditional' as const, criteria: 'when it fits' },
    ]);

    const result = await loadLaunchReadiness('ver-1');

    expect(scopeOffCheck(result.checks)).toBeUndefined();
    expect(scopeCheck(result.checks)).toBeDefined();
  });
});

describe('loadLaunchReadiness — the unreviewed-proposal arm', () => {
  /** A cached candidacy verdict, as `conditionalTopicsCandidate` stores it on the version. */
  function candidate(isCandidate: boolean) {
    return {
      goal: 'Understand readiness',
      audience: { who: 'Sales leaders at mid-market firms' },
      conditionalTopicsCandidate: {
        isCandidate,
        confidence: 0.8,
        signals: [],
        summary: 'Section 3 is addressed to franchise owners only.',
      },
    };
  }

  function reviewCheck(checks: { key: string; ok: boolean; label: string }[]) {
    return checks.find((c) => c.key === 'conditionalTopicsReview');
  }

  /**
   * A stored proposal, shaped as `narrowProposedTopicSet` actually accepts it.
   *
   * Written out rather than stubbed to a bare `{ topics: [...] }`: the narrow drops any topic
   * missing a key or a label, so a loose fixture reads as an EMPTY proposal — the row vanishes and
   * the test passes for the wrong reason.
   */
  function draftOf(keys: string[]) {
    return {
      topics: {
        v: 1,
        topics: keys.map((key) => ({
          key,
          label: `Topic ${key}`,
          phase: 'conditional',
          criteria: 'when it fits what they said',
          depth: 'full',
          // Nested, as `ProposedTopic` declares it — `narrowTopicMembers` reads `t.members`, so
          // top-level key lists are silently dropped and every topic reads as member-less.
          members: { questionKeys: [], dataSlotKeys: [] },
          rationale: 'the document says so',
        })),
        rules: [],
        gaps: [],
      },
    };
  }

  it("blocks launch while the analyst's proposal is still pending review", async () => {
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(draftOf(['a', 'b']));

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)?.label).toBe('2 suggested topics are waiting for review');
    expect(result.ready).toBe(false);
  });

  it('does not pay for the candidacy queries when there is a proposal to review', async () => {
    // The draft is conclusive on its own. Asking "is a run still owed?" as well would cost two
    // AppAiRun reads and a topic lookup to reach the row it already reached.
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(draftOf(['a']));

    await loadLaunchReadiness('ver-1');

    // All three, because the comment above names all three: an assertion on one of them would
    // still pass if the guard were narrowed to skip only that one.
    expect(prismaMock.appAiRun.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.appAiRun.count).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireTopic.findFirst).not.toHaveBeenCalled();
  });

  it('blocks launch on a flagged document whose proposal was never produced', async () => {
    // The non-streaming ingest path leaves exactly this: a verdict cached at ingest, the analyst
    // owed a run it only takes on the first Topics-tab visit.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(candidate(true));

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)?.label).toMatch(/describes who should be asked what/);
    expect(result.ready).toBe(false);
  });

  it('says nothing when the check read the document and found no routing', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(candidate(false));

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)).toBeUndefined();
    expect(result.ready).toBe(true);
  });

  it('stops blocking once the analyst has actually run', async () => {
    // A succeeded run is the durable "already tried" signal. Without this the row would outlive
    // the work it asks for — including for an admin who reviewed and discarded the proposal.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(candidate(true));
    prismaMock.appAiRun.findFirst.mockResolvedValue({ id: 'run-1' });

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)).toBeUndefined();
    expect(result.ready).toBe(true);
  });

  it('never holds a launch hostage to a broken provider', async () => {
    // Bounded retries: once they are spent the automation is done trying, and a launch must not
    // wait forever on a run that cannot succeed.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(candidate(true));
    prismaMock.appAiRun.count.mockResolvedValue(99);

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)).toBeUndefined();
    expect(result.ready).toBe(true);
  });

  it('says nothing about a flagged document once the feature is already on', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(candidate(true));
    topicMock.loadConditionalTopicsSettings.mockResolvedValue(settings());

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)).toBeUndefined();
  });

  it('agrees with the Topics tab about an empty proposal', async () => {
    // A draft row that narrows to zero topics is a draft row. Reading "no draft" from a zero-TOPIC
    // count made this gate block with "the suggested topics are not reviewed yet" while the Topics
    // tab — which asks `draft !== null` — reported nothing pending and never auto-fired, leaving
    // the admin with an empty proposal card and a launch they could not make.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(candidate(true));
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue({
      topics: { v: 1, topics: [], rules: [], gaps: [] },
    });

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)).toBeUndefined();
    expect(result.ready).toBe(true);
  });

  it('never blocks a launch the admin has no way to unblock', async () => {
    // With the Routing Analyst unseeded, no `AppAiRun` is ever written — the dispatcher is the only
    // writer of a failed one, and the analyse route returns ahead of it — so the bounded retries
    // never run out and this row would never clear. The admin would be sent to a tab whose auto-run
    // is silent, find nothing, and be left with "turn Conditional Topics on" or "hand-author a
    // topic" as the only exits: the coercion the whole design refuses.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(candidate(true));
    (loadRoutingAnalystAgent as unknown as Mock).mockResolvedValue(null);

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)).toBeUndefined();
    expect(result.ready).toBe(true);
  });

  it('still blocks on a pending proposal when the analyst is unseeded', async () => {
    // The other half of the same rule: a draft that already exists needs no analyst to resolve it.
    // Accept or discard are both local, so the exit stays open and the row stays a blocker.
    (loadRoutingAnalystAgent as unknown as Mock).mockResolvedValue(null);
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(draftOf(['a']));

    const result = await loadLaunchReadiness('ver-1');

    expect(reviewCheck(result.checks)?.label).toBe('1 suggested topic is waiting for review');
    expect(result.ready).toBe(false);
  });

  it('is skipped entirely for the preview gate', async () => {
    // Rehearsing the draft is how an admin decides what to do about the proposal. Blocking the
    // rehearsal on having already decided inverts the order the work happens in — and the draft
    // is not live, so nothing a preview session does depends on it.
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(draftOf(['a']));

    const result = await loadLaunchReadiness('ver-1', { includeConditionalTopicsReview: false });

    expect(reviewCheck(result.checks)).toBeUndefined();
    expect(result.ready).toBe(true);
    expect(prismaMock.appQuestionnaireTopicDraft.findUnique).not.toHaveBeenCalled();
  });
});
