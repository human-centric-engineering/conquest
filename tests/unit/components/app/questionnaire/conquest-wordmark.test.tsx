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

  describe('pre-release stage pill', () => {
    it('renders no stage pill by default (stable build)', () => {
      // Default stage is the live release stage, which is `stable`/null in the test env.
      render(<ConquestWordmark />);
      expect(screen.queryByText(/alpha|beta/i)).not.toBeInTheDocument();
      // Accessible name stays the plain brand when there's no stage.
      expect(screen.getByLabelText('ConQuest')).toBeInTheDocument();
    });

    it('renders an ALPHA pill and stage-qualified label when stage="alpha"', () => {
      render(<ConquestWordmark stage="alpha" />);
      expect(screen.getByText('alpha')).toBeInTheDocument();
      // The pill is decorative; the stage is conveyed once via the lockup's accessible name.
      expect(screen.getByLabelText('ConQuest (alpha)')).toBeInTheDocument();
    });

    it('renders a BETA pill when stage="beta"', () => {
      render(<ConquestWordmark stage="beta" />);
      expect(screen.getByText('beta')).toBeInTheDocument();
      expect(screen.getByLabelText('ConQuest (beta)')).toBeInTheDocument();
    });

    it('renders no pill when stage is explicitly stable', () => {
      render(<ConquestWordmark stage="stable" />);
      expect(screen.queryByText(/alpha|beta|stable/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText('ConQuest')).toBeInTheDocument();
    });

    it('renders no pill when stage is null', () => {
      render(<ConquestWordmark stage={null} />);
      expect(screen.getByLabelText('ConQuest')).toBeInTheDocument();
    });
  });
});
