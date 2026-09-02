// @vitest-environment happy-dom

/**
 * Where each layout actually puts the parts of the conversation.
 *
 * `registry.test.tsx` asserts that every `region`-placed slot reaches the DOM. That is necessary
 * and not sufficient here: Broadsheet would pass it while stacking the composer under the
 * transcript in one card, which is Classic's arrangement wearing Broadsheet's name — the whole
 * reason the `conversation` slot was split would be quietly gone, and the placement declaration
 * ("the margin") would be a lie the type system cannot catch. The same is true of the second split:
 * Horizon would pass while running the history straight into the current exchange, which is Focus
 * with a different name on it.
 *
 * So this file asserts the STRUCTURE the declarations claim — who is inside whose box, and in what
 * order. It is deliberately about containment rather than class names, since the claim is about
 * arrangement and not about which utilities draw the border.
 *
 * @see components/app/questionnaire/layouts/broadsheet-layout.tsx
 * @see components/app/questionnaire/layouts/registry.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { LAYOUT_REGISTRY } from '@/components/app/questionnaire/layouts/registry';
import type { RespondentSlots } from '@/components/app/questionnaire/layouts/types';
import { RESPONDENT_SLOTS } from '@/lib/app/questionnaire/layout/slots';
import { RESPONDENT_LAYOUTS } from '@/lib/app/questionnaire/types';
import type { SessionWorkspaceState } from '@/lib/hooks/use-session-workspace';

const LAYOUT_KEYS = RESPONDENT_LAYOUTS;

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

/** The smallest box that holds the conversation — its card, whichever layout drew it. */
function boxAround(el: HTMLElement): HTMLElement {
  const box = el.closest('.rounded-xl');
  if (!(box instanceof HTMLElement)) throw new Error('no card found around the conversation');
  return box;
}

/** True when `first` appears before `second` in document order. */
function precedes(first: HTMLElement, second: HTMLElement): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('the conversation card', () => {
  it.each([
    ['classic', LAYOUT_REGISTRY.classic.Component],
    ['focus', LAYOUT_REGISTRY.focus.Component],
    ['horizon', LAYOUT_REGISTRY.horizon.Component],
  ])('%s keeps the composer inside the conversation’s card', (_name, Component) => {
    render(<Component slots={sentinelSlots()} state={stubState()} />);

    const card = boxAround(screen.getByTestId('slot-currentExchange'));
    expect(card.contains(screen.getByTestId('slot-composer'))).toBe(true);
  });

  it('broadsheet keeps the composer OUT of the conversation’s card', () => {
    // The layout's entire reason for existing: the document scrolls, the answer box does not move
    // with it. Nesting them again would restore Classic's behaviour under a different label.
    render(<LAYOUT_REGISTRY.broadsheet.Component slots={sentinelSlots()} state={stubState()} />);

    const card = boxAround(screen.getByTestId('slot-currentExchange'));
    expect(card.contains(screen.getByTestId('slot-composer'))).toBe(false);
  });

  it('classic puts the section control and the submit offer in the card’s own header band', () => {
    // The alignment claim in Classic's placement declarations. The conversation card's top edge is
    // level with the answers panel beside it, and both of these come and go mid-session — the
    // section control when the interview is sectioned, the offer when the session is nearly done.
    // Above the card they pushed its top edge below the panel's; inside it the two edges stay level.
    // Asserted by containment, so the band may be restyled freely.
    render(<LAYOUT_REGISTRY.classic.Component slots={sentinelSlots()} state={stubState()} />);

    const card = boxAround(screen.getByTestId('slot-currentExchange'));
    const sections = screen.getByTestId('slot-sectionTabs');
    const offer = screen.getByTestId('slot-completionOffer');
    expect(card.contains(sections), 'the section control left the card').toBe(true);
    expect(card.contains(offer), 'the offer left the card').toBe(true);
    // Above the conversation, not below it: they are chrome that bounds the transcript.
    expect(precedes(sections, screen.getByTestId('slot-currentExchange'))).toBe(true);
    expect(precedes(offer, screen.getByTestId('slot-currentExchange'))).toBe(true);
  });

  it('classic puts the section’s finish control in the card’s closing band', () => {
    // The foot of the same alignment argument as the header band: the card's bottom edge is level
    // with the foot of the answers panel, and this control appears the moment a section becomes
    // finishable. On a row under the card, that moment moved the card's bottom edge up.
    render(<LAYOUT_REGISTRY.classic.Component slots={sentinelSlots()} state={stubState()} />);

    const card = boxAround(screen.getByTestId('slot-currentExchange'));
    const close = screen.getByTestId('slot-sectionClose');
    expect(card.contains(close), 'the finish control left the card').toBe(true);
    // Beneath the answer box, not competing with it for the same row.
    expect(precedes(screen.getByTestId('slot-composer'), close)).toBe(true);
  });

  it('classic’s bands hold nothing when their slots draw nothing', () => {
    // The band is hidden by `:empty`, which is unforgiving: a single always-present wrapper inside
    // it — a flex row, a spacer — and the selector never matches again, leaving an empty band and
    // its rule above every unsectioned conversation for the rest of the product's life. Nothing
    // else in the suite would notice, because the band would still be "correct" in every structural
    // sense. So this asserts the childlessness the CSS depends on, not the CSS.
    // Nodes that render nothing, NOT `null` slots — that is the production shape. `SectionTabStrip`
    // and `SectionCloseControl` are always in the tree and return null internally on an unsectioned
    // interview, so the bands really are rendered and really do have to collapse themselves.
    const Silent = () => null;
    render(
      <LAYOUT_REGISTRY.classic.Component
        slots={sentinelSlots({
          sectionTabs: <Silent />,
          completionOffer: <Silent />,
          sectionClose: <Silent />,
        })}
        state={stubState()}
      />
    );

    for (const id of ['conversation-header', 'conversation-footer']) {
      const band = screen.getByTestId(id);
      expect(band.childNodes.length, `something is drawing inside the empty ${id}`).toBe(0);
    }
  });

  it('broadsheet puts the completion offer with the composer, not above the document', () => {
    // Declared as "the margin, above the composer" — finishing and answering are the two things the
    // respondent does, and the document is the thing they read. Classic puts it in the conversation
    // card's header band instead, so this is a real difference and not a restatement of the
    // registry.
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
    // Not with the document — that is Classic's placement, and the difference is the point.
    expect(boxAround(screen.getByTestId('slot-currentExchange')).contains(offer)).toBe(false);
  });

  it('every layout still renders the conversation when the session has no composer', () => {
    // A terminal session (capped, submitted, expired) gets `composer: null` from the container.
    // Broadsheet must then leave no empty rail card and Classic no dangling seam — neither is
    // directly observable here, but a crash or a lost conversation is, and this is the cheapest
    // place to catch one.
    for (const key of LAYOUT_KEYS) {
      const { Component } = LAYOUT_REGISTRY[key];
      const { unmount } = render(
        <Component slots={sentinelSlots({ composer: null })} state={stubState()} />
      );
      expect(
        screen.getByTestId('slot-currentExchange'),
        `${key} lost the conversation`
      ).toBeInTheDocument();
      expect(screen.queryByTestId('slot-composer'), `${key} kept a composer`).toBeNull();
      unmount();
    }
  });
});

describe('the history, and where each layout puts it', () => {
  it.each([['classic'], ['focus'], ['broadsheet']] as const)(
    '%s reads the history straight into the current exchange, in one column',
    (key) => {
      // The arrangement a transcript has always had, now expressed as two slots: no seam, no
      // affordance, nothing between the last settled turn and the live one. If this ever stopped
      // being true the split would have changed three layouts nobody asked it to change.
      const { Component } = LAYOUT_REGISTRY[key];
      render(<Component slots={sentinelSlots()} state={stubState()} />);

      const history = screen.getByTestId('slot-history');
      const current = screen.getByTestId('slot-currentExchange');
      expect(history.parentElement?.contains(current), `${key} split the column`).toBe(true);
      expect(precedes(history, current), `${key} put the history after the exchange`).toBe(true);
    }
  );

  it('horizon folds the history into a disclosure and leaves the exchange on the stage', () => {
    // THE point of the layout, and the thing `registry.test.tsx` cannot see: it skips `overlay`
    // placements, so a Horizon that simply rendered the history inline would pass every other
    // assertion in this suite while being Focus with a different name.
    render(<LAYOUT_REGISTRY.horizon.Component slots={sentinelSlots()} state={stubState()} />);

    const disclosure = screen.getByTestId('horizon-history');
    expect(disclosure.tagName).toBe('DETAILS');
    expect(disclosure.contains(screen.getByTestId('slot-history'))).toBe(true);
    expect(disclosure.contains(screen.getByTestId('slot-currentExchange'))).toBe(false);
  });

  it('horizon keeps the recording notice OUT of the disclosure', () => {
    // Why `releaseNotice` became a slot of its own with this layout. Folded away with the history
    // it would be a "your conversation is being recorded" notice nobody is shown — reachable, and
    // therefore passing every mechanical check, while failing the only thing it exists to do.
    render(<LAYOUT_REGISTRY.horizon.Component slots={sentinelSlots()} state={stubState()} />);

    const notice = screen.getByTestId('slot-releaseNotice');
    expect(screen.getByTestId('horizon-history').contains(notice)).toBe(false);
    expect(precedes(notice, screen.getByTestId('slot-currentExchange'))).toBe(true);
  });

  it('horizon offers no disclosure at all when there is no history yet', () => {
    // A fresh session's opening burst is all current exchange, so the container hands over
    // `history: null`. An "Earlier in this conversation" control that opens onto nothing is worse
    // than no control — it implies the respondent has missed something.
    render(
      <LAYOUT_REGISTRY.horizon.Component
        slots={sentinelSlots({ history: null })}
        state={stubState()}
      />
    );

    expect(screen.queryByTestId('horizon-history')).toBeNull();
    expect(screen.getByTestId('slot-currentExchange')).toBeInTheDocument();
  });
});
