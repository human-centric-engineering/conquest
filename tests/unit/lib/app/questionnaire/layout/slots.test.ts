/**
 * Pins the slot vocabulary itself — the keys, the essential set, and the two helpers the layout
 * registry leans on.
 *
 * These are the rules that survive when someone adds a layout in a hurry. The registry's
 * `satisfies` catches an unclassified slot at compile time, but nothing in the type system says
 * "you may not omit the composer": that is {@link ESSENTIAL_SLOTS} plus
 * {@link missingEssentialSlots}, and both are asserted here rather than only at the call site.
 *
 * @see lib/app/questionnaire/layout/slots.ts
 * @see .context/app/questionnaire/respondent-layouts.md
 */
import { describe, expect, it } from 'vitest';

import {
  ESSENTIAL_SLOTS,
  RESPONDENT_SLOTS,
  isAvailable,
  missingEssentialSlots,
  type RespondentSlotKey,
  type SlotPlacement,
} from '@/lib/app/questionnaire/layout/slots';

/** A placement map where everything is on screen — the baseline a test mutates one key of. */
function allPlaced(): Record<RespondentSlotKey, SlotPlacement> {
  return Object.fromEntries(
    RESPONDENT_SLOTS.map((key) => [key, { kind: 'region', region: 'body' }])
  ) as Record<RespondentSlotKey, SlotPlacement>;
}

describe('RESPONDENT_SLOTS', () => {
  it('has no duplicate keys', () => {
    // A duplicate would silently make one layout's placement for it unreachable, and `satisfies`
    // would not notice: the Record type dedupes the union.
    expect(new Set(RESPONDENT_SLOTS).size).toBe(RESPONDENT_SLOTS.length);
  });

  it('covers the parts a respondent actually interacts with', () => {
    // Spot-check rather than a frozen snapshot: the list is meant to grow, but losing any of these
    // would mean a feature stopped being placeable at all.
    for (const key of [
      'transcript',
      'composer',
      'answersPanel',
      'completionOffer',
      'splash',
      'formView',
    ] as const) {
      expect(RESPONDENT_SLOTS).toContain(key);
    }
  });

  it('keeps the conversation divisible into a transcript and a composer', () => {
    // The granularity Broadsheet needs. Collapsing these back into one key would not fail a type
    // check anywhere — every layout would simply place the pair — so the loss would be silent, and
    // the next layout that wants the composer elsewhere would have to redo the split.
    expect(RESPONDENT_SLOTS).toContain('transcript');
    expect(RESPONDENT_SLOTS).toContain('composer');
    expect(RESPONDENT_SLOTS).not.toContain('conversation');
  });
});

describe('ESSENTIAL_SLOTS', () => {
  it('is a subset of the slot vocabulary', () => {
    for (const key of ESSENTIAL_SLOTS) {
      expect(RESPONDENT_SLOTS).toContain(key);
    }
  });

  it('does not include the answer panel', () => {
    // `answerSlotPanelScope: 'hidden'` is a supported configuration, and a layout may legitimately
    // move review behind a gesture. Marking it essential would make both of those illegal.
    expect(ESSENTIAL_SLOTS).not.toContain('answersPanel');
    expect(ESSENTIAL_SLOTS).not.toContain('answersDrawer');
  });

  it('does not include the pre-composed lifecycle bar', () => {
    // The bar is a convenience. A layout that puts progress on a spine and the toggle in a margin
    // omits it and places the atoms instead — that must stay legal.
    expect(ESSENTIAL_SLOTS).not.toContain('lifecycleBar');
  });
});

describe('isAvailable', () => {
  it('treats an overlay as available', () => {
    // The commercial promise is "reachable", not "always on screen". A sheet one tap away is a
    // design decision; counting it as missing would push every layout toward the same shape.
    expect(isAvailable({ kind: 'overlay', via: 'sheet' })).toBe(true);
  });

  it('treats a region as available', () => {
    expect(isAvailable({ kind: 'region', region: 'margin' })).toBe(true);
  });

  it('treats an omission as unavailable', () => {
    expect(isAvailable({ kind: 'omitted', because: 'no transcript in this layout' })).toBe(false);
  });
});

describe('missingEssentialSlots', () => {
  it('passes a map that places everything', () => {
    expect(missingEssentialSlots(allPlaced())).toEqual([]);
  });

  it('passes when an essential slot is behind a gesture rather than on screen', () => {
    const placements = allPlaced();
    placements.completionOffer = { kind: 'overlay', via: 'gesture' };
    expect(missingEssentialSlots(placements)).toEqual([]);
  });

  it('names the essential slot a layout dropped', () => {
    const placements = allPlaced();
    placements.transcript = { kind: 'omitted', because: 'oops' };
    expect(missingEssentialSlots(placements)).toEqual(['transcript']);
  });

  it('refuses a layout that keeps the transcript but drops the composer', () => {
    // The failure the split makes newly possible: before it, omitting the composer meant omitting
    // the whole conversation, which no author would do by accident. Now it is one line in a
    // placement map, and a respondent with nothing to type into cannot finish.
    const placements = allPlaced();
    placements.composer = { kind: 'omitted', because: 'the margin was full' };
    expect(missingEssentialSlots(placements)).toEqual(['composer']);
  });

  it('names every dropped slot, not just the first', () => {
    // A failure that reports one key at a time turns one fix into several review rounds.
    const placements = allPlaced();
    placements.completionOffer = { kind: 'omitted', because: 'oops' };
    placements.finalCheck = { kind: 'omitted', because: 'oops' };
    expect(missingEssentialSlots(placements).sort()).toEqual(['completionOffer', 'finalCheck']);
  });

  it('ignores a non-essential slot being omitted', () => {
    const placements = allPlaced();
    placements.answersPanel = { kind: 'omitted', because: 'review lives behind a gesture here' };
    expect(missingEssentialSlots(placements)).toEqual([]);
  });
});
