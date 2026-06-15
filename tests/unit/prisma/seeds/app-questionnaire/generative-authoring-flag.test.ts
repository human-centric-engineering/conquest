import { describe, it, expect, vi } from 'vitest';

import flagSeed from '@/prisma/seeds/app-questionnaire/035-generative-authoring-flag';
import { APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG } from '@/lib/app/questionnaire/feature-flag';
import type { SeedContext } from '@/prisma/runner';

function makeCtx() {
  const upsert = vi.fn().mockResolvedValue({ name: APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { prisma: { featureFlag: { upsert } }, logger } as unknown as SeedContext;
  return { ctx, upsert };
}

describe('app-questionnaire/035-generative-authoring-flag seed', () => {
  it('upserts the generative-authoring flag, disabled, keyed on the flag name', async () => {
    const { ctx, upsert } = makeCtx();
    await flagSeed.run(ctx);
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ name: APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG });
    expect(arg.create.enabled).toBe(false);
  });

  it('uses an idempotent empty update', async () => {
    const { ctx, upsert } = makeCtx();
    await flagSeed.run(ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({});
  });

  it('declares the path-derived seed unit name', () => {
    expect(flagSeed.name).toBe('app-questionnaire/035-generative-authoring-flag');
  });
});
