/**
 * ConquestWordmark Component Tests
 *
 * The wordmark is the single source of the ConQuest brand lockup on the admin
 * app surface. These tests pin the two behaviours the rest of the UI relies on:
 * the two-tone "Con" + "Quest" split is always present and labelled, and the
 * "Conversational Questionnaires" tagline is opt-in via `showSubtitle`.
 *
 * Source: components/app/questionnaire/conquest-wordmark.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';

describe('ConquestWordmark', () => {
  it('renders the two-tone "Con" + "Quest" lockup with an accessible name', () => {
    render(<ConquestWordmark />);

    // Both halves render as separate spans so each can be coloured.
    expect(screen.getByText('Con')).toBeInTheDocument();
    expect(screen.getByText('Quest')).toBeInTheDocument();
    // Screen readers get the whole brand, not "Con" / "Quest" fragments.
    expect(screen.getByLabelText('ConQuest')).toBeInTheDocument();
  });

  it('omits the tagline by default', () => {
    render(<ConquestWordmark />);
    expect(screen.queryByText(/conversational questionnaires/i)).not.toBeInTheDocument();
  });

  it('renders the tagline when showSubtitle is set', () => {
    render(<ConquestWordmark showSubtitle />);
    expect(screen.getByText(/conversational questionnaires/i)).toBeInTheDocument();
  });
});
