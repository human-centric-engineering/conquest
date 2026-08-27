/**
 * The layout registry's guarantees — the ones a compiler cannot make on its own.
 *
 * `satisfies LayoutRegistry` already fails the build when a layout forgets to classify a slot.
 * What it cannot check is any of the following, so they are checked here:
 *
 *   - that no layout omits something a respondent needs in order to finish;
 *   - that Classic remains the resolution fallback for anything unrecognised, which is the
 *     promise every launched questionnaire depends on;
 *   - that a layout's `placements` declaration matches what its component actually renders —
 *     asserted by rendering each layout with a sentinel per slot and looking for the ones it
 *     claims to place on screen.
 *
 * That last one is the important one. A declaration that drifts from its JSX is worse than no
 * declaration: it reads like a guarantee while quietly hiding a dropped feature.
 *
 * @see components/app/questionnaire/layouts/registry.ts
 * @see .context/app/questionnaire/respondent-layouts.md
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LAYOUT_REGISTRY, resolveLayout } from '@/components/app/questionnaire/layouts/registry';
import type { RespondentSlots } from '@/components/app/questionnaire/layouts/types';
import type { SessionWorkspaceState } from '@/lib/hooks/use-session-workspace';
import {
  RESPONDENT_SLOTS,
  missingEssentialSlots,
  type RespondentSlotKey,
  type SlotPlacement,
} from '@/lib/app/questionnaire/layout/slots';
import { DEFAULT_RESPONDENT_LAYOUT, RESPONDENT_LAYOUTS } from '@/lib/app/questionnaire/types';

const LAYOUT_KEYS = Object.keys(LAYOUT_REGISTRY) as (keyof typeof LAYOUT_REGISTRY)[];

/** A visible, uniquely-identifiable stand-in for each part. */
function sentinelSlots(): RespondentSlots {
  return Object.fromEntries(
    RESPONDENT_SLOTS.map((key) => [key, <div key={key} data-testid={`slot-${key}`} />])
  ) as RespondentSlots;
}

/**
 * Enough of the workspace for a layout to arrange. Layouts are presentational by contract — they
 * read flags and call navigation functions, never fetch — so a plain object is a faithful double
 * rather than a mock that hides behaviour.
 */
function stubState(overrides: Partial<SessionWorkspaceState> = {}): SessionWorkspaceState {
  return {
    phase: 'active',
    views: ['chat'],
    activeView: 'chat',
    activeIndex: 0,
    multiView: false,
    goToView: vi.fn(),
    goRelative: vi.fn(),
    carouselRef: { current: null },
    swipe: {
      dragPx: 0,
      animating: false,
      onTouchStart: vi.fn(),
      onTouchMove: vi.fn(),
      onTouchEnd: vi.fn(),
      handleWheel: vi.fn(),
    },
    showChat: true,
    showForm: false,
    showPanel: true,
    showIntro: false,
    showCapture: false,
    showPersona: false,
    showInterviewerChip: false,
    captureBlocking: false,
    turnCount: 2,
    formBlocked: false,
    correction: undefined,
    correctionTargets: [],
    newlyFilledKeys: [],
    reviewCountLabel: null,
    answeredCount: 0,
    textScaleIndex: 1,
    setTextScaleIndex: vi.fn(),
    chatScaleStyle: {},
    heldProbe: null,
    finalCheckOpen: false,
    closeFinalCheck: vi.fn(),
    doSubmit: vi.fn(),
    doFinishEarly: vi.fn(),
    finishAnyway: vi.fn(),
    reviewOpen: false,
    setReviewOpen: vi.fn(),
    selectedPersonaKey: null,
    currentPersonaLabel: 'Interviewer',
    choosePersona: vi.fn(),
    onChangeInterviewer: vi.fn(),
    personaModalOpen: false,
    setPersonaModalOpen: vi.fn(),
    handleRevisit: vi.fn(),
    handleRefine: vi.fn(),
    handleCaptureSubmitted: vi.fn(),
    onTurnSettled: vi.fn(),
    experience: null,
    stitched: false,
    stitchedSeamLabel: undefined,
    setStitchedOutcome: vi.fn(),
    onContinue: vi.fn(),
    onConclude: vi.fn(),
    ...overrides,
  } as unknown as SessionWorkspaceState;
}

describe('layout registry — coverage', () => {
  it('registers exactly the layouts the config enum offers', () => {
    // Divergence either way is a real bug: a registered layout no setting can select is dead code,
    // and a selectable layout with no entry renders the fallback while the admin thinks otherwise.
    expect(LAYOUT_KEYS.sort()).toEqual([...RESPONDENT_LAYOUTS].sort());
  });

  it('classifies every slot in every layout', () => {
    // Belt-and-braces for the `satisfies`, in the spirit of settings-registry.test.ts: reported as
    // a set difference so a failure names the forgotten part rather than dumping two objects.
    for (const key of LAYOUT_KEYS) {
      const declared = Object.keys(LAYOUT_REGISTRY[key].placements).sort();
      const expected: string[] = [...RESPONDENT_SLOTS].sort();
      expect(
        expected.filter((slot) => !declared.includes(slot)),
        `${key} is missing`
      ).toEqual([]);
      expect(
        declared.filter((slot) => !expected.includes(slot)),
        `${key} has stray`
      ).toEqual([]);
    }
  });

  it('never omits a slot a respondent needs in order to finish', () => {
    // The whole commercial promise, as one assertion: pick any layout, every feature is reachable.
    for (const key of LAYOUT_KEYS) {
      expect(missingEssentialSlots(LAYOUT_REGISTRY[key].placements), `${key} drops`).toEqual([]);
    }
  });

  it('records a reason whenever a layout does omit something', () => {
    // `because` is required by the type, but an empty string satisfies it. The point of the field
    // is that "we forgot" cannot masquerade as a decision, so it has to actually say something.
    for (const key of LAYOUT_KEYS) {
      const placements: Record<string, SlotPlacement> = LAYOUT_REGISTRY[key].placements;
      for (const [slot, placement] of Object.entries(placements)) {
        if (placement.kind === 'omitted') {
          expect(placement.because.trim().length, `${key}.${slot}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives every layout admin-facing copy', () => {
    for (const key of LAYOUT_KEYS) {
      expect(LAYOUT_REGISTRY[key].label.trim(), `${key} label`).toBeTruthy();
      expect(LAYOUT_REGISTRY[key].description.trim(), `${key} description`).toBeTruthy();
    }
  });
});

describe('resolveLayout', () => {
  it('returns the requested layout', () => {
    expect(resolveLayout('classic')).toBe(LAYOUT_REGISTRY.classic);
  });

  it.each([
    ['an unknown name', 'broadsheet'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to ConQuest Classic for %s', (_label, value) => {
    // A rollback, a hand-edited row, or a fork that removed a layout must not blank the surface a
    // respondent is mid-session on. Classic is the floor, always.
    expect(resolveLayout(value)).toBe(LAYOUT_REGISTRY[DEFAULT_RESPONDENT_LAYOUT]);
  });

  it('resolves the default name to a real definition', () => {
    expect(resolveLayout(DEFAULT_RESPONDENT_LAYOUT).Component).toBeTypeOf('function');
  });
});

describe('layout components honour their own declarations', () => {
  /**
   * Slots whose presence depends on session state rather than on the layout, exercised in a
   * configuration where they exist. Anything not listed is asserted under the default stub.
   */
  const STATE_DEPENDENT: Partial<Record<RespondentSlotKey, Partial<SessionWorkspaceState>>> = {
    splash: { views: ['intro', 'chat'], activeView: 'intro', showIntro: true },
    captureGate: { views: ['capture', 'chat'], activeView: 'capture', showCapture: true },
    personaPicker: { views: ['persona', 'chat'], activeView: 'persona', showPersona: true },
    formView: { views: ['form'], activeView: 'form', showChat: false, showForm: true },
  };

  it.each(LAYOUT_KEYS)('%s renders every part it says it places on screen', (key) => {
    const { Component, placements } = LAYOUT_REGISTRY[key];

    for (const slot of RESPONDENT_SLOTS) {
      const placement = placements[slot];
      // Overlays are asserted by their own feature tests (opening a sheet is behaviour, not
      // arrangement); `takeover` regions are rendered by the container, not the layout.
      if (placement.kind !== 'region' || placement.region === 'takeover') continue;
      // Atoms the layout deliberately delegates to a pre-composed parent — Classic's lifecycle
      // strip draws its own progress, download and trailing cluster, so the standalone nodes are
      // correctly absent from the layout's own JSX.
      if (placement.region.includes('inside the lifecycle strip')) continue;
      if (placement.region.startsWith('lifecycle strip')) continue;
      if (placement.region.includes('brand provider')) continue;
      if (placement.region.includes('intro splash')) continue;

      const { unmount } = render(
        <Component slots={sentinelSlots()} state={stubState(STATE_DEPENDENT[slot])} />
      );
      expect(
        screen.queryByTestId(`slot-${slot}`),
        `${key} declares "${slot}" in region "${placement.region}" but did not render it`
      ).not.toBeNull();
      unmount();
    }
  });
});
