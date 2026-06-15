/**
 * ComposeStudio component tests.
 *
 * Anti-green-bar: each test asserts DOM changes driven by component logic —
 * phase transitions after SSE events, error message text, fetch URL/body shape,
 * and navigation — not mock internals.
 *
 * Key mocking strategy:
 * - fetch is stubbed via vi.stubGlobal so SSE stream + refine POST are intercepted.
 * - SSE responses use a ReadableStream that emits crafted `event:` frames.
 * - StructurePreview is kept real (it's simple and covered separately).
 *
 * @see components/admin/questionnaires/compose/compose-studio.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { ComposeStudio } from '@/components/admin/questionnaires/compose/compose-studio';
import { API } from '@/lib/api/endpoints';

// ─── SSE helpers ─────────────────────────────────────────────────────────────

/** Build an SSE text block from an event type + JSON data. */
function sseFrame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Create a ReadableStream that delivers the given SSE text chunks. */
function makeSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

interface SseScenario {
  frames: string[];
  ok?: boolean;
  status?: number;
}

/** Stub global.fetch to return a streaming response. */
function mockSseStream({ frames, ok = true, status = 200 }: SseScenario) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    body: makeSseStream(frames),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Stub global.fetch to return a non-streaming JSON error response (pre-stream). */
function mockSseError(message: string, status = 422) {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    body: null,
    json: async () => ({ error: { message } }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Stub global.fetch for the refine POST endpoint. */
function mockRefineSuccess(
  summary = 'Shortened to 2 sections.',
  structure = {
    sections: [{ ordinal: 0, title: 'Background', description: undefined }],
    questions: [
      { sectionOrdinal: 0, key: 'q1', prompt: 'What is your role?', suggestedType: 'free_text' },
    ],
    goal: 'Refined goal',
  }
) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { summary, sectionCount: 1, questionCount: 1, structure },
    }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockRefineError(message = 'Rate limit exceeded', status = 429) {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ success: false, error: { code: 'RATE_LIMITED', message } }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A complete SSE stream that ends with the `done` event (valid happy path). */
function makeHappySseFrames(questionnaireId = 'qn-new', versionId = 'v-new'): string[] {
  return [
    sseFrame('outline', {
      type: 'outline',
      goal: 'Understand churn risk',
      sections: [
        { ordinal: 0, title: 'Background', description: 'Context questions' },
        { ordinal: 1, title: 'Satisfaction' },
      ],
    }),
    sseFrame('section_done', {
      type: 'section_done',
      ordinal: 0,
      title: 'Background',
      questions: [
        { key: 'q1', prompt: 'What is your role?', suggestedType: 'free_text' },
        { key: 'q2', prompt: 'How long have you been a customer?', suggestedType: 'numeric' },
      ],
    }),
    sseFrame('section_done', {
      type: 'section_done',
      ordinal: 1,
      title: 'Satisfaction',
      questions: [{ key: 'q3', prompt: 'How satisfied are you?', suggestedType: 'likert' }],
    }),
    sseFrame('done', {
      type: 'done',
      questionnaireId,
      versionId,
      sectionCount: 2,
      questionCount: 3,
    }),
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ComposeStudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Initial render ─────────────────────────────────────────────────────────

  describe('initial render (brief phase)', () => {
    it('renders the brief textarea with the correct placeholder', () => {
      render(<ComposeStudio />);
      expect(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…')
      ).toBeInTheDocument();
    });

    it('renders the optional title input', () => {
      render(<ComposeStudio />);
      expect(screen.getByPlaceholderText('e.g. Churn-risk onboarding survey')).toBeInTheDocument();
    });

    it('renders the Generate button enabled when not yet streaming', () => {
      render(<ComposeStudio />);
      expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /generate/i })).not.toBeDisabled();
    });

    it('renders the empty-state placeholder in the preview pane', () => {
      render(<ComposeStudio />);
      expect(
        screen.getByText('Your questionnaire will appear here as it builds.')
      ).toBeInTheDocument();
    });

    it('does NOT show the refine panel in the brief phase', () => {
      render(<ComposeStudio />);
      expect(screen.queryByText('Refine it')).not.toBeInTheDocument();
    });
  });

  // ── Brief validation ───────────────────────────────────────────────────────

  describe('brief validation', () => {
    it('shows an error message when Generate is clicked with an empty brief', async () => {
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.click(screen.getByRole('button', { name: /generate/i }));

      expect(screen.getByText('Describe the questionnaire you want to build.')).toBeInTheDocument();
    });

    it('does not call fetch when the brief is empty', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.click(screen.getByRole('button', { name: /generate/i }));

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not show a validation error before the user has attempted to submit', () => {
      render(<ComposeStudio />);
      expect(
        screen.queryByText('Describe the questionnaire you want to build.')
      ).not.toBeInTheDocument();
    });
  });

  // ── Streaming compose flow ─────────────────────────────────────────────────

  describe('streaming compose flow', () => {
    it('disables the Generate button and shows "Building…" while streaming', async () => {
      // Use a stream that doesn't close immediately so we can assert the in-flight state
      let resolveStream!: (frames: string[]) => void;
      const streamPromise = new Promise<string[]>((res) => (resolveStream = res));
      const encoder = new TextEncoder();
      const fn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: new ReadableStream({
          async start(controller) {
            const frames = await streamPromise;
            for (const frame of frames) {
              controller.enqueue(encoder.encode(frame));
            }
            controller.close();
          },
        }),
      });
      vi.stubGlobal('fetch', fn);

      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn risk survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      // While stream is open: button shows "Building…"
      await waitFor(() => {
        expect(screen.getByText('Building…')).toBeInTheDocument();
      });

      // Unblock the stream
      resolveStream(makeHappySseFrames());
    });

    it('POSTs to the composeStream endpoint with brief in the body', async () => {
      const fetchMock = mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'B2B SaaS churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRES.composeStream);
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      // The body must contain the brief — this is what the component contributed, not the mock
      expect(body.brief).toBe('B2B SaaS churn survey');
    });

    it('includes title in the POST body when the admin fills it in', async () => {
      const fetchMock = mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.type(
        screen.getByPlaceholderText('e.g. Churn-risk onboarding survey'),
        'My Survey Title'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.title).toBe('My Survey Title');
    });

    it('omits title from the POST body when the title field is left blank', async () => {
      const fetchMock = mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('title');
    });

    it('renders section titles from the outline event in the preview', async () => {
      mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      // After outline event: section titles appear
      await waitFor(() => {
        expect(screen.getByText('Background')).toBeInTheDocument();
        expect(screen.getByText('Satisfaction')).toBeInTheDocument();
      });
    });

    it('renders the goal text from the outline event', async () => {
      mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByText('Understand churn risk')).toBeInTheDocument();
      });
    });

    it('renders question prompts after section_done events', async () => {
      mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByText('What is your role?')).toBeInTheDocument();
        expect(screen.getByText('How satisfied are you?')).toBeInTheDocument();
      });
    });

    it('transitions to ready phase after the done event and shows refine panel', async () => {
      mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      // After done: Generate button gone, refine panel appears
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument();
        expect(screen.getByText('Refine it')).toBeInTheDocument();
      });
    });

    it('shows "Open in editor" button in the ready phase', async () => {
      mockSseStream({ frames: makeHappySseFrames() });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /open in editor/i })).toBeInTheDocument();
      });
    });
  });

  // ── Error states ───────────────────────────────────────────────────────────

  describe('error states', () => {
    it('shows the server error message and returns to brief phase on non-ok response', async () => {
      mockSseError('Feature flag disabled', 403);
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Some brief'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByText('Feature flag disabled')).toBeInTheDocument();
        // Returns to brief phase: Generate button is back
        expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument();
      });
    });

    it('shows a fallback error on non-ok response when the body has no error.message', async () => {
      const fn = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        body: null,
        json: async () => ({ success: false }),
      });
      vi.stubGlobal('fetch', fn);
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Some brief'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByText('Generation failed (500). Try again.')).toBeInTheDocument();
      });
    });

    it('shows an error when the stream ends without a done event', async () => {
      // Stream with only outline but no done
      const frames = [
        sseFrame('outline', {
          type: 'outline',
          sections: [{ ordinal: 0, title: 'Section A' }],
        }),
      ];
      mockSseStream({ frames });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Incomplete survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByText('Generation did not complete. Try again.')).toBeInTheDocument();
      });
    });

    it('shows the error message from the stream-level error event', async () => {
      const frames = [
        sseFrame('error', {
          type: 'error',
          code: 'PROVIDER_UNAVAILABLE',
          message: 'AI provider is offline.',
        }),
      ];
      mockSseStream({ frames });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Failing survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByText('AI provider is offline.')).toBeInTheDocument();
      });
    });

    it('shows a generic error when fetch itself throws (network failure)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Any brief'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Could not compose the questionnaire. Try again.')
        ).toBeInTheDocument();
      });
    });

    it('shows the section_error message in the preview', async () => {
      const frames = [
        sseFrame('outline', {
          type: 'outline',
          sections: [{ ordinal: 0, title: 'Problem section' }],
        }),
        sseFrame('section_error', {
          type: 'section_error',
          ordinal: 0,
          title: 'Problem section',
          message: 'Section AI call timed out',
        }),
        // No done event — stays in streaming phase (no done → incomplete error)
      ];
      mockSseStream({ frames });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Survey with error'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() => {
        expect(screen.getByText('Section AI call timed out')).toBeInTheDocument();
      });
    });
  });

  // ── Refine panel ───────────────────────────────────────────────────────────

  describe('refine panel (ready phase)', () => {
    /** Helper: render → generate → reach ready phase. */
    async function reachReadyPhase(questionnaireId = 'qn-1', versionId = 'v-1') {
      mockSseStream({ frames: makeHappySseFrames(questionnaireId, versionId) });
      const user = userEvent.setup();
      render(<ComposeStudio />);
      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Churn survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));
      await waitFor(() => expect(screen.getByText('Refine it')).toBeInTheDocument());
      return user;
    }

    it('disables the Apply change button when the instruction textarea is empty', async () => {
      await reachReadyPhase();
      expect(screen.getByRole('button', { name: /apply change/i })).toBeDisabled();
    });

    it('enables the Apply change button when the instruction has text', async () => {
      const user = await reachReadyPhase();
      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Add a section on pricing');
      expect(screen.getByRole('button', { name: /apply change/i })).toBeEnabled();
    });

    it('POSTs the instruction to the composeRefine endpoint with the correct ids', async () => {
      const user = await reachReadyPhase('qn-42', 'v-7');
      mockRefineSuccess();

      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Make it shorter');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        expect(vi.mocked(global.fetch)).toHaveBeenLastCalledWith(
          API.APP.QUESTIONNAIRES.composeRefine('qn-42', 'v-7'),
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          })
        );
      });

      const [, init] = (vi.mocked(global.fetch).mock.calls.at(-1) ?? []) as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.instruction).toBe('Make it shorter');
    });

    it('renders the refine summary in the chat list after a successful refine', async () => {
      const user = await reachReadyPhase();
      mockRefineSuccess('Shortened to 2 sections with focused questions.');

      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Shorten it');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Shortened to 2 sections with focused questions.')
        ).toBeInTheDocument();
      });
    });

    it('shows the instruction text in the chat history', async () => {
      const user = await reachReadyPhase();
      mockRefineSuccess();

      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Add a pricing section');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        // The component uses &ldquo;/&rdquo; (curly quotes) around the instruction
        expect(screen.getByText('“Add a pricing section”')).toBeInTheDocument();
      });
    });

    it('clears the instruction textarea after a successful refine', async () => {
      const user = await reachReadyPhase();
      mockRefineSuccess();

      const textarea = screen.getByPlaceholderText(/make it shorter/i);
      await user.type(textarea, 'Shorten it');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        expect(textarea).toHaveValue('');
      });
    });

    it('updates the preview sections from the refine response structure', async () => {
      const user = await reachReadyPhase();
      mockRefineSuccess('Done.', {
        sections: [{ ordinal: 0, title: 'Refined Section', description: undefined }],
        questions: [
          {
            sectionOrdinal: 0,
            key: 'r1',
            prompt: 'New refined question?',
            suggestedType: 'free_text',
          },
        ],
        goal: 'Refined goal',
      });

      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Refine');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        // The component rebuilt the preview from the refine response — not from the original stream data
        expect(screen.getByText('Refined Section')).toBeInTheDocument();
        expect(screen.getByText('New refined question?')).toBeInTheDocument();
      });
    });

    it('submits the instruction with Cmd+Enter keyboard shortcut', async () => {
      const user = await reachReadyPhase();
      mockRefineSuccess('Done via keyboard.');

      const textarea = screen.getByPlaceholderText(/make it shorter/i);
      await user.type(textarea, 'Make it shorter');
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      await waitFor(() => {
        expect(screen.getByText('Done via keyboard.')).toBeInTheDocument();
      });
    });

    it('submits the instruction with Ctrl+Enter keyboard shortcut', async () => {
      const user = await reachReadyPhase();
      mockRefineSuccess('Done via ctrl+enter.');

      const textarea = screen.getByPlaceholderText(/make it shorter/i);
      await user.type(textarea, 'Another instruction');
      await user.keyboard('{Control>}{Enter}{/Control}');

      await waitFor(() => {
        expect(screen.getByText('Done via ctrl+enter.')).toBeInTheDocument();
      });
    });

    it('disables the Apply change button while refining is in progress', async () => {
      const user = await reachReadyPhase();

      // Fetch that doesn't resolve immediately
      let resolveRefine!: () => void;
      const fn = vi.fn().mockReturnValue(
        new Promise<object>((res) => {
          resolveRefine = () =>
            res({
              ok: true,
              status: 200,
              json: async () => ({
                success: true,
                data: {
                  summary: 'Done',
                  sectionCount: 1,
                  questionCount: 1,
                  structure: {
                    sections: [{ ordinal: 0, title: 'S1' }],
                    questions: [],
                  },
                },
              }),
            });
        })
      );
      vi.stubGlobal('fetch', fn);

      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Shorten it');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /apply change/i })).toBeDisabled();
      });

      resolveRefine();
    });

    it('shows an error message when the refine POST returns an error', async () => {
      const user = await reachReadyPhase();
      mockRefineError('You have exceeded your refine quota.');

      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Change something');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        expect(screen.getByText('You have exceeded your refine quota.')).toBeInTheDocument();
      });
    });

    it('shows a fallback error when the refine fetch rejects (network failure)', async () => {
      const user = await reachReadyPhase();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

      await user.type(screen.getByPlaceholderText(/make it shorter/i), 'Change something');
      await user.click(screen.getByRole('button', { name: /apply change/i }));

      await waitFor(() => {
        expect(screen.getByText('Could not apply that change. Try again.')).toBeInTheDocument();
      });
    });
  });

  // ── Open in editor ─────────────────────────────────────────────────────────

  describe('"Open in editor" navigation', () => {
    it('navigates to the structure editor URL with the ids from the done event', async () => {
      mockSseStream({ frames: makeHappySseFrames('qn-99', 'v-55') });
      const user = userEvent.setup();
      render(<ComposeStudio />);

      await user.type(
        screen.getByPlaceholderText('Describe the questionnaire you want to build…'),
        'Final survey'
      );
      await user.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /open in editor/i })).toBeInTheDocument()
      );
      await user.click(screen.getByRole('button', { name: /open in editor/i }));

      expect(mockPush).toHaveBeenCalledWith('/admin/questionnaires/qn-99/v/v-55/structure');
    });
  });
});
