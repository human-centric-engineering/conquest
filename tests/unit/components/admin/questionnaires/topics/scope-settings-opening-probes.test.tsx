// @vitest-environment happy-dom

/**
 * ScopeSettingsCard — the opening's follow-up allowance (G03 / F17.17).
 *
 * Three things the control must never get wrong, because each of them silently changes what a
 * respondent is asked:
 *
 *   1. **Off shows no number.** A "1" visible beside a switch nobody set reads as a limit already
 *      in force.
 *   2. **Zero says "never follow up".** It is a real setting here, not the off switch, and a field
 *      showing a bare `0` next to a switch reading "on" is ambiguous in exactly the wrong way.
 *   3. **The step is 1.** The card's numbering IS the decision order — that is the whole reason the
 *      topic cap reads as enforced rather than requested — and the opening happens before the
 *      decision.
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
import { ScopeSettingsCard } from '@/components/admin/questionnaires/topics/scope-settings-card';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  MAX_OPENING_PROBES_CEILING,
  type ConditionalTopicsSettings,
} from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

const COSTS: TopicsPayload['costs'] = {
  budgetSeconds: 0,
  alwaysSeconds: 266,
  routedAllowanceSeconds: 0,
  byTopicKey: {},
};

function renderCard(settings: Partial<ConditionalTopicsSettings> = {}) {
  const onSave = vi.fn().mockResolvedValue(true);
  render(
    <ScopeSettingsCard
      settings={{ ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true, ...settings }}
      topics={[]}
      costs={COSTS}
      onSave={onSave}
      busy={false}
    />
  );
  return { onSave };
}

const probeSwitch = () => screen.getByLabelText(/Limit follow-up questions in the opening/);

describe('ScopeSettingsCard — the opening follow-up allowance (G03)', () => {
  it('shows no allowance field while the limit is off', () => {
    renderCard();
    expect(probeSwitch()).not.toBeChecked();
    expect(
      screen.queryByText(/Follow-ups allowed across the whole opening/)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/follows up as often as the per-slot limit allows/)
    ).toBeInTheDocument();
  });

  it('reveals the allowance once the limit is on, and names what one means', () => {
    renderCard({ limitOpeningProbes: true, maxOpeningProbes: 1 });
    expect(screen.getByText(/Follow-ups allowed across the whole opening/)).toBeInTheDocument();
    expect(screen.getByText('one, for the whole opening')).toBeInTheDocument();
  });

  it('says "never follow up" for zero rather than showing a bare 0', () => {
    renderCard({ limitOpeningProbes: true, maxOpeningProbes: 0 });
    expect(screen.getByText('never follow up')).toBeInTheDocument();
  });

  it('pluralises an allowance above one', () => {
    renderCard({ limitOpeningProbes: true, maxOpeningProbes: 3 });
    expect(screen.getByText('3 in total')).toBeInTheDocument();
  });

  it('carries both fields into the saved settings', () => {
    const { onSave } = renderCard({ limitOpeningProbes: true, maxOpeningProbes: 1 });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ limitOpeningProbes: true, maxOpeningProbes: 2 })
    );
  });

  it('clamps a typed allowance to the legal range rather than rejecting the keystroke', () => {
    const { onSave } = renderCard({ limitOpeningProbes: true, maxOpeningProbes: 1 });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ maxOpeningProbes: MAX_OPENING_PROBES_CEILING })
    );
  });

  it('turns the limit on from off, without needing the number first', () => {
    const { onSave } = renderCard();
    fireEvent.click(probeSwitch());
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ limitOpeningProbes: true, maxOpeningProbes: 1 })
    );
  });

  it('sits at step 1 — before the decision, which is what the numbering means', () => {
    // Appending it as a later step would quietly break the one thing the numbers are for: showing
    // that the agent's answer is filtered by limits it cannot argue with.
    renderCard();
    const heading = screen.getByText(/Before the decision/);
    expect(heading.textContent).toMatch(/^1/);
    expect(screen.getByText(/How much the agent may cover/).textContent).toMatch(/^2/);
  });
});
