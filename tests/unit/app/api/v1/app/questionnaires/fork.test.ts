/**
 * Unit tests for the version-fork writer (F2.1 / PR2).
 *
 * The fork decision matrix and deep-copy graph writes are exercised with a mocked
 * `executeTransaction` (invokes the callback against a fake `tx`) — so we assert
 * the exact copy semantics without a database:
 *   - draft target → no fork, original id returned, no writes, no audit;
 *   - launched target → fork: new draft, versionNumber = max+1, goal/audience/
 *     provenance copied, sections/questions deep-copied preserving ordinal/key/
 *     typeConfig, old→new id maps, change records NOT copied, fork audit emitted.
 *
 * `forkVersionIfLaunched` takes the already-loaded ScopedVersion (no re-read of
 * the row the route's `loadScopedVersion` already fetched).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db/utils', () => ({ executeTransaction: vi.fn() }));
// authoring-routes (imported transitively for jsonInput) touches prisma at load; the fork-confirm
// prompt branch reads the version list via prisma.appQuestionnaireVersion.findMany.
const prismaMock = vi.hoisted(() => ({
  appQuestionSlot: { findFirst: vi.fn() },
  appQuestionnaireVersion: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
// Fork confirmation reads the `x-fork-confirm` request header. Default (null) → no header → the
// legacy "fork silently" path, so every pre-existing fork test is unchanged.
const headerState = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () => new Headers(headerState.value ? { 'x-fork-confirm': headerState.value } : {})
  ),
}));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
// The fork trigger reads the route-local (Prisma) blocker counter (F3.2). Stub only the
// Prisma-touching `countLaunchBlockers`; keep the REAL `hasLaunchBlockers` predicate (a pure
// re-export) via importOriginal so the fork decision can't silently drift from production.
const { mockCountLaunchBlockers } = vi.hoisted(() => ({ mockCountLaunchBlockers: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/launch-blockers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/app/api/v1/app/questionnaires/_lib/launch-blockers')
  >()),
  countLaunchBlockers: mockCountLaunchBlockers,
}));

import { executeTransaction } from '@/lib/db/utils';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  forkVersionIfLaunched,
  ForkConfirmationRequiredError,
} from '@/app/api/v1/app/questionnaires/_lib/fork';
import type { ScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

type Mock = ReturnType<typeof vi.fn>;

let sectionSeq = 0;
let tagSeq = 0;
const tx = {
  appQuestionnaireVersion: {
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(async () => ({ id: 'v2' })),
  },
  appQuestionnaireSection: {
    create: vi.fn(async () => ({ id: `newsec-${++sectionSeq}` })),
  },
  appQuestionSlot: {
    createMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => [
      { id: 'newq-1', key: 'full_name' },
      { id: 'newq-2', key: 'team' },
    ]),
  },
  appQuestionTag: {
    create: vi.fn(async () => ({ id: `newtag-${++tagSeq}` })),
  },
  appQuestionSlotTag: {
    createMany: vi.fn(async () => ({ count: 0 })),
  },
  appDataSlot: {
    create: vi.fn(async () => ({ id: 'newds-1' })),
  },
  appDataSlotQuestion: {
    createMany: vi.fn(async () => ({ count: 0 })),
  },
  appQuestionnaireConfig: {
    create: vi.fn(async () => ({ id: 'newcfg-1' })),
  },
  // Present so the "never copies change records" test can assert the write is never ATTEMPTED
  // (behaviour) rather than that the fixture lacks the property (mock structure).
  appQuestionnaireExtractionChange: {
    createMany: vi.fn(async () => ({ count: 0 })),
  },
  // copyVersionGraph carries the pgvector embeddings via raw UPDATE … FROM (the
  // `embedding` column is Prisma-Unsupported), inside the same transaction.
  $executeRawUnsafe: vi.fn(async () => 0),
};

function scoped(overrides: Partial<ScopedVersion> = {}): ScopedVersion {
  return { id: 'v1', questionnaireId: 'qn-1', versionNumber: 2, status: 'launched', ...overrides };
}

/** A launched source version with two sections, the first holding two questions. */
function sourceGraph() {
  return {
    goal: 'Understand onboarding',
    audience: { role: 'new hire' },
    goalProvenance: 'admin-supplied',
    audienceProvenance: { role: 'inferred' },
    sections: [
      {
        id: 'oldsec-1',
        ordinal: 0,
        title: 'About you',
        description: 'Basics',
        questions: [
          {
            id: 'oldq-1',
            ordinal: 0,
            key: 'full_name',
            prompt: 'Your name?',
            guidelines: null,
            rationale: null,
            type: 'free_text',
            typeConfig: null,
            required: true,
            weight: 1,
            extractionConfidence: 0.9,
          },
          {
            id: 'oldq-2',
            ordinal: 1,
            key: 'team',
            prompt: 'Which team?',
            guidelines: 'Pick one',
            rationale: 'Routing',
            type: 'single_choice',
            typeConfig: {
              choices: [
                { value: 'eng', label: 'Eng' },
                { value: 'ops', label: 'Ops' },
              ],
            },
            required: false,
            weight: 2,
            extractionConfidence: null,
          },
        ],
      },
      { id: 'oldsec-2', ordinal: 1, title: 'Experience', description: null, questions: [] },
    ],
    // F2.2 vocabulary: 'Core' on both questions, 'Optional' on the second only.
    tags: [
      {
        id: 'oldtag-1',
        label: 'Core',
        normalizedLabel: 'core',
        color: 'blue',
        slots: [{ questionSlotId: 'oldq-1' }, { questionSlotId: 'oldq-2' }],
      },
      {
        id: 'oldtag-2',
        label: 'Optional',
        normalizedLabel: 'optional',
        color: null,
        slots: [{ questionSlotId: 'oldq-2' }],
      },
    ],
    // Data Slots feature: none on this source (copy is exercised by data-slot-specific tests).
    dataSlots: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sectionSeq = 0;
  tagSeq = 0;
  headerState.value = null; // default: legacy fork-through
  mockCountLaunchBlockers.mockResolvedValue({ sessions: 0, invitations: 0 });
  prismaMock.appQuestionnaireVersion.findMany.mockResolvedValue([]);
  (executeTransaction as unknown as Mock).mockImplementation((cb: (t: typeof tx) => unknown) =>
    cb(tx)
  );
  tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue(sourceGraph());
  tx.appQuestionnaireVersion.findFirst.mockResolvedValue({ versionNumber: 3 });
});

describe('forkVersionIfLaunched — fork confirmation', () => {
  it('throws ForkConfirmationRequiredError (no write) when a launched edit is unconfirmed (prompt)', async () => {
    headerState.value = 'prompt';
    prismaMock.appQuestionnaireVersion.findMany.mockResolvedValue([
      { versionNumber: 2, status: 'launched' },
      { versionNumber: 1, status: 'archived' },
    ]);

    const err = await forkVersionIfLaunched(scoped()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForkConfirmationRequiredError);
    expect((err as ForkConfirmationRequiredError).status).toBe(409);
    expect((err as ForkConfirmationRequiredError).details).toEqual({
      sourceVersionNumber: 2,
      nextVersionNumber: 3, // max existing (2) + 1
      versions: [
        { versionNumber: 2, status: 'launched' },
        { versionNumber: 1, status: 'archived' },
      ],
    });
    // Nothing was written — the throw precedes the transaction.
    expect(executeTransaction).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('forks normally when the launched edit is confirmed', async () => {
    headerState.value = 'confirmed';

    const result = await forkVersionIfLaunched(scoped(), { userId: 'admin-1' });

    expect(result.forked).toBe(true);
    expect(executeTransaction).toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalled();
  });

  it('forks silently (legacy) when no x-fork-confirm header is present', async () => {
    const result = await forkVersionIfLaunched(scoped(), { userId: 'admin-1' });

    expect(result.forked).toBe(true);
    expect(executeTransaction).toHaveBeenCalled();
  });

  it('does not prompt for a draft edit even with the prompt header', async () => {
    headerState.value = 'prompt';
    const result = await forkVersionIfLaunched(scoped({ status: 'draft', versionNumber: 1 }));
    expect(result).toEqual({ versionId: 'v1', forked: false, versionNumber: 1 });
    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('forks a draft version pinned by launch blockers (real hasLaunchBlockers path)', async () => {
    // A draft with a live blocker (invitation/session) must still fork — the OR arm of
    // `status === 'launched' || hasLaunchBlockers(...)` the status-only tests never exercise.
    mockCountLaunchBlockers.mockResolvedValue({ sessions: 0, invitations: 1 });
    const result = await forkVersionIfLaunched(scoped({ status: 'draft', versionNumber: 1 }), {
      userId: 'admin-1',
    });
    expect(result.forked).toBe(true);
    expect(executeTransaction).toHaveBeenCalled();
  });
});

describe('forkVersionIfLaunched — no fork', () => {
  it('returns the original id and does nothing when the version is a draft', async () => {
    const result = await forkVersionIfLaunched(scoped({ status: 'draft', versionNumber: 1 }), {
      userId: 'admin-1',
    });

    expect(result).toEqual({ versionId: 'v1', forked: false, versionNumber: 1 });
    expect(executeTransaction).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe('forkVersionIfLaunched — fork', () => {
  it('creates a new draft with versionNumber = max + 1 and copied goal/audience/provenance', async () => {
    const result = await forkVersionIfLaunched(scoped(), { userId: 'admin-1' });

    expect(result).toMatchObject({ versionId: 'v2', forked: true, versionNumber: 4 });
    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questionnaireId: 'qn-1',
          versionNumber: 4,
          status: 'draft',
          goal: 'Understand onboarding',
          audience: { role: 'new hire' },
          goalProvenance: 'admin-supplied',
          audienceProvenance: { role: 'inferred' },
        }),
      })
    );
  });

  it('recreates sections preserving ordinal/title/description', async () => {
    await forkVersionIfLaunched(scoped());

    expect(tx.appQuestionnaireSection.create).toHaveBeenCalledTimes(2);
    expect(tx.appQuestionnaireSection.create).toHaveBeenNthCalledWith(1, {
      data: { versionId: 'v2', ordinal: 0, title: 'About you', description: 'Basics' },
      select: { id: true },
    });
    const second = (tx.appQuestionnaireSection.create as Mock).mock.calls[1][0].data as Record<
      string,
      unknown
    >;
    expect(second).not.toHaveProperty('description');
  });

  it('carries the question-slot and data-slot embeddings over to the fork', async () => {
    // Regression: a fork used to land adaptive-blind because the typed copy can't
    // touch the Prisma-Unsupported `embedding` column. The graph copy now issues a
    // raw UPDATE … FROM for each slot table, keyed on the per-version-unique `key`.
    await forkVersionIfLaunched(scoped());

    const tables = (tx.$executeRawUnsafe as Mock).mock.calls.map((c) => c[0] as string);
    const questionCopy = tables.find((sql) => sql.includes('"app_question_slot"'));
    const dataCopy = tables.find((sql) => sql.includes('"app_data_slot"'));
    expect(questionCopy).toMatch(/tgt\."key" = src\."key"/);
    expect(dataCopy).toMatch(/tgt\."key" = src\."key"/);
    // Both write the new draft (v2) from the source version (v1): $1=target, $2=source.
    for (const call of (tx.$executeRawUnsafe as Mock).mock.calls) {
      expect(call.slice(1)).toEqual(['v2', 'v1']);
    }
  });

  it('deep-copies questions preserving ordinal, key, type, and typeConfig', async () => {
    await forkVersionIfLaunched(scoped());

    expect(tx.appQuestionSlot.createMany).toHaveBeenCalledTimes(1); // empty section skipped
    const rows = (tx.appQuestionSlot.createMany as Mock).mock.calls[0][0].data as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      versionId: 'v2',
      sectionId: 'newsec-1',
      ordinal: 0,
      key: 'full_name',
      type: 'free_text',
      required: true,
      weight: 1,
    });
    expect(rows[1]).toMatchObject({
      key: 'team',
      type: 'single_choice',
      typeConfig: {
        choices: [
          { value: 'eng', label: 'Eng' },
          { value: 'ops', label: 'Ops' },
        ],
      },
      guidelines: 'Pick one',
    });
  });

  it('returns old→new id maps for sections and questions', async () => {
    const result = await forkVersionIfLaunched(scoped());

    expect(result.sectionIdMap?.get('oldsec-1')).toBe('newsec-1');
    expect(result.sectionIdMap?.get('oldsec-2')).toBe('newsec-2');
    expect(result.questionIdMap?.get('oldq-1')).toBe('newq-1');
    expect(result.questionIdMap?.get('oldq-2')).toBe('newq-2');
  });

  it('emits a fork audit and never copies change records', async () => {
    await forkVersionIfLaunched(scoped(), { userId: 'admin-1', clientIp: '203.0.113.7' });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'questionnaire_version.fork',
        entityType: 'questionnaire_version',
        entityId: 'v2',
        metadata: { questionnaireId: 'qn-1', sourceVersionId: 'v1', versionNumber: 4 },
        clientIp: '203.0.113.7',
      })
    );
    expect(tx.appQuestionnaireExtractionChange.createMany).not.toHaveBeenCalled();
  });

  it('copies the tag vocabulary, preserving label/normalizedLabel and omitting a null colour', async () => {
    const result = await forkVersionIfLaunched(scoped());

    expect(tx.appQuestionTag.create).toHaveBeenCalledTimes(2);
    expect(tx.appQuestionTag.create).toHaveBeenNthCalledWith(1, {
      data: { versionId: 'v2', label: 'Core', normalizedLabel: 'core', color: 'blue' },
      select: { id: true },
    });
    // The uncoloured tag omits `color` rather than writing null.
    const second = (tx.appQuestionTag.create as Mock).mock.calls[1][0].data as Record<
      string,
      unknown
    >;
    expect(second).toMatchObject({
      versionId: 'v2',
      label: 'Optional',
      normalizedLabel: 'optional',
    });
    expect(second).not.toHaveProperty('color');

    expect(result.tagIdMap?.get('oldtag-1')).toBe('newtag-1');
    expect(result.tagIdMap?.get('oldtag-2')).toBe('newtag-2');
  });

  it('re-links assignments through the copied question and tag ids', async () => {
    await forkVersionIfLaunched(scoped());

    expect(tx.appQuestionSlotTag.createMany).toHaveBeenCalledTimes(1);
    const links = (tx.appQuestionSlotTag.createMany as Mock).mock.calls[0][0].data as Array<
      Record<string, string>
    >;
    // 'Core' → both copied questions; 'Optional' → the second copied question.
    expect(links).toEqual([
      { questionSlotId: 'newq-1', tagId: 'newtag-1' },
      { questionSlotId: 'newq-2', tagId: 'newtag-1' },
      { questionSlotId: 'newq-2', tagId: 'newtag-2' },
    ]);
  });

  it('skips the assignment write when the vocabulary has no assignments', async () => {
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue({
      ...sourceGraph(),
      tags: [{ id: 'oldtag-1', label: 'Core', normalizedLabel: 'core', color: null, slots: [] }],
    });

    await forkVersionIfLaunched(scoped());

    expect(tx.appQuestionTag.create).toHaveBeenCalledTimes(1);
    expect(tx.appQuestionSlotTag.createMany).not.toHaveBeenCalled();
  });

  it('writes SQL-NULL for a source with no audience/provenance', async () => {
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue({
      ...sourceGraph(),
      audience: null,
      audienceProvenance: null,
      goal: null,
      goalProvenance: null,
    });

    await forkVersionIfLaunched(scoped());

    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          goal: null,
          audience: Prisma.JsonNull,
          goalProvenance: null,
          audienceProvenance: Prisma.JsonNull,
        }),
      })
    );
  });

  it('copies the run-time config row into the fork when present (F3.1)', async () => {
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue({
      ...sourceGraph(),
      config: {
        selectionStrategy: 'weighted',
        minQuestionsAnswered: 3,
        coverageThreshold: 0.8,
        costBudgetUsd: 2.5,
        maxQuestionsPerSession: 20,
        voiceEnabled: true,
        contradictionMode: 'flag',
        contradictionWindowN: 5,
        anonymousMode: false,
        profileFields: [{ key: 'role', label: 'Role', type: 'text', required: true }],
        respondentReport: {
          enabled: true,
          mode: 'raw_plus_insights',
          rawIncludes: { dataSlots: false, questionsAsPresented: true },
          generation: {
            instructions: 'Be concise.',
            structure: '',
            backgroundContext: 'Quarterly pulse.',
            useClientKnowledge: true,
          },
          delivery: { onScreen: true, download: true },
        },
      },
    });

    await forkVersionIfLaunched(scoped());

    expect(tx.appQuestionnaireConfig.create).toHaveBeenCalledTimes(1);
    const data = (tx.appQuestionnaireConfig.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data).toMatchObject({
      versionId: 'v2',
      selectionStrategy: 'weighted',
      contradictionMode: 'flag',
      contradictionWindowN: 5,
      profileFields: [{ key: 'role', label: 'Role', type: 'text', required: true }],
      // The respondentReport JSON slice forks with the version (1:1 config copy).
      respondentReport: {
        enabled: true,
        mode: 'raw_plus_insights',
        generation: { useClientKnowledge: true },
      },
    });
  });

  it('does not create a config row when the source has none (F3.1)', async () => {
    // The default sourceGraph() carries no config — a no-config source forks to a
    // no-config draft (both resolve to defaults on read).
    await forkVersionIfLaunched(scoped());
    expect(tx.appQuestionnaireConfig.create).not.toHaveBeenCalled();
  });
});
