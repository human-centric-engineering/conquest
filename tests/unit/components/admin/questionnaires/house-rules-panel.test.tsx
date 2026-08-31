// @vitest-environment happy-dom

/**
 * HouseRulesPanel component tests.
 *
 * Anti-green-bar: drives the panel the way an admin does (toggle on → add → type → change kind →
 * reorder → remove → preview) and asserts the DOM and the `onChange` payload, never mock internals.
 *
 * The panel is a controlled component, so each test re-renders with whatever `onChange` last
 * emitted — otherwise the assertions would only ever pin the first edit.
 *
 * @see components/admin/questionnaires/house-rules-panel.tsx
 */

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HouseRulesPanel } from '@/components/admin/questionnaires/house-rules-panel';
import { HOUSE_RULE_PRESETS } from '@/lib/app/questionnaire/house-rules/presets';
import {
  DEFAULT_HOUSE_RULES_SETTINGS,
  MAX_HOUSE_RULES,
  type HouseRule,
  type HouseRulesSettings,
} from '@/lib/app/questionnaire/types';

const rule = (over: Partial<HouseRule> & Pick<HouseRule, 'id' | 'kind' | 'text'>): HouseRule => ({
  enabled: true,
  ...over,
});

/**
 * Render the controlled panel with self-updating state, so a test can perform several interactions
 * in sequence and assert the final settings — the way the real editor behaves.
 */
function renderPanel(initial: HouseRulesSettings = DEFAULT_HOUSE_RULES_SETTINGS) {
  const onChange = vi.fn();
  let current = initial;

  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <HouseRulesPanel
        value={value}
        onChange={(next) => {
          onChange(next);
          current = next;
          setValue(next);
        }}
      />
    );
  }

  render(<Harness />);
  return { onChange, latest: () => current };
}

const ON = (rules: HouseRule[] = []): HouseRulesSettings => ({ enabled: true, rules });

describe('HouseRulesPanel — the off state', () => {
  it('hides the whole editor until the admin turns house rules on', () => {
    render(<HouseRulesPanel value={DEFAULT_HOUSE_RULES_SETTINGS} onChange={vi.fn()} />);
    // Off is the safe default and must look like nothing is configured.
    expect(screen.queryByRole('button', { name: /add a rule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rule ideas/i })).not.toBeInTheDocument();
  });

  it('emits enabled:true when the master switch is turned on, keeping rules untouched', async () => {
    const user = userEvent.setup();
    const existing = [rule({ id: 'a', kind: 'never', text: 'Give advice.' })];
    const { onChange } = renderPanel({ enabled: false, rules: existing });

    await user.click(screen.getByRole('switch', { name: /add house rules/i }));

    expect(onChange).toHaveBeenCalledWith({ enabled: true, rules: existing });
  });
});

describe('HouseRulesPanel — editing rules', () => {
  it('adds a blank Always rule and writes what the admin types into it', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel(ON());

    await user.click(screen.getByRole('button', { name: /add a rule/i }));
    expect(latest().rules).toHaveLength(1);
    expect(latest().rules[0]?.kind).toBe('always');

    await user.type(screen.getByRole('textbox'), 'Ask for an example.');
    expect(latest().rules[0]?.text).toBe('Ask for an example.');
  });

  it('shows the trigger field only for an "if asked" rule, and drops the trigger on kind change', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel(
      ON([rule({ id: 'a', kind: 'if_asked', text: 'Only the team.', trigger: 'who sees this' })])
    );

    const trigger = screen.getByPlaceholderText(/who will see their answers/i);
    expect(trigger).toHaveValue('who sees this');

    // Switching kind must strip the trigger: the server rejects one on a non-if_asked rule.
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Never' }));

    expect(latest().rules[0]?.kind).toBe('never');
    expect(latest().rules[0]).not.toHaveProperty('trigger');
    expect(screen.queryByPlaceholderText(/who will see their answers/i)).not.toBeInTheDocument();
  });

  it('gives a rule switched to "if asked" an empty trigger to fill in', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel(ON([rule({ id: 'a', kind: 'always', text: 'Ask on.' })]));

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: /if asked/i }));

    expect(latest().rules[0]?.trigger).toBe('');
    expect(screen.getByPlaceholderText(/who will see their answers/i)).toBeInTheDocument();
  });

  it('reorders rules with the move controls and disables them at the ends', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel(
      ON([
        rule({ id: 'a', kind: 'always', text: 'First.' }),
        rule({ id: 'b', kind: 'always', text: 'Second.' }),
      ])
    );

    // The first rule cannot move up, the last cannot move down.
    expect(screen.getAllByRole('button', { name: 'Move up' })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Move down' })[1]).toBeDisabled();

    await user.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
    expect(latest().rules.map((r) => r.text)).toEqual(['Second.', 'First.']);
  });

  it('parks a rule with its own switch without discarding the wording', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel(ON([rule({ id: 'a', kind: 'never', text: 'Give advice.' })]));

    await user.click(screen.getByRole('switch', { name: /use this rule/i }));

    // Drafting and shipping are different decisions — the text must survive being switched off.
    expect(latest().rules[0]).toMatchObject({ enabled: false, text: 'Give advice.' });
  });

  it('removes a rule', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel(
      ON([
        rule({ id: 'a', kind: 'always', text: 'Keep.' }),
        rule({ id: 'b', kind: 'never', text: 'Drop.' }),
      ])
    );

    await user.click(screen.getAllByRole('button', { name: 'Remove rule' })[1]);
    expect(latest().rules.map((r) => r.text)).toEqual(['Keep.']);
  });

  it('stops adding rules at the cap', () => {
    const rules = Array.from({ length: MAX_HOUSE_RULES }, (_, i) =>
      rule({ id: `r${i}`, kind: 'always', text: `Rule ${i}.` })
    );
    render(<HouseRulesPanel value={ON(rules)} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /add a rule/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /rule ideas/i })).toBeDisabled();
  });

  it('skips past an id already in use rather than minting a duplicate', async () => {
    const user = userEvent.setup();
    // One stored rule carrying `hr-2` — the id a naive `hr-${length + 1}` counter would produce for
    // the next add. Perfectly ordinary: add two rules, delete the first. A duplicate id fails the
    // save with a path-based Zod error the admin cannot act on, so the skip loop is load-bearing.
    const { latest } = renderPanel(ON([rule({ id: 'hr-2', kind: 'always', text: 'Stored.' })]));

    await user.click(screen.getByRole('button', { name: /add a rule/i }));

    expect(latest().rules[1]?.id).toBe('hr-3');

    await user.click(screen.getByRole('button', { name: /add a rule/i }));
    const ids = latest().rules.map((r) => r.id);
    expect(ids).toEqual(['hr-2', 'hr-3', 'hr-4']);
  });
});

describe('HouseRulesPanel — authoring guidance', () => {
  it('points a first-time admin at the rule library when the list is empty', () => {
    render(<HouseRulesPanel value={ON()} onChange={vi.fn()} />);
    // The blank list is the real barrier this feature has to get past.
    expect(screen.getByText(/no rules yet/i)).toBeInTheDocument();
  });

  it('adds a library preset as an editable copy, then marks that preset as added', async () => {
    const user = userEvent.setup();
    const preset = HOUSE_RULE_PRESETS.find((p) => p.key === 'no-advice');
    if (!preset) throw new Error('expected the no-advice preset to exist');
    const { latest } = renderPanel(ON());

    await user.click(screen.getByRole('button', { name: /rule ideas/i }));

    // Scoped to the row carrying this preset's text, not "the first Add button" — reordering the
    // preset list is pure content editing and must not break this test.
    const row = () => {
      const node = within(screen.getByRole('dialog'))
        .getByText(preset.text)
        .closest('div')?.parentElement;
      if (!node) throw new Error('expected the preset row');
      return node;
    };
    await user.click(within(row()).getByRole('button', { name: /^add$/i }));

    expect(latest().rules[0]).toMatchObject({ kind: preset.kind, text: preset.text });
    // The preset that was added is the one marked added — a mis-keyed `addedKeys` map would
    // otherwise mark some unrelated row and go unnoticed.
    expect(within(row()).getByRole('button', { name: /added/i })).toBeDisabled();
  });

  it('offers the AI suggester only when the panel knows which version it is editing', () => {
    // Optional ids: the panel must still be fully usable standalone, just without the AI call.
    const { unmount } = render(<HouseRulesPanel value={ON()} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /suggest rules/i })).not.toBeInTheDocument();
    unmount();

    render(
      <HouseRulesPanel value={ON()} onChange={vi.fn()} questionnaireId="qn-1" versionId="v1" />
    );
    expect(screen.getByRole('button', { name: /suggest rules/i })).toBeInTheDocument();
  });

  it('names the unfinished rule by position and by the field it is actually missing', () => {
    const { rerender } = render(
      <HouseRulesPanel
        value={ON([
          rule({ id: 'a', kind: 'if_asked', text: 'Only the team.', trigger: 'who sees this' }),
          rule({ id: 'b', kind: 'always', text: '' }),
        ])}
        onChange={vi.fn()}
      />
    );

    // The blank rule is the `always` one in position 2. Naming the "if asked" fields here — as the
    // banner used to, whatever the kind — sends the admin to re-check a rule that is already fine.
    expect(screen.getByText(/Rule 2 is unfinished/)).toBeInTheDocument();
    expect(
      screen.getByText(/still needs what the interviewer should always do/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/what they ask about/)).not.toBeInTheDocument();

    // An "if asked" rule missing only its trigger asks for that one field, not for both.
    rerender(
      <HouseRulesPanel
        value={ON([rule({ id: 'a', kind: 'if_asked', text: 'Only the team.', trigger: '  ' })])}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText(/Rule 1 is unfinished/)).toBeInTheDocument();
    expect(screen.getByText(/still needs what they ask about\./)).toBeInTheDocument();

    // Complete on both fields ⇒ silence. This is the state the admin in the bug report was in.
    rerender(
      <HouseRulesPanel
        value={ON([
          rule({ id: 'a', kind: 'if_asked', text: 'Only the team.', trigger: 'who sees this' }),
        ])}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/unfinished/i)).not.toBeInTheDocument();
  });

  it('marks each unfinished rule on its own card, and lists every position when several are', () => {
    render(
      <HouseRulesPanel
        value={ON([
          rule({ id: 'a', kind: 'always', text: '' }),
          rule({ id: 'b', kind: 'never', text: 'Give advice.' }),
          rule({ id: 'c', kind: 'if_asked', text: '', trigger: '' }),
        ])}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Rules 1 and 3 are/)).toBeInTheDocument();
    // Per-card notes, so the admin can find the offender in a list of twenty without counting.
    const notes = screen.getAllByText(/^Unfinished/);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toHaveTextContent('add what they ask about and what to say');
  });

  it('warns when an enabled rule still carries a fill-in-the-blank placeholder', () => {
    const { rerender } = render(
      <HouseRulesPanel
        value={ON([rule({ id: 'a', kind: 'always', text: 'Call them "__".' })])}
        onChange={vi.fn()}
      />
    );
    // A placeholder left in gets read out literally to a respondent — worth flagging before launch.
    expect(screen.getByText(/still has/i)).toBeInTheDocument();

    rerender(
      <HouseRulesPanel
        value={ON([rule({ id: 'a', kind: 'always', text: 'Call them "colleagues".' })])}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/still has/i)).not.toBeInTheDocument();
  });

  it('previews the exact block the interviewer will be sent', async () => {
    const user = userEvent.setup();
    render(
      <HouseRulesPanel
        value={ON([rule({ id: 'a', kind: 'never', text: 'Give advice.' })])}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /show what the interviewer sees/i }));

    // Rendered by the same pure function the server uses, so this is the real text, not a mock-up.
    expect(screen.getByText(/Rules for this questionnaire/)).toBeInTheDocument();
    expect(screen.getByText(/- Give advice\./)).toBeInTheDocument();
  });

  it('tells the admin the preview is empty when every rule is switched off', async () => {
    const user = userEvent.setup();
    render(
      <HouseRulesPanel
        value={ON([rule({ id: 'a', enabled: false, kind: 'never', text: 'Give advice.' })])}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /show what the interviewer sees/i }));
    expect(screen.getByText(/no rules are switched on/i)).toBeInTheDocument();
  });
});
