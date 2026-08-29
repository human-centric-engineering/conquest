// @vitest-environment happy-dom

/**
 * PersonaLibraryPanel (F-persona) — unit tests for the built-in-persona half of the "Interviewer
 * voice" either/or shown in `config-editor.tsx` when built-in-persona mode is on.
 *
 * Tests pin what the component DOES:
 *  - a tick-box per persona says which interviewers the questionnaire offers, with select-all /
 *    deselect-all, the last one un-tickable, and the pinned default re-pinned when it's un-ticked
 *  - the default dropdown lists only the OFFERED personas, marks the pinned one, and fires
 *    `onSelectionChange({ defaultPersonaKey })` on change
 *  - the "Let respondents switch" toggle fires `onSelectionChange({ allowRespondentSwitch })` and
 *    reveals/hides the switcher-style select (which fires `onSelectionChange({ switcher })`)
 *  - the read-only preview renders the pinned persona's name, description, prompt, and active tone
 *    dials on the signed −2…+2 scale — and shows the neutral fallback when no dials are active
 *
 * The shadcn Select/Switch/FieldHelp are replaced with plain inputs so the popover-free controls
 * work in jsdom.
 *
 * @see components/admin/questionnaires/persona-library-panel.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { PersonaLibraryPanel } from '@/components/admin/questionnaires/persona-library-panel';
import {
  DEFAULT_TONE_SETTINGS,
  type PersonaOption,
  type PersonaSelectionSettings,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';

// ─── Select → native <select> ────────────────────────────────────────────────
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select value={value} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

// ─── Switch → checkbox ───────────────────────────────────────────────────────
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

// ─── FieldHelp → passthrough ─────────────────────────────────────────────────
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

/** A tone with two active dials: empathy at stored 5 (display +2) and formality at stored 1 (−2). */
function richTone(): ToneSettings {
  return {
    ...DEFAULT_TONE_SETTINGS,
    empathy: { enabled: true, level: 5 },
    formality: { enabled: true, level: 1 },
    persona: { enabled: true, text: 'Lead with warmth and make people feel heard.' },
  };
}

const CONFIDANT: PersonaOption = {
  key: 'confidant',
  label: 'The Confidant',
  description: 'Warm and easy — like talking things through with a friend.',
  tone: richTone(),
};

const PLAIN: PersonaOption = {
  key: 'plain',
  label: 'The Plain One',
  description: '',
  tone: { ...DEFAULT_TONE_SETTINGS },
};

/** A persona whose label is blank — the panel must fall back to showing its key. */
const NAMELESS: PersonaOption = {
  key: 'nameless-voice',
  label: '   ',
  description: '',
  tone: { ...DEFAULT_TONE_SETTINGS },
};

const PERSONAS: PersonaOption[] = [CONFIDANT, PLAIN];

function makeSelection(over: Partial<PersonaSelectionSettings> = {}): PersonaSelectionSettings {
  return {
    enabled: true,
    defaultPersonaKey: 'confidant',
    // Empty ⇒ every persona in the passed library is offered (the "all of them" shape).
    availableKeys: [],
    allowRespondentSwitch: false,
    switcher: 'page',
    ...over,
  };
}

/**
 * The name shown in the read-only preview. Scoped to the preview's "Name" block because a persona's
 * label now also appears on its availability tick-box, so a bare text query would match twice.
 */
function previewName(): HTMLElement {
  return screen.getByText('Name').parentElement as HTMLElement;
}

/** The availability tick-box for a persona, addressed by its accessible (label) name. */
function tickBox(name: string | RegExp): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('checkbox', { name });
}

function renderPanel(over: Partial<PersonaSelectionSettings> = {}, onSelectionChange = vi.fn()) {
  const utils = render(
    <PersonaLibraryPanel
      personas={PERSONAS}
      selection={makeSelection(over)}
      busy={false}
      onSelectionChange={onSelectionChange}
    />
  );
  return { onSelectionChange, ...utils };
}

describe('PersonaLibraryPanel', () => {
  it('lists the library in the persona dropdown and marks the pinned one Selected', () => {
    renderPanel();
    // Pinned persona surfaces in the dropdown with the "· Selected" suffix option.
    expect(screen.getByRole('option', { name: /The Confidant · Selected/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'The Plain One' })).toBeInTheDocument();
  });

  it('fires onSelectionChange with the new defaultPersonaKey when a different persona is picked', () => {
    const { onSelectionChange } = renderPanel();
    const personaSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(personaSelect, { target: { value: 'plain' } });
    expect(onSelectionChange).toHaveBeenCalledWith({ defaultPersonaKey: 'plain' });
  });

  it('toggles allowRespondentSwitch through onSelectionChange', () => {
    const { onSelectionChange } = renderPanel({ allowRespondentSwitch: false });
    fireEvent.click(screen.getByRole('switch'));
    expect(onSelectionChange).toHaveBeenCalledWith({ allowRespondentSwitch: true });
  });

  it('hides the switcher-style select while respondent switching is off', () => {
    renderPanel({ allowRespondentSwitch: false });
    // Only the persona dropdown is present (one combobox).
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.queryByText(/How respondents switch interviewer/)).not.toBeInTheDocument();
  });

  it('reveals the switcher-style select when respondent switching is on and fires switcher changes', () => {
    const { onSelectionChange } = renderPanel({ allowRespondentSwitch: true, switcher: 'page' });
    expect(screen.getByText(/How respondents switch interviewer/)).toBeInTheDocument();
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(2);
    fireEvent.change(comboboxes[1], { target: { value: 'indicator' } });
    expect(onSelectionChange).toHaveBeenCalledWith({ switcher: 'indicator' });
  });

  it('previews the pinned persona: name, description, prompt, and active tone dials (signed scale)', () => {
    renderPanel({ defaultPersonaKey: 'confidant' });
    expect(within(previewName()).getByText('The Confidant')).toBeInTheDocument();
    expect(
      screen.getByText('Warm and easy — like talking things through with a friend.')
    ).toBeInTheDocument();
    expect(screen.getByText('Lead with warmth and make people feel heard.')).toBeInTheDocument();
    // Active dials rendered with their signed display value: empathy +2, formality −2.
    const empathy = screen.getByText('Empathy').closest('span')!;
    expect(within(empathy).getByText('+2')).toBeInTheDocument();
    const formality = screen.getByText('Formality').closest('span')!;
    expect(within(formality).getByText('-2')).toBeInTheDocument();
  });

  it('shows the neutral fallback when the pinned persona has no active tone dials', () => {
    renderPanel({ defaultPersonaKey: 'plain' });
    expect(within(previewName()).getByText('The Plain One')).toBeInTheDocument();
    expect(screen.getByText(/Neutral — no tone dials applied\./)).toBeInTheDocument();
  });

  it('falls back to the first persona when the pinned key is not in the library', () => {
    // An unknown defaultPersonaKey (e.g. a stale/removed pin) resolves to the first library persona.
    renderPanel({ defaultPersonaKey: 'no-such-persona' });
    const personaSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(personaSelect.value).toBe('confidant');
    // Preview renders the fallback persona.
    expect(within(previewName()).getByText('The Confidant')).toBeInTheDocument();
  });

  // ── Which interviewers the questionnaire offers ──────────────────────────

  it('ticks every persona for the empty "offer everything" shape', () => {
    renderPanel();
    expect(tickBox(/The Confidant/).checked).toBe(true);
    expect(tickBox('The Plain One').checked).toBe(true);
    expect(screen.getByText('2 of 2 interviewers available.')).toBeInTheDocument();
  });

  it('ticks only the offered personas when a subset is stored', () => {
    renderPanel({ availableKeys: ['confidant'] });
    expect(tickBox(/The Confidant/).checked).toBe(true);
    expect(tickBox('The Plain One').checked).toBe(false);
  });

  it('un-ticking a persona saves the remaining offered keys', () => {
    const { onSelectionChange } = renderPanel();
    fireEvent.click(tickBox('The Plain One'));
    expect(onSelectionChange).toHaveBeenCalledWith({
      availableKeys: ['confidant'],
      defaultPersonaKey: 'confidant',
    });
  });

  it('re-pins the default when the pinned persona is un-ticked', () => {
    const { onSelectionChange } = renderPanel({ defaultPersonaKey: 'confidant' });
    fireEvent.click(tickBox(/The Confidant/));
    // Only "plain" survives, so it becomes the default without the admin pinning it.
    expect(onSelectionChange).toHaveBeenCalledWith({
      availableKeys: ['plain'],
      defaultPersonaKey: 'plain',
    });
  });

  it('will not let the last offered interviewer be un-ticked', () => {
    const { onSelectionChange } = renderPanel({
      availableKeys: ['confidant'],
      defaultPersonaKey: 'confidant',
    });
    const last = tickBox(/The Confidant/);
    expect(last.disabled).toBe(true);
    fireEvent.click(last);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('ticking the last un-ticked persona normalises back to the empty "all" shape', () => {
    const { onSelectionChange } = renderPanel({
      availableKeys: ['confidant'],
      defaultPersonaKey: 'confidant',
    });
    fireEvent.click(tickBox('The Plain One'));
    expect(onSelectionChange).toHaveBeenCalledWith({
      availableKeys: [],
      defaultPersonaKey: 'confidant',
    });
  });

  it('select all offers the whole library (the empty shape) and is disabled when it already does', () => {
    const { onSelectionChange } = renderPanel({
      availableKeys: ['confidant'],
      defaultPersonaKey: 'confidant',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onSelectionChange).toHaveBeenCalledWith({
      availableKeys: [],
      defaultPersonaKey: 'confidant',
    });

    onSelectionChange.mockClear();
    renderPanel({}, onSelectionChange);
    expect(screen.getAllByRole('button', { name: 'Select all' })[1]).toBeDisabled();
  });

  it('deselect all keeps the pinned default — something must always be offered', () => {
    const { onSelectionChange } = renderPanel({ defaultPersonaKey: 'plain' });
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(onSelectionChange).toHaveBeenCalledWith({
      availableKeys: ['plain'],
      defaultPersonaKey: 'plain',
    });
  });

  it('with one interviewer offered: it is the default, the dropdown and switching are inert', () => {
    renderPanel({
      availableKeys: ['plain'],
      defaultPersonaKey: 'plain',
      allowRespondentSwitch: true,
    });
    expect(
      screen.getByText(
        'One interviewer available — it is the default, and respondents see no picker.'
      )
    ).toBeInTheDocument();
    // The default dropdown lists only the offered persona, and can't be changed.
    const personaSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(personaSelect.value).toBe('plain');
    expect(personaSelect).toBeDisabled();
    expect(screen.queryByRole('option', { name: /The Confidant/ })).not.toBeInTheDocument();
    // Nothing to switch between, so the switch is disabled and the switcher-style select is hidden.
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.queryByText(/How respondents switch interviewer/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deselect all' })).toBeDisabled();
  });

  it('uses the persona key as the label when a persona has no name', () => {
    const onSelectionChange = vi.fn();
    render(
      <PersonaLibraryPanel
        personas={[NAMELESS, PLAIN]}
        selection={makeSelection({ defaultPersonaKey: 'nameless-voice' })}
        busy={false}
        onSelectionChange={onSelectionChange}
      />
    );
    // Blank label → the key is shown, both in the dropdown option and the preview name.
    expect(screen.getByRole('option', { name: /nameless-voice · Selected/ })).toBeInTheDocument();
    expect(within(previewName()).getByText('nameless-voice')).toBeInTheDocument();
  });
});
