/**
 * Provider-aware lookup from a spend row to its catalogue entry.
 *
 * The same bare `modelId` can exist under several providers — `gpt-4o` ships
 * under both `openai` and `microsoft` in the default model matrix — so a map
 * keyed on the id alone silently resolves to whichever entry was inserted last.
 * `mergeDbModelsWithRegistry` appends DB-only rows at the end, which is how
 * genuine OpenAI spend ended up labelled `microsoft / "GPT-4o (Azure)"` (#436).
 *
 * Callers that know which provider served the spend (anything reading
 * `AiCostLog.provider`) should use `lookupModel`. The bare-id fallback exists
 * for rows whose provider slug isn't in the catalogue at all — a custom or
 * renamed provider — where a plausible label beats no label; it is
 * first-write-wins so the built-in registry entry beats an appended demo row.
 */

import type { ModelInfo } from '@/lib/orchestration/llm/types';

export interface ModelIndex {
  /** Keyed `provider::modelId`. */
  byProviderAndId: Map<string, ModelInfo>;
  /** Keyed `modelId`, first entry wins. Fallback only. */
  byId: Map<string, ModelInfo>;
}

/** Compose the composite key used by {@link ModelIndex.byProviderAndId}. */
export function modelKey(provider: string, modelId: string): string {
  return `${provider}::${modelId}`;
}

export function buildModelIndex(models: ModelInfo[] | null | undefined): ModelIndex {
  const byProviderAndId = new Map<string, ModelInfo>();
  const byId = new Map<string, ModelInfo>();
  for (const m of models ?? []) {
    byProviderAndId.set(modelKey(m.provider, m.id), m);
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  return { byProviderAndId, byId };
}

/**
 * Resolve a spend row to its catalogue entry: exact provider match first, then
 * the bare id. Returns `undefined` when the model isn't in the catalogue at all
 * (a retired model that still has cost history, for instance).
 */
export function lookupModel(
  index: ModelIndex,
  provider: string,
  modelId: string
): ModelInfo | undefined {
  return index.byProviderAndId.get(modelKey(provider, modelId)) ?? index.byId.get(modelId);
}
