import { describe, it, expect, vi } from 'vitest';

import phrasingFlagSeed from '@/prisma/seeds/app-questionnaire/027-question-phrasing-flag';
import { APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG } from '@/lib/app/questionnaire/feature-flag';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/027-question-phrasing-flag` seed.
 *
 * Contract: upserts exactly one FeatureFlag row keyed on the phrasing flag, created DISABLED
 * (dark-launch — an operator opts the paid per-question phrasing in), idempotent `update: {}`,
 * and the unit name is the path-derived SeedHistory key.
 */
function makeCtx() {
  const upsert = vi.fn().mockResolvedValue({ name: APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    prisma: { featureFlag: { upsert } },
    logger,
  } as unknown as SeedContext;
  return { ctx, upsert };
}

describe('app-questionnaire/027-question-phrasing-flag seed', () => {
  it('upserts the phrasing flag, disabled, keyed on the phrasing flag name', async () => {
    const { ctx, upsert } = makeCtx();
    await phrasingFlagSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ name: APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG });
    expect(arg.create.name).toBe(APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG);
    expect(arg.create.enabled).toBe(false);
  });

  it('uses an idempotent empty update so re-seeding preserves operator toggles', async () => {
    const { ctx, upsert } = makeCtx();
    await phrasingFlagSeed.run(ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({});
  });

  it('declares the path-derived seed unit name', () => {
    expect(phrasingFlagSeed.name).toBe('app-questionnaire/027-question-phrasing-flag');
  });
});
