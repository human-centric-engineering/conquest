// @vitest-environment happy-dom

/**
 * HouseRulesLibrary component tests.
 *
 * The library is the non-AI half of the house-rules decision support, and its job is explanation
 * rather than convenience: an admin who has never written a prompt should be able to read this and
 * decide. So these tests pin the reasoning being visible and the categories being navigable, not
 * just that clicking Add emits something.
 *
 * @see components/admin/questionnaires/house-rules-library.tsx
 * @see lib/app/questionnaire/house-rules/presets.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HouseRulesLibrary } from '@/components/admin/questionnaires/house-rules-library';
import {
  HOUSE_RULE_CATEGORY_LABELS,
  HOUSE_RULE_PLACEHOLDER,
  HOUSE_RULE_PRESETS,
  presetsForCategory,
} from '@/lib/app/questionnaire/house-rules/presets';

function renderLibrary(over: Partial<Parameters<typeof HouseRulesLibrary>[0]> = {}) {
  const onAdd = vi.fn();
  render(
    <HouseRulesLibrary open onOpenChange={vi.fn()} addedKeys={new Set()} onAdd={onAdd} {...over} />
  );
  return { onAdd };
}

const dialog = () => screen.getByRole('dialog');

describe('HouseRulesLibrary', () => {
  it('opens on the first category and shows its presets', () => {
    renderLibrary();
    const first = presetsForCategory('scope')[0];
    expect(within(dialog()).getByText(first.text)).toBeInTheDocument();
  });

  it('gives every preset its reason, not just its wording', () => {
    // The `why` line is the actual decision support — a library without it is just a paste buffer.
    renderLibrary();
    for (const preset of presetsForCategory('scope')) {
      expect(within(dialog()).getByText(preset.why)).toBeInTheDocument();
    }
  });

  it('switches categories', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByRole('tab', { name: HOUSE_RULE_CATEGORY_LABELS.compliance }));

    const compliance = presetsForCategory('compliance')[0];
    expect(await within(dialog()).findByText(compliance.text)).toBeInTheDocument();
  });

  it('offers a tab for every category', () => {
    renderLibrary();
    for (const label of Object.values(HOUSE_RULE_CATEGORY_LABELS)) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('emits the whole preset when one is added', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderLibrary();

    await user.click(within(dialog()).getAllByRole('button', { name: /^add$/i })[0]);

    expect(onAdd).toHaveBeenCalledWith(presetsForCategory('scope')[0]);
  });

  it('shows an already-added preset as added rather than hiding it', async () => {
    // Scanning a category should show what you have covered as readily as what you are missing.
    const added = presetsForCategory('scope')[0];
    renderLibrary({ addedKeys: new Set([added.key]) });

    expect(within(dialog()).getByText(added.text)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /added/i })).toBeDisabled();
  });

  it('flags a preset that still needs a value filled in', async () => {
    const user = userEvent.setup();
    renderLibrary();

    // The "questions about the questionnaire" presets deliberately ship with a blank rather than a
    // guessed answer — a confident wrong "it takes 10 minutes" is worse than none.
    await user.click(screen.getByRole('tab', { name: HOUSE_RULE_CATEGORY_LABELS.process }));

    expect((await within(dialog()).findAllByText(/needs filling in/i)).length).toBeGreaterThan(0);
  });

  it('shows the trigger for an "if asked" preset so it reads as a question, not an instruction', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByRole('tab', { name: HOUSE_RULE_CATEGORY_LABELS.process }));

    const ifAsked = presetsForCategory('process').find((p) => p.trigger);
    if (!ifAsked?.trigger) throw new Error('expected a process preset with a trigger');
    expect(
      await within(dialog()).findByText(`when they ask about ${ifAsked.trigger}`)
    ).toBeInTheDocument();
  });

  it('disables adding entirely when the rule list is full', () => {
    renderLibrary({ disabled: true });
    for (const button of within(dialog()).getAllByRole('button', { name: /^add$/i })) {
      expect(button).toBeDisabled();
    }
  });
});

describe('HOUSE_RULE_PRESETS', () => {
  it('gives every preset a unique key, a reason, and a trigger only when if_asked', () => {
    // The library is fixed data with no schema behind it, so these invariants are only enforced
    // here — and a preset that breaks the trigger rule would insert a rule the server rejects.
    const keys = HOUSE_RULE_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);

    for (const preset of HOUSE_RULE_PRESETS) {
      expect(preset.why.trim()).not.toBe('');
      expect(preset.text.trim()).not.toBe('');
      if (preset.kind === 'if_asked') expect(preset.trigger?.trim()).toBeTruthy();
      else expect(preset.trigger).toBeUndefined();
    }
  });

  it('only uses the placeholder where a value genuinely has to be supplied', () => {
    // Every placeholder is a promise the panel makes to warn about it — a stray one in a preset
    // that needs no filling in would train the admin to ignore that warning.
    const withPlaceholder = HOUSE_RULE_PRESETS.filter((p) =>
      p.text.includes(HOUSE_RULE_PLACEHOLDER)
    );
    expect(withPlaceholder.length).toBeGreaterThan(0);
    for (const preset of withPlaceholder) {
      expect(['process', 'terminology']).toContain(preset.category);
    }
  });
});
