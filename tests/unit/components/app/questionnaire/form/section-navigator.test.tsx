/**
 * SectionNavigator — the completeness map for the form surface (P-presentation). Pins: per-section
 * answered/total counts, the active-section highlight, jump-to-section, and the inferred-answer dot
 * styling that lets a respondent spot what the agent filled in the background.
 *
 * @see components/app/questionnaire/form/section-navigator.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { SectionNavigator } from '@/components/app/questionnaire/form/section-navigator';
import type { PanelSectionView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

function slot(slotKey: string, prompt: string): PanelSlotView {
  return {
    slotKey,
    prompt,
    type: 'free_text',
    typeConfig: null,
    required: false,
    answered: false,
    value: null,
    provenance: null,
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: null,
    refinementHistory: [],
  };
}

const SECTIONS: PanelSectionView[] = [
  { sectionId: 's1', title: 'About', slots: [slot('a', 'A?'), slot('b', 'B?')] },
  { sectionId: 's2', title: 'Goals', slots: [slot('c', 'C?')] },
];

describe('SectionNavigator', () => {
  it('shows per-section answered/total counts', () => {
    render(
      <SectionNavigator
        sections={SECTIONS}
        activeIndex={0}
        onJump={vi.fn()}
        isAnswered={(k) => k === 'a'}
        isInferred={() => false}
      />
    );
    expect(screen.getByText('1/2')).toBeInTheDocument(); // About: a answered
    expect(screen.getByText('0/1')).toBeInTheDocument(); // Goals: none
  });

  it('marks the active section', () => {
    render(
      <SectionNavigator
        sections={SECTIONS}
        activeIndex={1}
        onJump={vi.fn()}
        isAnswered={() => false}
        isInferred={() => false}
      />
    );
    expect(screen.getByRole('button', { name: /Goals/ })).toHaveAttribute('aria-current', 'true');
  });

  it('jumps to a section on click', () => {
    const onJump = vi.fn();
    render(
      <SectionNavigator
        sections={SECTIONS}
        activeIndex={0}
        onJump={onJump}
        isAnswered={() => false}
        isInferred={() => false}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Goals/ }));
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it('rings an inferred answer dot distinctly from a respondent-stated one', () => {
    const { container } = render(
      <SectionNavigator
        sections={SECTIONS}
        activeIndex={0}
        onJump={vi.fn()}
        isAnswered={(k) => k === 'a' || k === 'b'}
        isInferred={(k) => k === 'a'}
      />
    );
    // Inferred dots carry a ring; plain answered dots are solid. At least one of each is present.
    expect(container.querySelector('.ring-primary')).toBeTruthy();
  });
});
