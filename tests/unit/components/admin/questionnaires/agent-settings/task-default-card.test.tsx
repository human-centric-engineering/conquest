/**
 * Component test: TaskDefaultCard.
 *
 * Asserts a non-optimal tier shows the current→recommended model with an enabled
 * Apply that fires `onApply`, and an optimal tier shows the Optimal badge with a
 * disabled button.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TaskDefaultCard } from '@/components/admin/questionnaires/agent-settings/task-default-card';
import type { TaskTierEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';

function tier(overrides: Partial<TaskTierEvaluation> = {}): TaskTierEvaluation {
  return {
    tier: 'reasoning',
    label: 'Reasoning',
    currentModel: 'gpt-4o',
    recommendedModel: 'gpt-5.4',
    currentModelPerMillionUsd: 6.25,
    recommendedModelPerMillionUsd: 8.75,
    isOptimal: false,
    rationale: 'Hard one-off work.',
    ...overrides,
  };
}

describe('TaskDefaultCard', () => {
  it('shows current → recommended and fires onApply on click', () => {
    const onApply = vi.fn();
    render(<TaskDefaultCard tier={tier()} applying={false} saved={false} onApply={onApply} />);

    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.4')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /apply/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('marks an optimal tier and disables the button', () => {
    const onApply = vi.fn();
    render(
      <TaskDefaultCard
        tier={tier({ isOptimal: true, currentModel: 'gpt-5.4' })}
        applying={false}
        saved={false}
        onApply={onApply}
      />
    );
    expect(screen.getByText('Optimal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /up to date/i })).toBeDisabled();
  });

  it('disables the button while applying', () => {
    render(<TaskDefaultCard tier={tier()} applying saved={false} onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  });
});
