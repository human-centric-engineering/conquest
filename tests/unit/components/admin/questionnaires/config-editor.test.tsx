// @vitest-environment happy-dom

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
import { render, screen, fireEvent, within, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ConfigView } from '@/lib/app/questionnaire/views';
import type { MutationSpec } from '@/components/admin/questionnaires/version-editor-types';
import {
  DEFAULT_CONTRADICTION_WINDOW_N,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_INVITEE_FIELDS,
  type HouseRule,
} from '@/lib/app/questionnaire/types';
import { DIMENSION_PHRASES } from '@/lib/app/questionnaire/chat/tone';

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

/** Toggle the "Respondent profile fields" enable switch (off by default; on seeds the starter set). */
const enableCapture = () =>
  fireEvent.click(screen.getByRole('switch', { name: /collect respondent profile fields/i }));

/** Expand a collapsed profile-field card by its summary "Toggle {label}" button. */
const expandField = (label: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`toggle ${label}`, 'i') }));

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

/**
 * The number input inside the same field block as a label. These inputs carry no id, and their
 * values collide across the form (several sit at 1, 3 or 4 by default), so finding one by its
 * displayed value picks an arbitrary field and asserts nothing reliable.
 */
function numberNear(labelText: string | RegExp): HTMLInputElement {
  const label = screen.getByText(labelText);
  let node: HTMLElement | null = label;
  while (node) {
    const input = node.querySelector('input[type="number"]');
    if (input) return input as HTMLInputElement;
    node = node.parentElement;
  }
  throw new Error(`config-editor test: no number input near ${String(labelText)}`);
}

/** Find the one native <select> whose option values are exactly `values`. */
function selectWithOptions(values: string[]): HTMLSelectElement {
  const match = screen
    .getAllByRole('combobox')
    .map((el) => el as HTMLSelectElement)
    .find(
      (el) =>
        Array.from(el.options)
          .map((o) => o.value)
          .join('|') === values.join('|')
    );
  if (!match) throw new Error(`config-editor test: no select with options ${values.join(', ')}`);
  return match;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

/*
 * The settings groups are an accordion and every one of them starts shut, so a field's markup is
 * present but hidden until its group is opened. These tests are about the wiring between a control
 * and the save payload, not about which group is open — so role queries here look inside shut
 * groups too. What the admin can actually *reach* is pinned separately, in "the settings
 * accordion" describe below, which is the file's contract for visibility.
 */
configure({ defaultHidden: true });

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
    expect(content.getByText('Progress milestones')).toBeInTheDocument();
    expect(content.getByText('Reasoning stream')).toBeInTheDocument();
    expect(content.getByText('Interviewer tone & persona')).toBeInTheDocument();
    expect(content.getByText('Access & invitations')).toBeInTheDocument();
    expect(content.getByText('Answer quality & safeguarding')).toBeInTheDocument();
    expect(content.getByText('Budget & limits')).toBeInTheDocument();
    expect(content.getByText('Respondent profile fields')).toBeInTheDocument();
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
    // Located by label, not by displayed value: `earlyFinishMinQuestions` also defaults to 0, so
    // a value match picks whichever comes first in the DOM rather than the field named here.
    fireEvent.change(numberNear(/^Min questions answered/), { target: { value: '5' } });
    clickSave();
    expect(bodyOf(specs).minQuestionsAnswered).toBe(5);
  });

  it('sends the entered minQuestionsAnswered value on save', () => {
    const { specs } = setup({ minQuestionsAnswered: 0 });
    fireEvent.change(numberNear(/^Min questions answered/), { target: { value: '4' } });
    clickSave();
    expect(bodyOf(specs).minQuestionsAnswered).toBe(4);
  });

  it('sends coverageThreshold clamped to [0,1]', () => {
    const { specs } = setup({ coverageThreshold: 1 });
    // `maxDataSlotAttempts` also defaults to 1 — same collision as above.
    fireEvent.change(numberNear(/^Coverage threshold/), { target: { value: '0.8' } });
    clickSave();
    expect(bodyOf(specs).coverageThreshold).toBe(0.8);
  });

  // ── early finish: coverage shown as a whole percent, stored as a 0–1 fraction ──
  it('shows the early-finish coverage as a percent and saves it back as a fraction', () => {
    // Default 1.0 renders as "100"; entering 50(%) must persist as 0.5.
    const { specs } = setup({ allowEarlyFinish: true, earlyFinishMinCoverage: 1 });
    const pctInput = screen
      .getAllByRole('spinbutton')
      .find((el) => (el as HTMLInputElement).value === '100') as HTMLElement;
    expect(pctInput).toBeDefined();
    fireEvent.change(pctInput, { target: { value: '50' } });
    clickSave();
    expect(bodyOf(specs).earlyFinishMinCoverage).toBe(0.5);
    // The question bar defaults to 0 (off) and is sent as-is.
    expect(bodyOf(specs).earlyFinishMinQuestions).toBe(0);
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

  it('PATCHes showProgressPercentText toggled off on save', () => {
    const { specs } = setup({ showProgressPercentText: true });
    fireEvent.click(switchNear(/^Show percent completed/));
    clickSave();
    expect(bodyOf(specs).showProgressPercentText).toBe(false);
  });

  // ── Progress milestones ───────────────────────────────────────────────────────

  const milestoneToggle = () =>
    screen.getByRole('switch', { name: /show completeness milestone banners/i });

  it('reflects milestoneBannerEnabled in the header switch', () => {
    setup({ milestoneBannerEnabled: true });
    expect(milestoneToggle()).toHaveAttribute('data-state', 'checked');
  });

  it('shows the off-state panel and a Turn on button when disabled', () => {
    setup({ milestoneBannerEnabled: false });
    expect(screen.getByText(/no milestone banners/i)).toBeInTheDocument();
    // Exact match: "Turn on" only, not the profile-fields panel's "Turn on & add starter fields"
    // (that panel is also in its off state by default — profileFields defaults to []).
    expect(screen.getByRole('button', { name: /^turn on$/i })).toBeInTheDocument();
  });

  it('shows the configured thresholds as chips when enabled', () => {
    setup({ milestoneBannerEnabled: true, milestoneBannerThresholds: [25, 50, 75, 90] });
    for (const t of [25, 50, 75, 90]) {
      expect(screen.getByText(`${t}%`)).toBeInTheDocument();
    }
  });

  it('PATCHes milestoneBannerEnabled toggled off on save', () => {
    const { specs } = setup({ milestoneBannerEnabled: true });
    fireEvent.click(milestoneToggle());
    clickSave();
    expect(bodyOf(specs).milestoneBannerEnabled).toBe(false);
  });

  it('closes the threshold list at the cap and says why', () => {
    // The cap is enforced by disabling the controls, not by rejecting the press: the guard inside
    // `addMilestoneThreshold` is unreachable from the UI, so the observable contract is the
    // disabled input, the disabled button, and the line telling the admin to remove one first.
    setup({
      milestoneBannerEnabled: true,
      milestoneBannerThresholds: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60],
    });
    expect(screen.getByPlaceholderText('e.g. 60')).toBeDisabled();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
    expect(
      screen.getByText(/At most 12 thresholds — remove one to add another\./)
    ).toBeInTheDocument();
  });

  it('leaves the threshold controls live below the cap', () => {
    setup({ milestoneBannerEnabled: true, milestoneBannerThresholds: [25, 75] });
    expect(screen.getByPlaceholderText('e.g. 60')).toBeEnabled();
    expect(screen.queryByText(/At most 12 thresholds/)).not.toBeInTheDocument();
  });

  it('adds a new threshold and PATCHes the sorted list on save', () => {
    const { specs } = setup({ milestoneBannerEnabled: true, milestoneBannerThresholds: [25, 75] });
    fireEvent.change(screen.getByPlaceholderText('e.g. 60'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByText('60%')).toBeInTheDocument();
    clickSave();
    expect(bodyOf(specs).milestoneBannerThresholds).toEqual([25, 60, 75]);
  });

  it('rejects an out-of-range threshold with an inline error and does not add it', () => {
    setup({ milestoneBannerEnabled: true, milestoneBannerThresholds: [25] });
    fireEvent.change(screen.getByPlaceholderText('e.g. 60'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByText(/enter a whole number between 1 and 99/i)).toBeInTheDocument();
    expect(screen.queryByText('150%')).not.toBeInTheDocument();
  });

  it('rejects a duplicate threshold with an inline error', () => {
    setup({ milestoneBannerEnabled: true, milestoneBannerThresholds: [50] });
    fireEvent.change(screen.getByPlaceholderText('e.g. 60'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByText(/already in the list/i)).toBeInTheDocument();
  });

  it('removes a threshold via its Remove button and PATCHes the reduced list', () => {
    const { specs } = setup({
      milestoneBannerEnabled: true,
      milestoneBannerThresholds: [25, 50],
    });
    fireEvent.click(screen.getByRole('button', { name: /remove 25%/i }));

    expect(screen.queryByText('25%')).not.toBeInTheDocument();
    clickSave();
    expect(bodyOf(specs).milestoneBannerThresholds).toEqual([50]);
  });

  it('PATCHes anonymousMode toggled on on save', () => {
    const { specs } = setup({ anonymousMode: false });
    fireEvent.click(switchNear(/^Anonymous mode/));
    clickSave();
    expect(bodyOf(specs).anonymousMode).toBe(true);
  });

  it('shows an "Anonymous mode on" badge on the Access & invitations header when anonymous, and hides it otherwise', () => {
    const { unmount } = setup({ anonymousMode: true });
    expect(settingsContent().getByText('Anonymous mode on')).toBeInTheDocument();
    unmount();

    setup({ anonymousMode: false });
    expect(settingsContent().queryByText('Anonymous mode on')).not.toBeInTheDocument();
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

  it('PATCHes the chat-only "hidden" answerSlotPanelScope (F7.2) on save', async () => {
    // Arrange: the new chat-only value this branch added, selected via the same
    // label-mapped option ("Hidden (chat only)") as any other scope choice.
    const { specs } = setup({ answerSlotPanelScope: 'full_progress' });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    const scopeSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'full_progress'
    ) as HTMLSelectElement;

    // Act
    await user.selectOptions(scopeSelect, 'hidden');
    clickSave();

    // Assert: the PATCH body carries the chat-only scope
    expect(bodyOf(specs).answerSlotPanelScope).toBe('hidden');
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

  it('shows contradiction sub-fields, pre-filled with a usable window, when switched on', async () => {
    // Switching on from `off` carries a stored window of 0, which the save path would clamp to 1 —
    // each answer checked against only the one before it. The editor proposes the real default.
    setup({ contradictionMode: 'off', contradictionWindowN: 0 });
    const user = userEvent.setup();
    const selects = screen.getAllByRole('combobox');
    const contradictionSelect = selects.find(
      (s) => (s as HTMLSelectElement).value === 'off'
    ) as HTMLSelectElement;
    await user.selectOptions(contradictionSelect, 'probe');
    expect(screen.getByText(/look-back window/i)).toBeInTheDocument();
    expect(screen.getByText(/detection cadence/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue(String(DEFAULT_CONTRADICTION_WINDOW_N))).toBeInTheDocument();
  });

  it('offers only Off and On — the retired flag mode is not selectable', () => {
    setup({ contradictionMode: 'off' });
    const contradictionSelect = screen
      .getAllByRole('combobox')
      .find((s) => (s as HTMLSelectElement).value === 'off') as HTMLSelectElement;
    const values = [...contradictionSelect.options].map((o) => o.value);
    expect(values).toEqual(['off', 'probe']);
  });

  it('keeps an admin-chosen window when switching on, rather than overwriting it', () => {
    // The proposal is a fill-in for an unusable value, not a reset of a deliberate one.
    const { specs } = setup({ contradictionMode: 'probe', contradictionWindowN: 3 });
    clickSave();
    expect(bodyOf(specs).contradictionWindowN).toBe(3);
  });

  it('sends contradictionWindowN:0 when mode is "off", regardless of the input value', () => {
    const { specs } = setup({ contradictionMode: 'off', contradictionWindowN: 5 });
    clickSave();
    expect(bodyOf(specs).contradictionWindowN).toBe(0);
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

  it('shows the OFF state (disabled by default) when there are no fields', () => {
    setup({ profileFields: [] });
    expect(screen.getByText(/not collecting respondent details/i)).toBeInTheDocument();
    // No field editor / add control while capture is off.
    expect(screen.queryByRole('button', { name: /add profile field/i })).not.toBeInTheDocument();
  });

  it('enabling capture seeds the four starter fields (name/email req, phone/org optional)', () => {
    const { specs } = setup({ profileFields: [] });
    enableCapture();
    for (const label of ['Name', 'Email address', 'Phone number', 'Organisation']) {
      expect(
        screen.getByRole('button', { name: new RegExp(`toggle ${label}`, 'i') })
      ).toBeInTheDocument();
    }
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{
      key: string;
      required: boolean;
      type: string;
    }>;
    expect(fields.map((f) => f.key)).toEqual(['name', 'email', 'phone', 'organisation']);
    expect(fields.map((f) => f.required)).toEqual([true, true, false, false]);
    expect(fields[1].type).toBe('email');
  });

  it('disabling capture saves no fields even when fields are configured', () => {
    const { specs } = setup({
      profileFields: [
        {
          key: 'org',
          label: 'Organisation',
          type: 'text',
          required: false,
          validation: 'deterministic',
        },
      ],
    });
    enableCapture(); // was on (has a field) → turn off
    clickSave();
    expect(bodyOf(specs).profileFields).toEqual([]);
  });

  it('"Add profile field" adds a new expanded row', () => {
    setup({
      profileFields: [
        { key: 'x', label: 'Existing', type: 'text', required: false, validation: 'deterministic' },
      ],
    });
    // The existing field is collapsed — its editor inputs are not rendered.
    expect(screen.queryByPlaceholderText(/your organisation/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add profile field/i }));
    // The new field opens expanded, so its label input is visible.
    expect(screen.getByPlaceholderText(/your organisation/i)).toBeInTheDocument();
  });

  it('opening a field collapses any other open field (accordion)', () => {
    setup({ profileFields: [] });
    enableCapture(); // seeds Name, Email address, Phone number, Organisation — all collapsed
    const nameToggle = () => screen.getByRole('button', { name: /toggle name/i });
    const emailToggle = () => screen.getByRole('button', { name: /toggle email address/i });

    fireEvent.click(nameToggle());
    expect(nameToggle()).toHaveAttribute('aria-expanded', 'true');

    // Opening a second field closes the first.
    fireEvent.click(emailToggle());
    expect(emailToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(nameToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('adding a field collapses the currently-open one (accordion)', () => {
    setup({
      profileFields: [
        { key: 'x', label: 'Existing', type: 'text', required: false, validation: 'deterministic' },
      ],
    });
    expandField('existing');
    expect(screen.getByRole('button', { name: /toggle existing/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: /add profile field/i }));
    expect(screen.getByRole('button', { name: /toggle existing/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('removing a profile field removes it from the list', () => {
    setup({
      profileFields: [
        {
          key: 'org',
          label: 'Organisation',
          type: 'text',
          required: false,
          validation: 'deterministic',
        },
      ],
    });
    expect(screen.getByRole('button', { name: /toggle organisation/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove organisation/i }));
    expect(screen.queryByRole('button', { name: /toggle organisation/i })).not.toBeInTheDocument();
  });

  it('PATCHes profileFields with trimmed key/label on save', () => {
    const { specs } = setup({
      profileFields: [
        {
          key: 'org',
          label: 'Organisation',
          type: 'text',
          required: false,
          validation: 'deterministic',
        },
      ],
    });
    expandField('organisation');
    fireEvent.change(screen.getByDisplayValue('org'), { target: { value: ' org_key ' } });
    fireEvent.change(screen.getByDisplayValue('Organisation'), {
      target: { value: ' Org Label ' },
    });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; label: string }>;
    expect(fields[0].key).toBe('org_key');
    expect(fields[0].label).toBe('Org Label');
  });

  it('auto-derives the storage key (slugified) from the label for a NEW field', () => {
    const { specs } = setup({
      profileFields: [
        { key: 'x', label: 'Existing', type: 'text', required: false, validation: 'deterministic' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /add profile field/i }));
    fireEvent.change(screen.getByPlaceholderText(/your organisation/i), {
      target: { value: 'Company Size!' },
    });
    // The key input mirrors the slugified label without the admin touching it.
    expect(screen.getByDisplayValue('company_size')).toBeInTheDocument();
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; label: string }>;
    expect(fields).toContainEqual(
      expect.objectContaining({ key: 'company_size', label: 'Company Size!' })
    );
  });

  it('stops auto-deriving the key once it has been hand-edited', () => {
    const { specs } = setup({
      profileFields: [
        { key: 'x', label: 'Existing', type: 'text', required: false, validation: 'deterministic' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /add profile field/i }));
    fireEvent.change(screen.getByPlaceholderText(/your organisation/i), {
      target: { value: 'Full Name' },
    });
    expect(screen.getByDisplayValue('full_name')).toBeInTheDocument(); // auto-derived
    // Hand-edit the key, then change the label again — the key must NOT be rewritten.
    fireEvent.change(screen.getByDisplayValue('full_name'), { target: { value: 'custom_id' } });
    fireEvent.change(screen.getByDisplayValue('Full Name'), { target: { value: 'Full Name X' } });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; label: string }>;
    expect(fields).toContainEqual(
      expect.objectContaining({ key: 'custom_id', label: 'Full Name X' })
    );
  });

  it('does NOT rewrite a saved field’s key when its label is edited (protects stored answers)', () => {
    const { specs } = setup({
      profileFields: [
        {
          key: 'org',
          label: 'Organisation',
          type: 'text',
          required: false,
          validation: 'deterministic',
        },
      ],
    });
    expandField('organisation');
    // A loaded field is key-locked — editing the label leaves the key alone.
    fireEvent.change(screen.getByDisplayValue('Organisation'), { target: { value: 'Company' } });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; label: string }>;
    expect(fields[0]).toMatchObject({ key: 'org', label: 'Company' });
  });

  it('preserves a per-field captureVia override on save (hybrid placement)', () => {
    const { specs } = setup({
      captureMode: 'conversational',
      profileFields: [
        {
          key: 'name',
          label: 'Name',
          type: 'text',
          required: true,
          validation: 'deterministic',
          captureVia: 'form',
        },
      ],
    });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; captureVia?: string }>;
    expect(fields[0].captureVia).toBe('form');
  });

  it('omits captureVia from the payload when a field inherits the default placement', () => {
    const { specs } = setup({
      profileFields: [
        {
          key: 'name',
          label: 'Name',
          type: 'text',
          required: true,
          validation: 'deterministic',
        },
      ],
    });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<Record<string, unknown>>;
    expect(fields[0]).not.toHaveProperty('captureVia');
  });

  it('shows the Options input only for select-type profile fields', async () => {
    setup({
      profileFields: [
        {
          key: 'dept',
          label: 'Department',
          type: 'text',
          required: false,
          validation: 'deterministic',
        },
      ],
    });
    expandField('department');
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
      profileFields: [
        {
          key: 'dept',
          label: 'Department',
          type: 'select',
          required: false,
          validation: 'deterministic',
        },
      ],
    });
    expandField('department');
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
      profileFields: [
        { key: 'name', label: 'Name', type: 'text', required: false, validation: 'deterministic' },
      ],
    });
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; options?: string[] }>;
    expect(fields[0]).not.toHaveProperty('options');
  });

  it('toggling required on a profile field includes required:true in the body', () => {
    const { specs } = setup({
      profileFields: [
        {
          key: 'org',
          label: 'Organisation',
          type: 'text',
          required: false,
          validation: 'deterministic',
        },
      ],
    });
    // Scope to the profile section, expand the field, and click its required switch — the section has
    // exactly two switches (the section enable toggle, which carries an aria-label, and the field's
    // required toggle, which doesn't), so filter out the enable one.
    const section = settingsContent()
      .getByText('Respondent profile fields')
      .closest('[class*="overflow-hidden"]') as HTMLElement;
    expandField('organisation');
    const requiredSwitch = within(section)
      .getAllByRole('switch')
      .find((s) => s.getAttribute('aria-label') !== 'Collect respondent profile fields');
    fireEvent.click(requiredSwitch!);
    clickSave();
    const fields = bodyOf(specs).profileFields as Array<{ key: string; required: boolean }>;
    expect(fields[0].required).toBe(true);
  });

  // ── Config conflicts ───────────────────────────────────────────────────────────

  it('surfaces a config conflict (anonymous mode + profile capture) in the banner and inline', () => {
    setup({
      anonymousMode: true,
      profileFields: [
        { key: 'name', label: 'Name', type: 'text', required: true, validation: 'deterministic' },
      ],
    });
    // Summary banner flags an error-level conflict.
    expect(screen.getByText(/won.t work as set/i)).toBeInTheDocument();
    // The conflict title appears (banner row + inline alert in the profile-fields section).
    expect(screen.getAllByText(/profile fields won.t be collected/i).length).toBeGreaterThan(0);
  });

  it('shows no conflict banner for a coherent config', () => {
    setup({ anonymousMode: false, profileFields: [] });
    expect(screen.queryByText(/won.t work as set/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs? a look/i)).not.toBeInTheDocument();
  });

  it('the Anonymous mode toggle now lives in the Access & invitations section', () => {
    setup();
    const section = settingsContent()
      .getByText('Access & invitations')
      .closest('[class*="overflow-hidden"]') as HTMLElement;
    expect(within(section).getAllByText(/anonymous mode/i).length).toBeGreaterThan(0);
    // ...and no longer in the Respondent experience section (where it used to live).
    const experience = settingsContent()
      .getByText('Respondent experience')
      .closest('[class*="overflow-hidden"]') as HTMLElement;
    expect(within(experience).queryByText(/anonymous mode/i)).not.toBeInTheDocument();
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

  // ── Conditional topics master switch ───────────────────────────────────────────────
  //
  // The switch is mirrored here from the Conditional topics tab, which makes it the only field on
  // this tab with two editors. The send is therefore conditional, and the test that matters most
  // is the negative one: an untouched switch must not appear in the body at all, or a Settings
  // tab loaded before someone turned scope on would turn it back off on the next unrelated save.

  const scopeConfig = (enabled: boolean) => ({
    conditionalTopics: { ...DEFAULT_QUESTIONNAIRE_CONFIG.conditionalTopics, enabled },
  });

  it('renders the Conditional topics group with a link to its tab', () => {
    setup();
    const content = settingsContent();
    expect(content.getByText('Conditional topics')).toBeInTheDocument();
    expect(content.getByRole('link', { name: /set up topics and conditions/i })).toHaveAttribute(
      'href',
      '/admin/questionnaires/qn-1/v/ver-1/topics'
    );
  });

  it('reflects the stored conditionalTopics.enabled in the switch', () => {
    setup(scopeConfig(true));
    expect(screen.getByRole('switch', { name: /use conditional topics/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('says what off means, and what on means', () => {
    const { rerender } = render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig(scopeConfig(false))}
        questionCount={5}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    // Matched on the state sentence, not the group description — the description says something
    // deliberately similar, and matching it would pass whatever the switch said.
    expect(screen.getByText(/sits idle until this is on/i)).toBeInTheDocument();

    rerender(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig(scopeConfig(true))}
        questionCount={5}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    expect(screen.getByText(/is still asked of everyone/i)).toBeInTheDocument();
  });

  it('sends conditionalTopics only when the switch was changed', () => {
    const { specs } = setup(scopeConfig(false));
    fireEvent.click(screen.getByRole('switch', { name: /use conditional topics/i }));
    clickSave();
    expect(bodyOf(specs)).toMatchObject({ conditionalTopics: { enabled: true } });
  });

  it('turning it back off from on sends enabled:false', () => {
    const { specs } = setup(scopeConfig(true));
    fireEvent.click(screen.getByRole('switch', { name: /use conditional topics/i }));
    clickSave();
    expect(bodyOf(specs)).toMatchObject({ conditionalTopics: { enabled: false } });
  });

  it('omits conditionalTopics entirely when the switch was not touched', () => {
    const { specs } = setup(scopeConfig(true));
    // Change something unrelated, so this is a real save rather than a no-op one.
    fireEvent.click(switchNear(/show percent completed/i));
    clickSave();
    expect(bodyOf(specs)).not.toHaveProperty('conditionalTopics');
  });

  it('resyncs the switch when the config prop changes', () => {
    const { rerender } = render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig(scopeConfig(false))}
        questionCount={5}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    expect(screen.getByRole('switch', { name: /use conditional topics/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );

    rerender(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig(scopeConfig(true))}
        questionCount={5}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    expect(screen.getByRole('switch', { name: /use conditional topics/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  // ── Resync from new config prop ────────────────────────────────────────────────

  it('resyncs all fields when the config prop changes', () => {
    const { rerender } = render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ selectionStrategy: 'sequential' })}
        questionCount={5}
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
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );

    expect(screen.getByText(/keep the reasoning on each turn/i)).toBeInTheDocument();
  });

  // ── adaptive strategy option ─────────────────────────────────────────────────

  it('offers the adaptive option in the strategy picker', () => {
    render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig({ selectionStrategy: 'adaptive' })}
        questionCount={5}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    expect(screen.getByRole('option', { name: /adaptive/i })).toBeInTheDocument();
  });

  // ── data-slot embeddings step ────────────────────────────────────────────────

  it('shows the data-slot embeddings step', () => {
    render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig()}
        questionCount={5}
        run={vi.fn(() => Promise.resolve(true))}
        busy={false}
      />
    );
    // The shared EmbeddingCoverageStep renders its title synchronously (before the
    // coverage fetch resolves), so the data-slot variant's heading is the proof it mounted.
    expect(screen.getByText(/data-slot selection needs embeddings/i)).toBeInTheDocument();
  });

  // ── busy disables controls ────────────────────────────────────────────────────

  it('disables all controls when busy is true', () => {
    render(
      <ConfigEditorUnderTest
        questionnaireId="qn-1"
        versionId="ver-1"
        config={makeConfig()}
        questionCount={5}
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

  /**
   * Custom-voice mode. The tone dials and the free-text persona only render when built-in persona
   * mode is OFF, and the config default is now Built-in persona (The Coach) — so every test that
   * drives the custom tone editor opts out of the default explicitly.
   */
  const customVoice = (over: Partial<ConfigView> = {}): Partial<ConfigView> => ({
    ...over,
    personaSelection: { ...DEFAULT_QUESTIONNAIRE_CONFIG.personaSelection, enabled: false },
  });

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
    setup(customVoice());
    // The pole captions only render when the slider is shown.
    expect(screen.queryByText('Dispassionate')).not.toBeInTheDocument();
    fireEvent.click(switchNear(/^Empathy/));
    expect(screen.getByText('Dispassionate')).toBeInTheDocument();
    expect(screen.getByText('Highly empathetic')).toBeInTheDocument();
  });

  it('enables a dimension in the saved tone block when its toggle is switched on', () => {
    const { specs } = setup(customVoice());
    fireEvent.click(switchNear(/^Empathy/));
    clickSave();
    const tone = bodyOf(specs).tone as Record<string, { enabled: boolean; level: number }>;
    expect(tone.empathy.enabled).toBe(true);
  });

  it('reveals the persona textarea on toggle and sends the trimmed text on save', () => {
    const { specs } = setup(customVoice());
    fireEvent.click(switchNear(/^Persona/));
    const textarea = screen.getByPlaceholderText(/supportive career coach/i);
    fireEvent.change(textarea, { target: { value: '  You are a blunt consultant.  ' } });
    clickSave();
    const persona = (bodyOf(specs).tone as { persona: { enabled: boolean; text: string } }).persona;
    expect(persona).toEqual({ enabled: true, text: 'You are a blunt consultant.' });
  });

  it('previews the exact tone clause a dimension injects, from the real prompt source', () => {
    setup(customVoice());
    // Mirroring is unipolar — it emits a clause even at the default midpoint (3).
    fireEvent.click(switchNear(/^Mirroring/));
    const clause = DIMENSION_PHRASES.mirroring[3];
    expect(clause.length).toBeGreaterThan(0);
    expect(screen.getByText((c) => c.includes(clause))).toBeInTheDocument();
  });

  it('shows the neutral “adds nothing” message for a bipolar dimension at the midpoint', () => {
    setup(customVoice());
    // Empathy is bipolar — the midpoint (3) is neutral-empty, so no clause is injected.
    expect(DIMENSION_PHRASES.empathy[3]).toBe('');
    fireEvent.click(switchNear(/^Empathy/));
    expect(screen.getByText(/no tone clause is added/i)).toBeInTheDocument();
  });

  it('edits the persona prose without echoing the assembled prompt clause back', () => {
    // The clause preview was removed: it restated the admin's own sentence wrapped in boilerplate,
    // which read as duplication rather than information. The textarea is the whole control now.
    setup(customVoice());
    fireEvent.click(switchNear(/^Persona/));
    const textarea = screen.getByPlaceholderText(/supportive career coach/i);
    fireEvent.change(textarea, { target: { value: 'You are a blunt consultant' } });
    expect(textarea).toHaveValue('You are a blunt consultant');
    // The admin's own sentence appears once, in the box. Nothing echoes it back inside the
    // assembled clause. (The field's help still quotes the boilerplate TEMPLATE, with no admin
    // text in it — that is explanation, not duplication, so the matcher requires both halves.)
    expect(
      screen.queryByText(
        (c) => c.includes('You are a blunt consultant') && c.includes('Adopt this persona')
      )
    ).not.toBeInTheDocument();
  });

  it('reflects a stored enabled dimension from config', () => {
    setup(
      customVoice({
        tone: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.tone,
          formality: { enabled: true, level: 5 },
        },
      })
    );
    // The slider's pole captions are visible because the dimension is enabled.
    expect(screen.getByText('Formal')).toBeInTheDocument();
  });

  it('shows the signed −2…+2 dial value (stored 1–5 → display) and a collapsed scale legend', () => {
    const content = () => settingsContent();
    // Stored 5 (the max pole) shows as +2 on the display scale.
    setup(
      customVoice({
        tone: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.tone,
          formality: { enabled: true, level: 5 },
        },
      })
    );
    expect(content().getByText('+2')).toBeInTheDocument();
    // The scale legend collapses behind a summary — read once, then out of the way. Its body still
    // renders (a closed <details> keeps its content in the DOM), so both halves are asserted.
    expect(content().getByText('How the dials work')).toBeInTheDocument();
    expect(content().getByText(/Each dial runs from/)).toBeInTheDocument();
    expect(content().getByText(/treat 0 as neutral/)).toBeInTheDocument();
  });

  it('marks a balanced dial as neutral at 0 (stored midpoint 3)', () => {
    setup(
      customVoice({
        tone: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.tone,
          empathy: { enabled: true, level: 3 }, // display 0, bipolar ⇒ neutral
        },
      })
    );
    expect(settingsContent().getByText('0 · neutral')).toBeInTheDocument();
  });

  // ── Interviewer voice either/or (custom tone vs built-in persona, F-persona) ──

  it('offers the either/or and starts in Custom voice mode when built-in mode is off', () => {
    const content = () => settingsContent();
    setup(customVoice());
    expect(content().getByText('Custom voice')).toBeInTheDocument();
    expect(content().getByText('Built-in persona')).toBeInTheDocument();
    // Custom mode → tone dials shown, persona-library controls hidden.
    expect(content().getByText(/^Empathy/)).toBeInTheDocument();
    expect(content().queryByText('Let respondents switch interviewer')).not.toBeInTheDocument();
  });

  it('switches to Built-in persona mode, hiding the tone editor, and saves enabled:true', () => {
    const { specs } = setup();
    fireEvent.click(screen.getByText('Built-in persona'));
    const content = settingsContent();
    // Built-in mode → the library controls show and the custom tone dials are gone.
    expect(content.getByText(/^Let respondents switch interviewer/)).toBeInTheDocument();
    expect(content.queryByText(/^Empathy/)).not.toBeInTheDocument();
    clickSave();
    const personaSelection = bodyOf(specs).personaSelection as { enabled: boolean };
    expect(personaSelection.enabled).toBe(true);
  });

  it('opens directly in Built-in persona mode when the version is already on it', () => {
    setup({
      personaSelection: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.personaSelection,
        enabled: true,
        defaultPersonaKey: 'philosopher',
      },
    });
    const content = settingsContent();
    expect(content.getByText(/^Let respondents switch interviewer/)).toBeInTheDocument();
    // The switcher style is hidden until respondents are allowed to switch.
    expect(content.queryByText(/How respondents switch interviewer/)).not.toBeInTheDocument();
  });

  it('reveals the switcher style only once respondents may switch, and saves the flag', () => {
    const { specs } = setup({
      personaSelection: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.personaSelection,
        enabled: true,
      },
    });
    fireEvent.click(switchNear(/^Let respondents switch interviewer/));
    expect(screen.getByText(/How respondents switch interviewer/)).toBeInTheDocument();
    clickSave();
    const personaSelection = bodyOf(specs).personaSelection as { allowRespondentSwitch: boolean };
    expect(personaSelection.allowRespondentSwitch).toBe(true);
  });
});

describe('ConfigEditor — question fidelity gate (P18)', () => {
  const fidelitySwitch = () => screen.getByRole('switch', { name: /per-question fidelity/i });

  it('saves the stored block untouched when the admin does not open the section', () => {
    // A config field that quietly resets on an unrelated save is the failure mode worth pinning —
    // here it would silently deactivate every must-ask question in the questionnaire.
    const questionFidelity = { enabled: true, defaultFidelity: 0.75 } as const;
    const { specs } = setup({ questionFidelity });
    clickSave();
    expect(bodyOf(specs).questionFidelity).toEqual(questionFidelity);
  });

  it('is off by default, with no level picker until it is switched on', () => {
    setup();
    expect(fidelitySwitch()).not.toBeChecked();
    expect(screen.queryByRole('combobox', { name: /level for new questions/i })).toBeNull();
  });

  it('turns the feature on and persists it', () => {
    const { specs } = setup();
    fireEvent.click(fidelitySwitch());
    clickSave();
    expect(bodyOf(specs).questionFidelity).toEqual({ enabled: true, defaultFidelity: 0.5 });
  });

  it('turns it back off without losing the configured default', () => {
    // Switching off must be reversible: the admin's prepared levels stay, they just stop applying.
    const { specs } = setup({ questionFidelity: { enabled: true, defaultFidelity: 1 } });
    fireEvent.click(fidelitySwitch());
    clickSave();
    expect(bodyOf(specs).questionFidelity).toEqual({ enabled: false, defaultFidelity: 1 });
  });

  /** The level picker — the only select whose options are the fidelity level slugs. */
  const levelPicker = () =>
    screen
      .getAllByRole('combobox')
      .find((el) =>
        Array.from(el.querySelectorAll('option')).some(
          (o) => o.getAttribute('value') === 'must_ask'
        )
      ) as HTMLSelectElement | undefined;

  it('reflects the stored level and explains what it means', () => {
    setup({ questionFidelity: { enabled: true, defaultFidelity: 1 } });
    expect(levelPicker()?.value).toBe('must_ask');
    expect(
      screen.getAllByText(/Choice and scale questions show their real answer control/).length
    ).toBeGreaterThan(0);
  });

  it('maps the chosen level back onto its numeric stop when saving', () => {
    // The admin picks a NAME; the API takes the grid value. Sending 'close' would fail validation,
    // and sending the wrong number would silently set a different level than the one displayed.
    const { specs } = setup({ questionFidelity: { enabled: true, defaultFidelity: 0.5 } });
    fireEvent.change(levelPicker()!, { target: { value: 'close' } });
    clickSave();
    expect(bodyOf(specs).questionFidelity).toEqual({ enabled: true, defaultFidelity: 0.75 });
  });
});

describe('ConfigEditor — interviewer house rules', () => {
  const ruleFor = (
    over: Partial<HouseRule> & Pick<HouseRule, 'id' | 'kind' | 'text'>
  ): HouseRule => ({
    enabled: true,
    ...over,
  });

  it('saves the stored block untouched when the admin does not open the section', () => {
    const houseRules = {
      enabled: true,
      rules: [ruleFor({ id: 'a', kind: 'never', text: 'Give advice.' })],
    };
    const { specs } = setup({ houseRules });
    clickSave();
    // A config field that quietly resets on an unrelated save is the failure mode worth pinning.
    expect(bodyOf(specs).houseRules).toEqual(houseRules);
  });

  it('trims rule text and triggers on save', () => {
    const { specs } = setup({
      houseRules: {
        enabled: true,
        rules: [
          ruleFor({ id: 'a', kind: 'always', text: '  Ask for an example.  ' }),
          ruleFor({
            id: 'b',
            kind: 'if_asked',
            text: '  Fifteen minutes.  ',
            trigger: '  how long  ',
          }),
        ],
      },
    });
    clickSave();
    expect(bodyOf(specs).houseRules).toEqual({
      enabled: true,
      rules: [
        { id: 'a', kind: 'always', enabled: true, text: 'Ask for an example.' },
        { id: 'b', kind: 'if_asked', enabled: true, text: 'Fifteen minutes.', trigger: 'how long' },
      ],
    });
  });

  it('surfaces a house-rule conflict inline as the admin has it configured', () => {
    // End-to-end through the real detector: a rule asking for a name on an anonymous questionnaire.
    setup({
      anonymousMode: true,
      houseRules: {
        enabled: true,
        rules: [ruleFor({ id: 'a', kind: 'always', text: 'Ask for their name first.' })],
      },
    });
    expect(
      screen.getAllByText(/may ask for details this questionnaire doesn.t collect/i).length
    ).toBeGreaterThan(0);
  });

  it('raises no house-rule conflict for an ordinary rule', () => {
    setup({
      houseRules: {
        enabled: true,
        rules: [ruleFor({ id: 'a', kind: 'never', text: 'Give advice.' })],
      },
    });
    // The panel is only useful if a normal rule is silent.
    expect(screen.queryByText(/won.t work as set/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs? a look/i)).not.toBeInTheDocument();
  });

  it('drops rules the admin left incomplete rather than failing the save', () => {
    const { specs } = setup({
      houseRules: {
        enabled: true,
        rules: [
          ruleFor({ id: 'a', kind: 'always', text: 'Keep this one.' }),
          // An added-but-never-typed rule: the server rejects empty text, and a blocked save with no
          // obvious cause is a worse outcome than silently dropping a rule that says nothing.
          ruleFor({ id: 'b', kind: 'always', text: '   ' }),
          // An if_asked rule whose trigger was never filled in can never fire.
          ruleFor({ id: 'c', kind: 'if_asked', text: 'Only the team.', trigger: '' }),
        ],
      },
    });
    clickSave();
    const saved = bodyOf(specs).houseRules as { rules: HouseRule[] };
    expect(saved.rules.map((r) => r.id)).toEqual(['a']);
  });
});

// ─── Interviewer strategy — save payload ─────────────────────────────────────
//
// The panel itself is covered by interviewer-strategy-panel.test.tsx. What only the editor can
// pin is the transform it applies on the way out: the opening examples are trimmed and the blank
// ones dropped, so a row the admin added but never wrote in never reaches the server (and the
// "n of 5" counter doesn't lie after a reload).

describe('ConfigEditor — interviewer strategy', () => {
  it('saves the stored block untouched when the admin does not open the section', () => {
    const interviewerStrategy = {
      ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
      approach: 'funnel' as const,
      pace: 'brisk' as const,
      openingMode: 'examples' as const,
      openingExamples: ['What brought you here today?'],
    };
    const { specs } = setup({ interviewerStrategy });
    clickSave();
    // A config field that quietly resets on an unrelated save is the failure mode worth pinning.
    expect(bodyOf(specs).interviewerStrategy).toEqual(interviewerStrategy);
  });

  it('trims the opening examples and drops the blank ones on save', () => {
    const { specs } = setup({
      interviewerStrategy: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
        openingMode: 'examples',
        openingExamples: [
          '  Tell me about your week.  ',
          // An added-but-never-typed row. It is not an example, and the runtime would ignore it —
          // storing it would only make the counter overstate what the interviewer has to work with.
          '   ',
          '',
          'What made you say yes?',
        ],
      },
    });
    clickSave();
    const saved = bodyOf(specs).interviewerStrategy as { openingExamples: string[] };
    expect(saved.openingExamples).toEqual(['Tell me about your week.', 'What made you say yes?']);
  });

  // ── Controls whose only assertion is what they save ──────────────────────────
  //
  // A long tail of settings-tab fields that had no coverage at all: each is a small handler
  // between a control and the save body, and the failure mode for every one of them is the same
  // and silent — an admin sets it, the payload does not carry it, and the questionnaire runs on
  // the old value with the editor showing the new one.

  describe('the respondent-experience controls', () => {
    it('saves the chosen opening text size', async () => {
      // The rung the conversation opens at. It reached the respondent surface but was dropped on
      // the way there once already, so the payload half is worth pinning on its own.
      const { specs } = setup({ chatTextSize: 'standard' });
      const user = userEvent.setup();
      await user.selectOptions(
        selectWithOptions(['small', 'standard', 'large', 'largest']),
        'largest'
      );
      clickSave();
      expect(bodyOf(specs).chatTextSize).toBe('largest');
    });

    it('reflects a stored text size rather than always opening on the default', () => {
      setup({ chatTextSize: 'large' });
      expect(selectWithOptions(['small', 'standard', 'large', 'largest']).value).toBe('large');
    });

    it('carries an untouched text size through an unrelated save', () => {
      // The regression that matters more than the edit path: a field that quietly resets to the
      // default on somebody else's save.
      const { specs } = setup({ chatTextSize: 'largest' });
      clickSave();
      expect(bodyOf(specs).chatTextSize).toBe('largest');
    });
  });

  describe('the answer-quality numbers', () => {
    it('saves an edited answer-confidence floor as a number', () => {
      const { specs } = setup({ answerConfidenceFloor: 0.5 });
      fireEvent.change(numberNear(/^Answer confidence floor/), { target: { value: '0.65' } });
      clickSave();
      expect(bodyOf(specs).answerConfidenceFloor).toBe(0.65);
    });

    it('saves an edited data-slot attempt cap as a number', () => {
      const { specs } = setup({ maxDataSlotAttempts: 1 });
      fireEvent.change(numberNear(/^Data-slot attempts/), { target: { value: '3' } });
      clickSave();
      expect(bodyOf(specs).maxDataSlotAttempts).toBe(3);
    });

    it('saves the chosen answer-fit mode', async () => {
      const { specs } = setup({ answerFitMode: 'fallback' });
      const user = userEvent.setup();
      await user.selectOptions(selectWithOptions(['off', 'fallback', 'always']), 'always');
      clickSave();
      expect(bodyOf(specs).answerFitMode).toBe('always');
    });
  });

  describe('the contradiction sweep', () => {
    it('saves both sweep numbers once the sweep is on', () => {
      // Both inputs only exist while the mode is something other than `off`, which is why the
      // fixture turns it on rather than asserting against the default.
      const { specs } = setup({
        contradictionMode: 'flag',
        contradictionWindowN: 4,
        contradictionEveryNTurns: 3,
      });
      fireEvent.change(numberNear(/^Look-back window/), { target: { value: '6' } });
      fireEvent.change(numberNear(/^Detection cadence/), { target: { value: '2' } });
      clickSave();
      expect(bodyOf(specs)).toMatchObject({
        contradictionWindowN: 6,
        contradictionEveryNTurns: 2,
      });
    });
  });

  describe('the early-finish question bar', () => {
    it('saves the entered question count', () => {
      const { specs } = setup({ allowEarlyFinish: true, earlyFinishMinQuestions: 0 });
      // Uniquely identifiable: it is the only input on the form that placeholders with "Off".
      const input = screen.getByPlaceholderText('Off');
      fireEvent.change(input, { target: { value: '8' } });
      clickSave();
      expect(bodyOf(specs).earlyFinishMinQuestions).toBe(8);
    });
  });

  describe('the settings accordion', () => {
    // Fifteen groups of a dozen fields each; one open at a time, none to begin with. Folding is
    // presentation only — a shut group still saves — so both halves are pinned here.

    /** The header button that opens/shuts a group (the whole header is the target, not a chevron). */
    const header = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

    it('starts with every group shut', () => {
      const { container } = setup();
      expect(container.querySelector('#budget-fields')).not.toBeVisible();
      expect(container.querySelector('#access-fields')).not.toBeVisible();
      expect(header('Budget & limits')).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens a group when its header is clicked, and shuts it again', async () => {
      const { container } = setup();
      const user = userEvent.setup();
      await user.click(header('Budget & limits'));
      expect(container.querySelector('#budget-fields')).toBeVisible();
      await user.click(header('Budget & limits'));
      expect(container.querySelector('#budget-fields')).not.toBeVisible();
    });

    it('shuts the open group when another is opened — only ever one at a time', async () => {
      const { container } = setup();
      const user = userEvent.setup();
      await user.click(header('Budget & limits'));
      await user.click(header('Access & invitations'));
      expect(container.querySelector('#access-fields')).toBeVisible();
      expect(container.querySelector('#budget-fields')).not.toBeVisible();
    });

    it('still saves the settings inside a shut group', () => {
      // Every group is shut on load, budget included. Folding hides the fields; it must never
      // drop them from the payload.
      const { specs } = setup({ costBudgetUsd: 12 });
      clickSave();
      expect(bodyOf(specs).costBudgetUsd).toBe(12);
    });
  });

  describe('the progress milestones', () => {
    it('adds a typed threshold to the saved list', async () => {
      const { specs } = setup({ milestoneBannerThresholds: [50] });
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText('e.g. 60'), '75');
      await user.click(screen.getByRole('button', { name: /^Add$/i }));
      clickSave();
      expect(bodyOf(specs).milestoneBannerThresholds).toEqual([50, 75]);
    });
  });
});

describe('sectioned interviews (P21)', () => {
  /** Turn the feature on and reveal the rest of the group. */
  function enableSections() {
    fireEvent.click(
      screen.getByRole('switch', { name: /work through the questionnaire in sections/i })
    );
  }

  it('hides every section setting until the feature is switched on', () => {
    setup();
    expect(screen.queryByText(/where the sections come from/i)).not.toBeInTheDocument();
    enableSections();
    expect(screen.getByText(/where the sections come from/i)).toBeInTheDocument();
  });

  it('sends the whole settings blob, with the percent converted back to a fraction', () => {
    const { specs } = setup();
    enableSections();

    fireEvent.change(selectWithOptions(['auto', 'topics', 'themes', 'document']), {
      target: { value: 'themes' },
    });
    fireEvent.change(selectWithOptions(['sequential', 'free']), { target: { value: 'free' } });
    fireEvent.change(selectWithOptions(['capture', 'stay']), { target: { value: 'stay' } });
    fireEvent.change(numberNear(/section is done at/i), { target: { value: '60' } });
    fireEvent.change(numberNear(/this many answered/i), { target: { value: '3' } });
    fireEvent.change(numberNear(/most turns in one section/i), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('switch', { name: /let the interviewer offer to move on/i }));
    fireEvent.click(screen.getByRole('switch', { name: /show sections not yet reached/i }));

    clickSave();
    expect(bodyOf(specs).sections).toEqual({
      enabled: true,
      source: 'themes',
      navigation: 'free',
      tangentPolicy: 'stay',
      // Edited as a whole percent, stored as the fraction the runtime reads.
      closeCoverage: 0.6,
      closeMinAnswered: 3,
      maxTurnsPerSection: 12,
      // Both default to true, so one click each flips them off.
      agentOffersClose: false,
      showLockedSections: false,
    });
  });

  it('keeps the saved coverage when the percent field is cleared', () => {
    const { specs } = setup({
      sections: { ...DEFAULT_QUESTIONNAIRE_CONFIG.sections, enabled: true, closeCoverage: 0.75 },
    });
    fireEvent.change(numberNear(/section is done at/i), { target: { value: '' } });
    clickSave();
    expect((bodyOf(specs).sections as { closeCoverage: number }).closeCoverage).toBe(0.75);
  });

  it('renders the stored settings rather than the defaults', () => {
    setup({
      sections: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.sections,
        enabled: true,
        source: 'document',
        navigation: 'free',
        tangentPolicy: 'stay',
        closeCoverage: 0.4,
        closeMinAnswered: 2,
        maxTurnsPerSection: 8,
      },
    });
    expect(selectWithOptions(['auto', 'topics', 'themes', 'document']).value).toBe('document');
    expect(selectWithOptions(['sequential', 'free']).value).toBe('free');
    expect(selectWithOptions(['capture', 'stay']).value).toBe('stay');
    expect(numberNear(/section is done at/i).value).toBe('40');
    expect(numberNear(/this many answered/i).value).toBe('2');
    expect(numberNear(/most turns in one section/i).value).toBe('8');
  });
});
