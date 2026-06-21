/**
 * Unit: the Learning Mode `learning_applied` session marker (idempotent + fail-soft).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSessionEvent: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/logging', () => ({ logger: { warn: vi.fn() } }));

import {
  recordLearningApplied,
  wasLearningApplied,
  LEARNING_APPLIED_EVENT,
} from '@/lib/app/questionnaire/learning/events';

beforeEach(() => vi.clearAllMocks());

describe('recordLearningApplied', () => {
  it('creates the marker once when none exists', async () => {
    prismaMock.appQuestionnaireSessionEvent.findFirst.mockResolvedValue(null);
    await recordLearningApplied('s1');
    expect(prismaMock.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: { sessionId: 's1', eventType: LEARNING_APPLIED_EVENT },
    });
  });

  it('does not duplicate when a marker already exists', async () => {
    prismaMock.appQuestionnaireSessionEvent.findFirst.mockResolvedValue({ id: 'e1' });
    await recordLearningApplied('s1');
    expect(prismaMock.appQuestionnaireSessionEvent.create).not.toHaveBeenCalled();
  });

  it('never throws on a write failure (fail-soft)', async () => {
    prismaMock.appQuestionnaireSessionEvent.findFirst.mockResolvedValue(null);
    prismaMock.appQuestionnaireSessionEvent.create.mockRejectedValue(new Error('db down'));
    await expect(recordLearningApplied('s1')).resolves.toBeUndefined();
  });
});

describe('wasLearningApplied', () => {
  it('reflects whether the marker exists', async () => {
    prismaMock.appQuestionnaireSessionEvent.findFirst.mockResolvedValue({ id: 'e1' });
    expect(await wasLearningApplied('s1')).toBe(true);
    prismaMock.appQuestionnaireSessionEvent.findFirst.mockResolvedValue(null);
    expect(await wasLearningApplied('s1')).toBe(false);
  });
});
