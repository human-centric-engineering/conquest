/**
 * Selection-strategy domain module barrel (F4.1).
 *
 * Imports every strategy module so each one's top-level `registerStrategy` call
 * fires at startup — adding a strategy is one new file plus one import line here.
 * Import order is also the order `listStrategies()` returns them (and matches the
 * `SELECTION_STRATEGIES` tuple): simple → complex.
 *
 * Pure (no Prisma / Next). The DB-touching seam — mapping a version's slots into
 * a `SelectionContext` and wiring `adaptive`'s deps — lives route-local under
 * `app/api/v1/app/questionnaires/.../next-question/`.
 */

import '@/lib/app/questionnaire/selection/strategies/sequential';
import '@/lib/app/questionnaire/selection/strategies/random';
import '@/lib/app/questionnaire/selection/strategies/weighted';
import '@/lib/app/questionnaire/selection/strategies/adaptive';

export * from '@/lib/app/questionnaire/selection/types';
export * from '@/lib/app/questionnaire/selection/context';
export {
  registerStrategy,
  getStrategy,
  hasStrategy,
  listStrategies,
  getRegisteredStrategySlugs,
  __resetStrategyRegistryForTests,
} from '@/lib/app/questionnaire/selection/registry';

/**
 * Canonical list of slugs the registry MUST contain after barrel import — equal
 * to `SELECTION_STRATEGIES`. The parity test asserts both directions, so a
 * strategy that's added to the enum but never registered (or vice versa) fails
 * CI instead of throwing for a valid config value at runtime.
 */
export const KNOWN_STRATEGY_SLUGS = ['sequential', 'random', 'weighted', 'adaptive'] as const;
