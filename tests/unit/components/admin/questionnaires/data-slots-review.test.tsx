/**
 * DataSlotsReview component tests.
 *
 * Anti-green-bar: asserts the component renders the right slot-count text, groups slots under a
 * single editable theme heading, fires API calls with the right bodies, and updates the DOM after
 * user interactions (field edits, theme rename, slot removal, single-slot AI refine). All
 * assertions target DOM state the component *produces*, not mock return values.
 *
 * The set is reviewed as a working copy: generation streams a draft in (SSE), edits/removes/refines
 * mutate the in-memory set, and Save (PUT) / Discard (DELETE) commit it. There is no per-slot
 * accept/reject — every slot in the set is saved.
 *
 * @see components/admin/questionnaires/data-slots-review.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  return { slots, updatedAt: '2026-01-01T00:00:00.000Z' };
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

/** Mock a JSON fetch (used by authoringMutate for save / discard / refine). */
function mockFetchSuccess<T>(data: T, meta?: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data, ...(meta ? { meta } : {}) }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Mock a JSON error fetch. */
function mockFetchError(message: string, code = 'API_ERROR'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ success: false, error: { code, message, details: {} } }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Build a ReadableStream that emits the given SSE blocks then closes. */
function sseBody(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = blocks.join('\n\n') + '\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

/** Mock the streaming generate endpoint with a final `done` event carrying `slots`. */
function mockGenerateStream(slots: GeneratedDataSlot[]): ReturnType<typeof vi.fn> {
  const block = `event: done\ndata: ${JSON.stringify({ type: 'done', slots, persisted: true })}`;
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, body: sseBody([block]) });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Mock the streaming endpoint with an arbitrary sequence of SSE events (each `{ type, ... }`). */
function mockGenerateEvents(
  events: { type: string; [key: string]: unknown }[]
): ReturnType<typeof vi.fn> {
  const blocks = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`);
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, body: sseBody(blocks) });
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
    it('shows the generate heading and a "Generate" button', () => {
      render(<DataSlotsReview {...baseProps()} />);
      expect(screen.getByRole('heading', { name: 'Generate data slots' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^generate$/i })).toBeInTheDocument();
    });

    it('does not render a slot list or Save button when there are no slots', () => {
      render(<DataSlotsReview {...baseProps()} />);
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Slot name (1–4 words)')).not.toBeInTheDocument();
    });
  });

  // ── Live slots rendering ──────────────────────────────────────────────────

  describe('live slots (initialSlots provided, no draft)', () => {
    it('renders the slot name in the input field', () => {
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ name: 'Primary Goal' })]} />
      );
      expect(screen.getByDisplayValue('Primary Goal')).toBeInTheDocument();
    });

    it('shows the live count message and a "Discard and regenerate" button', () => {
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot(), makeSlot({ id: 'slot-2', key: 'budget', name: 'Budget' })]}
        />
      );
      expect(screen.getByText('2 live slots.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /discard and regenerate/i })).toBeInTheDocument();
    });

    it('does not show a per-slot Draft/Live badge (status is global)', () => {
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} />);
      expect(screen.queryByText('Live')).not.toBeInTheDocument();
      expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    });

    it('shows the question-key coverage badge with correct numbers', () => {
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot({ questionKeys: ['q1', 'q2'] })]}
        />
      );
      expect(screen.getByText('2/3 questions covered')).toBeInTheDocument();
    });

    it('shows the uncovered-question hint when some questions have no slot', () => {
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ questionKeys: ['q1'] })]} />
      );
      expect(screen.getByText(/not yet covered by any slot/i)).toBeInTheDocument();
      expect(screen.getByText(/q2, q3/)).toBeInTheDocument();
    });

    it('Save button starts disabled for live slots with no edits (clean state)', () => {
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} />);
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  // ── Theme grouping ──────────────────────────────────────────────────────────

  describe('theme grouping', () => {
    it('renders one shared theme input for two slots in the same theme', () => {
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[
            makeSlot({ id: 's1', key: 'a', name: 'A', theme: 'Goals' }),
            makeSlot({ id: 's2', key: 'b', name: 'B', theme: 'Goals' }),
          ]}
        />
      );
      // Both slot names render…
      expect(screen.getByDisplayValue('A')).toBeInTheDocument();
      expect(screen.getByDisplayValue('B')).toBeInTheDocument();
      // …under a single 'Goals' theme heading.
      expect(screen.getAllByPlaceholderText('Theme')).toHaveLength(1);
      expect(screen.getByText('2 slots')).toBeInTheDocument();
    });

    it('renders separate theme inputs for slots in different themes', () => {
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[
            makeSlot({ id: 's1', key: 'a', name: 'A', theme: 'Goals' }),
            makeSlot({ id: 's2', key: 'b', name: 'B', theme: 'Urgency' }),
          ]}
        />
      );
      expect(screen.getAllByPlaceholderText('Theme')).toHaveLength(2);
    });

    it('renaming a theme header updates both slots and marks the form dirty', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[
            makeSlot({ id: 's1', key: 'a', name: 'A', theme: 'Goals' }),
            makeSlot({ id: 's2', key: 'b', name: 'B', theme: 'Goals' }),
          ]}
        />
      );
      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();

      const themeInput = screen.getByDisplayValue('Goals');
      await user.type(themeInput, 'X');

      // Still one group (both slots followed the rename), now 'GoalsX'.
      await waitFor(() => expect(screen.getByDisplayValue('GoalsX')).toBeInTheDocument());
      expect(screen.getAllByPlaceholderText('Theme')).toHaveLength(1);
      expect(saveBtn).toBeEnabled();
    });
  });

  // ── Draft rendering ────────────────────────────────────────────────────────

  describe('draft mode (initialDraft provided)', () => {
    it('shows the "Draft — not live yet" warning banner', () => {
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);
      expect(screen.getByText('Draft — not live yet')).toBeInTheDocument();
    });

    it('shows the draft count message', () => {
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);
      expect(screen.getByText(/1 draft slot — not live yet/i)).toBeInTheDocument();
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

      const nameInput = screen.getByPlaceholderText('Slot name (1–4 words)');
      await user.clear(nameInput);
      await user.type(nameInput, 'Updated Name');

      await waitFor(() => expect(saveBtn).toBeEnabled());
      expect(screen.getByDisplayValue('Updated Name')).toBeInTheDocument();
    });

    it('shows "unsaved edits" message in live mode after editing', async () => {
      const user = userEvent.setup();
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} />);

      const nameInput = screen.getByPlaceholderText('Slot name (1–4 words)');
      await user.type(nameInput, '!');

      await waitFor(() =>
        expect(screen.getByText(/unsaved edits to your live data slots/i)).toBeInTheDocument()
      );
    });

    it('typing in the description textarea updates the value', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ description: 'Original.' })]} />
      );
      const textarea = screen.getByDisplayValue('Original.');
      await user.type(textarea, ' Extended.');
      expect(screen.getByDisplayValue('Original. Extended.')).toBeInTheDocument();
    });
  });

  // ── Remove slot (confirm dialog) ──────────────────────────────────────────

  describe('remove slot', () => {
    it('removing the only slot empties the list after confirming', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ name: 'Primary Goal' })]} />
      );

      await user.click(screen.getByRole('button', { name: 'Remove slot' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText('Remove this data slot?')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Remove slot' }));

      await waitFor(() =>
        expect(screen.queryByDisplayValue('Primary Goal')).not.toBeInTheDocument()
      );
    });

    it('cancelling the confirm dialog keeps the slot', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview {...baseProps()} initialSlots={[makeSlot({ name: 'Primary Goal' })]} />
      );

      await user.click(screen.getByRole('button', { name: 'Remove slot' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(screen.getByDisplayValue('Primary Goal')).toBeInTheDocument();
    });
  });

  // ── Question-key coverage ─────────────────────────────────────────────────

  describe('question-key coverage', () => {
    it('removing a covered-question chip decrements the coverage badge', async () => {
      const user = userEvent.setup();
      render(
        <DataSlotsReview
          {...baseProps()}
          initialSlots={[makeSlot({ questionKeys: ['q1', 'q2'] })]}
        />
      );
      expect(screen.getByText('2/3 questions covered')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Remove q1' }));
      // Removing coverage is guarded by an "are you sure" — confirm it.
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /remove anyway/i }));

      await waitFor(() => expect(screen.getByText('1/3 questions covered')).toBeInTheDocument());
    });
  });

  // ── Generate (streaming) ──────────────────────────────────────────────────

  describe('generate action', () => {
    it('POSTs to the streaming generate endpoint', async () => {
      const user = userEvent.setup();
      const fetchMock = mockGenerateStream([makeGeneratedSlot()]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          API.APP.QUESTIONNAIRES.versionDataSlotsGenerateStream('qn-1', 'ver-1'),
          expect.objectContaining({ method: 'POST' })
        );
      });
    });

    it('switches to draft mode and shows a notice after a successful generation', async () => {
      const user = userEvent.setup();
      mockGenerateStream([makeGeneratedSlot({ name: 'Timeline' })]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText(/Generated 1 draft data slot/i)).toBeInTheDocument()
      );
      expect(screen.getByText('Draft — not live yet')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Timeline')).toBeInTheDocument();
    });

    it('shows a generic error when generation returns zero slots', async () => {
      const user = userEvent.setup();
      mockGenerateStream([]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText(/did not return any slots/i)).toBeInTheDocument()
      );
    });

    it('shows the server error message when generation fails with an API error', async () => {
      const user = userEvent.setup();
      mockFetchError('Generator is over capacity');
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText('Generator is over capacity')).toBeInTheDocument()
      );
    });

    it('consumes a full progress stream (start → group → merge → done) then shows the result', async () => {
      const user = userEvent.setup();
      mockGenerateEvents([
        {
          type: 'start',
          totalQuestions: 3,
          groups: [{ index: 0, title: 'Section A', questionCount: 3 }],
        },
        {
          type: 'group_done',
          index: 0,
          title: 'Section A',
          slots: [makeGeneratedSlot({ name: 'Timeline' })],
        },
        { type: 'group_error', index: 1, title: 'Section B', message: 'section failed' },
        { type: 'merge_start', rawSlotCount: 2 },
        { type: 'merge_warning', message: 'merge fell back to a union' },
        { type: 'done', slots: [makeGeneratedSlot({ name: 'Timeline' })], persisted: true },
      ]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      // The progress events are applied during streaming; the final `done` yields the draft.
      await waitFor(() =>
        expect(screen.getByText(/Generated 1 draft data slot/i)).toBeInTheDocument()
      );
      expect(screen.getByDisplayValue('Timeline')).toBeInTheDocument();
    });

    it('maps a streamed error event with a known code to friendly guidance', async () => {
      const user = userEvent.setup();
      mockGenerateEvents([
        { type: 'error', code: 'no_provider_configured', message: 'raw provider error' },
      ]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText(/No LLM provider is configured/i)).toBeInTheDocument()
      );
    });

    it('shows the raw message for a streamed error event with an unrecognised code', async () => {
      const user = userEvent.setup();
      mockGenerateEvents([
        { type: 'error', code: 'weird_code', message: 'Something specific went wrong' },
      ]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText('Something specific went wrong')).toBeInTheDocument()
      );
    });

    it('falls back to a code-only message when an error event carries no message', async () => {
      const user = userEvent.setup();
      mockGenerateEvents([{ type: 'error', code: 'weird_code' }]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText(/Generation failed \(weird_code\)/i)).toBeInTheDocument()
      );
    });

    it('falls back to a generic message when an error event carries neither code nor message', async () => {
      const user = userEvent.setup();
      mockGenerateEvents([{ type: 'error' }]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText(/did not return any slots/i)).toBeInTheDocument()
      );
    });

    it('pluralises the notice for a multi-slot generation', async () => {
      const user = userEvent.setup();
      mockGenerateStream([
        makeGeneratedSlot({ name: 'Timeline' }),
        makeGeneratedSlot({ name: 'Budget', theme: 'Money', questionKeys: ['q3'] }),
      ]);
      render(<DataSlotsReview {...baseProps()} />);

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() =>
        expect(screen.getByText(/Generated 2 draft data slots/i)).toBeInTheDocument()
      );
    });
  });

  // ── Regenerate messaging (while a set already exists) ─────────────────────

  describe('regenerate messaging', () => {
    it('warns that a new set will replace the current unsaved draft', async () => {
      const user = userEvent.setup();
      // A fetch that never resolves keeps the component in the generating state.
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /discard and regenerate/i }));

      await waitFor(() =>
        expect(
          screen.getByText(/replace the current unsaved draft of 1 data slot/i)
        ).toBeInTheDocument()
      );
    });

    it('reassures that live slots stay in use while a new set generates', async () => {
      const user = userEvent.setup();
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      render(<DataSlotsReview {...baseProps()} initialSlots={[makeSlot()]} />);

      await user.click(screen.getByRole('button', { name: /discard and regenerate/i }));

      await waitFor(() =>
        expect(
          screen.getByText(/your 1 live data slot.*stay in use until you save/i)
        ).toBeInTheDocument()
      );
    });
  });

  // ── Save action ───────────────────────────────────────────────────────────

  describe('save action', () => {
    it('sends all slots in the PUT body and shows a success notice', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchSuccess({ slots: [makeSlot()] });
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /save & make live/i }));

      await waitFor(() =>
        expect(screen.getByText(/Saved 1 data slots — now live/i)).toBeInTheDocument()
      );
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse((opts as { body: string }).body);
      expect(body.slots).toHaveLength(1);
      expect(body.slots[0]).toMatchObject({ name: 'Timeline', theme: 'Urgency' });
    });

    it('redirects to the forked draft when the version was launched', async () => {
      const user = userEvent.setup();
      mockFetchSuccess(
        { slots: [makeSlot()] },
        { forked: true, versionId: 'ver-2', versionNumber: 2 }
      );
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /save & make live/i }));

      await waitFor(() =>
        expect(mockRouterPush).toHaveBeenCalledWith('/admin/questionnaires/qn-1/v/ver-2/data-slots')
      );
    });
  });

  // ── Discard action (confirm dialog) ───────────────────────────────────────

  describe('discard draft action', () => {
    it('calls the DELETE endpoint and shows a notice after confirming', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchSuccess({});
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /^discard$/i }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /discard draft/i }));

      await waitFor(() => expect(screen.getByText('Draft discarded.')).toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRES.versionDataSlotsDraft('qn-1', 'ver-1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('shows an error message when the DELETE call fails', async () => {
      const user = userEvent.setup();
      mockFetchError('Could not delete');
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /^discard$/i }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /discard draft/i }));

      await waitFor(() => expect(screen.getByText('Could not delete')).toBeInTheDocument());
    });
  });

  // ── Refine a single slot ──────────────────────────────────────────────────

  describe('refine action', () => {
    it('refines one slot in place from the instructions popover', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchSuccess({
        slot: makeGeneratedSlot({
          name: 'Enterprise Timeline',
          description: 'Refined.',
          theme: 'Urgency',
          questionKeys: ['q3'],
        }),
      });
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /refine with ai/i }));

      const instructions = await screen.findByPlaceholderText(/make it focus on enterprise/i);
      await user.type(instructions, 'Focus on enterprise buyers.');
      await user.click(screen.getByRole('button', { name: /^refine$/i }));

      // The card's name is replaced with the refined value, and a notice appears.
      await waitFor(() =>
        expect(screen.getByDisplayValue('Enterprise Timeline')).toBeInTheDocument()
      );
      expect(screen.getByText(/Slot refined — review and save/i)).toBeInTheDocument();

      // It POSTed to the refine endpoint with the instructions + current slot.
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(API.APP.QUESTIONNAIRES.versionDataSlotsRefine('qn-1', 'ver-1'));
      const body = JSON.parse((opts as { body: string }).body);
      expect(body.instructions).toBe('Focus on enterprise buyers.');
      expect(body.slot).toMatchObject({ name: 'Timeline' });
    });

    it('shows the diagnostic message when the refiner returns no slot', async () => {
      const user = userEvent.setup();
      mockFetchSuccess({
        slot: null,
        diagnostic: 'provider_unavailable',
        diagnosticMessage: 'Provider offline.',
      });
      render(<DataSlotsReview {...baseProps()} initialDraft={makeDraft()} />);

      await user.click(screen.getByRole('button', { name: /refine with ai/i }));
      const instructions = await screen.findByPlaceholderText(/make it focus on enterprise/i);
      await user.type(instructions, 'Tighten it up.');
      await user.click(screen.getByRole('button', { name: /^refine$/i }));

      await waitFor(() => expect(screen.getByText('Provider offline.')).toBeInTheDocument());
      // The original name is untouched.
      expect(screen.getByDisplayValue('Timeline')).toBeInTheDocument();
    });
  });

  // ── Busy-state disabling ──────────────────────────────────────────────────

  describe('busy-state disabling', () => {
    it('disables the generate button while generation is in flight', async () => {
      const user = userEvent.setup();
      // A fetch that never resolves keeps `generating` true.
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      render(<DataSlotsReview {...baseProps()} />);

      const btn = screen.getByRole('button', { name: /^generate$/i });
      await user.click(btn);

      await waitFor(() => expect(btn).toBeDisabled());
    });
  });
});
