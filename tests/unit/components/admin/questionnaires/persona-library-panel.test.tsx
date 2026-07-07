/**
 * PersonaLibraryPanel (F-persona) — unit tests for the built-in-persona half of the "Interviewer
 * voice" either/or shown in `config-editor.tsx` when built-in-persona mode is on.
 *
 * Tests pin what the component DOES:
 *  - the persona dropdown lists the library, marks the pinned one, and fires
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
    allowRespondentSwitch: false,
    switcher: 'page',
    ...over,
  };
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
    expect(screen.getByText('The Confidant')).toBeInTheDocument();
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
    expect(screen.getByText('The Plain One')).toBeInTheDocument();
    expect(screen.getByText(/Neutral — no tone dials applied\./)).toBeInTheDocument();
  });

  it('falls back to the first persona when the pinned key is not in the library', () => {
    // An unknown defaultPersonaKey (e.g. a stale/removed pin) resolves to the first library persona.
    renderPanel({ defaultPersonaKey: 'no-such-persona' });
    const personaSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(personaSelect.value).toBe('confidant');
    // Preview renders the fallback persona.
    expect(screen.getByText('The Confidant')).toBeInTheDocument();
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
    expect(screen.getByText('nameless-voice')).toBeInTheDocument();
  });
});
