/**
 * Interviewer switcher (F-persona) — the `indicator` / `both` in-chat presentation.
 *
 * Pins the two presentational pieces the workspace composes: the "Interviewer: {name} · Change" chip
 * (shows the current interviewer, runs the change action) and the modal (renders the persona picker,
 * closes on Done). The workspace owns the state; these just render + delegate.
 *
 * @see components/app/questionnaire/persona/interviewer-switcher.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  CurrentInterviewerChip,
  PersonaSwitcherModal,
} from '@/components/app/questionnaire/persona/interviewer-switcher';

const PERSONAS = [
  { key: 'neutral-coach', label: 'The Coach', description: 'Balanced and objective.' },
  { key: 'comedian', label: 'The Comedian', description: 'Playful and quick-witted.' },
];

describe('CurrentInterviewerChip', () => {
  it('shows the current interviewer name and a Change affordance', () => {
    render(<CurrentInterviewerChip label="The Comedian" onChange={vi.fn()} />);
    expect(screen.getByText('The Comedian')).toBeInTheDocument();
    expect(screen.getByText('Change')).toBeInTheDocument();
  });

  it('runs the change action when pressed', () => {
    const onChange = vi.fn();
    render(<CurrentInterviewerChip label="The Coach" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is inert while busy (e.g. mid-stream)', () => {
    render(<CurrentInterviewerChip label="The Coach" onChange={vi.fn()} busy />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('PersonaSwitcherModal', () => {
  function renderModal(over: Partial<React.ComponentProps<typeof PersonaSwitcherModal>> = {}) {
    const onChoose = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PersonaSwitcherModal
        open
        onOpenChange={onOpenChange}
        personas={PERSONAS}
        selectedKey={null}
        defaultKey="neutral-coach"
        onChoose={onChoose}
        {...over}
      />
    );
    return { onChoose, onOpenChange };
  }

  it('renders the persona picker grid when open', () => {
    renderModal();
    expect(screen.getByText('The Coach')).toBeInTheDocument();
    expect(screen.getByText('The Comedian')).toBeInTheDocument();
  });

  it('persists a pick through onChoose', () => {
    const { onChoose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /The Comedian/ }));
    expect(onChoose).toHaveBeenCalledWith('comedian');
  });

  it('closes on Done', () => {
    const { onOpenChange } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when closed', () => {
    render(
      <PersonaSwitcherModal
        open={false}
        onOpenChange={vi.fn()}
        personas={PERSONAS}
        selectedKey={null}
        defaultKey="neutral-coach"
        onChoose={vi.fn()}
      />
    );
    expect(screen.queryByText('The Coach')).not.toBeInTheDocument();
  });
});
