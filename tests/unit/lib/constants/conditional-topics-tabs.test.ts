/**
 * The Conditional Topics sub-tab registry (F17.26).
 *
 * The load-bearing property is the ISSUE→TAB mapping: the issue strip sits above the tab bar and
 * every row has to land somewhere real. A code that fell through to nowhere would give an admin a
 * button that appears to do nothing, on the surface whose whole job is being checkable.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  CONDITIONAL_TOPICS_TABS,
  CONDITIONAL_TOPICS_TAB_HINTS,
  CONDITIONAL_TOPICS_TAB_LABELS,
  DEFAULT_CONDITIONAL_TOPICS_TAB,
  narrowConditionalTopicsTab,
  tabForScopeIssue,
} from '@/lib/constants/conditional-topics-tabs';

describe('the tab set', () => {
  it('labels and hints every tab', () => {
    for (const tab of CONDITIONAL_TOPICS_TABS) {
      expect(CONDITIONAL_TOPICS_TAB_LABELS[tab]).toBeTruthy();
      expect(CONDITIONAL_TOPICS_TAB_HINTS[tab]).toBeTruthy();
    }
  });

  it('defaults to the tab that owns the topic set', () => {
    // Topics is where an admin arriving with no particular intent should land: it is the thing
    // they edit most, and it is what the other two tabs are about.
    expect(DEFAULT_CONDITIONAL_TOPICS_TAB).toBe('topics');
  });

  it('does not call a tab "Settings" — the workspace already has one', () => {
    // Two things called Settings on one screen is a collision an admin resolves by clicking both.
    expect(Object.values(CONDITIONAL_TOPICS_TAB_LABELS)).not.toContain('Settings');
  });
});

describe('narrowConditionalTopicsTab', () => {
  it('accepts a real tab id', () => {
    expect(narrowConditionalTopicsTab('rules')).toBe('rules');
  });

  it.each([null, undefined, '', 'nonsense', 'TOPICS'])('falls back on %p', (input) => {
    // `?tab=` is user-supplied and survives being pasted, bookmarked and hand-edited, so it can
    // be anything. Falling back beats throwing on a surface an admin is mid-task on.
    expect(narrowConditionalTopicsTab(input)).toBe(DEFAULT_CONDITIONAL_TOPICS_TAB);
  });
});

describe('tabForScopeIssue', () => {
  it('sends topic-shaped findings to Topics', () => {
    for (const code of [
      'orphaned_questions',
      'conditional_without_criteria',
      'light_depth_on_always_topic',
      'no_opening_topic',
    ]) {
      expect(tabForScopeIssue({ code })).toBe('topics');
    }
  });

  it('sends limit, budget and fallback findings to Limits & fallbacks', () => {
    for (const code of [
      'budget_below_floor',
      'cap_exceeds_candidates',
      'fallback_unknown_topic',
      'check_preference_unknown_topic',
    ]) {
      expect(tabForScopeIssue({ code })).toBe('rules');
    }
  });

  it('falls back rather than throwing on a code it has never heard of', () => {
    // Deliberately NOT a `Record<Code, Tab>`: that would make every new finding a compile error in
    // a file the author of that finding has no reason to open. The cost of the default is a row
    // that lands on Topics instead of Rules; the cost of the record is a wrong-file compile error
    // that gets fixed by guessing.
    expect(tabForScopeIssue({ code: 'a_code_added_next_year' })).toBe(
      DEFAULT_CONDITIONAL_TOPICS_TAB
    );
  });

  it('maps every code the validator can actually emit', () => {
    // Reads the source rather than trusting a hand-kept list, in the spirit of
    // `scope/leak-guard.test.ts`. The fallback means an unmapped code is not a crash — it is a row
    // that quietly lands on the wrong tab, which is exactly the kind of thing nobody notices.
    const src = readFileSync('lib/app/questionnaire/scope/validate.ts', 'utf8');
    const codes = [...src.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]);

    expect(codes.length).toBeGreaterThan(15);
    const unmapped = codes.filter((code) => {
      // A mapped code resolves to something; an unmapped one resolves to the default. Only the
      // codes the map genuinely lists should ever be indistinguishable from the fallback.
      const tab = tabForScopeIssue({ code });
      return tab === DEFAULT_CONDITIONAL_TOPICS_TAB && !TOPICS_CODES.has(code);
    });
    expect(unmapped).toEqual([]);
  });
});

/** The codes the registry deliberately routes to the default tab. */
const TOPICS_CODES = new Set([
  'orphaned_questions',
  'orphaned_data_slots',
  'empty_topic',
  'conditional_without_criteria',
  'duplicate_membership',
  'no_opening_topic',
  'no_conditional_topics',
  'light_depth_on_always_topic',
  // F17.31a — recorded triggers. The topic is where each of these is read, and for
  // `trigger_settled_at_opening` where its story is: nothing is misconfigured and no edit clears it.
  'trigger_settled_at_opening',
  'trigger_on_always_topic',
  'trigger_without_cues',
]);
