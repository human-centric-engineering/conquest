/**
 * Unit test: data-slot thematic material (F14.7).
 *
 * Asserts `buildDataSlotThemeMaterial` builds a per-slot block of respondent paraphrases for the
 * agent, prefers paraphrase over raw value, and applies the per-slot k-anonymity floor (a slot with
 * fewer than the threshold of fills contributes nothing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyDataSlots = vi.fn();
const findManyFills = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appDataSlot: { findMany: (...a: unknown[]) => findManyDataSlots(...a) },
    appDataSlotFill: { findMany: (...a: unknown[]) => findManyFills(...a) },
  },
}));

import { buildDataSlotThemeMaterial } from '@/lib/app/questionnaire/cohort-report/data-slot-material';

const sessionIds = ['s1', 's2', 's3', 's4', 's5', 's6'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildDataSlotThemeMaterial', () => {
  it('builds a per-slot block of paraphrases above the k-anonymity floor', async () => {
    findManyDataSlots.mockResolvedValue([
      {
        id: 'd1',
        name: 'Risk appetite',
        theme: 'Strategy',
        description: 'how much risk they accept',
      },
    ]);
    findManyFills.mockResolvedValue(
      sessionIds.map((_id, i) => ({
        dataSlotId: 'd1',
        paraphrase: `position ${i}`,
        value: { x: i },
      }))
    );

    const out = await buildDataSlotThemeMaterial({ versionId: 'v1', sessionIds });

    expect(out).toContain('## Risk appetite — Strategy');
    expect(out).toContain('- position 0');
    expect(out).toContain('- position 5');
  });

  it('drops a slot answered by fewer than the threshold of respondents', async () => {
    findManyDataSlots.mockResolvedValue([
      { id: 'd1', name: 'Rare topic', theme: 'X', description: 'y' },
    ]);
    // Only 3 fills — below the floor of 5 → excluded.
    findManyFills.mockResolvedValue([
      { dataSlotId: 'd1', paraphrase: 'a', value: null },
      { dataSlotId: 'd1', paraphrase: 'b', value: null },
      { dataSlotId: 'd1', paraphrase: 'c', value: null },
    ]);

    const out = await buildDataSlotThemeMaterial({ versionId: 'v1', sessionIds });
    expect(out).toBe('');
  });

  it('falls back to the value when no paraphrase, and returns empty with no slots/fills', async () => {
    findManyDataSlots.mockResolvedValue([{ id: 'd1', name: 'N', theme: 'T', description: 'D' }]);
    findManyFills.mockResolvedValue(
      sessionIds.map(() => ({ dataSlotId: 'd1', paraphrase: null, value: 'raw position' }))
    );
    const out = await buildDataSlotThemeMaterial({ versionId: 'v1', sessionIds });
    expect(out).toContain('- raw position');

    findManyFills.mockResolvedValue([]);
    expect(await buildDataSlotThemeMaterial({ versionId: 'v1', sessionIds })).toBe('');
  });
});
