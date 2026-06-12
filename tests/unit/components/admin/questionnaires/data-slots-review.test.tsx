/**
 * DataSlotsReview component tests.
 *
 * Anti-green-bar: asserts the component renders the right slot-count text, fires
 * API calls with the right bodies, updates the DOM after user interactions (field
 * edits, slot removal, question-key toggling, accept/reject checkboxes), shows the
 * draft warning banner when in draft mode, and displays inline errors/notices from
 * the API.  All assertions target DOM state the component *produces*, not mock
 * return values.
 *
 * @see components/admin/questionnaires/data-slots-review.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();
const mockRouterPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    refresh: mockRouterRefresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// Stub the hook so it doesn't attach real beforeunload listeners in jsdom.
vi.mock('@/lib/hooks/use-unsaved-changes-warning', () => ({
  useUnsavedChangesWarning: vi.fn(),
}));

// Stub the StatusTicker to an identifiable marker — its own tests cover the
// animation; here we just assert it mounts/unmounts on the right state.
vi.mock('@/components/admin/questionnaires/status-ticker', () => ({
  StatusTicker: () => <div data-testid="status-ticker" />,
  DATA_SLOT_MESSAGES: ['Thinking…'],
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { DataSlotsReview } from '@/components/admin/questionnaires/data-slots-review';
import { API } from '@/lib/api/endpoints';
import type {
  DataSlotView,
  DataSlotDraftView,
  GeneratedDataSlot,
} from '@/lib/app/questionnaire/data-slots';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSlot(over: Partial<DataSlotView> = {}): DataSlotView {
  return {
    id: 'slot-1',
    key: 'primary_goal',
    name: 'Primary Goal',
    description: 'What the prospect wants to achieve.',
    theme: 'Goals',
    ordinal: 0,
    weight: 1,
    questionKeys: ['q1', 'q2'],
    ...over,
  };
}

function makeGeneratedSlot(over: Partial<GeneratedDataSlot> = {}): GeneratedDataSlot {
  return {
    name: 'Timeline',
    description: 'When the prospect needs the solution.',
    theme: 'Urgency',
    questionKeys: ['q3'],
    confidence: 0.9,
    ...over,
  };
}

function makeDraft(slots: GeneratedDataSlot[] = [makeGeneratedSlot()]): DataSlotDraftView {
  return {
    slots,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeQuestions() {
  return [
    { key: 'q1', prompt: 'What is your goal?' },
    { key: 'q2', prompt: 'What is your timeline?' },
    { key: 'q3', prompt: 'What is your budget?' },
  ];
}

function baseProps() {
  return {
    questionnaireId: 'qn-1',
    versionId: 'ver-1',
    questions: makeQuestions(),
    initialSlots: [] as DataSlotView[],
    initialDraft: null as DataSlotDraftView | null,
  };
}

/** Mock a successful fetch response. */
function mockFetchSuccess<T>(data: T, meta?: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data,
      ...(meta ? { meta } : {}),
    }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Mock a fetch error response. */
function mockFetchError(message: string, code = 'API_ERROR'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ success: false, error: { code, message, details: {} } }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DataSlotsReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Empty state ──────────────────────────────────────────────────────────

  describe('empty state (no slots, no draft)', () => {
    it('shows the "no data slots" prompt and a "Generate data slots" button', () => {
      render(<DataSlotsReview {...baseProps()} />);
      expect(
        screen.getByText('No data slots yet. Generate a set from this version’s questions.')
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /generate data slots/i })).toBeInTheDocument();
    });

    it('does not render a slot list or Save button when there are no slots', () => {
      render(<DataSlotsReview {...baseProps()} />);
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: /accept this slot/i })).not.toBeInTheDocument();
    });
  });

  // ── Live slots rendering ──────────────────────────────────────────────────

  describe('live slots (initialSlots provided, no draft)', () => {
    it('renders the slot name in the input field', () => {
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ name: 'Primary Goal' })]} />
      );
      const inputs = screen.getAllByDisplayValue('Primary Goal');
      expect(inputs.length).toBeGreaterThan(0);
    });

    it('shows the live count message and "Regenerate" button', () => {
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot(), makeSlot({ id: 'slot-2', key: 'budget', name: 'Budget' })]}
        />
      );
      expect(screen.getByText('2 live data slots.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('shows the "Live" badge (not "Draft") for live slots', () => {
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} />);
      expect(screen.getByText('Live')).toBeInTheDocument();
      expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    });

    it('shows the question-key coverage badge with correct numbers', () => {
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot({ questionKeys: ['q1', 'q2'] })]}
        />
      );
      // 2 out of 3 questions covered
      expect(screen.getByText('2/3 questions covered')).toBeInTheDocument();
    });

    it('shows the uncovered-question hint when some questions have no slot', () => {
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ questionKeys: ['q1'] })]} />
      );
      // q2 and q3 not covered
      expect(screen.getByText(/not yet covered by any accepted slot/i)).toBeInTheDocument();
      expect(screen.getByText(/q2, q3/)).toBeInTheDocument();
    });

    it('Save button starts disabled for live slots with no edits (clean state)', () => {
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} />);
      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  // ── Draft rendering ────────────────────────────────────────────────────────

  describe('draft mode (initialDraft provided)', () => {
    it('shows the "Draft — not live yet" warning banner', () => {
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);
      expect(screen.getByText('Draft — not live yet')).toBeInTheDocument();
    });

    it('shows the "Draft" badge (not "Live") for draft slots', () => {
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);
      expect(screen.getByText('Draft')).toBeInTheDocument();
      expect(screen.queryByText('Live')).not.toBeInTheDocument();
    });

    it('shows the draft count message', () => {
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);
      expect(screen.getByText(/1 draft data slot.*not live yet/i)).toBeInTheDocument();
    });

    it('shows the live-slots-in-use message inside the banner when live slots exist', () => {
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} initialDraft={makeDraft()} />
      );
      expect(screen.getByText(/1 live data slot.*stay in use until then/i)).toBeInTheDocument();
    });

    it('shows the launch-requirement message when there are no live slots', () => {
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);
      expect(
        screen.getByText(/Launching this version requires saved data slots/i)
      ).toBeInTheDocument();
    });

    it('Save button label reads "Save & make live" in draft mode', () => {
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);
      expect(screen.getByRole('button', { name: /save & make live/i })).toBeInTheDocument();
    });
  });

  // ── Slot field editing ────────────────────────────────────────────────────

  describe('slot field editing', () => {
    it('typing in the name field updates the value and marks the form dirty (Save enabled)', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ name: 'Primary Goal' })]} />
      );

      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();

      const nameInputs = screen.getAllByPlaceholderText('Slot name (1–4 words)');
      await user.clear(nameInputs[0]);
      await user.type(nameInputs[0], 'Updated Name');

      await waitFor(() => {
        expect(saveBtn).toBeEnabled();
      });
    });

    it('shows "unsaved edits" message on live mode after editing', async () => {
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} />);

      const nameInputs = screen.getAllByPlaceholderText('Slot name (1–4 words)');
      await user.clear(nameInputs[0]);
      await user.type(nameInputs[0], 'Changed');

      await waitFor(() => {
        expect(screen.getByText(/unsaved edits to your live data slots/i)).toBeInTheDocument();
      });
    });

    it('typing in the theme field is reflected in the input value', async () => {
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ theme: 'Goals' })]} />);

      const themeInput = screen.getByDisplayValue('Goals');
      await user.clear(themeInput);
      await user.type(themeInput, 'Outcomes');

      expect(screen.getByDisplayValue('Outcomes')).toBeInTheDocument();
    });

    it('typing in the description textarea updates the value and marks the form dirty', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot({ description: 'Original description.' })]}
        />
      );

      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();

      const descTextarea = screen.getByPlaceholderText(
        'What this slot captures and why it matters'
      );
      await user.clear(descTextarea);
      await user.type(descTextarea, 'Revised description.');

      expect(screen.getByDisplayValue('Revised description.')).toBeInTheDocument();
      await waitFor(() => {
        expect(saveBtn).toBeEnabled();
      });
    });
  });

  // ── Accept/reject checkbox ────────────────────────────────────────────────

  describe('accept/reject checkbox', () => {
    it('unchecking a slot decrements the accepted count in the Save button', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview
          {...baseProps()}
          initialDraft={makeDraft([
            makeGeneratedSlot({ name: 'Slot A' }),
            makeGeneratedSlot({ name: 'Slot B' }),
          ])}
        />
      );

      // Both accepted initially → Save button should say "(2)"
      expect(screen.getByRole('button', { name: /save & make live \(2\)/i })).toBeInTheDocument();

      const checkboxes = screen.getAllByRole('checkbox', { name: /accept this slot/i });
      await user.click(checkboxes[0]);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save & make live \(1\)/i })).toBeInTheDocument();
      });
    });
  });

  // ── Remove slot ────────────────────────────────────────────────────────────

  describe('remove slot', () => {
    it('clicking "Remove slot" removes it from the list', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[
            makeSlot({ id: 'slot-1', key: 's1', name: 'Goal' }),
            makeSlot({ id: 'slot-2', key: 's2', name: 'Budget' }),
          ]}
        />
      );

      expect(screen.getByDisplayValue('Goal')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Budget')).toBeInTheDocument();

      const removeButtons = screen.getAllByRole('button', { name: /remove slot/i });
      await user.click(removeButtons[0]);

      await waitFor(() => {
        expect(screen.queryByDisplayValue('Goal')).not.toBeInTheDocument();
        expect(screen.getByDisplayValue('Budget')).toBeInTheDocument();
      });
    });
  });

  // ── Question-key toggle ───────────────────────────────────────────────────

  describe('question-key toggle', () => {
    it('clicking an inactive question key adds it to the slot', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ questionKeys: ['q1'] })]} />
      );

      // q3 button is inactive — clicking it should add it to the slot's coverage
      const q3Btn = screen.getByRole('button', { name: 'q3' });
      await user.click(q3Btn);

      await waitFor(() => {
        // After toggling, the slot should cover q1 and q3; the badge updates
        expect(screen.getByText('2/3 questions covered')).toBeInTheDocument();
      });
    });

    it('clicking an active question key removes it from the slot', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot({ questionKeys: ['q1', 'q2'] })]}
        />
      );

      // Coverage starts at 2/3; deselect q2
      expect(screen.getByText('2/3 questions covered')).toBeInTheDocument();
      const q2Btn = screen.getByRole('button', { name: 'q2' });
      await user.click(q2Btn);

      await waitFor(() => {
        expect(screen.getByText('1/3 questions covered')).toBeInTheDocument();
      });
    });

    it('shows a warning when a slot has question keys not in the version', () => {
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot({ questionKeys: ['q1', 'orphan_key'] })]}
        />
      );
      expect(screen.getByText(/Some mapped keys aren’t in this version/i)).toBeInTheDocument();
    });
  });

  // ── Generate action ────────────────────────────────────────────────────────

  describe('generate action', () => {
    it('shows the StatusTicker while generation is in flight', async () => {
      let settle: (v: unknown) => void = () => {};
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((res) => (settle = res))));
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      expect(screen.getByTestId('status-ticker')).toBeInTheDocument();

      // Settle with a success to avoid unhandled-promise noise
      settle({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { slots: [makeGeneratedSlot()], diagnostic: undefined },
        }),
      });
    });

    it('POSTs to the generate endpoint with the correct URL', async () => {
      const fetchMock = mockFetchSuccess(
        { slots: [makeGeneratedSlot()], diagnostic: undefined },
        undefined
      );
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          API.APP.QUESTIONNAIRES.versionDataSlotsGenerate('qn-1', 'ver-1'),
          expect.objectContaining({ method: 'POST' })
        );
      });
    });

    it('switches to draft mode and shows a notice after successful generation', async () => {
      mockFetchSuccess({ slots: [makeGeneratedSlot({ name: 'Timeline' })], diagnostic: undefined });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      await waitFor(() => {
        // Notice message appears
        expect(screen.getByText(/Generated 1 draft data slot/i)).toBeInTheDocument();
        // Draft badge shows
        expect(screen.getByText('Draft')).toBeInTheDocument();
      });
    });

    it('shows a diagnostic error message when generation returns a diagnostic string', async () => {
      mockFetchSuccess({ slots: [], diagnostic: 'No LLM provider configured' });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/Generation failed.*No LLM provider configured/i)
        ).toBeInTheDocument();
      });
    });

    it('shows a generic error when generation returns zero slots with no diagnostic', async () => {
      mockFetchSuccess({ slots: [], diagnostic: undefined });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      await waitFor(() => {
        expect(screen.getByText(/did not return any slots/i)).toBeInTheDocument();
      });
    });

    it('shows the server error message inline when generation fails with an API error', async () => {
      mockFetchError('LLM provider quota exceeded');
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      await waitFor(() => {
        expect(screen.getByText(/LLM provider quota exceeded/i)).toBeInTheDocument();
      });
    });

    it('shows a fallback error when fetch rejects (network failure)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      await waitFor(() => {
        expect(screen.getByText(/Could not generate data slots/i)).toBeInTheDocument();
      });
    });
  });

  // ── Save action ────────────────────────────────────────────────────────────

  describe('save action', () => {
    it('PUTs to the data-slots endpoint with accepted slots payload', async () => {
      const slot = makeGeneratedSlot({ name: 'Goal', questionKeys: ['q1'] });
      const fetchMock = mockFetchSuccess({
        slots: [makeSlot({ name: 'Goal', questionKeys: ['q1'] })],
      });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft([slot])} />);

      await user.click(screen.getByRole('button', { name: /save & make live/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          API.APP.QUESTIONNAIRES.versionDataSlots('qn-1', 'ver-1'),
          expect.objectContaining({
            method: 'PUT',
            body: expect.stringContaining('"name":"Goal"'),
          })
        );
      });
    });

    it('only sends accepted slots in the PUT body (excludes rejected ones)', async () => {
      const slots = [
        makeGeneratedSlot({ name: 'Slot A', questionKeys: ['q1'] }),
        makeGeneratedSlot({ name: 'Slot B', questionKeys: ['q2'] }),
      ];
      const fetchMock = mockFetchSuccess({
        slots: [makeSlot({ name: 'Slot B', questionKeys: ['q2'] })],
      });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft(slots)} />);

      // Uncheck Slot A (first accept checkbox)
      const checkboxes = screen.getAllByRole('checkbox', { name: /accept this slot/i });
      await user.click(checkboxes[0]);

      await user.click(screen.getByRole('button', { name: /save & make live \(1\)/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          API.APP.QUESTIONNAIRES.versionDataSlots('qn-1', 'ver-1'),
          expect.objectContaining({ method: 'PUT' })
        );
        const body = JSON.parse(
          (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string
        ) as { slots: Array<{ name: string }> };
        expect(body.slots).toHaveLength(1);
        expect(body.slots[0].name).toBe('Slot B');
      });
    });

    it('shows a success notice and switches to live mode after saving', async () => {
      mockFetchSuccess({ slots: [makeSlot({ name: 'Goal' })] });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /save & make live/i }));

      await waitFor(() => {
        expect(screen.getByText(/Saved 1 data slots.*now live/i)).toBeInTheDocument();
        expect(screen.getByText('Live')).toBeInTheDocument();
        expect(screen.queryByText('Draft')).not.toBeInTheDocument();
      });
    });

    it('calls router.refresh() after a successful save', async () => {
      mockFetchSuccess({ slots: [makeSlot()] });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /save & make live/i }));

      await waitFor(() => {
        expect(mockRouterRefresh).toHaveBeenCalled();
      });
    });

    it('navigates to the forked version URL when meta.forked is true', async () => {
      mockFetchSuccess({ slots: [] }, { forked: true, versionId: 'ver-2', versionNumber: 2 });
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /save & make live/i }));

      await waitFor(() => {
        expect(mockRouterPush).toHaveBeenCalledWith(
          '/admin/questionnaires/qn-1/v/ver-2/data-slots'
        );
      });
    });

    it('shows an inline error message when the PUT fails', async () => {
      mockFetchError('Version is locked');
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /save & make live/i }));

      await waitFor(() => {
        expect(screen.getByText(/Version is locked/i)).toBeInTheDocument();
      });
    });
  });

  // ── Discard draft action ──────────────────────────────────────────────────

  describe('discard draft action', () => {
    it('shows a success notice and reverts to live mode after discarding', async () => {
      // jsdom doesn't define window.confirm — stub it as a global
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      mockFetchSuccess({});
      const user = userEvent.setup();
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} initialDraft={makeDraft()} />
      );

      await user.click(screen.getByRole('button', { name: /discard draft/i }));

      await waitFor(() => {
        expect(screen.getByText('Draft discarded.')).toBeInTheDocument();
        // Should now show the live slot and be in live mode
        expect(screen.getByText('Live')).toBeInTheDocument();
        expect(screen.queryByText('Draft')).not.toBeInTheDocument();
      });
    });

    it('calls the DELETE endpoint for the draft', async () => {
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      const fetchMock = mockFetchSuccess({});
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /discard draft/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          API.APP.QUESTIONNAIRES.versionDataSlotsDraft('qn-1', 'ver-1'),
          expect.objectContaining({ method: 'DELETE' })
        );
      });
    });

    it('does nothing when confirm returns false', async () => {
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
      const fetchMock = mockFetchSuccess({});
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /discard draft/i }));

      expect(fetchMock).not.toHaveBeenCalled();
      // Still in draft mode
      expect(screen.getByText('Draft')).toBeInTheDocument();
    });

    it('shows an error message when the DELETE call fails', async () => {
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      mockFetchError('Could not discard');
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /discard draft/i }));

      await waitFor(() => {
        expect(screen.getByText(/Could not discard/i)).toBeInTheDocument();
      });
    });
  });

  // ── Button busy state ─────────────────────────────────────────────────────

  describe('busy-state disabling', () => {
    it('disables the Generate button while generation is in flight', async () => {
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /generate data slots/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate data slots/i })).toBeDisabled();
      });
    });
  });
});
