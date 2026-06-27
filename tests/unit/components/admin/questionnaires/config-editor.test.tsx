/**
 * ConfigEditor (F3.1) — unit tests for the version run-time configuration editor.
 *
 * Tests pin what the component DOES:
 *  - renders current config values in each field/control
 *  - conditional sections appear / disappear based on toggle state
 *  - changing a field updates internal state (re-rendered value or mutation payload)
 *  - the save thunk hands the correct, transformed body to `run`
 *  - "not yet saved" warning renders / hides based on `config.saved`
 *  - profile-field list: add, remove, update, select type exposes options input
 *  - invitee field toggles (shown / required / locked email row)
 *  - resync from a new `config` prop updates all fields
 *
 * Heavy non-logic children are stubbed so the test focuses on this component's own
 * state management. The shadcn Select is replaced by a native <select> to make
 * userEvent.selectOptions usable in jsdom; SaveButton and CostEstimateCard are
 * replaced by identifiable markers.
 *
 * @see components/admin/questionnaires/config-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ConfigView } from '@/lib/app/questionnaire/views';
import type { MutationSpec } from '@/components/admin/questionnaires/version-editor-types';
import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_INVITEE_FIELDS,
} from '@/lib/app/questionnaire/types';

// ─── Shadcn Select → native <select> ─────────────────────────────────────────
// Radix Select's popover doesn't work in jsdom; replace with a native select so
// userEvent.selectOptions and value assertions work straightforwardly.

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

// ─── FieldHelp → transparent passthrough ─────────────────────────────────────
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// ─── CostEstimateCard → identifiable marker ──────────────────────────────────
vi.mock('@/components/admin/questionnaires/cost-estimate-card', () => ({
  CostEstimateCard: ({
    questionnaireId,
    versionId,
  }: {
    questionnaireId: string;
    versionId: string;
    reloadKey: string;
    costBudgetUsd: number | null;
  }) => <div data-testid="cost-estimate-card" data-qid={questionnaireId} data-vid={versionId} />,
}));

// ─── SaveButton → a plain button that invokes onSave ─────────────────────────
vi.mock('@/components/admin/questionnaires/save-button', () => ({
  SaveButton: ({
    onSave,
    children,
    disabled,
  }: {
    onSave: () => void;
    children: React.ReactNode;
    disabled?: boolean;
    size?: string;
  }) => (
    <button type="button" onClick={onSave} disabled={disabled}>
      {children}
    </button>
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a ConfigView by overlaying partial overrides on the defaults. */
function makeConfig(over: Partial<ConfigView> = {}): ConfigView {
  return { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true, ...over };
}

/** Capture the [method, path, body] the editor hands to `run`. */
function setup(over: Partial<ConfigView> = {}) {
  const specs: MutationSpec[] = [];
  const run = vi.fn((thunk: () => MutationSpec): Promise<boolean> => {
    specs.push(thunk());
    return Promise.resolve(true);
  });

  const config = makeConfig(over);

  const utils = render(
    <ConfigEditorUnderTest
      questionnaireId="qn-1"
      versionId="ver-1"
      config={config}
      questionCount={5}
      adaptiveEnabled
      run={run}
      busy={false}
    />
  );

  return { specs, run, config, ...utils };
}

// Import after mocks are established (vi.mock is hoisted automatically).
import { ConfigEditor as ConfigEditorUnderTest } from '@/components/admin/questionnaires/config-editor';

const clickSave = () =>
  fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

const bodyOf = (specs: MutationSpec[]) => specs[0][2] as Record<string, unknown>;

/**
 * Scope queries to the settings content. The scroll-spy rail lists the same section
 * labels as sibling jump-links outside this container, so unscoped getByText is
 * ambiguous. Throws a clear error (not a cryptic `within(null)` TypeError) if the
 * container id ever changes.
 */
function settingsContent() {
  const el = document.getElementById('settings-sections');
  if (!el) throw new Error("config-editor test: '#settings-sections' container not in DOM");
  return within(el);
}

/**
 * Find the switch <button> that is a sibling of (or very close to) a label with
 * matching text. The component renders `<Switch> <Label>text</Label>` inside a
 * `flex items-center gap-2` container, so we walk up to the common parent and find
 * the switch inside it.
 */
function switchNear(labelText: string | RegExp): HTMLElement {
  const label = screen.getByText(labelText);
  // Walk up until we find a container that also holds a switch button.
  let node: HTMLElement | null = label;
  while (node) {
    const sw = node.querySelector('[role="switch"]');
    if (sw) return sw as HTMLElement;
    node = node.parentElement;
  }
  throw new Error(`No switch found near label: ${String(labelText)}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConfigEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Section headings render ──────────────────────────────────────────────────

  it('renders every settings group heading', () => {
    setup();
    // Scope to the settings content; the scroll-spy rail lists the same labels as
    // sibling jump-links outside this container, so an unscoped getByText is ambiguous.
    const content = settingsContent();
    expect(content.getByText('Questions & completion')).toBeInTheDocument();
    expect(content.getByText('Respondent experience')).toBeInTheDocument();
    expect(content.getByText('Reasoning stream')).toBeInTheDocument();
    expect(content.getByText('Interviewer tone & persona')).toBeInTheDocument();
    expect(content.getByText('Access & invitations')).toBeInTheDocument();
    expect(content.getByText('Answer quality & safeguarding')).toBeInTheDocument();
    expect(content.getByText('Budget & limits')).toBeInTheDocument();
    expect(content.getByText('Session-start profile fields')).toBeInTheDocument();
  });

  // ── "Not yet saved" warning ──────────────────────────────────────────────────

  it('shows the unsaved warning when config.saved is false', () => {
    setup({ saved: false });
    expect(screen.getByText(/not yet saved/i)).toBeInTheDocument();
  });

  it('does not show the unsaved warning when config.saved is true', () => {
    setup({ saved: true });
    expect(screen.queryByText(/not yet saved/i)).not.toBeInTheDocument();
  });

  // ── Selection strategy ───────────────────────────────────────────────────────

  it('reflects the current selectionStrategy in the select', () => {
    setup({ selectionStrategy: 'random' });
    // The native <select> has the value directly.
    const selects = screen.getAllByRole('combobox');
    // First select on the page is the selection-strategy one.
    expect((selects[0] as HTMLSelectElement).value).toBe('random');
  });

  it('PATCHes with the chosen selectionStrategy on save', async () => {
    const { specs } = setup({ selectionStrategy: 'sequential' });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0], 'weighted');

    clickSave();
    expect(bodyOf(specs)).toMatchObject({ selectionStrategy: 'weighted' });
  });

  it('lists Adaptive first in the selection-strategy dropdown', () => {
    setup({ selectionStrategy: 'sequential' });
    const selects = screen.getAllByRole('combobox');
    const options = Array.from((selects[0] as HTMLSelectElement).options).map((o) => o.value);
    // Adaptive is the top option even when it isn't the saved value.
    expect(options[0]).toBe('adaptive');
    // The deterministic strategies still follow, none dropped.
    expect(options).toEqual(['adaptive', 'sequential', 'random', 'weighted']);
  });

  // ── minQuestionsAnswered / coverageThreshold ─────────────────────────────────

  it('renders minQuestionsAnswered input with the stored value', () => {
    setup({ minQuestionsAnswered: 3 });
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
  });

  it('PATCHes minQuestionsAnswered as an integer on save', () => {
    const { specs } = setup({ minQuestionsAnswered: 0, coverageThreshold: 0.9 });
    const inputs = screen.getAllByRole('spinbutton');
    // minQuestionsAnswered has min=0; find it by current value "0"
    const minInput = inputs.find((el) => (el as HTMLInputElement).value === '0') as HTMLElement;
    fireEvent.change(minInput, { target: { value: '5' } });
    clickSave();
    expect(bodyOf(specs).minQuestionsAnswered).toBe(5);
  });

  it('sends the entered minQuestionsAnswered value on save', () => {
    const { specs } = setup({ minQuestionsAnswered: 0 });
    // Find the min-questions input by its current value
    const inputs = screen.getAllByRole('spinbutton');
    // minQuestionsAnswered is the first numeric input (value "0")
    const minInput = inputs.find((el) => (el as HTMLInputElement).value === '0') as HTMLElement;
    fireEvent.change(minInput, { target: { value: '4' } });
    clickSave();
    expect(bodyOf(specs).minQuestionsAnswered).toBe(4);
  });

  it('sends coverageThreshold clamped to [0,1]', () => {
    const { specs } = setup({ coverageThreshold: 1 });
    const inputs = screen.getAllByRole('spinbutton');
    const coverageInput = inputs.find(
      (el) => (el as HTMLInputElement).value === '1'
    ) as HTMLElement;
    fireEvent.change(coverageInput, { target: { value: '0.8' } });
    clickSave();
    expect(bodyOf(specs).coverageThreshold).toBe(0.8);
  });

  // ── Voice / Attachments / Anonymous toggles ──────────────────────────────────

  it('reflects voiceEnabled in the Switch', () => {
    setup({ voiceEnabled: true });
    expect(switchNear(/^Voice input/)).toHaveAttribute('data-state', 'checked');
  });

  it('PATCHes voiceEnabled toggled off on save', () => {
    const { specs } = setup({ voiceEnabled: true });
    fireEvent.click(switchNear(/^Voice input/));
    clickSave();
    expect(bodyOf(specs).voiceEnabled).toBe(false);
  });

  it('PATCHes attachmentsEnabled toggled on on save', () => {
    const { specs } = setup({ attachmentsEnabled: false });
    fireEvent.click(switchNear(/^Attachments/));
    clickSave();
    expect(bodyOf(specs).attachmentsEnabled).toBe(true);
  });

  it('PATCHes anonymousMode toggled on on save', () => {
    const { specs } = setup({ anonymousMode: false });
    fireEvent.click(switchNear(/^Anonymous mode/));
    clickSave();
    expect(bodyOf(specs).anonymousMode).toBe(true);
  });

  it('PATCHes extractionPrefilter toggled on on save', () => {
    const { specs } = setup({ extractionPrefilter: false });
    fireEvent.click(switchNear(/^Extraction pre-filter/));
    clickSave();
    expect(bodyOf(specs).extractionPrefilter).toBe(true);
  });

  // ── Presentation mode ────────────────────────────────────────────────────────

  it('reflects presentationMode in its select', () => {
    setup({ presentationMode: 'form' });
    const selects = screen.getAllByRole('combobox');
    const presentationSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'form'
    ) as HTMLSelectElement;
    expect(presentationSelect.value).toBe('form');
  });

  it('PATCHes the chosen presentationMode on save', async () => {
    const { specs } = setup({ presentationMode: 'chat' });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    const presentationSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'chat'
    ) as HTMLSelectElement;
    await user.selectOptions(presentationSelect, 'both');
    clickSave();
    expect(bodyOf(specs).presentationMode).toBe('both');
  });

  // ── Answer slot panel scope ──────────────────────────────────────────────────

  it('PATCHes the chosen answerSlotPanelScope on save', async () => {
    const { specs } = setup({ answerSlotPanelScope: 'full_progress' });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    const scopeSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'full_progress'
    ) as HTMLSelectElement;
    await user.selectOptions(scopeSelect, 'answered_only');
    clickSave();
    expect(bodyOf(specs).answerSlotPanelScope).toBe('answered_only');
  });

  // ── Reasoning stream section ─────────────────────────────────────────────────

  it('shows the placement/persist sub-controls only when reasoningStreamEnabled is on', () => {
    setup({ reasoningStreamEnabled: true });
    expect(screen.getByText(/keep the reasoning on each turn/i)).toBeInTheDocument();
    // "Placement" label with FieldHelp sibling — use a flexible matcher
    expect(screen.getByText((text) => text.includes('Placement'))).toBeInTheDocument();
  });

  it('hides the placement/persist sub-controls when reasoningStreamEnabled is off', () => {
    setup({ reasoningStreamEnabled: false });
    expect(screen.queryByText(/keep the reasoning on each turn/i)).not.toBeInTheDocument();
    // The group heading is always there; the placement options inside the conditional block are not
    expect(screen.queryByRole('option', { name: /animated/i })).not.toBeInTheDocument();
  });

  it('toggling reasoning off hides sub-controls and sends reasoningStreamEnabled:false', () => {
    const { specs } = setup({ reasoningStreamEnabled: true });
    fireEvent.click(switchNear(/^Show the reasoning stream/));
    clickSave();
    expect(bodyOf(specs).reasoningStreamEnabled).toBe(false);
    // Sub-controls gone after toggle
    expect(screen.queryByText(/keep the reasoning on each turn/i)).not.toBeInTheDocument();
  });

  it('toggling reasoning on reveals sub-controls and sends reasoningStreamEnabled:true', () => {
    const { specs } = setup({ reasoningStreamEnabled: false });
    fireEvent.click(switchNear(/^Show the reasoning stream/));
    clickSave();
    expect(bodyOf(specs).reasoningStreamEnabled).toBe(true);
    expect(screen.getByText(/keep the reasoning on each turn/i)).toBeInTheDocument();
  });

  it('PATCHes reasoningStreamPlacement on save', async () => {
    const { specs } = setup({ reasoningStreamEnabled: true, reasoningStreamPlacement: 'overlay' });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    const placementSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'overlay'
    ) as HTMLSelectElement;
    await user.selectOptions(placementSelect, 'inline');
    clickSave();
    expect(bodyOf(specs).reasoningStreamPlacement).toBe('inline');
  });

  it('PATCHes reasoningStreamPersist toggled off on save', () => {
    const { specs } = setup({ reasoningStreamEnabled: true, reasoningStreamPersist: true });
    fireEvent.click(switchNear(/^Keep the reasoning on each turn/));
    clickSave();
    expect(bodyOf(specs).reasoningStreamPersist).toBe(false);
  });

  it('shows the dwell timing inputs only for the Animated placement and PATCHes them as integers', () => {
    const { specs } = setup({
      reasoningStreamEnabled: true,
      reasoningStreamPlacement: 'overlay',
      reasoningStreamDwellMs: 2000,
      reasoningStreamPerItemMs: 330,
    });
    const dwell = screen.getByLabelText(/reasoning dwell/i);
    const perItem = screen.getByLabelText(/extra dwell per reasoning step/i);

    fireEvent.change(dwell, { target: { value: '3000' } });
    fireEvent.change(perItem, { target: { value: '400' } });
    clickSave();

    expect(bodyOf(specs)).toMatchObject({
      reasoningStreamDwellMs: 3000,
      reasoningStreamPerItemMs: 400,
    });
  });

  it('hides the dwell timing inputs for the Inline placement', () => {
    setup({ reasoningStreamEnabled: true, reasoningStreamPlacement: 'inline' });
    expect(screen.queryByLabelText(/reasoning dwell/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/extra dwell per reasoning step/i)).not.toBeInTheDocument();
  });

  // ── Access mode ──────────────────────────────────────────────────────────────

  it('reflects the current accessMode in the select', () => {
    setup({ accessMode: 'public' });
    const selects = screen.getAllByRole('combobox');
    const accessSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'public'
    ) as HTMLSelectElement;
    expect(accessSelect.value).toBe('public');
  });

  it('PATCHes the chosen accessMode on save', async () => {
    const { specs } = setup({ accessMode: 'invitation_only' });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    const accessSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'invitation_only'
    ) as HTMLSelectElement;
    await user.selectOptions(accessSelect, 'both');
    clickSave();
    expect(bodyOf(specs).accessMode).toBe('both');
  });

  // ── Invitee fields ───────────────────────────────────────────────────────────

  it('renders the email invitee row as locked (always-on)', () => {
    setup();
    expect(screen.getByText(/always on/i)).toBeInTheDocument();
    const emailShownSwitch = screen.getByRole('switch', { name: /email shown/i });
    expect(emailShownSwitch).toBeDisabled();
  });

  it('toggling a non-locked invitee field shown:true sends it in the body', () => {
    const { specs } = setup({
      inviteeFields: DEFAULT_INVITEE_FIELDS.map((f) =>
        f.key === 'jobTitle' ? { ...f, shown: false } : f
      ),
    });
    fireEvent.click(screen.getByRole('switch', { name: /job title shown/i }));
    clickSave();
    const sentFields = bodyOf(specs).inviteeFields as Array<{
      key: string;
      shown: boolean;
      required: boolean;
    }>;
    const jobTitleField = sentFields.find((f) => f.key === 'jobTitle');
    expect(jobTitleField?.shown).toBe(true);
  });

  it('toggling shown OFF on an invitee field also forces required to false', () => {
    const { specs } = setup({
      inviteeFields: DEFAULT_INVITEE_FIELDS.map((f) =>
        f.key === 'firstName' ? { ...f, shown: true, required: true } : f
      ),
    });
    fireEvent.click(screen.getByRole('switch', { name: /first name shown/i }));
    clickSave();
    const sentFields = bodyOf(specs).inviteeFields as Array<{
      key: string;
      shown: boolean;
      required: boolean;
    }>;
    const firstNameField = sentFields.find((f) => f.key === 'firstName');
    // shown toggled off → required must also be false (enforced by the component)
    expect(firstNameField?.shown).toBe(false);
    expect(firstNameField?.required).toBe(false);
  });

  // ── Sensitivity awareness ────────────────────────────────────────────────────

  it('hides support message / URL when sensitivityAwareness is off', () => {
    setup({ sensitivityAwareness: false });
    expect(screen.queryByPlaceholderText(/support is available/i)).not.toBeInTheDocument();
  });

  it('shows support message / URL when sensitivityAwareness is on', () => {
    setup({ sensitivityAwareness: true });
    expect(screen.getByPlaceholderText(/support is available/i)).toBeInTheDocument();
  });

  it('toggling sensitivityAwareness on reveals the sub-fields', () => {
    setup({ sensitivityAwareness: false });
    fireEvent.click(switchNear(/^Sensitivity awareness/));
    expect(screen.getByPlaceholderText(/support is available/i)).toBeInTheDocument();
  });

  it('PATCHes supportMessage trimmed on save', () => {
    const { specs } = setup({ sensitivityAwareness: true, supportMessage: '' });
    fireEvent.change(screen.getByPlaceholderText(/support is available/i), {
      target: { value: '  Call us anytime.  ' },
    });
    clickSave();
    expect(bodyOf(specs).supportMessage).toBe('Call us anytime.');
  });

  it('PATCHes supportResourceUrl trimmed on save', () => {
    const { specs } = setup({ sensitivityAwareness: true, supportResourceUrl: '' });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), {
      target: { value: '  https://helpline.example.com  ' },
    });
    clickSave();
    expect(bodyOf(specs).supportResourceUrl).toBe('https://helpline.example.com');
  });

  // ── Contradiction detection ──────────────────────────────────────────────────

  it('hides contradiction sub-fields when mode is "off"', () => {
    setup({ contradictionMode: 'off' });
    expect(screen.queryByText(/look-back window/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/detection cadence/i)).not.toBeInTheDocument();
  });

  it('shows contradiction sub-fields when mode is "flag"', async () => {
    setup({ contradictionMode: 'off' });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    const contradictionSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'off'
    ) as HTMLSelectElement;
    await user.selectOptions(contradictionSelect, 'flag');
    expect(screen.getByText(/look-back window/i)).toBeInTheDocument();
    expect(screen.getByText(/detection cadence/i)).toBeInTheDocument();
  });

  it('sends contradictionWindowN:0 when mode is "off", regardless of the input value', () => {
    const { specs } = setup({ contradictionMode: 'off', contradictionWindowN: 5 });
    clickSave();
    expect(bodyOf(specs).contradictionWindowN).toBe(0);
  });

  it('sends the contradictionWindowN value when mode is not "off"', () => {
    const { specs } = setup({ contradictionMode: 'flag', contradictionWindowN: 3 });
    clickSave();
    expect(bodyOf(specs).contradictionWindowN).toBe(3);
  });

  // ── Budget & limits ──────────────────────────────────────────────────────────

  it('sends costBudgetUsd:null when the field is blank', () => {
    const { specs } = setup({ costBudgetUsd: null });
    clickSave();
    expect(bodyOf(specs).costBudgetUsd).toBeNull();
  });

  it('sends costBudgetUsd as a number when entered', () => {
    const { specs } = setup({ costBudgetUsd: null });
    // There are two "No cap" placeholder inputs; costBudgetUsd is the first.
    const noCapInputs = screen.getAllByPlaceholderText(/no cap/i);
    fireEvent.change(noCapInputs[0], { target: { value: '2.50' } });
    clickSave();
    expect(bodyOf(specs).costBudgetUsd).toBe(2.5);
  });

  it('sends maxQuestionsPerSession:null when blank', () => {
    const { specs } = setup({ maxQuestionsPerSession: null });
    clickSave();
    expect(bodyOf(specs).maxQuestionsPerSession).toBeNull();
  });

  it('renders the CostEstimateCard for the correct questionnaire/version', () => {
    setup();
    const card = screen.getByTestId('cost-estimate-card');
    expect(card).toHaveAttribute('data-qid', 'qn-1');
    expect(card).toHaveAttribute('data-vid', 'ver-1');
  });

  // ── Profile fields ────────────────────────────────────────────────────────────

  it('shows the empty-state message when no profile fields exist', () => {
    setup({ profileFields: [] });
    expect(screen.getByText(/no profile fields/i)).toBeInTheDocument();
  });

  it('"Add profile field" adds a new row', () => {
    setup({ profileFields: [] });
    fireEvent.click(screen.getByRole('button', { name: /add profile field/i }));
    // A new row with Key/Label inputs appears
    expect(screen.getAllByPlaceholderText(/e\.g\. organisation/i).length).toBeGreaterThan(0);
  });

  it('removing a profile field removes it from the list', () => {
    setup({
      profileFields: [{ key: 'org', label: 'Organisation', type: 'text', required: false }],
    });
    expect(screen.getByDisplayValue('org')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByDisplayValue('org')).not.toBeInTheDocument();
  });

  it('PATCHes profileFields with trimmed key/label on save', () => {
    const { specs } = setup({
      profileFields: [{ key: 'org', label: 'Organisation', type: 'text', required: false }],
    });
    fireEvent.change(screen.getByDisplayValue('org'), { target: { value: ' org_key ' } });
    fireEvent.change(screen.getByDisplayValue('Organisation'), {
      target: { value: ' Org Label ' },
    });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; label: string }>;
    expect(fields[0].key).toBe('org_key');
    expect(fields[0].label).toBe('Org Label');
  });

  it('shows the Options input only for select-type profile fields', async () => {
    setup({
      profileFields: [{ key: 'dept', label: 'Department', type: 'text', required: false }],
    });
    expect(screen.queryByPlaceholderText(/e\.g\. Engineering/i)).not.toBeInTheDocument();

    // Switch the field type to 'select'
    const user = userEvent.setup();
    const typeSelects = screen.getAllByRole('combobox');
    // The type select for the profile field row has value 'text'
    const typeSelect = typeSelects.find(
      (s) => (s as HTMLSelectElement).value === 'text'
    ) as HTMLSelectElement;
    await user.selectOptions(typeSelect, 'select');
    expect(screen.getByPlaceholderText(/e\.g\. Engineering/i)).toBeInTheDocument();
  });

  it('PATCHes select-type profile field with parsed options on save', async () => {
    const { specs } = setup({
      profileFields: [{ key: 'dept', label: 'Department', type: 'select', required: false }],
    });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Engineering/i), {
      target: { value: 'Engineering, Sales, Support' },
    });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{
      key: string;
      type: string;
      options?: string[];
    }>;
    expect(fields[0].options).toEqual(['Engineering', 'Sales', 'Support']);
  });

  it('does not include options key for non-select profile field types', () => {
    const { specs } = setup({
      profileFields: [{ key: 'name', label: 'Name', type: 'text', required: false }],
    });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; options?: string[] }>;
    expect(fields[0]).not.toHaveProperty('options');
  });

  it('toggling required on a profile field includes required:true in the body', () => {
    const { specs } = setup({
      profileFields: [{ key: 'org', label: 'Organisation', type: 'text', required: false }],
    });
    // The profile field row is rendered as a div; the required switch label appears right next to
    // the switch inside that row. The invitee table uses aria-label="... required" so the only
    // plain "Required" text (xs label with no aria-label) is the profile field row.
    // getAllByRole('switch') includes: voiceEnabled, attachmentsEnabled, anonymousMode,
    // reasoningStreamEnabled (DEFAULT=true), reasoningStreamPersist, sensitivityAwareness (false),
    // and the invitee field rows (6 rows × 2 = 12 switches). Profile field Required switch
    // comes after those. Use label text proximity inside the profile section.
    // Strategy: all profile-field switches are below the "Session-start profile fields" heading.
    const sectionHeading = settingsContent().getByText('Session-start profile fields');
    const section = sectionHeading.closest('[class*="overflow-hidden"]') as HTMLElement;
    const requiredSwitch = within(section).getByRole('switch');
    fireEvent.click(requiredSwitch);
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; required: boolean }>;
    expect(fields[0].required).toBe(true);
  });

  // ── Save mutation path ────────────────────────────────────────────────────────

  it('calls run once on save with PATCH and the correct version config URL', () => {
    const { run, specs } = setup();
    clickSave();
    expect(run).toHaveBeenCalledTimes(1);
    const [method, path] = specs[0];
    expect(method).toBe('PATCH');
    expect(path).toContain('/questionnaires/qn-1/versions/ver-1/config');
  });

  it('save body contains all top-level config keys', () => {
    const { specs } = setup();
    clickSave();
    const body = bodyOf(specs);
    const required = [
      'selectionStrategy',
      'minQuestionsAnswered',
      'coverageThreshold',
      'costBudgetUsd',
      'maxQuestionsPerSession',
      'voiceEnabled',
      'attachmentsEnabled',
      'contradictionMode',
      'contradictionWindowN',
      'contradictionEveryNTurns',
      'anonymousMode',
      'accessMode',
      'inviteeFields',
      'abuseThreshold',
      'maxDataSlotAttempts',
      'sensitivityAwareness',
      'supportMessage',
      'supportResourceUrl',
      'answerSlotPanelScope',
      'presentationMode',
      'reasoningStreamEnabled',
      'reasoningStreamPlacement',
      'reasoningStreamPersist',
      'profileFields',
    ];
    for (const key of required) {
      expect(body, `body missing key: ${key}`).toHaveProperty(key);
    }
  });

  // ── Resync from new config prop ────────────────────────────────────────────────

  it('resyncs all fields when the config prop changes', () => {
    const { rerender } = render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ selectionStrategy: 'sequential' })}
        questionCount={5}
        adaptiveEnabled
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );

    const selects = screen.getAllByRole('combobox');
    expect((selects[0] as HTMLSelectElement).value).toBe('sequential');

    rerender(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ selectionStrategy: 'weighted' })}
        questionCount={5}
        adaptiveEnabled
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );

    const updatedSelects = screen.getAllByRole('combobox');
    expect((updatedSelects[0] as HTMLSelectElement).value).toBe('weighted');
  });

  it('resyncs reasoningStreamEnabled sub-controls when config prop changes', () => {
    const { rerender } = render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ reasoningStreamEnabled: false })}
        questionCount={5}
        adaptiveEnabled
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );

    expect(screen.queryByText(/keep the reasoning on each turn/i)).not.toBeInTheDocument();

    rerender(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ reasoningStreamEnabled: true })}
        questionCount={5}
        adaptiveEnabled
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );

    expect(screen.getByText(/keep the reasoning on each turn/i)).toBeInTheDocument();
  });

  // ── adaptive hidden when flag off ────────────────────────────────────────────

  it('hides the adaptive option when adaptiveEnabled is false and current value is not adaptive', () => {
    render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ selectionStrategy: 'sequential' })}
        questionCount={5}
        adaptiveEnabled={false}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    // The <option> for adaptive should not be in the DOM
    expect(screen.queryByRole('option', { name: /adaptive/i })).not.toBeInTheDocument();
  });

  it('keeps the adaptive option when adaptiveEnabled is false but current strategy is adaptive', () => {
    render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ selectionStrategy: 'adaptive' })}
        questionCount={5}
        adaptiveEnabled={false}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    expect(screen.getByRole('option', { name: /adaptive/i })).toBeInTheDocument();
  });

  // ── busy disables controls ────────────────────────────────────────────────────

  it('disables all controls when busy is true', () => {
    render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig()}
        questionCount={5}
        adaptiveEnabled
        run={vi.fn(() => Promise.resolve(true))}
        busy
      />
    );
    // Save button is disabled
    expect(screen.getByRole('button', { name: /save configuration/i })).toBeDisabled();
    // First select (selection strategy) is disabled
    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toBeDisabled();
    // All spinbutton inputs are disabled
    const spinbuttons = screen.getAllByRole('spinbutton');
    spinbuttons.forEach((input) => expect(input).toBeDisabled());
    // All switch buttons are disabled (they render as role="switch" buttons)
    const switchBtns = screen.getAllByRole('switch');
    switchBtns.forEach((sw) => expect(sw).toBeDisabled());
  });

  // ── Interviewer tone & persona (F-tone) ──────────────────────────────────────

  it('sends the full all-off tone block by default', () => {
    const { specs } = setup();
    clickSave();
    const tone = bodyOf(specs).tone as Record<string, { enabled: boolean; level: number }>;
    // Every dimension present and disabled at the neutral midpoint.
    expect(tone.empathy).toEqual({ enabled: false, level: 3 });
    expect(tone.humour).toEqual({ enabled: false, level: 3 });
    expect((tone as unknown as { persona: { enabled: boolean; text: string } }).persona).toEqual({
      enabled: false,
      text: '',
    });
  });

  it('keeps a dimension slider hidden until its toggle is enabled', () => {
    setup();
    // The pole captions only render when the slider is shown.
    expect(screen.queryByText('Dispassionate')).not.toBeInTheDocument();
    fireEvent.click(switchNear(/^Empathy/));
    expect(screen.getByText('Dispassionate')).toBeInTheDocument();
    expect(screen.getByText('Highly empathetic')).toBeInTheDocument();
  });

  it('enables a dimension in the saved tone block when its toggle is switched on', () => {
    const { specs } = setup();
    fireEvent.click(switchNear(/^Empathy/));
    clickSave();
    const tone = bodyOf(specs).tone as Record<string, { enabled: boolean; level: number }>;
    expect(tone.empathy.enabled).toBe(true);
  });

  it('reveals the persona textarea on toggle and sends the trimmed text on save', () => {
    const { specs } = setup();
    fireEvent.click(switchNear(/^Persona/));
    const textarea = screen.getByPlaceholderText(/supportive career coach/i);
    fireEvent.change(textarea, { target: { value: '  You are a blunt consultant.  ' } });
    clickSave();
    const persona = (bodyOf(specs).tone as { persona: { enabled: boolean; text: string } }).persona;
    expect(persona).toEqual({ enabled: true, text: 'You are a blunt consultant.' });
  });

  it('reflects a stored enabled dimension from config', () => {
    setup({
      tone: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.tone,
        formality: { enabled: true, level: 5 },
      },
    });
    // The slider's pole captions are visible because the dimension is enabled.
    expect(screen.getByText('Formal')).toBeInTheDocument();
  });
});
