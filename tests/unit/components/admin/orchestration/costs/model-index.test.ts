/**
 * Tests for the provider-aware model lookup shared by the costs surfaces.
 *
 * The bug this exists for (#436): `gpt-4o` ships under both `openai` and
 * `microsoft` in the default matrix, so a map keyed on the bare id resolved to
 * whichever entry was inserted last — an unconfigured Azure demo row — and
 * genuine OpenAI spend was labelled with it.
 *
 * @see components/admin/orchestration/costs/model-index.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildModelIndex,
  lookupModel,
  modelKey,
} from '@/components/admin/orchestration/costs/model-index';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    tier: 'mid',
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 10,
    maxContext: 128_000,
    supportsTools: true,
    ...overrides,
  };
}

const OPENAI_GPT4O = makeModel();
const AZURE_GPT4O = makeModel({
  name: 'GPT-4o (Azure)',
  provider: 'microsoft',
  tier: 'frontier',
});

describe('modelKey', () => {
  it('composes provider and model id', () => {
    expect(modelKey('openai', 'gpt-4o')).toBe('openai::gpt-4o');
  });
});

describe('lookupModel', () => {
  it('resolves the entry for the provider that served the spend', () => {
    const index = buildModelIndex([OPENAI_GPT4O, AZURE_GPT4O]);

    expect(lookupModel(index, 'openai', 'gpt-4o')).toBe(OPENAI_GPT4O);
    expect(lookupModel(index, 'microsoft', 'gpt-4o')).toBe(AZURE_GPT4O);
  });

  it('is unaffected by catalogue order', () => {
    // `mergeDbModelsWithRegistry` appends DB-only rows last, which is what made
    // the old bare-id map resolve to the wrong entry.
    const index = buildModelIndex([AZURE_GPT4O, OPENAI_GPT4O]);

    expect(lookupModel(index, 'openai', 'gpt-4o')).toBe(OPENAI_GPT4O);
  });

  it('falls back to the bare id for a provider outside the catalogue', () => {
    const index = buildModelIndex([OPENAI_GPT4O, AZURE_GPT4O]);

    // A custom or renamed provider slug: a plausible label beats none.
    expect(lookupModel(index, 'my-proxy', 'gpt-4o')).toBe(OPENAI_GPT4O);
  });

  it('prefers the first catalogue entry on the bare-id fallback', () => {
    // First-write-wins: the static registry is merged ahead of DB-only rows, so
    // a seeded example row cannot displace the real entry.
    const index = buildModelIndex([AZURE_GPT4O, OPENAI_GPT4O]);

    expect(lookupModel(index, 'unknown', 'gpt-4o')).toBe(AZURE_GPT4O);
  });

  it('returns undefined for a model that is not in the catalogue at all', () => {
    const index = buildModelIndex([OPENAI_GPT4O]);

    // Retired models keep their cost history after leaving the matrix.
    expect(lookupModel(index, 'openai', 'text-davinci-003')).toBeUndefined();
  });

  it('handles a null catalogue', () => {
    const index = buildModelIndex(null);

    expect(lookupModel(index, 'openai', 'gpt-4o')).toBeUndefined();
  });
});
