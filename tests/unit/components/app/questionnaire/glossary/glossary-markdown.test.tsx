// @vitest-environment happy-dom

/**
 * Glossary markdown annotator — component tests (P16).
 *
 * The exclusion rules are what this file exists to defend. The annotator only ever inspects
 * STRING children, which is what structurally keeps code spans and links out of annotation — but
 * "structurally" is a claim about how react-markdown hands children to overrides, and that is
 * exactly the kind of claim that should be pinned by a test rather than trusted.
 *
 * @see components/app/questionnaire/glossary/glossary-markdown.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GlossaryMarkdown } from '@/components/app/questionnaire/glossary/glossary-markdown';
import { GlossaryText } from '@/components/app/questionnaire/glossary/glossary-text';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

const EGO: GlossaryEntry = {
  termId: 't-ego',
  term: 'ego',
  surfaces: ['ego'],
  definitions: ['The constructed self that seeks approval.'],
};

const MULTI: GlossaryEntry = {
  termId: 't-multi',
  term: 'higher self',
  surfaces: ['higher self'],
  definitions: ['The observing part of you.', 'Your connection to something larger.'],
};

/** Every rendered glossary trigger, in document order. */
function triggers(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^Definition of / });
}

describe('GlossaryMarkdown', () => {
  it('underlines a defined term in a paragraph', () => {
    render(<GlossaryMarkdown glossary={[EGO]}>{'Describe your ego honestly.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(1);
    expect(triggers()[0]).toHaveTextContent('ego');
    expect(triggers()[0]).toHaveAttribute('aria-label', 'Definition of ego');
  });

  it('renders nothing special when no glossary is supplied', () => {
    render(<GlossaryMarkdown>{'Describe your ego honestly.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(0);
    expect(screen.getByText(/Describe your ego honestly/)).toBeInTheDocument();
  });

  it('renders nothing special for an empty glossary', () => {
    render(<GlossaryMarkdown glossary={[]}>{'Describe your ego honestly.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(0);
  });

  it('does NOT annotate inside a code span', () => {
    // Verbatim content: an underline inside an identifier is misleading.
    render(<GlossaryMarkdown glossary={[EGO]}>{'Set the `ego` flag.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(0);
  });

  it('does NOT annotate inside a link', () => {
    render(
      <GlossaryMarkdown glossary={[EGO]}>{'See [ego](https://example.com).'}</GlossaryMarkdown>
    );
    expect(triggers()).toHaveLength(0);
  });

  it('DOES annotate inside bold, where the interviewer emphasises a phrase', () => {
    // The interviewer bolds one phrase per message; a defined term landing there must not
    // silently lose its definition.
    render(<GlossaryMarkdown glossary={[EGO]}>{'Describe your **ego** now.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(1);
  });

  it('DOES annotate inside a list item', () => {
    render(<GlossaryMarkdown glossary={[EGO]}>{'- your ego\n- something else'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(1);
  });

  it('annotates only the first occurrence across a whole multi-paragraph message', () => {
    // A shared `seen` set spans the paragraphs of one message — four underlines of one word reads
    // as emphasis, not as a definition affordance.
    render(
      <GlossaryMarkdown glossary={[EGO]}>
        {'Your ego matters here.\n\nAnd your ego again later.'}
      </GlossaryMarkdown>
    );
    expect(triggers()).toHaveLength(1);
  });

  it('does not annotate a term embedded in a longer word', () => {
    render(<GlossaryMarkdown glossary={[EGO]}>{'That is egotistical.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(0);
  });

  it('keeps the surrounding prose intact around an annotated term', () => {
    const { container } = render(
      <GlossaryMarkdown glossary={[EGO]}>{'Describe your ego honestly.'}</GlossaryMarkdown>
    );
    expect(container.textContent).toBe('Describe your ego honestly.');
  });

  it('preserves the surface as written, not the canonical term', () => {
    // "Ego" at the start of a sentence must stay capitalised or the sentence reads wrong.
    render(<GlossaryMarkdown glossary={[EGO]}>{'Ego is the subject.'}</GlossaryMarkdown>);
    expect(triggers()[0]).toHaveTextContent('Ego');
  });
});

describe('GlossaryText', () => {
  it('underlines a defined term in plain text', () => {
    render(<GlossaryText text="How healthy is your ego?" glossary={[EGO]} />);
    expect(triggers()).toHaveLength(1);
  });

  it('returns the text verbatim with no glossary', () => {
    const { container } = render(<GlossaryText text="How healthy is your ego?" />);
    expect(triggers()).toHaveLength(0);
    expect(container.textContent).toBe('How healthy is your ego?');
  });

  it('scopes first-occurrence-only to its own label', () => {
    // Two form fields that both use a term should EACH explain it — unlike two paragraphs of one
    // chat message, which are read together.
    render(
      <>
        <GlossaryText text="Your ego, first field." glossary={[EGO]} />
        <GlossaryText text="Your ego, second field." glossary={[EGO]} />
      </>
    );
    expect(triggers()).toHaveLength(2);
  });

  it('carries the term with several senses through to its trigger', () => {
    render(<GlossaryText text="About your higher self." glossary={[MULTI]} />);
    expect(triggers()).toHaveLength(1);
    expect(triggers()[0]).toHaveAttribute('aria-label', 'Definition of higher self');
  });
});

describe('GlossaryMarkdown — re-render stability', () => {
  it('keeps the underline when the parent re-renders with identical props', () => {
    // THE REGRESSION. `seen` used to live inside a `useMemo` keyed on [glossary, children], but it
    // is mutated during render. Any re-render with unchanged props returned the cached overrides
    // closing over an already-populated set, so every term was treated as "already seen" and
    // rendered as plain text. QuestionnaireChat owns the composer's input state and renders the
    // transcript in the same component, so this fired on EVERY keystroke: the underlines appeared
    // once and vanished the moment the respondent started typing.
    const { rerender } = render(
      <GlossaryMarkdown glossary={[EGO]}>{'Describe your ego honestly.'}</GlossaryMarkdown>
    );
    expect(triggers()).toHaveLength(1);

    rerender(<GlossaryMarkdown glossary={[EGO]}>{'Describe your ego honestly.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(1);

    rerender(<GlossaryMarkdown glossary={[EGO]}>{'Describe your ego honestly.'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(1);
  });

  it('still annotates once per message as a reply streams in', () => {
    // The property the original memo was reaching for, preserved: a growing message re-annotates
    // from scratch rather than suppressing terms against a stale set.
    const { rerender } = render(<GlossaryMarkdown glossary={[EGO]}>{'Your ego'}</GlossaryMarkdown>);
    expect(triggers()).toHaveLength(1);

    rerender(
      <GlossaryMarkdown glossary={[EGO]}>{'Your ego matters. Your ego again.'}</GlossaryMarkdown>
    );
    // Still exactly one — first occurrence per message, not per paragraph and not per render.
    expect(triggers()).toHaveLength(1);
  });

  it("does not leak react-markdown's mdast `node` prop onto the DOM", () => {
    const { container } = render(
      <GlossaryMarkdown glossary={[EGO]}>{'Describe your ego.'}</GlossaryMarkdown>
    );
    const p = container.querySelector('p');
    expect(p?.hasAttribute('node')).toBe(false);
  });
});

describe('GlossaryTermMark', () => {
  it('opens the definition popover when the term is clicked', async () => {
    // THE REGRESSION. The trigger's own onClick called `event.preventDefault()` (to stop a
    // surrounding <label> toggling its control). Radix composes its open-toggle onto that handler
    // with `composeEventHandlers`, which bails when the event was default-prevented — so the click
    // focused the word and did nothing else. In prod, defined terms looked live but never
    // explained themselves.
    const user = userEvent.setup();
    render(<GlossaryMarkdown glossary={[EGO]}>{'Describe your ego honestly.'}</GlossaryMarkdown>);

    await user.click(triggers()[0]);

    expect(
      await screen.findByText('The constructed self that seeks approval.')
    ).toBeInTheDocument();
  });

  it('lists every sense when the term has more than one definition', async () => {
    const user = userEvent.setup();
    render(<GlossaryMarkdown glossary={[MULTI]}>{'Your higher self knows.'}</GlossaryMarkdown>);

    await user.click(triggers()[0]);

    expect(await screen.findByText(/uses this term in more than one sense/)).toBeInTheDocument();
    expect(screen.getByText('The observing part of you.')).toBeInTheDocument();
    expect(screen.getByText('Your connection to something larger.')).toBeInTheDocument();
  });

  it('does not toggle a surrounding clickable control when the term is clicked', async () => {
    // Why the handler still calls stopPropagation: a defined term can sit inside a label or a
    // clickable row, and opening a definition must not also select that option.
    const user = userEvent.setup();
    let rowClicks = 0;
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div onClick={() => (rowClicks += 1)}>
        <GlossaryMarkdown glossary={[EGO]}>{'Describe your ego honestly.'}</GlossaryMarkdown>
      </div>
    );

    await user.click(triggers()[0]);

    expect(
      await screen.findByText('The constructed self that seeks approval.')
    ).toBeInTheDocument();
    expect(rowClicks).toBe(0);
  });
});
