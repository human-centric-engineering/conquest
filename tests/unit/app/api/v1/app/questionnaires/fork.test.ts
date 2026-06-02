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
// authoring-routes (imported transitively for jsonInput) touches prisma at load.
vi.mock('@/lib/db/client', () => ({ prisma: { appQuestionSlot: { findFirst: vi.fn() } } }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

import { executeTransaction } from '@/lib/db/utils';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import type { ScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

type Mock = ReturnType<typeof vi.fn>;

let sectionSeq = 0;
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sectionSeq = 0;
  (executeTransaction as unknown as Mock).mockImplementation((cb: (t: typeof tx) => unknown) =>
    cb(tx)
  );
  tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue(sourceGraph());
  tx.appQuestionnaireVersion.findFirst.mockResolvedValue({ versionNumber: 3 });
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
    expect(tx).not.toHaveProperty('appQuestionnaireExtractionChange');
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
});
