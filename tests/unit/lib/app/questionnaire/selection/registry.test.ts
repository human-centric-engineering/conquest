import { describe, it, expect } from 'vitest';
import { SELECTION_STRATEGIES } from '@/lib/app/questionnaire/types';
import {
  KNOWN_STRATEGY_SLUGS,
  getStrategy,
  hasStrategy,
  listStrategies,
  getRegisteredStrategySlugs,
} from '@/lib/app/questionnaire/selection';

describe('selection registry parity', () => {
  it('KNOWN_STRATEGY_SLUGS matches the SELECTION_STRATEGIES enum exactly', () => {
    expect([...KNOWN_STRATEGY_SLUGS].sort()).toEqual([...SELECTION_STRATEGIES].sort());
  });

  it('every enum slug is registered after barrel import', () => {
    const registered = new Set(getRegisteredStrategySlugs());
    for (const slug of SELECTION_STRATEGIES) {
      expect(registered.has(slug), `"${slug}" should be registered`).toBe(true);
      expect(hasStrategy(slug)).toBe(true);
    }
  });

  it('registers no strategy that is not in the enum', () => {
    const enumSet = new Set<string>(SELECTION_STRATEGIES);
    for (const slug of getRegisteredStrategySlugs()) {
      expect(enumSet.has(slug), `"${slug}" registered but not in the enum`).toBe(true);
    }
  });

  it('getStrategy returns a plugin whose slug matches the lookup', () => {
    for (const slug of SELECTION_STRATEGIES) {
      const plugin = getStrategy(slug);
      expect(plugin.slug).toBe(slug);
      expect(typeof plugin.select).toBe('function');
      expect(plugin.description.length).toBeGreaterThan(0);
    }
  });

  it('getStrategy throws for an unknown slug', () => {
    expect(() => getStrategy('does-not-exist')).toThrow(/No selection strategy registered/);
  });

  it('listStrategies returns every registered strategy', () => {
    expect(listStrategies()).toHaveLength(SELECTION_STRATEGIES.length);
  });
});
