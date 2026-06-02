/**
 * Unit test: questionnaire detail read models (P2 / F2.1a).
 *
 * Covers getQuestionnaireDetail + getVersionGraph: per-version count mapping, the
 * stored per-field provenance columns (`goalProvenance`/`audienceProvenance`) read
 * directly from the version row (no change-record derivation), the null (→ 404)
 * path, ordered graph projection, and version scoping by both ids.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaire: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findFirst: vi.fn() },
    appQuestionnaireSection: { groupBy: vi.fn() },
    appQuestionSlot: { groupBy: vi.fn() },
    appQuestionnaireExtractionChange: { groupBy: vi.fn() },
  },
}));

import {
  getQuestionnaireDetail,
  getVersionGraph,
} from '@/app/api/v1/app/questionnaires/_lib/detail';
import { prisma } from '@/lib/db/client';

type Mock = ReturnType<typeof vi.fn>;

const findUnique = prisma.appQuestionnaire.findUnique as unknown as Mock;
const findFirst = prisma.appQuestionnaireVersion.findFirst as unknown as Mock;
const sectionGroupBy = prisma.appQuestionnaireSection.groupBy as unknown as Mock;
const slotGroupBy = prisma.appQuestionSlot.groupBy as unknown as Mock;
const changeGroupBy = prisma.appQuestionnaireExtractionChange.groupBy as unknown as Mock;

const D1 = new Date('2026-01-01T00:00:00.000Z');
const D2 = new Date('2026-01-02T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getQuestionnaireDetail', () => {
  it('returns null when the questionnaire is unknown', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getQuestionnaireDetail('missing')).toBeNull();
  });

  it('maps section/question/change counts per version (newest-first)', async () => {
    findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      status: 'draft',
      createdAt: D1,
      updatedAt: D2,
      versions: [
        {
          id: 'ver-2',
          versionNumber: 2,
          status: 'draft',
          goal: 'Goal 2',
          audience: { role: 'admin' },
          createdAt: D1,
          updatedAt: D2,
        },
        {
          id: 'ver-1',
          versionNumber: 1,
          status: 'draft',
          goal: 'Goal 1',
          audience: null,
          createdAt: D1,
          updatedAt: D2,
        },
      ],
    });
    sectionGroupBy.mockResolvedValue([{ versionId: 'ver-2', _count: { _all: 3 } }]);
    slotGroupBy.mockResolvedValue([{ versionId: 'ver-2', _count: { _all: 8 } }]);
    changeGroupBy.mockResolvedValue([
      { versionId: 'ver-2', _count: { _all: 5 } },
      { versionId: 'ver-1', _count: { _all: 1 } },
    ]);

    const detail = await getQuestionnaireDetail('qn-1');
    expect(detail).not.toBeNull();

    expect(detail!.versions[0]).toMatchObject({
      id: 'ver-2',
      sectionCount: 3,
      questionCount: 8,
      changeCount: 5,
    });
    expect(detail!.versions[1]).toMatchObject({
      id: 'ver-1',
      sectionCount: 0,
      questionCount: 0,
      changeCount: 1,
    });
    // Provenance is exposed on the version graph, not the summary — no inferred
    // derivation here.
    expect(detail!.versions[0]).not.toHaveProperty('goalInferred');
  });

  it('skips the change-count query when the questionnaire has no versions', async () => {
    findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Empty',
      status: 'draft',
      createdAt: D1,
      updatedAt: D2,
      versions: [],
    });

    const detail = await getQuestionnaireDetail('qn-1');
    expect(detail!.versions).toEqual([]);
    // All three count sweeps short-circuit on empty versionIds — none should run.
    expect(changeGroupBy).not.toHaveBeenCalled();
    expect(sectionGroupBy).not.toHaveBeenCalled();
    expect(slotGroupBy).not.toHaveBeenCalled();
  });
});

describe('getVersionGraph', () => {
  it('returns null when the version is absent / mismatched', async () => {
    findFirst.mockResolvedValue(null);
    expect(await getVersionGraph('qn-1', 'nope')).toBeNull();
    // Scoped by BOTH ids so a version from another questionnaire 404s.
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'nope',
      questionnaireId: 'qn-1',
    });
  });

  it('projects an ordered graph and surfaces stored per-field provenance', async () => {
    findFirst.mockResolvedValue({
      id: 'ver-1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'draft',
      goal: 'Collect details',
      audience: { role: 'new hire', locale: 'en' },
      goalProvenance: 'admin-supplied',
      audienceProvenance: { role: 'inferred' },
      sections: [
        {
          id: 's0',
          ordinal: 0,
          title: 'About You',
          description: null,
          questions: [
            {
              id: 'q0',
              ordinal: 0,
              key: 'name',
              prompt: 'Your name?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              typeConfig: null,
              required: false,
              weight: 1,
              extractionConfidence: 0.9,
            },
          ],
        },
      ],
    });

    const graph = await getVersionGraph('qn-1', 'ver-1');
    expect(graph).not.toBeNull();
    // Read straight from the columns — no change-record query.
    expect(graph!.goalProvenance).toBe('admin-supplied');
    expect(graph!.audienceProvenance).toEqual({ role: 'inferred' });
    expect(changeGroupBy).not.toHaveBeenCalled();
    expect(graph!.sections).toHaveLength(1);
    expect(graph!.sections[0].questions[0]).toMatchObject({ key: 'name', type: 'free_text' });
  });

  it('normalises null / unrecognised stored provenance to null', async () => {
    // A version with no provenance recorded (e.g. a row predating the provenance
    // columns) has a null goalProvenance; an unrecognised string must not leak
    // through `asFieldProvenance`. Both resolve to null; audienceProvenance null → null.
    findFirst.mockResolvedValue({
      id: 'ver-1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'draft',
      goal: null,
      audience: null,
      goalProvenance: 'legacy-unknown',
      audienceProvenance: null,
      sections: [],
    });

    const graph = await getVersionGraph('qn-1', 'ver-1');
    expect(graph).not.toBeNull();
    expect(graph!.goalProvenance).toBeNull();
    expect(graph!.audienceProvenance).toBeNull();
  });
});
