/**
 * PersonaPicker — the respondent "Choose your interviewer" surface (F-persona).
 *
 * Pins the surface's OWN behaviour: it renders a card per persona (name + description), highlights
 * the current choice (falling back to the default when nothing is chosen), fires `onChoose` on a
 * card press and `onContinue` on the CTA, and disables interaction while busy.
 *
 * @see components/app/questionnaire/persona/persona-picker.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PersonaPicker } from '@/components/app/questionnaire/persona/persona-picker';

const PERSONAS = [
  { key: 'neutral-coach', label: 'The Coach', description: 'Balanced and objective.' },
  { key: 'comedian', label: 'The Comedian', description: 'Playful and quick-witted.' },
];

function renderPicker(over: Partial<React.ComponentProps<typeof PersonaPicker>> = {}) {
  const onChoose = vi.fn();
  const onContinue = vi.fn();
  render(
    <PersonaPicker
      personas={PERSONAS}
      selectedKey={null}
      defaultKey="neutral-coach"
      onChoose={onChoose}
      onContinue={onContinue}
      {...over}
    />
  );
  return { onChoose, onContinue };
}

describe('PersonaPicker', () => {
  it('renders a card per persona with its name and description', () => {
    renderPicker();
    expect(screen.getByText('The Coach')).toBeInTheDocument();
    expect(screen.getByText('Balanced and objective.')).toBeInTheDocument();
    expect(screen.getByText('The Comedian')).toBeInTheDocument();
    expect(screen.getByText('Playful and quick-witted.')).toBeInTheDocument();
  });

  it('highlights the default persona when nothing is chosen', () => {
    renderPicker({ selectedKey: null, defaultKey: 'comedian' });
    expect(screen.getByRole('button', { name: /The Comedian/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /The Coach/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('leads with the default persona (first card) and badges it "Default"', () => {
    // Default is the second entry in the source order; it should be pulled to the front.
    renderPicker({ defaultKey: 'comedian' });
    const cards = screen.getAllByRole('button', { name: /The (Coach|Comedian)/ });
    expect(cards[0]).toHaveAccessibleName(/The Comedian/);
    // The "Default" badge sits on the default card only.
    const badges = screen.getAllByText('Default');
    expect(badges).toHaveLength(1);
    expect(cards[0]).toContainElement(badges[0]);
  });

  it('highlights the explicit choice over the default', () => {
    renderPicker({ selectedKey: 'comedian', defaultKey: 'neutral-coach' });
    expect(screen.getByRole('button', { name: /The Comedian/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('fires onChoose with the card key when a persona is pressed', () => {
    const { onChoose } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /The Comedian/ }));
    expect(onChoose).toHaveBeenCalledWith('comedian');
  });

  it('fires onContinue from the CTA', () => {
    const { onContinue } = renderPicker({ continueLabel: 'Start the conversation' });
    fireEvent.click(screen.getByRole('button', { name: /Start the conversation/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('disables the cards and CTA while busy', () => {
    renderPicker({ busy: true });
    expect(screen.getByRole('button', { name: /The Coach/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Start the conversation/ })).toBeDisabled();
  });
});
