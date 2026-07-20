/**
 * Data-integrity coverage for the Experience worked-examples library (P15 explainer tab).
 *
 * This module is static presentation data, not business logic — the risk here is not "wrong
 * computation", it's a kind with no example (a dead-end explainer tab) or an example whose steps
 * don't hang together as a walkthrough (empty fields, a routing sentence with nothing to route
 * between). Assertions target those integrity properties, not the exact prose, per the task's
 * instruction not to write bloated assertions that just restate the data.
 *
 * @see lib/app/questionnaire/experiences/examples.ts
 */

import { describe, it, expect } from 'vitest';

import {
  EXPERIENCE_EXAMPLES,
  examplesForKind,
  type ExperienceExample,
} from '@/lib/app/questionnaire/experiences/examples';
import { EXPERIENCE_KINDS, type ExperienceKind } from '@/lib/app/questionnaire/experiences/types';

/** A non-empty, non-whitespace-only string. */
function isMeaningfulString(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Every prose field on an example is present and every step is internally consistent. */
function assertWellFormed(example: ExperienceExample) {
  expect(isMeaningfulString(example.id)).toBe(true);
  expect(isMeaningfulString(example.title)).toBe(true);
  expect(isMeaningfulString(example.scenario)).toBe(true);
  expect(isMeaningfulString(example.routing)).toBe(true);
  expect(isMeaningfulString(example.respondentSees)).toBe(true);
  expect(isMeaningfulString(example.adminGets)).toBe(true);

  // A "worked example" with no steps is not a walkthrough.
  expect(example.steps.length).toBeGreaterThan(0);
  for (const step of example.steps) {
    expect(isMeaningfulString(step.kind)).toBe(true);
    expect(isMeaningfulString(step.title)).toBe(true);
    expect(isMeaningfulString(step.detail)).toBe(true);
  }
}

describe('lib/app/questionnaire/experiences/examples', () => {
  describe('EXPERIENCE_EXAMPLES', () => {
    it('has at least one example for every ExperienceKind', () => {
      // Drives the coverage from the source of truth (EXPERIENCE_KINDS) rather than hardcoding the
      // two current kinds — a third kind added later without an example fails this test instead of
      // silently rendering a dead-end explainer tab.
      for (const kind of EXPERIENCE_KINDS) {
        expect(EXPERIENCE_EXAMPLES[kind]).toBeDefined();
        expect(EXPERIENCE_EXAMPLES[kind].length).toBeGreaterThan(0);
      }
    });

    it('gives every example well-formed, non-empty fields and at least one step', () => {
      for (const kind of EXPERIENCE_KINDS) {
        for (const example of EXPERIENCE_EXAMPLES[kind]) {
          assertWellFormed(example);
        }
      }
    });

    it('does not repeat an example id within a kind', () => {
      // Rendered as a React `key` in the explainer tab — a collision would silently drop or
      // misrender a duplicate example rather than throwing.
      for (const kind of EXPERIENCE_KINDS) {
        const ids = EXPERIENCE_EXAMPLES[kind].map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    });
  });

  describe('examplesForKind', () => {
    it('returns exactly the switcher examples for agentic_switcher', () => {
      expect(examplesForKind('agentic_switcher')).toBe(EXPERIENCE_EXAMPLES.agentic_switcher);
    });

    it('returns exactly the meeting examples for facilitated_meeting', () => {
      expect(examplesForKind('facilitated_meeting')).toBe(EXPERIENCE_EXAMPLES.facilitated_meeting);
    });

    it('never returns undefined, even for a kind outside the known set', () => {
      // The lookup table is typed as Record<ExperienceKind, ...>, so TypeScript guarantees every
      // real caller gets a hit — but the `?? []` fallback exists for a reason (a value that reached
      // this function without going through the type system, e.g. loosely-typed test/demo data).
      // Cast past the type system deliberately to exercise that defensive branch.
      const bogusKind = 'not_a_real_kind' as unknown as ExperienceKind;
      expect(examplesForKind(bogusKind)).toEqual([]);
    });

    it('draws the switcher examples from more than one domain', () => {
      // Locks in the module's documented constraint: the switcher set must stay domain-neutral
      // (triage / escalating-depth / role-branching), not narrow to a single commercial scenario.
      const scenarios = examplesForKind('agentic_switcher').map((e) => e.scenario.toLowerCase());
      expect(scenarios.length).toBeGreaterThanOrEqual(2);
      const distinctOpeningWords = new Set(
        scenarios.map((s) => s.split(' ').slice(0, 3).join(' '))
      );
      expect(distinctOpeningWords.size).toBeGreaterThan(1);
    });
  });
});
