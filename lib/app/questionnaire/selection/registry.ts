/**
 * Selection-strategy registry — module-scoped map of slug → strategy plugin.
 *
 * Modelled on the grader registry (`lib/orchestration/evaluations/graders/
 * registry.ts`): a flat `Map` populated at startup by the barrel (`./index.ts`),
 * which imports each strategy file so its top-level `registerStrategy` call
 * fires. Adding a strategy is one new file + one import line.
 *
 * Discoverability is the point: the engine resolves a version's
 * `selectionStrategy` config to a plugin via `getStrategy`, and a parity test
 * asserts every `SELECTION_STRATEGIES` slug is registered after import — so a
 * strategy that forgets to register fails CI rather than throwing at runtime for
 * a perfectly valid config value.
 *
 * Pure — no Next.js, no DB.
 */

import type { SelectionStrategy } from '@/lib/app/questionnaire/types';
import type { SelectionStrategyPlugin } from '@/lib/app/questionnaire/selection/types';

const registry = new Map<SelectionStrategy, SelectionStrategyPlugin>();

/**
 * Register a strategy. Re-registering overrides the previous entry — useful in
 * tests for swapping in a mock.
 */
export function registerStrategy(strategy: SelectionStrategyPlugin): void {
  registry.set(strategy.slug, strategy);
}

/**
 * Look up a strategy by slug. Throws if the slug isn't registered — callers
 * resolving a stored config value should narrow it through `SELECTION_STRATEGIES`
 * (or fall back) before reaching here, but the throw is the backstop that turns a
 * missing registration into a loud failure.
 */
export function getStrategy(slug: string): SelectionStrategyPlugin {
  const entry = registry.get(slug as SelectionStrategy);
  if (!entry) {
    throw new Error(`No selection strategy registered for slug "${slug}"`);
  }
  return entry;
}

/** Has-check for callers that want to fall back rather than throw. */
export function hasStrategy(slug: string): boolean {
  return registry.has(slug as SelectionStrategy);
}

/** Every registered strategy, in registration order. */
export function listStrategies(): readonly SelectionStrategyPlugin[] {
  return Array.from(registry.values());
}

/** Registered slugs — primarily for the parity test. */
export function getRegisteredStrategySlugs(): readonly string[] {
  return Array.from(registry.keys());
}

/** Reset the registry. Test-only helper — production code never calls this. */
export function __resetStrategyRegistryForTests(): void {
  registry.clear();
}
