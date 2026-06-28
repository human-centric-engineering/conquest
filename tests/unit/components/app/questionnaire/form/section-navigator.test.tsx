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

  it('gently pulses the dots filled by the most recent turn', () => {
    const { container } = render(
      <SectionNavigator
        sections={SECTIONS}
        activeIndex={0}
        onJump={vi.fn()}
        isAnswered={(k) => k === 'a' || k === 'b'}
        isInferred={() => false}
        isRecentlyFilled={(k) => k === 'b'}
      />
    );
    const dots = Array.from(container.querySelectorAll<HTMLElement>('span.rounded-full'));
    // One-shot pulse (settles), not the infinite `cq-livedot` breathe.
    const pulsing = dots.filter((d) => d.className.includes('cq-livedot-once'));
    expect(pulsing).toHaveLength(1); // only slot 'b' was filled this turn
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
    // Inferred dots carry a brand-accent ring (inline box-shadow); plain answered dots are solid
    // (no ring); unanswered dots are hollow (dashed border). Slot 'a' is inferred, 'b' is
    // answered-stated, 'c' is unanswered. (Background colours use CSS var() which jsdom drops, so we
    // key off the box-shadow ring and the dashed-border class — both jsdom-stable.)
    const dots = Array.from(container.querySelectorAll<HTMLElement>('span.rounded-full'));
    const ringed = dots.filter((d) => d.style.boxShadow !== '');
    const answeredSolid = dots.filter(
      (d) => d.style.boxShadow === '' && !d.className.includes('border-dashed')
    );
    expect(ringed).toHaveLength(1); // the inferred dot ('a')
    expect(answeredSolid).toHaveLength(1); // the respondent-stated dot ('b'), no ring
  });
});
