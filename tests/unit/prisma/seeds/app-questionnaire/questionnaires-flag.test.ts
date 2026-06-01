import { describe, it, expect, vi } from 'vitest';

import questionnairesFlagSeed from '@/prisma/seeds/app-questionnaire/001-questionnaires-flag';
import { APP_QUESTIONNAIRES_FLAG } from '@/lib/app/questionnaire/feature-flag';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/001-questionnaires-flag` seed.
 *
 * Contract:
 *  - upserts exactly one FeatureFlag row, keyed on APP_QUESTIONNAIRES_FLAG;
 *  - the flag is created DISABLED (the app ships dark, gated off until an
 *    operator flips it on);
 *  - the upsert uses `update: {}` so re-seeding is idempotent and never
 *    clobbers an operator's toggle;
 *  - the unit name is the path-derived SeedHistory key (recursive discovery).
 */

function makeCtx() {
  const upsert = vi.fn().mockResolvedValue({ name: APP_QUESTIONNAIRES_FLAG });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: { featureFlag: { upsert } },
    logger,
  } as unknown as SeedContext;

  return { ctx, upsert };
}

describe('app-questionnaire/001-questionnaires-flag seed', () => {
  it('upserts the questionnaire flag, disabled, keyed on APP_QUESTIONNAIRES_FLAG', async () => {
    const { ctx, upsert } = makeCtx();

    await questionnairesFlagSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ name: APP_QUESTIONNAIRES_FLAG });
    expect(arg.create.name).toBe(APP_QUESTIONNAIRES_FLAG);
    expect(arg.create.enabled).toBe(false);
  });

  it('uses an idempotent empty update so re-seeding preserves operator toggles', async () => {
    const { ctx, upsert } = makeCtx();

    await questionnairesFlagSeed.run(ctx);

    expect(upsert.mock.calls[0][0].update).toEqual({});
  });

  it('declares the path-derived seed unit name', () => {
    expect(questionnairesFlagSeed.name).toBe('app-questionnaire/001-questionnaires-flag');
  });
});
