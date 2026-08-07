/**
 * SessionWorkspace — the chat + answer-panel split-screen wiring (F7.2).
 *
 * All three hooks and the children are mocked so the test pins SessionWorkspace's OWN
 * responsibilities, not theirs: that the single stream is created with `onTurnSettled`
 * fanning out to BOTH the panel refetch and the lifecycle refetch (F7.3), that the
 * panel's view/loading and the stream's `canSend` are threaded down, that the lifecycle
 * `applyStatus` is wired to the shared stream, and that the Revisit handler sends a
 * correctly-phrased turn through the shared stream only when sending is allowed.
 *
 * @see components/app/questionnaire/session-workspace.tsx
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { useRouter } from 'next/navigation';

import type { PanelSlotView, DataSlotPanelSlot } from '@/lib/app/questionnaire/panel/types';
import { CHAT_TEXT_SCALE_STORAGE_KEY } from '@/lib/app/questionnaire/chat/text-scale';

const sendMessage = vi.fn();
const applyStatus = vi.fn();
const kickoff = vi.fn();
const refetch = vi.fn();
const lifecycleRefetch = vi.fn();

const formRefresh = vi.fn();
const formSetValue = vi.fn();

const streamHook = vi.fn();
const panelHook = vi.fn();
const lifecycleHook = vi.fn();
const formHook = vi.fn();

vi.mock('@/lib/hooks/use-questionnaire-session-stream', () => ({
  useQuestionnaireSessionStream: (opts: unknown) => streamHook(opts),
}));
vi.mock('@/lib/hooks/use-answer-panel', () => ({
  useAnswerPanel: (opts: unknown) => panelHook(opts),
}));
vi.mock('@/lib/hooks/use-session-lifecycle', () => ({
  useSessionLifecycle: (opts: unknown) => lifecycleHook(opts),
}));
vi.mock('@/lib/hooks/use-form-answers', () => ({
  useFormAnswers: (opts: unknown) => formHook(opts),
}));
vi.mock('@/components/app/questionnaire/form/questionnaire-form', () => ({
  QuestionnaireForm: () => <div data-testid="form" />,
}));
// Capture-gate stub surfaces `onSubmitted` as a button so the gate-advance/kickoff-release tests can
// drive it without rendering the real form (RHF + fetch).
vi.mock('@/components/app/questionnaire/profile/profile-capture-gate', () => ({
  ProfileCaptureGate: ({ onSubmitted }: { onSubmitted: () => void }) => (
    <div data-testid="capture-gate">
      <button type="button" onClick={onSubmitted}>
        capture-submit
      </button>
    </div>
  ),
}));
// Persona-picker stub surfaces `onContinue` so the capture→persona kickoff-defer test can advance the
// carousel past the picker without the real component.
vi.mock('@/components/app/questionnaire/persona/persona-picker', () => ({
  PersonaPicker: ({ onContinue }: { onContinue: () => void }) => (
    <div data-testid="persona-picker">
      <button type="button" onClick={onContinue}>
        persona-continue
      </button>
    </div>
  ),
}));
// In-chat interviewer switcher (indicator/both modes) — the chip surfaces the workspace's
// `onChangeInterviewer` handler, and the modal surfaces `choosePersona` directly (the same
// PATCH-sending callback the carousel picker uses) so both can be driven without the real
// PersonaPicker grid.
vi.mock('@/components/app/questionnaire/persona/interviewer-switcher', () => ({
  CurrentInterviewerChip: ({ label, onChange }: { label: string; onChange: () => void }) => (
    <button type="button" onClick={onChange} data-testid="interviewer-chip">
      {label}
    </button>
  ),
  PersonaSwitcherModal: ({ open, onChoose }: { open: boolean; onChoose: (key: string) => void }) =>
    open ? (
      <div data-testid="persona-switcher-modal">
        <button type="button" onClick={() => onChoose('b')}>
          switcher-choose-b
        </button>
      </div>
    ) : null,
}));

// Chat + lifecycle children are irrelevant here — marker stubs keep the render cheap. The chat
// stub surfaces `readOnly` so the read-only-mode tests can assert it's threaded through.
vi.mock('@/components/app/questionnaire/chat/questionnaire-chat', () => ({
  QuestionnaireChat: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="chat" data-read-only={String(Boolean(readOnly))} />
  ),
}));
// Lifecycle-bar stub surfaces the Pause/Resume handlers as buttons so the test can verify
// the workspace wires them to the hook's actions.
vi.mock('@/components/app/questionnaire/lifecycle/session-lifecycle-bar', () => ({
  SessionLifecycleBar: ({
    onPause,
    onResume,
    trailing,
  }: {
    onPause: () => void;
    onResume: () => void;
    trailing?: ReactNode;
  }) => (
    <div data-testid="lifecycle-bar">
      <button type="button" onClick={onPause}>
        bar-pause
      </button>
      <button type="button" onClick={onResume}>
        bar-resume
      </button>
      {/* The mode toggle is passed here as `trailing` — render it so the test can drive it. */}
      {trailing}
    </div>
  ),
}));
// Completion-offer stub surfaces the Submit handler as a button (same reason).
vi.mock('@/components/app/questionnaire/lifecycle/completion-offer', () => ({
  CompletionOffer: ({ onSubmit }: { onSubmit: () => void }) => (
    <div data-testid="completion-offer">
      <button type="button" onClick={onSubmit}>
        offer-submit
      </button>
    </div>
  ),
}));
// Early-finish-control stub surfaces the Finish handler as a button (same reason).
vi.mock('@/components/app/questionnaire/lifecycle/early-finish-control', () => ({
  EarlyFinishControl: ({ onFinish }: { onFinish: () => void }) => (
    <div data-testid="early-finish-control">
      <button type="button" onClick={onFinish}>
        early-finish
      </button>
    </div>
  ),
}));
vi.mock('@/components/app/questionnaire/lifecycle/session-complete', () => ({
  SessionComplete: () => <div data-testid="session-complete" />,
}));
// Final-check modal stub surfaces `onClarify` / `onFinishAnyway` as buttons so the held-probe
// escape-hatch wiring can be driven without the real Dialog.
vi.mock('@/components/app/questionnaire/lifecycle/final-check-modal', () => ({
  FinalCheckModal: ({
    open,
    probeText,
    onClarify,
    onFinishAnyway,
  }: {
    open: boolean;
    probeText: string;
    onClarify: () => void;
    onFinishAnyway: () => void;
  }) =>
    open ? (
      <div data-testid="final-check-modal" data-probe-text={probeText}>
        <button type="button" onClick={onClarify}>
          final-check-clarify
        </button>
        <button type="button" onClick={onFinishAnyway}>
          final-check-finish-anyway
        </button>
      </div>
    ) : null,
}));
// Experiences continuity (P15.3): stubbed so `onContinue` / `onConclude` — the workspace's OWN
// navigate-vs-refresh decision, not the handoff polling machinery (covered by
// handoff-card.test.tsx / stitched-continuation.test.tsx) — are directly drivable as buttons.
vi.mock('@/components/app/questionnaire/experiences/handoff-card', () => ({
  HandoffCard: ({
    onContinue,
    onConclude,
  }: {
    onContinue: (sessionId: string) => void;
    onConclude: () => void;
  }) => (
    <div data-testid="handoff-card">
      <button type="button" onClick={() => onContinue('s2')}>
        handoff-continue
      </button>
      <button type="button" onClick={onConclude}>
        handoff-conclude
      </button>
    </div>
  ),
}));
vi.mock('@/components/app/questionnaire/experiences/stitched-continuation', () => ({
  StitchedContinuation: ({ onContinue }: { onContinue: (sessionId: string) => void }) => (
    <div data-testid="stitched-continuation">
      <button type="button" onClick={() => onContinue('s2')}>
        stitched-continue
      </button>
    </div>
  ),
}));
// The stitched-history fetch is irrelevant to onContinue/onConclude wiring; null keeps the
// stitched surface (when exercised) from making a real, unmocked fetch call.
vi.mock('@/lib/hooks/use-stitched-history', () => ({
  useStitchedHistory: vi.fn(() => null),
}));

// Panel stub exposes the props the workspace controls + buttons that fire onRevisit/onRefine.
vi.mock('@/components/app/questionnaire/panel/answer-slot-panel', () => ({
  AnswerSlotPanel: ({
    loading,
    canRevisit,
    onRevisit,
    onRefine,
    newlyFilledKeys,
  }: {
    loading: boolean;
    canRevisit: boolean;
    onRevisit: (slot: PanelSlotView) => void;
    onRefine?: (slot: DataSlotPanelSlot) => void;
    newlyFilledKeys?: readonly string[];
  }) => (
    <div
      data-testid="panel"
      data-loading={String(loading)}
      data-can-revisit={String(canRevisit)}
      data-newly-filled={(newlyFilledKeys ?? []).join(',')}
    >
      <button type="button" onClick={() => onRevisit(SLOT)}>
        revisit
      </button>
      <button type="button" onClick={() => onRefine?.(DATA_SLOT)}>
        refine
      </button>
      <button type="button" onClick={() => onRefine?.(DATA_SLOT_UNFILLED)}>
        refine-unfilled
      </button>
    </div>
  ),
}));
// Drawer stub surfaces `onRevisit` / `onRefine` directly as buttons — the workspace's OWN
// wiring (which callback it hands the drawer, and whether it closes the sheet after) is what's
// under test here; the real Radix Dialog behaviour is covered by answer-review-drawer.test.tsx.
vi.mock('@/components/app/questionnaire/panel/answer-review-drawer', () => ({
  AnswerReviewDrawer: ({
    open,
    onRevisit,
    onRefine,
  }: {
    open: boolean;
    onRevisit: (slot: PanelSlotView) => void;
    onRefine?: (slot: DataSlotPanelSlot) => void;
  }) =>
    open ? (
      <div role="dialog">
        <div data-testid="panel">
          <button type="button" onClick={() => onRevisit(SLOT)}>
            revisit
          </button>
          <button type="button" onClick={() => onRefine?.(DATA_SLOT)}>
            drawer-refine
          </button>
        </div>
      </div>
    ) : null,
}));

import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';

const SLOT: PanelSlotView = {
  slotKey: 'budget',
  prompt: 'What is your budget?',
  type: 'free_text',
  typeConfig: null,
  required: true,
  answered: true,
  value: '£10k',
  provenance: 'direct',
  confidence: 0.8,
  rationale: null,
  answeredAtTurnIndex: 2,
  respondentEdited: false,
  refinementHistory: [],
};

const DATA_SLOT: DataSlotPanelSlot = {
  key: 'goal',
  name: 'Goal',
  description: 'What they want to achieve',
  paraphrase: 'Grow revenue 20% this year',
  provenance: 'direct',
  confidence: 0.8,
  rationale: null,
  filled: true,
  provisional: false,
  answeredAtTurnIndex: 2,
  history: [],
  coverage: { total: 1, answered: 1, questions: [] },
};

// No captured reading yet — pins the ternary branch in `handleRefine` that omits the
// "Right now you have it as" clause when there's nothing to quote.
const DATA_SLOT_UNFILLED: DataSlotPanelSlot = {
  ...DATA_SLOT,
  paraphrase: null,
  filled: false,
  confidence: null,
};

function lifecycleReturn(over: Record<string, unknown> = {}) {
  return {
    view: null,
    loading: false,
    busy: false,
    actionError: null,
    canSubmit: false,
    canFinishEarly: false,
    canPause: false,
    canResume: false,
    refetch: lifecycleRefetch,
    pause: vi.fn(),
    resume: vi.fn(),
    submit: vi.fn(),
    finishEarly: vi.fn(),
    ...over,
  };
}

function setup(
  streamOver: Record<string, unknown> = {},
  panelOver: Record<string, unknown> = {},
  lifecycleOver: Record<string, unknown> = {}
) {
  streamHook.mockReturnValue({
    canSend: true,
    status: 'idle',
    sendMessage,
    kickoff,
    applyStatus,
    ...streamOver,
  });
  panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch, ...panelOver });
  lifecycleHook.mockReturnValue(lifecycleReturn(lifecycleOver));
  // Pin chat mode so these mode-agnostic tests render a single surface; the default is now
  // 'both' (which renders chat + form together). Mode-specific tests override per render.
  render(<SessionWorkspace sessionId="s1" presentationMode="chat" />);
}

function formReturn(over: Record<string, unknown> = {}) {
  return {
    view: null,
    loading: false,
    error: false,
    values: {},
    statuses: {},
    setValue: formSetValue,
    flush: vi.fn(),
    refresh: formRefresh,
    // Mirror the rest of the real useFormAnswers shape the workspace threads into QuestionnaireForm
    // (editedKeys / saveState / lastSavedAt) so the mock can't silently drift from the hook's API.
    editedKeys: new Set<string>(),
    saveState: 'idle' as const,
    lastSavedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The text-size preference is a real localStorage write, so clear it between tests or a stepped
  // size leaks into the next case.
  window.localStorage.clear();
  // Sensible defaults so a render in any mode doesn't crash; mode tests override as needed.
  streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, kickoff, applyStatus });
  panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
  lifecycleHook.mockReturnValue(lifecycleReturn());
  formHook.mockReturnValue(formReturn());
  // `vi.clearAllMocks()` clears call history but NOT a previously-set `mockReturnValue`, so without
  // resetting this here, a router assertion set by one test (the onContinue suite) would silently
  // leak into every later test. Fresh spies every test; the onContinue tests override with their
  // own push/refresh so they can assert on them.
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

describe('SessionWorkspace', () => {
  it('fans onTurnSettled out to BOTH the panel and lifecycle refetches', () => {
    setup();
    const opts = streamHook.mock.calls[0][0];
    // It's a combined closure now (refs set in an effect), not the panel refetch directly.
    expect(typeof opts.onTurnSettled).toBe('function');
    opts.onTurnSettled();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(lifecycleRefetch).toHaveBeenCalledTimes(1);
  });

  it('wires the lifecycle hook to the shared stream applyStatus', () => {
    setup();
    expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ applyStatus });
  });

  it('refreshes the lifecycle when the form reports a save (onSaved)', () => {
    // A form save must re-pull the status so coverage / submit-readiness reflect the new answer.
    render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
    const opts = formHook.mock.calls[0][0] as { onSaved?: () => void };
    expect(typeof opts.onSaved).toBe('function');
    opts.onSaved?.();
    expect(lifecycleRefetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-fire the kickoff when autoStart is off (the default)', () => {
    setup();
    expect(kickoff).not.toHaveBeenCalled();
  });

  it('fires the kickoff exactly once on mount when autoStart is set', () => {
    streamHook.mockReturnValue({
      canSend: true,
      status: 'idle',
      sendMessage,
      kickoff,
      applyStatus,
    });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());

    const { rerender } = render(<SessionWorkspace sessionId="s1" autoStart />);
    // A re-render with unchanged state must NOT fire a second kickoff (the effect deps —
    // status + turn count — are stable, so it does not re-run).
    rerender(<SessionWorkspace sessionId="s1" autoStart />);

    expect(kickoff).toHaveBeenCalledTimes(1);
  });

  it('re-fires the kickoff after a StrictMode abort (idle again with no question), then stops once a question arrives', () => {
    const greeting = [{ role: 'assistant', content: 'Welcome' }];
    const withQuestion = [...greeting, { role: 'assistant', content: 'Q1?' }];
    const base = { canSend: true, sendMessage, kickoff, applyStatus };
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());

    // 1) Fresh + idle + only the greeting → fire the opening kickoff.
    streamHook.mockReturnValue({ ...base, status: 'idle', turns: greeting });
    const { rerender } = render(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(1);

    // 2) Kickoff in flight (streaming) → no duplicate.
    streamHook.mockReturnValue({ ...base, status: 'streaming', turns: greeting });
    rerender(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(1);

    // 3) StrictMode aborted it: status recovered to idle, still only the greeting → re-fire.
    streamHook.mockReturnValue({ ...base, status: 'idle', turns: greeting });
    rerender(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(2);

    // 4) The first question landed (turns grew past the greeting) → never fire again.
    streamHook.mockReturnValue({ ...base, status: 'idle', turns: withQuestion });
    rerender(<SessionWorkspace sessionId="s1" autoStart />);
    expect(kickoff).toHaveBeenCalledTimes(2);
  });

  // ── Intro carousel surface (deferred kickoff) ────────────────────────────────
  describe('intro surface', () => {
    const intro = {
      enabled: true,
      questionnaireTitle: 'Team Health Check',
      background: '',
      videoUrl: '',
      copy: {
        howItWorks: { heading: 'How it works', body: 'This is a conversation, not a form.' },
        whatYouGet: null,
        goodToKnow: [],
        buttonLabel: 'Begin your conversation',
      },
    };

    it('lands on the Intro surface and DEFERS the kickoff while it shows', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" autoStart intro={intro} />);

      // Intro is the active tab, and the opening turn has NOT been spent yet.
      expect(screen.getByRole('tab', { name: 'Intro' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Form' })).toBeInTheDocument();
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('fires the kickoff once the respondent leaves the intro', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" autoStart intro={intro} />);
      expect(kickoff).not.toHaveBeenCalled();

      // Sliding to Chat marks the session started, releasing the deferred opening turn.
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('on a resume (autoStart off) keeps the Intro tab but lands on the conversation, no kickoff', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" intro={intro} />);
      // The recap is still reachable (slide-back), but we open on chat and never fire the opening turn.
      expect(screen.getByRole('tab', { name: 'Intro' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('weaves an Intro toggle into a chat-only session (no form) and defers the kickoff', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" autoStart intro={intro} />);
      // chat-only normally has no toggle; the intro adds an Intro↔Chat one.
      expect(screen.getByRole('tab', { name: 'Intro' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Form' })).not.toBeInTheDocument();
      expect(kickoff).not.toHaveBeenCalled();
    });
  });

  // ── Capture gate (blocking pre-chat form; F-capture) ─────────────────────────
  describe('capture gate', () => {
    const captureForm = (over: Record<string, unknown> = {}) => ({
      captureMode: 'form' as const,
      formFields: [
        {
          key: 'name',
          label: 'Name',
          type: 'text' as const,
          required: true,
          validation: 'deterministic' as const,
        },
      ],
      satisfied: false,
      ...over,
    });

    const setStreamIdle = () =>
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });

    const personasFixture = {
      enabled: true,
      personas: [
        { key: 'a', label: 'Ana', description: 'da' },
        { key: 'b', label: 'Bo', description: 'db' },
      ],
      selectedPersonaKey: null,
      defaultPersonaKey: 'a',
      switcher: 'page' as const,
    };

    it('lands ON the Details gate (active surface) on a fresh session and DEFERS the kickoff', () => {
      setStreamIdle();
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="chat"
          autoStart
          capture={captureForm()}
        />
      );
      // The gate is the ACTIVE carousel surface (its tabpanel is not inert), not merely mounted — the
      // carousel renders every surface, so presence alone wouldn't prove we landed on it.
      const capturePanel = screen.getByRole('tabpanel', { name: 'Details' });
      expect(capturePanel).not.toHaveAttribute('inert');
      expect(within(capturePanel).getByTestId('capture-gate')).toBeInTheDocument();
      // The opening turn has NOT been spent yet.
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('blocks forward keyboard/swipe nav past the unsubmitted gate (stays on Details)', () => {
      setStreamIdle();
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="both"
          autoStart
          capture={captureForm()}
        />
      );
      // ArrowRight would advance the carousel — but the blocking gate forbids moving past it.
      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      const capturePanel = screen.getByRole('tabpanel', { name: 'Details' });
      expect(capturePanel).not.toHaveAttribute('inert'); // still the active surface
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('with a persona picker after it, submitting capture lands on the picker and STILL defers the kickoff', () => {
      // Regression: releasing the kickoff on submit would stream the opening turn behind the persona
      // picker with the DEFAULT persona. `started` must stay false until the respondent leaves the picker.
      setStreamIdle();
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="chat"
          autoStart
          capture={captureForm()}
          personas={personasFixture}
        />
      );
      expect(kickoff).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('capture-submit'));
      // Advanced to the persona picker — not the chat — and the opening turn is STILL deferred.
      expect(screen.getByTestId('persona-picker')).toBeInTheDocument();
      expect(kickoff).not.toHaveBeenCalled();

      // Leaving the picker for the chat finally releases the kickoff (now with the chosen persona in place).
      fireEvent.click(screen.getByText('persona-continue'));
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('fires the kickoff only after the gate is submitted', () => {
      setStreamIdle();
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="chat"
          autoStart
          capture={captureForm()}
        />
      );
      expect(kickoff).not.toHaveBeenCalled();
      // Submitting the gate advances to the chat and releases the deferred opening turn.
      fireEvent.click(screen.getByText('capture-submit'));
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('suppresses the surface toggle while the blocking gate is open (no skip)', () => {
      setStreamIdle();
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="both"
          autoStart
          capture={captureForm()}
        />
      );
      // The toggle would otherwise offer a one-tap skip past required details.
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
      // Once submitted, the toggle returns.
      fireEvent.click(screen.getByText('capture-submit'));
      expect(screen.getAllByRole('tab').length).toBeGreaterThan(0);
    });

    it('skips the gate when the capture is already satisfied (resume)', () => {
      setStreamIdle();
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="chat"
          autoStart
          capture={captureForm({ satisfied: true })}
        />
      );
      expect(screen.queryByTestId('capture-gate')).not.toBeInTheDocument();
      // No gate → the kickoff fires immediately.
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('never shows the gate when there is no form subset (all-conversational version)', () => {
      // A pure-conversational version (or the conversational half of a hybrid) resolves to an empty
      // `formFields` subset — the interviewer gathers those fields in-chat, so the gate is absent and
      // the kickoff fires immediately. `captureMode` is only a default-placement hint here.
      setStreamIdle();
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="chat"
          autoStart
          capture={captureForm({ captureMode: 'conversational', formFields: [] })}
        />
      );
      expect(screen.queryByTestId('capture-gate')).not.toBeInTheDocument();
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('never shows the gate for an anonymous version (capture null)', () => {
      setStreamIdle();
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" autoStart capture={null} />);
      expect(screen.queryByTestId('capture-gate')).not.toBeInTheDocument();
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('is never shown in the read-only admin viewer', () => {
      setStreamIdle();
      render(<SessionWorkspace sessionId="s1" readOnly capture={captureForm()} />);
      expect(screen.queryByTestId('capture-gate')).not.toBeInTheDocument();
    });
  });

  it('threads the session id and access token into all three hooks', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    render(<SessionWorkspace sessionId="s1" accessToken="tok-9" />);

    expect(panelHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
    expect(streamHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
    expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ sessionId: 's1', accessToken: 'tok-9' });
  });

  it('seeds useAnswerPanel with the SSR-resolved initialPanel view', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    const seed = {
      status: 'active' as const,
      scope: 'full_progress' as const,
      sections: [],
      answeredCount: 0,
      totalCount: 0,
    };
    render(<SessionWorkspace sessionId="s1" initialPanel={seed} />);

    expect(panelHook.mock.calls[0][0]).toMatchObject({ initialView: seed });
  });

  it('seeds useSessionLifecycle with the SSR-resolved initialStatusView', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    const statusSeed = {
      status: 'active' as const,
      completion: {
        kind: 'offer' as const,
        coverage: 0.9,
        displayCoverage: 0.9,
        answeredCount: 3,
        requiredUnansweredKeys: [],
        capReached: false,
        earlyFinishAvailable: false,
      },
      cost: null,
      anonymous: false,
      ref: null,
      experience: null,
    };
    render(<SessionWorkspace sessionId="s1" initialStatusView={statusSeed} />);

    expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ initialView: statusSeed });
  });

  it('seeds the stream hook with the SSR-resolved initialStatus', () => {
    streamHook.mockReturnValue({ canSend: true, status: 'idle', sendMessage, applyStatus });
    panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    render(<SessionWorkspace sessionId="s1" initialStatus="not_active" />);

    expect(streamHook.mock.calls[0][0]).toMatchObject({ initialStatus: 'not_active' });
  });

  it('passes the panel loading state and stream canSend down to the panel', () => {
    setup({ canSend: false }, { loading: true });
    const panel = screen.getByTestId('panel');
    expect(panel).toHaveAttribute('data-loading', 'true');
    expect(panel).toHaveAttribute('data-can-revisit', 'false');
  });

  it('diffs panel snapshots and passes the newly-filled data-slot keys down (seeding silently first)', () => {
    // A data-slot view where `goal` is unfilled.
    const before = {
      status: 'active' as const,
      scope: 'full_progress' as const,
      sections: [],
      answeredCount: 0,
      totalCount: 0,
      dataSlotGroups: [
        {
          theme: 'Goals',
          slots: [
            {
              key: 'goal',
              name: 'Goal',
              description: '',
              paraphrase: null,
              provenance: null,
              confidence: null,
              rationale: null,
              filled: false,
              provisional: false,
              answeredAtTurnIndex: null,
              history: [],
            },
          ],
        },
      ],
      progressPercent: 0,
    };
    streamHook.mockReturnValue({
      canSend: true,
      status: 'idle',
      sendMessage,
      kickoff,
      applyStatus,
    });
    lifecycleHook.mockReturnValue(lifecycleReturn());
    panelHook.mockReturnValue({ view: before, loading: false, error: false, refetch });
    const { rerender } = render(<SessionWorkspace sessionId="s1" />);
    // First snapshot only seeds the diff baseline — nothing is announced as newly filled.
    expect(screen.getByTestId('panel')).toHaveAttribute('data-newly-filled', '');

    // The turn fills `goal`.
    const after = {
      ...before,
      dataSlotGroups: [
        {
          theme: 'Goals',
          slots: [{ ...before.dataSlotGroups[0].slots[0], filled: true, answeredAtTurnIndex: 2 }],
        },
      ],
    };
    panelHook.mockReturnValue({ view: after, loading: false, error: false, refetch });
    rerender(<SessionWorkspace sessionId="s1" />);
    expect(screen.getByTestId('panel')).toHaveAttribute('data-newly-filled', 'goal');
  });

  it('sends a revisit turn through the shared stream when sending is allowed', () => {
    setup({ canSend: true });
    fireEvent.click(screen.getByText('revisit'));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "I'd like to revisit my answer to: What is your budget?"
    );
  });

  it('ignores Revisit while the stream cannot send', () => {
    setup({ canSend: false });
    fireEvent.click(screen.getByText('revisit'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Chat text size — the PUBLISHING half. The stepper and the transcript live in different
   * subtrees, joined only by the `--cq-chat-scale` custom property this component puts on its
   * root, so these pin the value that property actually carries after a step, a restore, and a
   * corrupt read. QuestionnaireChat is mocked here, so the consuming half (the transcript opting
   * in via `.cq-chat-scale`) is asserted in `chat/questionnaire-chat.test.tsx` instead.
   */
  describe('chat text size', () => {
    /**
     * The div carrying the custom property. Queried by its own testid rather than by climbing to the
     * nearest styled ancestor — that climb silently retargets to any styled wrapper introduced
     * between the bar and the root, and the resulting `''` reads as a real value.
     */
    const scaleRoot = () => screen.getByTestId('workspace-scale-root');
    const scale = () => scaleRoot().style.getPropertyValue('--cq-chat-scale');

    it('publishes the default scale so an untouched session renders unchanged', () => {
      setup();
      expect(scale()).toBe('1');
    });

    it('raises the scale exactly one rung when the respondent steps up', () => {
      setup();
      fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }));
      // Index 1 → 2, i.e. 1.15. Pinned exactly: a broken step that jumped to the top of the ladder
      // would still be "larger", so a comparison would pass on the wrong value.
      expect(scale()).toBe('1.15');
    });

    it('writes the chosen index to storage', () => {
      setup();
      fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }));
      expect(window.localStorage.getItem(CHAT_TEXT_SCALE_STORAGE_KEY)).toBe('2');
    });

    it('restores a stored preference on mount', () => {
      window.localStorage.setItem(CHAT_TEXT_SCALE_STORAGE_KEY, JSON.stringify(3));
      setup();
      expect(scale()).toBe('1.3');
    });

    it('falls back to the default scale when storage holds something unusable', () => {
      // A stale index from an older ladder. A NaN reaching the calc() would drop the transcript's
      // font-size declaration entirely, so this must resolve to a real number.
      window.localStorage.setItem(CHAT_TEXT_SCALE_STORAGE_KEY, JSON.stringify(99));
      setup();
      expect(scale()).toBe('1');
    });

    it('hides the stepper on the form surface, where there is no transcript to scale', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="form" />);
      expect(screen.queryByRole('button', { name: 'Increase text size' })).toBeNull();
    });
  });

  it('swaps to the completion confirmation (not the chat) once submitted', () => {
    setup({ status: 'completed', canSend: false });
    expect(screen.getByTestId('session-complete')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('shows the completion screen for a reopened completed session, not the "not active" chat', () => {
    // On resume the stream starts idle (no in-session submit fired), so the lifecycle status read
    // is the authority that the session is already done. Without this the surface would drop into
    // the chat and 409 on any send, flashing the "session no longer active" panel.
    setup(
      { status: 'not_active', canSend: false },
      {},
      {
        view: {
          status: 'completed',
          completion: {
            kind: 'offer',
            coverage: 1,
            displayCoverage: 1,
            answeredCount: 6,
            requiredUnansweredKeys: [],
            capReached: false,
            earlyFinishAvailable: false,
          },
          cost: null,
          anonymous: true,
          ref: 'GSP289HB',
        },
      }
    );
    expect(screen.getByTestId('session-complete')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
  });

  it('wires the lifecycle bar Pause/Resume controls to the hook actions', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    setup({}, {}, { canPause: true, canResume: true, pause, resume });

    fireEvent.click(screen.getByText('bar-pause'));
    fireEvent.click(screen.getByText('bar-resume'));

    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('shows the completion offer and wires Submit when the session is submittable', () => {
    const submit = vi.fn();
    setup({}, {}, { canSubmit: true, submit });

    fireEvent.click(screen.getByText('offer-submit'));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('hides the completion offer when the session is not submittable', () => {
    setup({}, {}, { canSubmit: false });
    expect(screen.queryByTestId('completion-offer')).not.toBeInTheDocument();
  });

  it('shows the early-finish control and wires Finish when only the escape hatch is unlocked', () => {
    const finishEarly = vi.fn();
    setup({}, {}, { canSubmit: false, canFinishEarly: true, finishEarly });

    expect(screen.queryByTestId('completion-offer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('early-finish'));
    expect(finishEarly).toHaveBeenCalledTimes(1);
  });

  it('prefers the full submit offer over the early-finish control when both are available', () => {
    setup({}, {}, { canSubmit: true, canFinishEarly: true });
    expect(screen.getByTestId('completion-offer')).toBeInTheDocument();
    expect(screen.queryByTestId('early-finish-control')).not.toBeInTheDocument();
  });

  describe('read-only mode (admin viewer)', () => {
    it('renders only the read-only transcript — no panel, lifecycle bar, completion offer, or form', () => {
      render(<SessionWorkspace sessionId="s1" readOnly />);
      const chat = screen.getByTestId('chat');
      expect(chat).toHaveAttribute('data-read-only', 'true');
      expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('lifecycle-bar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('completion-offer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('form')).not.toBeInTheDocument();
    });

    it('makes the panel, lifecycle, and form hooks inert (enabled: false) — no fetches', () => {
      render(<SessionWorkspace sessionId="s1" readOnly />);
      expect(panelHook.mock.calls[0][0]).toMatchObject({ enabled: false });
      expect(lifecycleHook.mock.calls[0][0]).toMatchObject({ enabled: false });
      expect(formHook.mock.calls[0][0]).toMatchObject({ enabled: false });
    });

    it('shows the conversation (not the completion screen) for a completed session', () => {
      streamHook.mockReturnValue({ canSend: false, status: 'completed', sendMessage, applyStatus });
      render(<SessionWorkspace sessionId="s1" readOnly />);
      expect(screen.getByTestId('chat')).toBeInTheDocument();
      expect(screen.queryByTestId('session-complete')).not.toBeInTheDocument();
    });
  });

  describe('presentation mode (P-presentation)', () => {
    it('chat mode renders chat + panel, no form, and keeps the form hook inert', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" />);
      expect(screen.getByTestId('chat')).toBeInTheDocument();
      expect(screen.getByTestId('panel')).toBeInTheDocument();
      expect(screen.queryByTestId('form')).not.toBeInTheDocument();
      // The form hook is mounted but disabled (no fetch) in chat-only mode.
      expect(formHook.mock.calls[0][0]).toMatchObject({ enabled: false });
    });

    it('form mode renders the form, no chat, and enables the form hook', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="form" />);
      expect(screen.getByTestId('form')).toBeInTheDocument();
      expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
      expect(formHook.mock.calls[0][0]).toMatchObject({ enabled: true });
    });

    it('form mode never fires the chat kickoff even with autoStart', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="form" autoStart />);
      expect(kickoff).not.toHaveBeenCalled();
    });

    it('both mode mounts BOTH surfaces (carousel) with a toggle defaulting to chat', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      // Toggle present and both surfaces are mounted simultaneously (they slide, not mount/unmount).
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(screen.getByTestId('chat')).toBeInTheDocument();
      expect(screen.getByTestId('form')).toBeInTheDocument();
      // Chat is the selected tab by default.
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'false');
    });

    it('toggling to Form selects it and re-seeds the form from the server', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
      expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'true');
      expect(formRefresh).toHaveBeenCalledTimes(1);
    });

    it('toggling back to Chat refetches the panel so it reflects form edits', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(refetch).toHaveBeenCalled();
    });
  });

  describe('mobile "Review answers" drawer', () => {
    const questionView = {
      status: 'active' as const,
      scope: 'full_progress' as const,
      sections: [],
      answeredCount: 3,
      totalCount: 8,
    };
    const dataSlotView = { ...questionView, dataSlotGroups: [], progressPercent: 40 };

    it('renders a mobile-only trigger (lg:hidden) in chat mode', () => {
      setup({}, { view: questionView });
      const trigger = screen.getByRole('button', { name: /review answers/i });
      expect(trigger).toHaveClass('lg:hidden');
    });

    it('omits the trigger in form-only mode (no answer panel there)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="form" />);
      expect(screen.queryByRole('button', { name: /review answers/i })).not.toBeInTheDocument();
    });

    it('labels the trigger "N of M" in question mode', () => {
      setup({}, { view: questionView });
      expect(screen.getByRole('button', { name: 'Review answers, 3 of 8' })).toBeInTheDocument();
    });

    it('labels the trigger by percent in data-slot mode', () => {
      setup({}, { view: dataSlotView });
      expect(
        screen.getByRole('button', { name: 'Review answers, 40% complete' })
      ).toBeInTheDocument();
    });

    it('opens the drawer reusing the workspace panel view — no second fetch hook', () => {
      setup({}, { view: questionView });
      // One panel (the hidden desktop side panel) before the sheet opens.
      expect(screen.getAllByTestId('panel')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

      const dialog = screen.getByRole('dialog');
      // Two panels now — the desktop side panel plus the drawer panel — both fed by the workspace's
      // single useAnswerPanel return value. Reusing the one view (not a second fetch hook) is what
      // lets both render the same data; the drawer mounts no hook of its own.
      expect(screen.getAllByTestId('panel')).toHaveLength(2);
      expect(within(dialog).getByTestId('panel')).toBeInTheDocument();
    });

    it('closes the drawer when a revisit fires from inside it', () => {
      setup({ canSend: true }, { view: questionView });
      fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByText('revisit'));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('keeps the both-mode ModeToggle alongside the trigger', () => {
      panelHook.mockReturnValue({ view: questionView, loading: false, error: false, refetch });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      expect(screen.getByRole('button', { name: /review answers/i })).toBeInTheDocument();
      expect(screen.getAllByRole('tab')).toHaveLength(2);
    });
  });

  // Carousel navigation (F7.x): the surfaces slide between via the swipe/wheel gesture and arrow
  // keys. `both` mode mounts two surfaces (Chat + Form) so there's something to move between; the
  // active surface is reflected by the selected tab.
  describe('carousel navigation (keyboard / wheel / touch)', () => {
    const selected = (name: string) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected');

    it('steps to the next surface on ArrowRight and back on ArrowLeft', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      expect(selected('Chat')).toBe('true');

      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      expect(selected('Form')).toBe('true');
      expect(selected('Chat')).toBe('false');

      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      expect(selected('Chat')).toBe('true');
    });

    it('keeps the slide transition on settled surfaces so non-swipe navigation animates', () => {
      // At rest (no active drag → dragPx 0) every surface carries the transition class, so a tab
      // toggle or arrow-key move slides rather than snapping. Regression guard: gating the transition
      // on `animating` alone dropped it for toggle/keyboard nav (which never call settle()).
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      for (const panel of screen.getAllByRole('tabpanel')) {
        expect(panel.className).toContain('transition-transform');
      }
    });

    it('rubber-bands at the ends — ArrowLeft on the first surface is a no-op', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      expect(selected('Chat')).toBe('true');
    });

    it('ignores arrow keys while typing in a field (the composer owns its caret)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const input = document.createElement('input');
      document.body.appendChild(input);
      // finally so a failed assertion can't leave a focused <input> on document.body, which would
      // corrupt activeElement for the keyboard sibling tests that fire on document.body.
      try {
        input.focus();
        fireEvent.keyDown(input, { key: 'ArrowRight' });
        expect(selected('Chat')).toBe('true'); // unchanged — handed to the field
      } finally {
        input.remove();
      }
    });

    it('ignores arrow keys with a modifier held (browser shortcuts still work)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.keyDown(document.body, { key: 'ArrowRight', metaKey: true });
      expect(selected('Chat')).toBe('true');
    });

    it('ignores non-arrow keys (only ←/→ navigate)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      fireEvent.keyDown(document.body, { key: 'Enter' });
      expect(selected('Chat')).toBe('true');
    });

    it('does not bind arrow navigation in a single-surface mode', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" />);
      // Only one surface — nothing to navigate, and no tablist to flip.
      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
    });

    it('advances on a decisive horizontal wheel burst (trackpad swipe)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const carousel = screen.getAllByRole('tabpanel')[0].parentElement as HTMLElement;
      // Horizontal-dominant burst past the instant-commit trip → forward one surface.
      fireEvent.wheel(carousel, { deltaX: 250, deltaY: 0 });
      expect(selected('Form')).toBe('true');
    });

    it('leaves a vertical-dominant wheel to native scroll (no surface change)', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const carousel = screen.getAllByRole('tabpanel')[0].parentElement as HTMLElement;
      fireEvent.wheel(carousel, { deltaX: 4, deltaY: 120 });
      expect(selected('Chat')).toBe('true');
    });

    it('commits a horizontal touch drag past the threshold', () => {
      render(<SessionWorkspace sessionId="s1" presentationMode="both" />);
      const carousel = screen.getAllByRole('tabpanel')[0].parentElement as HTMLElement;
      const t = (x: number) => ({
        touches: [{ clientX: x, clientY: 200 }],
        changedTouches: [{ clientX: x, clientY: 200 }],
      });
      // Width is unmeasured in jsdom (0 → 320 fallback), so a ~100px leftward drag clears the 20%
      // commit threshold and advances to the next surface.
      fireEvent.touchStart(carousel, t(300));
      fireEvent.touchMove(carousel, t(280));
      fireEvent.touchMove(carousel, t(180));
      fireEvent.touchEnd(carousel, t(180));
      expect(selected('Form')).toBe('true');
    });
  });

  // ── Experiences continuity (P15.3): onContinue / onConclude ──────────────────
  // The docblock above `onContinue` in the source calls this "easy to get silently wrong": the
  // no-login `/x/<publicRef>` surface is already sitting on the address the next leg needs, so
  // continuing must REFRESH; the authenticated surface addresses each session by id, so
  // continuing must NAVIGATE. Getting the arms backwards either strands the anonymous respondent
  // on a completed leg (a no-op push) or leaves the authenticated one on the wrong session.
  describe('Experiences continuity (onContinue / onConclude)', () => {
    const baseExperience = {
      runId: 'run-1',
      ordinal: 0,
      continuityMode: 'linked' as const,
      seamMarker: 'divider' as const,
      stepTitle: 'Step 1',
    };

    // `linked` (not `stitched`) so the completed-leg branch renders HandoffCard — onContinue is
    // the exact same callback handed to StitchedContinuation, so one route is enough to pin it.
    function renderCompletedLeg(experienceOver: Record<string, unknown>, accessToken?: string) {
      streamHook.mockReturnValue({
        canSend: false,
        status: 'completed',
        sendMessage,
        applyStatus,
      });
      panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
      lifecycleHook.mockReturnValue(
        lifecycleReturn({
          view: {
            status: 'completed',
            completion: {
              kind: 'offer',
              coverage: 1,
              displayCoverage: 1,
              answeredCount: 4,
              requiredUnansweredKeys: [],
              capReached: false,
              earlyFinishAvailable: false,
            },
            cost: null,
            anonymous: Boolean(accessToken),
            ref: null,
            experience: { ...baseExperience, ...experienceOver },
          },
        })
      );
      render(<SessionWorkspace sessionId="s1" accessToken={accessToken} />);
    }

    it('on the no-login stable address (publicRef + accessToken), continuing REFRESHES rather than navigates', () => {
      const push = vi.fn();
      const refresh = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
        refresh,
        replace: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
      });

      renderCompletedLeg({ publicRef: 'ABC123' }, 'tok-9');
      expect(screen.getByTestId('handoff-card')).toBeInTheDocument();

      fireEvent.click(screen.getByText('handoff-continue'));

      // The URL for the next leg is already the one in the address bar — a push here would be a
      // no-op and strand the respondent on the completed leg.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(push).not.toHaveBeenCalled();
    });

    it('on the authenticated surface (no accessToken), continuing NAVIGATES to the next session', () => {
      const push = vi.fn();
      const refresh = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
        refresh,
        replace: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
      });

      // No accessToken — the authenticated surface — regardless of publicRef.
      renderCompletedLeg({ publicRef: null });
      expect(screen.getByTestId('handoff-card')).toBeInTheDocument();

      fireEvent.click(screen.getByText('handoff-continue'));

      expect(push).toHaveBeenCalledWith('/questionnaires/s2');
      expect(refresh).not.toHaveBeenCalled();
    });

    it('onConclude falls the surface all the way through to the ordinary SessionComplete screen', () => {
      // The run-level report doesn't exist yet, so the leg's own completion screen — not a run
      // summary — is the honest destination once the respondent chooses to see it.
      renderCompletedLeg({ publicRef: null });
      expect(screen.getByTestId('handoff-card')).toBeInTheDocument();
      expect(screen.queryByTestId('session-complete')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('handoff-conclude'));

      expect(screen.queryByTestId('handoff-card')).not.toBeInTheDocument();
      expect(screen.getByTestId('session-complete')).toBeInTheDocument();
    });
  });

  // ── Interviewer persona selection (choosePersona / onChangeInterviewer) ──────
  describe('interviewer persona selection', () => {
    const personasBase = {
      enabled: true,
      personas: [
        { key: 'a', label: 'Ana', description: 'da' },
        { key: 'b', label: 'Bo', description: 'db' },
      ],
      selectedPersonaKey: null,
    };

    function renderWithChip(switcher: 'indicator' | 'both' = 'indicator', accessToken?: string) {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
      lifecycleHook.mockReturnValue(lifecycleReturn());
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="chat"
          personas={{ ...personasBase, defaultPersonaKey: 'a', switcher }}
          accessToken={accessToken}
        />
      );
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('PATCHes the session with the chosen persona key and the session-token header on the no-login surface', () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      renderWithChip('indicator', 'tok-5');

      fireEvent.click(screen.getByTestId('interviewer-chip'));
      fireEvent.click(screen.getByText('switcher-choose-b'));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/v1/app/questionnaire-sessions/s1/persona');
      expect(init.method).toBe('PATCH');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'X-Session-Token': 'tok-5',
      });
      expect(init.body).toBe(JSON.stringify({ personaKey: 'b' }));
    });

    it('omits the session-token header on the authenticated surface (no accessToken)', () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      renderWithChip();

      fireEvent.click(screen.getByTestId('interviewer-chip'));
      fireEvent.click(screen.getByText('switcher-choose-b'));

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.headers).not.toHaveProperty('X-Session-Token');
    });

    it('fails soft: a rejected PATCH does not throw, and the local highlight stays on the choice', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);
      renderWithChip('indicator', 'tok-5');

      fireEvent.click(screen.getByTestId('interviewer-chip'));
      // Must not throw synchronously, and must not leave an unhandled rejection.
      expect(() => fireEvent.click(screen.getByText('switcher-choose-b'))).not.toThrow();
      // Let the rejected promise's `.catch()` settle before asserting.
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // choosePersona sets the local highlight BEFORE the fetch settles — the failed write never
      // rolls it back, so the chip keeps reading the respondent's choice either way.
      expect(screen.getByTestId('interviewer-chip')).toHaveTextContent('Bo');
    });

    it('switcher "both": pressing the chip slides the carousel to the persona page, not a modal', () => {
      renderWithChip('both');
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(screen.getByTestId('interviewer-chip'));

      expect(screen.getByRole('tab', { name: 'Interviewer' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(screen.queryByTestId('persona-switcher-modal')).not.toBeInTheDocument();
    });

    it('switcher "indicator" (no carousel page): pressing the chip opens the switcher MODAL instead', () => {
      renderWithChip();
      expect(screen.queryByRole('tab', { name: 'Interviewer' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('persona-switcher-modal')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('interviewer-chip'));

      expect(screen.getByTestId('persona-switcher-modal')).toBeInTheDocument();
    });
  });

  // ── Data-slot "Incorrect?" refine (handleRefine) ──────────────────────────────
  describe('data-slot refine (handleRefine)', () => {
    it('sends a steering turn naming the slot and quoting its current reading', () => {
      setup({ canSend: true });
      fireEvent.click(screen.getByText('refine'));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [message] = sendMessage.mock.calls[0] as [string];
      expect(message).toContain(DATA_SLOT.name);
      // The current paraphrase is embedded so the agent knows exactly what to re-open, not just
      // that the respondent is unhappy with SOMETHING.
      expect(message).toContain(DATA_SLOT.paraphrase as string);
    });

    it('omits the "current reading" clause when the slot has no paraphrase yet', () => {
      setup({ canSend: true });
      fireEvent.click(screen.getByText('refine-unfilled'));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [message] = sendMessage.mock.calls[0] as [string];
      // Still names the slot...
      expect(message).toContain(DATA_SLOT_UNFILLED.name);
      // ...but there is nothing to quote, so the "Right now you have it as" clause must be absent
      // rather than rendering as "Right now you have it as: null".
      expect(message).not.toContain('Right now you have it as');
    });

    it('ignores refine while the stream cannot send', () => {
      setup({ canSend: false });
      fireEvent.click(screen.getByText('refine'));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('drawer variant: refining a slot sends the same steering turn AND closes the review sheet', () => {
      setup({ canSend: true });
      fireEvent.click(screen.getByRole('button', { name: /review answers/i }));
      const dialog = screen.getByRole('dialog');

      fireEvent.click(within(dialog).getByText('drawer-refine'));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect((sendMessage.mock.calls[0] as [string])[0]).toContain(DATA_SLOT.name);
      // Unlike the desktop panel's onRefine, the drawer's variant must ALSO dismiss the sheet —
      // the respondent is about to see the agent's probe in the chat behind it.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // ── Held reconciliation probe (onHeld) ────────────────────────────────────────
  describe('a held reconciliation probe (onHeld)', () => {
    function renderWithOnHeld(appendAgentTurn = vi.fn()) {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
        appendAgentTurn,
      });
      panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
      lifecycleHook.mockReturnValue(lifecycleReturn());
      render(<SessionWorkspace sessionId="s1" />);
      return lifecycleHook.mock.calls[0][0] as {
        onHeld: (
          probe: { text: string; slotKeys: string[]; notice?: string },
          opts: { early: boolean }
        ) => void;
      };
    }

    it('appends the probe to the live transcript with the SAME contradiction notice the server persisted', () => {
      const appendAgentTurn = vi.fn();
      const { onHeld } = renderWithOnHeld(appendAgentTurn);

      act(() => {
        onHeld(
          {
            text: 'Did you mean full-time or part-time?',
            slotKeys: ['employment'],
            notice: 'That seems to contradict an earlier answer.',
          },
          { early: false }
        );
      });

      // Matching the server's persisted shape is what makes a post-reload replay of the
      // transcript show the same "I noticed something" box rather than bare probe text.
      expect(appendAgentTurn).toHaveBeenCalledWith('Did you mean full-time or part-time?', [
        { code: 'contradiction', message: 'That seems to contradict an earlier answer.' },
      ]);
    });

    it('opens the final-check modal when the held submit was an EARLY finish', () => {
      const { onHeld } = renderWithOnHeld();
      expect(screen.queryByTestId('final-check-modal')).not.toBeInTheDocument();

      act(() => {
        onHeld({ text: 'probe', slotKeys: [] }, { early: true });
      });

      expect(screen.getByTestId('final-check-modal')).toBeInTheDocument();
    });

    it('does NOT open the modal for a held probe mid-conversation (non-early)', () => {
      // The normal (mid-conversation) path surfaces the probe in the chat only — the modal is
      // reserved for the early-finish exit action, which the probe would otherwise interrupt.
      const { onHeld } = renderWithOnHeld();

      act(() => {
        onHeld({ text: 'probe', slotKeys: [] }, { early: false });
      });

      expect(screen.queryByTestId('final-check-modal')).not.toBeInTheDocument();
    });
  });

  // ── Final-check modal actions (onClarify / onFinishAnyway) ───────────────────
  describe('final-check modal actions', () => {
    function renderHeldEarly(lifecycleOver: Record<string, unknown> = {}) {
      const appendAgentTurn = vi.fn();
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
        appendAgentTurn,
      });
      panelHook.mockReturnValue({ view: null, loading: false, error: false, refetch });
      lifecycleHook.mockReturnValue(lifecycleReturn(lifecycleOver));
      // Single-surface mode: `both` would mount the completion affordance twice (once per
      // surface), making `offer-submit` ambiguous below.
      render(<SessionWorkspace sessionId="s1" presentationMode="chat" />);
      const { onHeld } = lifecycleHook.mock.calls[0][0] as {
        onHeld: (probe: { text: string; slotKeys: string[] }, opts: { early: boolean }) => void;
      };
      act(() => {
        onHeld({ text: 'Did you mean X or Y?', slotKeys: [] }, { early: true });
      });
    }

    it('onClarify closes the modal but leaves the held state intact — finishing again "finishes anyway"', () => {
      const finishAnyway = vi.fn();
      const submit = vi.fn();
      renderHeldEarly({ canSubmit: true, finishAnyway, submit });
      expect(screen.getByTestId('final-check-modal')).toBeInTheDocument();

      fireEvent.click(screen.getByText('final-check-clarify'));
      expect(screen.queryByTestId('final-check-modal')).not.toBeInTheDocument();

      // `heldProbe.early` must survive the dismissal, or re-clicking here would re-run the full
      // submit sweep and hold again on the same still-unresolved conflict instead of finishing.
      fireEvent.click(screen.getByText('offer-submit'));
      expect(finishAnyway).toHaveBeenCalledWith(true);
      expect(submit).not.toHaveBeenCalled();
    });

    it('onFinishAnyway calls lifecycle.finishAnyway with the preserved early flag', () => {
      const finishAnyway = vi.fn();
      renderHeldEarly({ finishAnyway });

      fireEvent.click(screen.getByText('final-check-finish-anyway'));

      expect(finishAnyway).toHaveBeenCalledWith(true);
    });
  });

  // ── Intro splash Proceed (onProceed / proceedLabel) ───────────────────────────
  describe('intro splash Proceed', () => {
    const intro = {
      enabled: true,
      questionnaireTitle: 'Team Health Check',
      background: '',
      videoUrl: '',
      copy: {
        howItWorks: { heading: 'How it works', body: 'This is a conversation, not a form.' },
        whatYouGet: null,
        goodToKnow: [],
        buttonLabel: 'Begin your conversation',
      },
    };

    it('advances off the intro to the first real surface and releases the deferred kickoff', () => {
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(<SessionWorkspace sessionId="s1" presentationMode="both" autoStart intro={intro} />);
      expect(screen.getByRole('tab', { name: 'Intro' })).toHaveAttribute('aria-selected', 'true');
      expect(kickoff).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: intro.copy.buttonLabel }));

      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(kickoff).toHaveBeenCalledTimes(1);
    });

    it('proceedLabel reads "Continue" (not the begin label) when a capture gate follows the intro', () => {
      const captureForm = {
        captureMode: 'form' as const,
        formFields: [
          {
            key: 'name',
            label: 'Name',
            type: 'text' as const,
            required: true,
            validation: 'deterministic' as const,
          },
        ],
        satisfied: false,
      };
      streamHook.mockReturnValue({
        canSend: true,
        status: 'idle',
        sendMessage,
        kickoff,
        applyStatus,
      });
      render(
        <SessionWorkspace
          sessionId="s1"
          presentationMode="chat"
          autoStart
          intro={intro}
          capture={captureForm}
        />
      );

      // "Continue" here, NOT "Begin your conversation" — the next surface is the details gate,
      // not the conversation itself.
      const proceed = screen.getByRole('button', { name: 'Continue' });
      expect(
        screen.queryByRole('button', { name: intro.copy.buttonLabel })
      ).not.toBeInTheDocument();

      fireEvent.click(proceed);

      expect(screen.getByRole('tabpanel', { name: 'Details' })).not.toHaveAttribute('inert');
      expect(kickoff).not.toHaveBeenCalled();
    });
  });
});
