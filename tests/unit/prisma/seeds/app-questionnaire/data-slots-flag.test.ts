import { describe, it, expect, vi } from 'vitest';

import dataSlotsFlagSeed from '@/prisma/seeds/app-questionnaire/028-data-slots-flag';
import { APP_QUESTIONNAIRES_DATA_SLOTS_FLAG } from '@/lib/app/questionnaire/feature-flag';
import type { SeedContext } from '@/prisma/runner';

function makeCtx() {
  const upsert = vi.fn().mockResolvedValue({ name: APP_QUESTIONNAIRES_DATA_SLOTS_FLAG });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { prisma: { featureFlag: { upsert } }, logger } as unknown as SeedContext;
  return { ctx, upsert };
}

describe('app-questionnaire/028-data-slots-flag seed', () => {
  it('upserts the data-slots flag, disabled, keyed on the flag name', async () => {
    const { ctx, upsert } = makeCtx();
    await dataSlotsFlagSeed.run(ctx);
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ name: APP_QUESTIONNAIRES_DATA_SLOTS_FLAG });
    expect(arg.create.enabled).toBe(false);
  });

  it('uses an idempotent empty update', async () => {
    const { ctx, upsert } = makeCtx();
    await dataSlotsFlagSeed.run(ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({});
  });

  it('declares the path-derived seed unit name', () => {
    expect(dataSlotsFlagSeed.name).toBe('app-questionnaire/028-data-slots-flag');
  });
});
