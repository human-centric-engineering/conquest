// @vitest-environment happy-dom

/**
 * ScopeSettingsCard — the session length budget (C7).
 *
 * The number an author types is not the number that matters. Most of a budget is already spent by
 * the questions every respondent gets, and what is left is the only figure that decides how much
 * routing is possible — so the readout beneath the field is the feature, not decoration. These
 * cover the two things it must never get wrong: that it states the leftover, and that it says so
 * plainly when there isn't one.
 *
 * @see components/admin/questionnaires/topics/scope-settings-card.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      {...rest}
    />
  ),
}));
vi.mock('@/components/ui/multi-select', () => ({
  MultiSelect: () => <div data-testid="multi-select" />,
}));
vi.mock('@/components/admin/questionnaires/topics/scope-rules-editor', () => ({
  ScopeRulesEditor: () => <div data-testid="rules-editor" />,
}));

import { ScopeSettingsCard } from '@/components/admin/questionnaires/topics/scope-settings-card';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
} from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

function costs(over: Partial<TopicsPayload['costs']> = {}): TopicsPayload['costs'] {
  return {
    budgetSeconds: 600,
    alwaysSeconds: 266,
    routedAllowanceSeconds: 334,
    byTopicKey: {},
    ...over,
  };
}

function renderCard(settings: Partial<ConditionalTopicsSettings>, costView = costs()) {
  const onSave = vi.fn().mockResolvedValue(true);
  render(
    <ScopeSettingsCard
      settings={{ ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true, ...settings }}
      topics={[]}
      dataSlots={[]}
      costs={costView}
      onSave={onSave}
      busy={false}
    />
  );
  return { onSave };
}

describe('ScopeSettingsCard — session length budget (C7)', () => {
  it('says nothing about time when no budget is set', () => {
    renderCard({ sessionBudgetSeconds: 0 });
    expect(screen.getByText('no limit')).toBeInTheDocument();
    expect(screen.queryByText(/leaving/)).not.toBeInTheDocument();
  });

  it('states what the always-on questions cost and what is left', () => {
    // The whole point: "600" is not the number an author is allocating.
    renderCard({ sessionBudgetSeconds: 600 });
    expect(screen.getByText(/4m 26s/)).toBeInTheDocument();
    expect(screen.getByText(/5m 34s/)).toBeInTheDocument();
  });

  it('warns plainly when the floor already exceeds the budget', () => {
    // Not a tight interview — a broken one. Nothing can ever route, and the symptom without this
    // is an instrument that quietly stops adapting.
    renderCard({ sessionBudgetSeconds: 200 }, costs({ alwaysSeconds: 266 }));
    expect(screen.getByText(/No conditional topic can fit/)).toBeInTheDocument();
  });

  it('keeps the topic limit alongside it — breadth and duration are different bounds', () => {
    renderCard({ sessionBudgetSeconds: 600 });
    expect(screen.getByText(/Most conditional topics per interview/)).toBeInTheDocument();
    expect(screen.getByText(/How long an interview may take/)).toBeInTheDocument();
  });

  it('carries the budget into the saved settings', () => {
    const { onSave } = renderCard({ sessionBudgetSeconds: 600 });
    const input = screen.getByDisplayValue('600');
    fireEvent.change(input, { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ sessionBudgetSeconds: 900 }));
  });
});
