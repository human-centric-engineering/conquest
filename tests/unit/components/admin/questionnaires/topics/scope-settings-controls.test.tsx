/**
 * ScopeSettingsCard — the controls themselves, and the draft they edit.
 *
 * `scope-settings-budget.test.tsx` and `scope-settings-opening-probes.test.tsx` cover the two
 * readouts on this card that do arithmetic. What is covered here is everything else: each control
 * writing the field it claims to, the two numeric inputs that clamp rather than reject, and the
 * dirty/save cycle the whole card hangs off.
 *
 * Two of these are worth more than their line count suggests:
 *
 * - **`boundedInt` clamps, it does not reject.** An author dragging a number spinner past the ceiling,
 *   or clearing the box to retype it, must not be able to put an out-of-range value into the draft —
 *   and must not have the keystroke swallowed either. The fallback keeps the previous value rather
 *   than resetting to a default.
 * - **The Save button is gated on `dirty`, not on validity.** A card that saved when nothing had
 *   changed would fork a launched version for no reason, which is the one destructive thing this
 *   surface can do by accident.
 *
 * @see components/admin/questionnaires/topics/scope-settings-card.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: ReactNode }) => <span>{children}</span>,
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
  MultiSelect: ({
    options,
    value,
    onChange,
    placeholder,
  }: {
    options: { value: string; label: string }[];
    value: string[];
    onChange: (next: string[]) => void;
    placeholder: string;
  }) => (
    <button
      type="button"
      data-testid={`multi-${placeholder}`}
      data-value={value.join(',')}
      data-options={options.map((o) => o.value).join(',')}
      onClick={() => onChange([...value, options[0]?.value ?? 'x'])}
    >
      {placeholder}
    </button>
  ),
}));
vi.mock('@/components/admin/questionnaires/topics/scope-rules-editor', () => ({
  ScopeRulesEditor: ({ onChange }: { onChange: (next: unknown[]) => void }) => (
    <button type="button" data-testid="rules-editor" onClick={() => onChange([RULE])}>
      rules
    </button>
  ),
}));

import { ScopeSettingsCard } from '@/components/admin/questionnaires/topics/scope-settings-card';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  MAX_CONDITIONAL_TOPICS_CEILING,
  MIN_CONDITIONAL_TOPICS,
  PLANNER_INSTRUCTIONS_MAX_LENGTH,
  type AdaptiveScopeSettings,
  type ScopeRule,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const RULE: ScopeRule = {
  id: 'r1',
  dataSlotKey: 'licence',
  operator: 'not_exists',
  value: '',
  action: 'exclude',
  topicKey: 'audit',
  ordinal: 0,
};

function topic(key: string, phase: Topic['phase']): Topic {
  return {
    id: `t-${key}`,
    key,
    label: `Topic ${key}`,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it applies' : null,
    depth: 'full',
    members: { questionKeys: [], dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
  };
}

const CONDITIONALS = [topic('pricing', 'conditional'), topic('support', 'conditional')];

const COSTS: TopicsPayload['costs'] = {
  budgetSeconds: 0,
  alwaysSeconds: 0,
  routedAllowanceSeconds: 0,
  byTopicKey: {},
};

function renderCard(
  settings: Partial<AdaptiveScopeSettings> = {},
  { topics = CONDITIONALS, busy = false } = {}
) {
  const onSave = vi.fn().mockResolvedValue(true);
  render(
    <ScopeSettingsCard
      settings={{ ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true, ...settings }}
      topics={topics}
      dataSlots={[]}
      costs={COSTS}
      onSave={onSave}
      busy={busy}
    />
  );
  return { onSave };
}

/**
 * The one save control. Matched loosely because `SaveButton` relabels itself to "Saved" for two
 * seconds after a successful save, and a strict name would stop finding it exactly when the
 * post-save assertions run.
 */
const saveButton = () => screen.getByRole('button', { name: /^Save/ });

/** The draft the card would save. Read by clicking Save, which is the only way it leaves the card. */
async function savedDraft(onSave: ReturnType<typeof vi.fn>): Promise<AdaptiveScopeSettings> {
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls.at(-1)![0] as AdaptiveScopeSettings;
}

/**
 * The two numeric inputs carry no `id` and their `<Label>` is not associated with them, so there is no
 * accessible name to query by. They are picked out by the bounds they declare — which is also the
 * assertion that those bounds reached the DOM at all.
 */
function spin(max: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[type="number"][max="${max}"]`);
  if (!el) throw new Error(`no number input with max=${max}`);
  return el;
}

/** A switch, by the id the card gives it. */
function toggleById(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no switch #${id}`);
  return el;
}

const topicLimit = () => spin(String(MAX_CONDITIONAL_TOPICS_CEILING));
const confidence = () => spin('1');

/* -------------------------------------------------------------------------- */
/* The master switch                                                          */
/* -------------------------------------------------------------------------- */

describe('ScopeSettingsCard — the master switch', () => {
  it('reads Off when the version does not route, and On when it does', () => {
    renderCard({ enabled: false });
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('flips the draft and the label together', () => {
    renderCard({ enabled: false });

    fireEvent.click(toggleById('adaptive-scope-enabled'));

    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('carries the flip through to the save', async () => {
    const { onSave } = renderCard({ enabled: false });

    fireEvent.click(toggleById('adaptive-scope-enabled'));

    expect((await savedDraft(onSave)).enabled).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The topic limit                                                            */
/* -------------------------------------------------------------------------- */

describe('ScopeSettingsCard — the topic limit', () => {
  it('accepts an in-range number', async () => {
    const { onSave } = renderCard();

    fireEvent.change(topicLimit(), { target: { value: '4' } });

    expect((await savedDraft(onSave)).maxConditionalTopics).toBe(4);
  });

  it('clamps above the ceiling rather than storing it', async () => {
    const { onSave } = renderCard();

    fireEvent.change(topicLimit(), { target: { value: '999' } });

    expect((await savedDraft(onSave)).maxConditionalTopics).toBe(MAX_CONDITIONAL_TOPICS_CEILING);
  });

  it('clamps below the floor rather than storing zero', async () => {
    const { onSave } = renderCard();

    fireEvent.change(topicLimit(), { target: { value: '0' } });

    expect((await savedDraft(onSave)).maxConditionalTopics).toBe(MIN_CONDITIONAL_TOPICS);
  });

  it('keeps the previous value when the box is cleared, rather than rejecting the keystroke', async () => {
    const { onSave } = renderCard({ maxConditionalTopics: 3 });

    fireEvent.change(topicLimit(), { target: { value: '' } });

    expect((await savedDraft(onSave)).maxConditionalTopics).toBe(3);
  });

  it('warns when the limit is wide enough to select every conditional topic every time', () => {
    renderCard({ maxConditionalTopics: 5 });

    expect(screen.getByText(/so this limit selects all of them every time/)).toBeInTheDocument();
  });

  it('says "topic" rather than "topics" when only one is conditional', () => {
    renderCard({ maxConditionalTopics: 5 }, { topics: [topic('pricing', 'conditional')] });

    expect(screen.getByText(/You have 1 conditional/)).toBeInTheDocument();
    expect(screen.getByText(/topic,/)).toBeInTheDocument();
  });

  it('says nothing when the limit is tighter than the conditional set', () => {
    renderCard({ maxConditionalTopics: 1 });

    expect(screen.queryByText(/selects all of them/)).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* The confidence floor                                                       */
/* -------------------------------------------------------------------------- */

describe('ScopeSettingsCard — the confidence floor', () => {
  it('accepts a fraction', async () => {
    const { onSave } = renderCard();

    fireEvent.change(confidence(), { target: { value: '0.85' } });

    expect((await savedDraft(onSave)).minConfidence).toBe(0.85);
  });

  it.each([
    ['above 1', '2', 1],
    ['below 0', '-1', 0],
  ])('clamps a value %s', async (_label, typed, expected) => {
    const { onSave } = renderCard();

    fireEvent.change(confidence(), { target: { value: typed } });

    expect((await savedDraft(onSave)).minConfidence).toBe(expected);
  });

  it('keeps the previous value when the box is cleared', async () => {
    const { onSave } = renderCard({ minConfidence: 0.6 });

    fireEvent.change(confidence(), { target: { value: '' } });

    expect((await savedDraft(onSave)).minConfidence).toBe(0.6);
  });
});

/* -------------------------------------------------------------------------- */
/* The blind-spot check                                                       */
/* -------------------------------------------------------------------------- */

describe('ScopeSettingsCard — the blind-spot check', () => {
  it('hides the preference picker while the check is off', () => {
    renderCard({ includeCheckTopic: false });

    expect(screen.queryByTestId('multi-Any unselected topic')).not.toBeInTheDocument();
  });

  it('reveals the preference picker when the check is switched on', async () => {
    const { onSave } = renderCard({ includeCheckTopic: false });

    fireEvent.click(toggleById('scope-check-topic'));

    expect(await screen.findByTestId('multi-Any unselected topic')).toBeInTheDocument();
    expect((await savedDraft(onSave)).includeCheckTopic).toBe(true);
  });

  it('offers only conditional topics as preferences — an always-run topic cannot be the check', () => {
    renderCard({ includeCheckTopic: true }, { topics: [...CONDITIONALS, topic('core', 'core')] });

    expect(screen.getByTestId('multi-Any unselected topic')).toHaveAttribute(
      'data-options',
      'pricing,support'
    );
  });

  it('writes the chosen preference into the draft', async () => {
    const { onSave } = renderCard({ includeCheckTopic: true });

    fireEvent.click(screen.getByTestId('multi-Any unselected topic'));

    expect((await savedDraft(onSave)).checkTopicPreference).toEqual(['pricing']);
  });
});

/* -------------------------------------------------------------------------- */
/* Fallback, announcement and amendment                                       */
/* -------------------------------------------------------------------------- */

describe('ScopeSettingsCard — the remaining fields', () => {
  it('writes the fallback set', async () => {
    const { onSave } = renderCard();

    fireEvent.click(screen.getByTestId('multi-Always-run topics only'));

    expect((await savedDraft(onSave)).fallbackTopicKeys).toEqual(['pricing']);
  });

  it('toggles the announcement', async () => {
    const { onSave } = renderCard({ announce: true });

    fireEvent.click(toggleById('scope-announce'));

    expect((await savedDraft(onSave)).announce).toBe(false);
  });

  it('toggles respondent amendment', async () => {
    const { onSave } = renderCard({ allowRespondentAmendment: true });

    fireEvent.click(toggleById('scope-amendment'));

    expect((await savedDraft(onSave)).allowRespondentAmendment).toBe(false);
  });

  it('takes the rules editor’s list as-is', async () => {
    const { onSave } = renderCard();

    fireEvent.click(screen.getByTestId('rules-editor'));

    expect((await savedDraft(onSave)).rules).toEqual([RULE]);
  });

  it('stores planner guidance', async () => {
    const { onSave } = renderCard();

    fireEvent.change(screen.getByPlaceholderText('Optional'), {
      target: { value: 'prefer breadth over depth' },
    });

    expect((await savedDraft(onSave)).plannerInstructions).toBe('prefer breadth over depth');
  });

  it('truncates guidance at the stored maximum rather than letting the save fail', async () => {
    const { onSave } = renderCard();

    fireEvent.change(screen.getByPlaceholderText('Optional'), {
      target: { value: 'x'.repeat(PLANNER_INSTRUCTIONS_MAX_LENGTH + 500) },
    });

    expect((await savedDraft(onSave)).plannerInstructions).toHaveLength(
      PLANNER_INSTRUCTIONS_MAX_LENGTH
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Dirty state and saving                                                     */
/* -------------------------------------------------------------------------- */

describe('ScopeSettingsCard — dirty state', () => {
  it('cannot be saved before anything is edited — an idle save would fork for nothing', () => {
    renderCard();

    expect(saveButton()).toBeDisabled();
  });

  it('enables the save as soon as any field changes', () => {
    renderCard();

    fireEvent.change(topicLimit(), { target: { value: '4' } });

    expect(saveButton()).not.toBeDisabled();
  });

  it('goes clean again once the save lands, so the next click cannot re-save the same draft', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { onSave } = renderCard();
      fireEvent.change(topicLimit(), { target: { value: '4' } });

      await savedDraft(onSave);
      // Past the two-second "Saved" flash, so the button is back to its idle label and the only
      // thing that can still be disabling it is the card's own dirty flag.
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });

      expect(saveButton()).toHaveTextContent('Save adaptive scope');
      expect(saveButton()).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays dirty when the save is rejected, so the edit is not silently lost', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(
      <ScopeSettingsCard
        settings={{ ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true }}
        topics={CONDITIONALS}
        dataSlots={[]}
        costs={COSTS}
        onSave={onSave}
        busy={false}
      />
    );
    fireEvent.change(topicLimit(), { target: { value: '4' } });

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    await waitFor(() => expect(saveButton()).not.toBeDisabled());
  });

  it('locks every control while a save is in flight', () => {
    renderCard({}, { busy: true });

    expect(topicLimit()).toBeDisabled();
    expect(confidence()).toBeDisabled();
    expect(screen.getByPlaceholderText('Optional')).toBeDisabled();
  });
});
