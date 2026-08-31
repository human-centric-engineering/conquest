// @vitest-environment happy-dom

/**
 * ScopeRulesEditor — the data-slot dependency, stated on screen.
 *
 * Every hard rule tests ONE data slot, so a version with none cannot carry a rule at all. That is
 * not a rare edge case: no ingest path generates data slots, so a freshly uploaded questionnaire is
 * always in this state, and the Routing Analyst hits the same wall from the other side (its prompt
 * is told "DATA SLOTS: none. Propose no hard rules"). An admin could therefore run the analyst, get
 * no rules back, and find nothing on screen explaining why.
 *
 * What is pinned here is that the surface SAYS so rather than failing quietly — and that "Add rule"
 * cannot mint a rule with an empty `dataSlotKey` for the admin to discover and delete later.
 *
 * @see components/admin/questionnaires/topics/scope-rules-editor.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { ScopeRulesEditor } from '@/components/admin/questionnaires/topics/scope-rules-editor';
import type { Topic } from '@/lib/app/questionnaire/scope/types';

afterEach(cleanup);

const TOPIC: Topic = {
  id: 'id-partner',
  key: 'partner_channel',
  label: 'Partner channel',
  description: null,
  phase: 'conditional',
  criteria: 'They sell through partners',
  depth: 'full',
  members: { dataSlotKeys: [], questionKeys: [] },
  ordinal: 0,
  source: 'analyst',
  trigger: null,
};

const SLOT = { key: 'channel_type', name: 'Channel type' };

function renderEditor(over: { dataSlots?: { key: string; name: string }[] } = {}) {
  const onChange = vi.fn();
  render(
    <ScopeRulesEditor
      rules={[]}
      onChange={onChange}
      topics={[TOPIC]}
      dataSlots={(over.dataSlots ?? [SLOT]) as never}
    />
  );
  return { onChange };
}

describe('with no data slots on the version', () => {
  it('says a rule cannot be added yet, and why', () => {
    renderEditor({ dataSlots: [] });
    // The reason, not just the absence — "No hard rules" alone reads as a choice the admin made.
    expect(
      screen.getByText(/You need at least one data slot before you can add one/i)
    ).toBeTruthy();
    // And the shape of the thing, so the admin knows what they would be adding. Matched on a
    // phrase unique to the empty state — the ⓘ help carries the same worked example, and this
    // suite mocks FieldHelp so its children render inline.
    expect(screen.getByText(/Add one to overrule it for a specific answer/i)).toBeTruthy();
  });

  it('disables "Add rule" rather than minting a rule with no data slot', () => {
    const { onChange } = renderEditor({ dataSlots: [] });
    const button = screen.getByRole('button', { name: /add rule/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('with data slots available', () => {
  it('keeps the plain empty state — nothing is blocking the admin', () => {
    renderEditor();
    expect(
      screen.getByText(/No hard rules — the agent decides every conditional topic/i)
    ).toBeTruthy();
    expect(
      screen.queryByText(/You need at least one data slot before you can add one/i)
    ).toBeNull();
  });

  it('adds a rule seeded with the first data slot', () => {
    const { onChange } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [{ dataSlotKey: string; topicKey: string }[]];
    expect(next[0].dataSlotKey).toBe('channel_type');
    expect(next[0].topicKey).toBe('partner_channel');
  });
});
