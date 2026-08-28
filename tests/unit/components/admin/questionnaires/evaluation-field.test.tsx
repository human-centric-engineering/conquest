// @vitest-environment happy-dom

/**
 * The shared typography of the evaluation surfaces — specifically the treatment that keeps the
 * questionnaire's own words distinguishable from the panel's commentary about them.
 *
 * @see components/admin/questionnaires/evaluation-field.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  MetaRow,
  QUESTION_FACE,
  QuotedProse,
  stripRestatedQuotes,
} from '@/components/admin/questionnaires/evaluation-field';

/** Every `<q>` in the render, in document order. */
function quoted(container: HTMLElement): HTMLQuoteElement[] {
  return Array.from(container.querySelectorAll('q'));
}

describe('QuotedProse', () => {
  it('sets a prompt quoted inside a judge sentence apart from the sentence carrying it', () => {
    const { container } = render(
      <p>
        <QuotedProse
          text={'Add a direct question on runway, such as: “How many months could you cover?”'}
        />
      </p>
    );

    const marks = quoted(container);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('How many months could you cover?');
    // The whole point: it is in the questionnaire's face, not the prose face around it.
    expect(marks[0].className).toContain(QUESTION_FACE);
    // Roman, not slanted. The face and the quote marks are already two signals; the slant was a
    // third, and it landed on the longest strings at the smallest sizes.
    expect(marks[0].className).not.toContain('italic');

    // The advice around it survives intact — this restyles a span, it does not rewrite the sentence.
    expect(container.textContent).toBe(
      'Add a direct question on runway, such as: How many months could you cover?'
    );
  });

  it('matches straight quotes as well as curly ones — judges emit both', () => {
    const { container } = render(
      <p>
        <QuotedProse text={'Define "recommend" for the reader.'} />
      </p>
    );
    expect(quoted(container).map((q) => q.textContent)).toEqual(['recommend']);
  });

  it('marks every quoted span, not just the first', () => {
    const { container } = render(
      <p>
        <QuotedProse text={'Merge “How old are you?” into “Tell us about yourself”.'} />
      </p>
    );
    expect(quoted(container).map((q) => q.textContent)).toEqual([
      'How old are you?',
      'Tell us about yourself',
    ]);
  });

  it('leaves an unquoted suggestion exactly as written', () => {
    // Judges often return the bare replacement prompt with no quotes at all. Guessing that a
    // sentence "looks like a question" and restyling the whole of it would misattribute the
    // judge's own advice to the questionnaire.
    const text = 'Split the double-barrelled question into two.';
    const { container } = render(
      <p>
        <QuotedProse text={text} />
      </p>
    );
    expect(quoted(container)).toHaveLength(0);
    expect(container.textContent).toBe(text);
  });

  it('marks a single-character option instead of the prose between two of them', () => {
    // A lazy `{2,}?` floor did not skip a one-character span, it swallowed it: the only match on
    // this sentence became ` or `, so the connective prose was set as the questionnaire's wording
    // and the two options the judge actually proposed were not.
    render(<QuotedProse text={'Offer "y" or "n" as the options'} />);

    const quotes = screen.getAllByText((_, el) => el?.tagName === 'Q');
    expect(quotes.map((q) => q.textContent)).toEqual(['y', 'n']);
  });

  it('does not treat an unpaired quote as a span', () => {
    const text = 'The 5" screen size is ambiguous.';
    const { container } = render(
      <p>
        <QuotedProse text={text} />
      </p>
    );
    expect(quoted(container)).toHaveLength(0);
    expect(container.textContent).toBe(text);
  });

  it('finds the same spans on a re-render', () => {
    // The matcher is a module-level /g/ regex, so a leaked `lastIndex` would make the second
    // render of the same string silently skip its first quote.
    const text = 'Reword to “How confident are you?” for clarity.';
    const { rerender, container } = render(
      <p>
        <QuotedProse text={text} />
      </p>
    );
    expect(quoted(container)).toHaveLength(1);
    rerender(
      <p>
        <QuotedProse text={text} />
      </p>
    );
    expect(quoted(container)).toHaveLength(1);
  });

  it('keeps the quotation marks available to a reader the face never reaches', () => {
    // `<q>` rather than a styled span: the marks come back from the UA stylesheet, so the quoting
    // survives a failed webfont, a screen reader, and greyscale.
    render(
      <p>
        <QuotedProse text={'Reword to “Are you sure?” instead.'} />
      </p>
    );
    expect(screen.getByText('Are you sure?').tagName).toBe('Q');
  });
});

describe('stripRestatedQuotes', () => {
  it('drops a quoted prompt the card already prints in full below it', () => {
    // The exact shape a Coverage judge emits: the drafted question inside the suggestion, and then
    // again in its own block. Read as written, the reviewer meets the same sentence twice in two
    // different faces and has to compare them word by word to discover they are identical.
    const prompt = 'How would you rate the effectiveness of our current sales strategy?';
    expect(
      stripRestatedQuotes(`Add a question on actual sales outcomes: “${prompt}”`, [prompt])
    ).toBe('Add a question on actual sales outcomes.');
  });

  it('tolerates the punctuation and quote-mark drift between the two copies', () => {
    // The block prints the prompt raw; the suggestion wraps it in curly quotes and may end it
    // differently. Matching on the exact string would miss almost every real pair.
    expect(
      stripRestatedQuotes('Ask about runway, such as "How many months could you cover?"', [
        'How many months could you cover',
      ])
    ).toBe('Ask about runway, such as.');
  });

  it('keeps a quote that is not the drafted wording — that is evidence, not a duplicate', () => {
    const text = 'Define “recommend” before asking this.';
    expect(stripRestatedQuotes(text, ['How likely are you to recommend us?'])).toBe(text);
  });

  it('returns nothing when only the lead-in survives', () => {
    // "Add the following question:" on its own is not a sentence — better to print no paragraph
    // than half of one above the block that carries the whole thing.
    expect(stripRestatedQuotes('Add: “Who signs off on this?”', ['Who signs off on this?'])).toBe(
      ''
    );
  });

  it('leaves the text alone when nothing is drafted', () => {
    const text = 'Reword “What is your role?” to name the team.';
    expect(stripRestatedQuotes(text, [])).toBe(text);
  });
});

describe('MetaRow', () => {
  it('separates the facts it is given with a dot and drops the empty ones', () => {
    const { container } = render(
      <MetaRow>
        {'Coverage Judge'}
        {null}
        {false}
        {'Applied'}
      </MetaRow>
    );
    // One separator, between the two facts that survived — a dropped fact must not leave a
    // dangling dot behind it.
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(container.textContent).toBe('Coverage Judge·Applied');
  });
});
