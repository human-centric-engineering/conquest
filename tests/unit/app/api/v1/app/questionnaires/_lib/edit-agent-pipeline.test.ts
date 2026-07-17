/**
 * Unit tests for the Structure Edit Agent server pipeline (precise mode).
 *
 * File under test: app/api/v1/app/questionnaires/_lib/edit-agent-pipeline.ts
 *
 * Prisma and the transaction runner are mocked at the module boundary; the REAL mapping and
 * per-change dispatch logic run. Tests assert what the pipeline DOES — the loaded structure shape,
 * the 404 responses, the exact per-entity updates written, and the returned counts (anti-green-bar).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  sectionUpdate: vi.fn(),
  slotUpdate: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireVersion: { findUnique: mocks.findUnique } },
}));

// executeTransaction runs its callback with a tx client — mirror that, handing the callback a tx
// whose two update methods are the spies we assert on.
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
    fn({
      appQuestionnaireSection: { update: mocks.sectionUpdate },
      appQuestionSlot: { update: mocks.slotUpdate },
    })
  ),
}));

import {
  loadEditableStructure,
  applyResolvedChanges,
} from '@/app/api/v1/app/questionnaires/_lib/edit-agent-pipeline';
import type { ResolvedChange } from '@/lib/app/questionnaire/edit-agent/types';

/**
 * Build a complete {@link ResolvedChange} from the fields the pipeline actually reads
 * (`entityId` / `field` / `value` / `toSectionId`), filling the preview-only fields so the
 * fixture satisfies the real type without an `as` cast.
 */
function change(
  partial: Pick<ResolvedChange, 'entityId' | 'field' | 'value'> &
    Partial<Pick<ResolvedChange, 'toSectionId'>>
): ResolvedChange {
  return {
    entity: partial.field.startsWith('section.') ? 'section' : 'question',
    label: 'label',
    before: '',
    after: String(partial.value),
    ...partial,
  };
}

const findUnique = mocks.findUnique as Mock;
const sectionUpdate = mocks.sectionUpdate as Mock;
const slotUpdate = mocks.slotUpdate as Mock;

/** A version row shaped as the pipeline's `select` returns it. */
function versionRow(over: Record<string, unknown> = {}) {
  return {
    questionnaireId: 'qn-1',
    sections: [
      {
        id: 'sec-a',
        ordinal: 0,
        title: 'Background',
        description: null,
        questions: [
          {
            id: 'q1',
            key: 'name',
            ordinal: 0,
            prompt: 'Name?',
            type: 'free_text',
            required: true,
            weight: 0.5,
          },
        ],
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sectionUpdate.mockResolvedValue({});
  slotUpdate.mockResolvedValue({});
});

describe('loadEditableStructure', () => {
  it('maps a found version into an EditableStructure preserving ids, ordinals, and field flags', async () => {
    findUnique.mockResolvedValue(versionRow());

    const result = await loadEditableStructure('qn-1', 'v1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({
      versionId: 'v1',
      sections: [
        {
          id: 'sec-a',
          ordinal: 0,
          title: 'Background',
          description: null,
          questions: [
            {
              id: 'q1',
              key: 'name',
              ordinal: 0,
              prompt: 'Name?',
              type: 'free_text',
              required: true,
              weight: 0.5,
            },
          ],
        },
      ],
    });
  });

  it('returns a 404 response when the version does not exist', async () => {
    findUnique.mockResolvedValue(null);

    const result = await loadEditableStructure('qn-1', 'missing');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.response.status).toBe(404);
  });

  it('returns a 404 when the version belongs to a different questionnaire (scope guard)', async () => {
    findUnique.mockResolvedValue(versionRow({ questionnaireId: 'other-qn' }));

    const result = await loadEditableStructure('qn-1', 'v1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.response.status).toBe(404);
  });
});

describe('applyResolvedChanges', () => {
  it('writes each change as its own per-entity update and counts distinct sections/questions', async () => {
    const changes: ResolvedChange[] = [
      change({ entityId: 'sec-a', field: 'section.title', value: 'Intro' }),
      change({ entityId: 'sec-a', field: 'section.ordinal', value: 1 }),
      change({ entityId: 'q1', field: 'question.prompt', value: 'Your name?' }),
      change({ entityId: 'q1', field: 'question.required', value: false }),
      change({ entityId: 'q2', field: 'question.weight', value: 0.9 }),
      change({ entityId: 'q2', field: 'question.ordinal', value: 3 }),
      change({ entityId: 'q3', field: 'question.section', value: 0, toSectionId: 'sec-b' }),
    ];

    const counts = await applyResolvedChanges(changes);

    // sec-a touched twice → 1 distinct section; q1/q2/q3 → 3 distinct questions.
    expect(counts).toEqual({ changeCount: 7, sectionCount: 1, questionCount: 3 });

    expect(sectionUpdate).toHaveBeenCalledWith({
      where: { id: 'sec-a' },
      data: { title: 'Intro' },
    });
    expect(sectionUpdate).toHaveBeenCalledWith({ where: { id: 'sec-a' }, data: { ordinal: 1 } });
    expect(slotUpdate).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { prompt: 'Your name?' },
    });
    expect(slotUpdate).toHaveBeenCalledWith({ where: { id: 'q1' }, data: { required: false } });
    expect(slotUpdate).toHaveBeenCalledWith({ where: { id: 'q2' }, data: { weight: 0.9 } });
    expect(slotUpdate).toHaveBeenCalledWith({ where: { id: 'q2' }, data: { ordinal: 3 } });
    // A cross-section move writes both the new sectionId and the target ordinal.
    expect(slotUpdate).toHaveBeenCalledWith({
      where: { id: 'q3' },
      data: { sectionId: 'sec-b', ordinal: 0 },
    });
  });

  it('is a no-op with zero counts and no writes for an empty change list', async () => {
    const counts = await applyResolvedChanges([]);

    expect(counts).toEqual({ changeCount: 0, sectionCount: 0, questionCount: 0 });
    expect(sectionUpdate).not.toHaveBeenCalled();
    expect(slotUpdate).not.toHaveBeenCalled();
  });
});
