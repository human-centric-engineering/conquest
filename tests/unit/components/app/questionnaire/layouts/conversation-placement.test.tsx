/**
 * Where each layout actually puts the two halves of the conversation.
 *
 * `registry.test.tsx` asserts that every `region`-placed slot reaches the DOM. That is necessary
 * and not sufficient here: Broadsheet would pass it while stacking the composer under the
 * transcript in one card, which is Classic's arrangement wearing Broadsheet's name — the whole
 * reason the `conversation` slot was split would be quietly gone, and the placement declaration
 * ("the margin") would be a lie the type system cannot catch.
 *
 * So this file asserts the STRUCTURE the declarations claim: Classic and Focus put the pair in one
 * box, Broadsheet does not. It is deliberately about containment rather than class names, since the
 * claim is about arrangement and not about which utilities draw the border.
 *
 * @see components/app/questionnaire/layouts/broadsheet-layout.tsx
 * @see components/app/questionnaire/layouts/registry.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { LAYOUT_REGISTRY } from '@/components/app/questionnaire/layouts/registry';
import type { RespondentSlots } from '@/components/app/questionnaire/layouts/types';
import { RESPONDENT_SLOTS } from '@/lib/app/questionnaire/layout/slots';
import type { SessionWorkspaceState } from '@/lib/hooks/use-session-workspace';

function sentinelSlots(over: Partial<RespondentSlots> = {}): RespondentSlots {
  return {
    ...(Object.fromEntries(
      RESPONDENT_SLOTS.map((key) => [key, <div key={key} data-testid={`slot-${key}`} />])
    ) as RespondentSlots),
    ...over,
  };
}

function stubState(overrides: Partial<SessionWorkspaceState> = {}): SessionWorkspaceState {
  return {
    phase: 'active',
    views: ['chat'],
    activeView: 'chat',
    activeIndex: 0,
    swipe: {
      dragPx: 0,
      animating: false,
      onTouchStart: vi.fn(),
      onTouchMove: vi.fn(),
      onTouchEnd: vi.fn(),
      handleWheel: vi.fn(),
    },
    carouselRef: { current: null },
    showChat: true,
    showForm: false,
    showPanel: true,
    ...overrides,
  } as unknown as SessionWorkspaceState;
}

/** The smallest box that holds the transcript — the conversation's card, whichever layout drew it. */
function boxAround(el: HTMLElement): HTMLElement {
  const box = el.closest('.rounded-xl');
  if (!(box instanceof HTMLElement)) throw new Error('no card found around the transcript');
  return box;
}

describe('the conversation card', () => {
  it.each([
    ['classic', LAYOUT_REGISTRY.classic.Component],
    ['focus', LAYOUT_REGISTRY.focus.Component],
  ])('%s keeps the composer inside the transcript’s card', (_name, Component) => {
    render(<Component slots={sentinelSlots()} state={stubState()} />);

    const card = boxAround(screen.getByTestId('slot-transcript'));
    expect(card.contains(screen.getByTestId('slot-composer'))).toBe(true);
  });

  it('broadsheet keeps the composer OUT of the transcript’s card', () => {
    // The layout's entire reason for existing: the document scrolls, the answer box does not move
    // with it. Nesting them again would restore Classic's behaviour under a different label.
    render(<LAYOUT_REGISTRY.broadsheet.Component slots={sentinelSlots()} state={stubState()} />);

    const card = boxAround(screen.getByTestId('slot-transcript'));
    expect(card.contains(screen.getByTestId('slot-composer'))).toBe(false);
  });

  it('broadsheet puts the completion offer with the composer, not above the document', () => {
    // Declared as "the margin, above the composer" — finishing and answering are the two things the
    // respondent does, and the document is the thing they read. Classic puts it above the
    // conversation instead, so this is a real difference and not a restatement of the registry.
    render(<LAYOUT_REGISTRY.broadsheet.Component slots={sentinelSlots()} state={stubState()} />);

    const offer = screen.getByTestId('slot-completionOffer');
    const composer = screen.getByTestId('slot-composer');
    // The offer's own container is the rail, and the composer is inside it too — asserted by
    // containment rather than by an exact parent chain, so wrapping the composer in a card of its
    // own (which it is) does not make this a test of nesting depth.
    const rail = offer.parentElement;
    expect(rail?.contains(composer)).toBe(true);
    // ...and the offer comes first: the respondent reads the document, then acts in the margin.
    expect(offer.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not above the document — that is Classic's placement, and the difference is the point.
    expect(boxAround(screen.getByTestId('slot-transcript')).contains(offer)).toBe(false);
  });

  it('every layout still renders both halves when the session has no composer', () => {
    // A terminal session (capped, submitted, expired) gets `composer: null` from the container.
    // Broadsheet must then leave no empty rail card and Classic no dangling seam — neither is
    // directly observable here, but a crash or a lost transcript is, and this is the cheapest place
    // to catch one.
    for (const key of ['classic', 'focus', 'broadsheet'] as const) {
      const { Component } = LAYOUT_REGISTRY[key];
      const { unmount } = render(
        <Component slots={sentinelSlots({ composer: null })} state={stubState()} />
      );
      expect(
        screen.getByTestId('slot-transcript'),
        `${key} lost the transcript`
      ).toBeInTheDocument();
      expect(screen.queryByTestId('slot-composer'), `${key} kept a composer`).toBeNull();
      unmount();
    }
  });
});
