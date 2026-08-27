// @vitest-environment happy-dom

/**
 * GlossaryTermCard component tests (P16).
 *
 * The card has two faces — the open working form, and the collapsed "settled record" a term drops
 * into once it's accepted or rejected. What's worth defending is the boundary between them:
 *
 *   - a verdict COLLAPSES the card and stamps it, so a column of twenty terms is scannable;
 *   - the collapsed record shows only the readings actually in use (an unticked suggestion is on
 *     file, not in force), and shows several as numbered senses exactly as the respondent sees them;
 *   - a card that can NOT be saved as-is — nothing ticked, no surface typed, duplicate surface — is
 *     forced open, because collapsing it would hide the error the admin has to fix.
 *
 * Drives it the way an admin does (click Accept / Edit / Restore) and asserts what renders, plus
 * the `onChange` payload the editor above it relies on.
 *
 * @see components/admin/questionnaires/glossary/glossary-term-card.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GlossaryTermCard } from '@/components/admin/questionnaires/glossary/glossary-term-card';
import type {
  DraftDefinition,
  DraftTerm,
} from '@/components/admin/questionnaires/glossary/glossary-types';

function definition(over: Partial<DraftDefinition> = {}): DraftDefinition {
  return {
    id: 'def-1',
    text: 'The observing part of you.',
    selected: true,
    source: 'ai_proposed',
    sourceQuote: null,
    edited: false,
    ...over,
  };
}

function draft(over: Partial<DraftTerm> = {}): DraftTerm {
  return {
    id: 'term-1',
    term: 'higher self',
    aliases: [],
    status: 'accepted',
    source: 'ai_proposed',
    rationale: 'A spiritually loaded term with several live readings.',
    contextQuote: null,
    definitions: [definition()],
    ...over,
  };
}

function renderCard(term: DraftTerm, duplicateOf: string | null = null) {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <GlossaryTermCard
      term={term}
      duplicateOf={duplicateOf}
      onChange={onChange}
      onRemove={onRemove}
    />
  );
  return { onChange, onRemove, ...view };
}

/** The card's open face is the one with editable fields; the settled face has none. */
const termField = () => screen.queryByPlaceholderText('The term as it appears in your questions');

describe('GlossaryTermCard — settled record', () => {
  it('collapses an accepted term to a stamped record with the reading in force', () => {
    renderCard(draft());

    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('higher self')).toBeInTheDocument();
    expect(screen.getByText('The observing part of you.')).toBeInTheDocument();
    // The form is gone — that's the decluttering the record buys.
    expect(termField()).not.toBeInTheDocument();
    expect(screen.queryByText(/Why this may need defining/)).not.toBeInTheDocument();
  });

  it('lists only the readings actually in use, not every suggestion on file', () => {
    renderCard(
      draft({
        definitions: [
          definition({ id: 'd1', text: 'In force.', selected: true }),
          definition({ id: 'd2', text: 'On file only.', selected: false }),
        ],
      })
    );

    expect(screen.getByText('In force.')).toBeInTheDocument();
    expect(screen.queryByText('On file only.')).not.toBeInTheDocument();
  });

  it('renders several accepted readings as numbered senses, the way a respondent sees them', () => {
    renderCard(
      draft({
        definitions: [
          definition({ id: 'd1', text: 'Sense one.' }),
          definition({ id: 'd2', text: 'Sense two.' }),
        ],
      })
    );

    const senses = screen.getAllByRole('listitem');
    expect(senses.map((item) => item.textContent)).toEqual(['Sense one.', 'Sense two.']);
  });

  it('collapses a rejected term to its verdict, with a way back', () => {
    const { onChange } = renderCard(draft({ status: 'rejected' }));

    expect(screen.getByText('Rejected')).toBeInTheDocument();
    // A rejected term is not in force, so its wording is not part of the record.
    expect(screen.queryByText('The observing part of you.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(termField()).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores a rejected term to accepted on Restore', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCard(draft({ status: 'rejected' }));

    await user.click(screen.getByRole('button', { name: /Restore/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
  });

  it('reopens the form on Edit, keeping the stamp visible while editing', async () => {
    const user = userEvent.setup();
    renderCard(draft());

    await user.click(screen.getByRole('button', { name: /Edit/ }));

    expect(termField()).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText(/Why this may need defining/)).toBeInTheDocument();
  });

  it('collapses again on Done', async () => {
    const user = userEvent.setup();
    renderCard(draft());

    await user.click(screen.getByRole('button', { name: /Edit/ }));
    await user.click(screen.getByRole('button', { name: /Done/ }));

    expect(termField()).not.toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });
});

describe('GlossaryTermCard — cards that must stay open', () => {
  it('forces an accepted term with nothing ticked open, and withholds Done', () => {
    renderCard(draft({ definitions: [definition({ selected: false })] }));

    expect(termField()).toBeInTheDocument();
    expect(screen.getByText(/Tick at least one to accept/)).toBeInTheDocument();
    // Collapsing here would hide the one thing stopping this term from working.
    expect(screen.queryByRole('button', { name: /Done/ })).not.toBeInTheDocument();
  });

  it('opens a blank hand-added term, which arrives accepted with nothing typed', () => {
    renderCard(draft({ term: '', source: 'admin', rationale: null }));
    expect(termField()).toBeInTheDocument();
  });

  it('forces a duplicate open so the clash is visible, not summarised away', () => {
    renderCard(draft(), 'higher self');

    expect(screen.getByText(/Already defined above/)).toBeInTheDocument();
    expect(termField()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Done/ })).not.toBeInTheDocument();
  });
});

describe('GlossaryTermCard — adjudication', () => {
  it('shows a proposal as the working form, with no verdict stamped on it', () => {
    renderCard(draft({ status: 'proposed' }));

    expect(termField()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accept/ })).toBeInTheDocument();
    expect(screen.queryByText('Accepted')).not.toBeInTheDocument();
  });

  it('reports the accepted status upward — the editor owns the term list', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCard(draft({ status: 'proposed' }));

    await user.click(screen.getByRole('button', { name: /^Accept/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
  });

  it('rejects from the settled record without reopening the form', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCard(draft());

    await user.click(screen.getByRole('button', { name: /Reject/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(termField()).not.toBeInTheDocument();
  });

  it('keeps the delete affordance on a settled card', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderCard(draft());

    await user.click(screen.getByRole('button', { name: /Delete higher self/ }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('still ticks and edits readings once reopened', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCard(
      draft({
        definitions: [
          definition({ selected: true }),
          definition({ id: 'd2', text: 'Second.', selected: false }),
        ],
      })
    );

    await user.click(screen.getByRole('button', { name: /Edit/ }));
    const boxes = screen.getAllByRole('checkbox', { name: /Use this definition/ });
    await user.click(boxes[1]);

    const next = onChange.mock.calls.at(-1)?.[0] as DraftTerm;
    expect(next.definitions[1].selected).toBe(true);
  });
});

describe('GlossaryTermCard — definitions', () => {
  it('adds a blank admin-sourced definition on "Add a definition"', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCard(draft({ status: 'proposed' }));

    await user.click(screen.getByRole('button', { name: /Add a definition/ }));

    const next = onChange.mock.calls.at(-1)?.[0] as DraftTerm;
    expect(next.definitions).toHaveLength(2);
    expect(next.definitions[1]).toMatchObject({
      text: '',
      selected: false,
      source: 'admin',
      sourceQuote: null,
      edited: false,
    });
  });

  it('removes a definition on "Remove definition"', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCard(
      draft({
        status: 'proposed',
        definitions: [definition({ id: 'd1' }), definition({ id: 'd2', text: 'Second.' })],
      })
    );

    const removeButtons = screen.getAllByRole('button', { name: /Remove definition/ });
    await user.click(removeButtons[0]);

    const next = onChange.mock.calls.at(-1)?.[0] as DraftTerm;
    expect(next.definitions.map((d) => d.id)).toEqual(['d2']);
  });

  it('stamps edited:true the first time an unedited AI-suggested definition is changed', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCard(
      draft({
        status: 'proposed',
        definitions: [
          definition({ source: 'ai_proposed', edited: false, text: 'Original.', selected: true }),
        ],
      })
    );

    const textarea = screen.getByPlaceholderText('What this term means in this questionnaire…');
    await user.type(textarea, '!');

    const next = onChange.mock.calls.at(-1)?.[0] as DraftTerm;
    expect(next.definitions[0].text).toBe('Original.!');
    expect(next.definitions[0].edited).toBe(true);
  });

  it('badges a document-sourced definition as from the source document', () => {
    renderCard(
      draft({
        status: 'proposed',
        definitions: [definition({ source: 'document' })],
      })
    );

    expect(screen.getByText('From your document')).toBeInTheDocument();
  });
});

describe('GlossaryTermCard — term and aliases fields', () => {
  it('parses the aliases field into a trimmed, comma-separated list', () => {
    const { onChange } = renderCard(draft({ status: 'proposed' }));

    const aliasInput = screen.getByPlaceholderText(
      'Comma-separated alternative spellings or acronyms'
    );
    fireEvent.change(aliasInput, { target: { value: 'Higher Self, HS' } });

    const next = onChange.mock.calls.at(-1)?.[0] as DraftTerm;
    expect(next.aliases).toEqual(['Higher Self', 'HS']);
  });
});

describe('GlossaryTermCard — status rail', () => {
  it('marks the card with its curation state so the column is scannable', () => {
    const { container, rerender } = renderCard(draft());
    const card = () => container.querySelector('[data-testid="glossary-term-card"]') as HTMLElement;
    expect(card().dataset.status).toBe('accepted');
    expect(card().className).toContain('border-l-emerald-500');

    rerender(
      <GlossaryTermCard
        term={draft({ status: 'rejected' })}
        duplicateOf={null}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />
    );
    expect(card().dataset.status).toBe('rejected');
    expect(card().className).toContain('border-l-destructive/60');
  });

  it('keeps the verdict readable without relying on colour alone', () => {
    renderCard(draft());
    // The word and the icon carry the verdict too, not just the emerald rail.
    const stamp = screen.getByText('Accepted');
    expect(stamp.querySelector('svg')).toBeInTheDocument();
  });
});
