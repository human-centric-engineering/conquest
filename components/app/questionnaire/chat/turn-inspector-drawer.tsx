'use client';

/**
 * Preview Turn Inspector drawer (ADMIN ONLY).
 *
 * A right-edge "flight-recorder" console that reveals, per respondent turn, the sequence of
 * agent/LLM calls the conversation made — each with its model, latency, estimated cost, token
 * counts, and the raw prompt + response. It renders only in an admin **preview** session: the
 * server emits the `inspector` frames that feed it solely when the session is a preview AND the
 * version's `previewInspectorEnabled` toggle is on, so this is never shown to a real respondent
 * (the parent only mounts it once such frames have arrived).
 *
 * Aesthetic: an editorial forensic dossier — amber accent on a dark slate console, monospace
 * transcripts, a collapsible timeline of calls per turn. Purely presentational.
 *
 * Rendered through a portal to `document.body`. It's mounted inside the chat surface, which in
 * `both`-presentation mode lives in a `transform`ed, `inert`-toggled carousel track — a
 * transformed ancestor becomes the containing block for `position: fixed` (so the drawer would
 * anchor to the 200%-wide track, not the viewport) and `inert` would swallow its clicks when the
 * form view is active. Portaling to `<body>` escapes both: the drawer is truly viewport-fixed and
 * stays interactive regardless of which surface is on screen.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  Copy,
  Cpu,
  Gauge,
  Loader2,
  Lock,
  ScanSearch,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  formatInspectorCall,
  formatInspectorTurn,
  formatInspectorTurns,
  totalInspectorCostUsd,
  totalInspectorLatencyMs,
  type AgentCallTrace,
  type TurnInspectorData,
} from '@/lib/app/questionnaire/inspector';
// Import the PURE submodule directly, not the barrel: the barrel re-exports the server-only
// `evaluate-turn` service (→ provider-manager → pg → node `dns`), which would pull Node-only code
// into this client bundle. `schema` is zod-only and client-safe.
import type { TurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/schema';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import { TurnEvaluationVerdict } from '@/components/app/questionnaire/turn-evaluation/turn-evaluation-verdict';
import { TurnEvaluationReview } from '@/components/app/questionnaire/turn-evaluation/turn-evaluation-review';

export interface TurnInspectorDrawerProps {
  turns: TurnInspectorData[];
  /** The preview session id — the evaluate-turn route is keyed on it (admin + preview only). */
  sessionId: string;
  /**
   * The live conversation turns (user/assistant messages), oldest first. Threaded so an
   * evaluation can carry the respondent message that opened a turn and the interviewer reply that
   * closed it — the context the learning-dataset action needs (without it, actioning 422s with
   * `no_content`). Optional: absent for older mounts, in which case the evaluation is run without
   * conversation context (the verdict still persists; only the learning case can't be built).
   */
  messages?: QuestionnaireTurn[];
}

/** $0.00 → "$0", small values to 4 sig decimals, larger to cents. */
function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

interface TurnTotals {
  turns: number;
  calls: number;
  costUsd: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

/** Session-wide rollup for the summary header. Token sums skip calls that don't expose counts. */
function summariseTurns(turns: TurnInspectorData[]): TurnTotals {
  const totals: TurnTotals = {
    turns: turns.length,
    calls: 0,
    costUsd: 0,
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  for (const turn of turns) {
    totals.calls += turn.calls.length;
    totals.costUsd += totalInspectorCostUsd(turn.calls);
    totals.latencyMs += totalInspectorLatencyMs(turn.calls);
    for (const call of turn.calls) {
      if (typeof call.tokensIn === 'number') totals.tokensIn += call.tokensIn;
      if (typeof call.tokensOut === 'number') totals.tokensOut += call.tokensOut;
    }
  }
  return totals;
}

/** A compact at-a-glance rollup pinned to the top of the drawer body. */
function SummaryHeader({ totals }: { totals: TurnTotals }) {
  const tokens =
    totals.tokensIn || totals.tokensOut
      ? `${totals.tokensIn.toLocaleString()} / ${totals.tokensOut.toLocaleString()}`
      : '—';
  return (
    <dl className="mb-3 grid grid-cols-3 gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2.5">
      <SummaryStat label="Turns" value={String(totals.turns)} />
      <SummaryStat label="Calls" value={String(totals.calls)} />
      <SummaryStat label="Total cost" value={fmtCost(totals.costUsd)} accent />
      <SummaryStat label="Latency" value={fmtLatency(totals.latencyMs)} />
      <SummaryStat label="Tokens in/out" value={tokens} />
    </dl>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[0.58rem] tracking-[0.12em] text-zinc-500 uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          'truncate font-mono text-sm font-semibold',
          accent ? 'text-[color:var(--cq-accent)]' : 'text-zinc-100'
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export function TurnInspectorDrawer({ turns, sessionId, messages }: TurnInspectorDrawerProps) {
  // Start closed: the drawer is opt-in via the edge tab (whose badge signals when data has arrived),
  // so it never covers the preview chat unless the admin asks for it.
  const [open, setOpen] = useState(false);
  const totals = useMemo(() => summariseTurns(turns), [turns]);
  const totalCalls = totals.calls;

  // Esc closes the open drawer — expected of any overlay console.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Portal to <body> so `position: fixed` anchors to the viewport (not the transformed carousel
  // track) and the drawer escapes the `inert` chat panel in `both` mode. Resolve the host on the
  // client only — `document` is absent during SSR and the first hydration frame.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.body);
  }, []);
  if (!host) return null;

  return createPortal(
    // The console chrome is always dark slate, so it should always use the *dark-background* lifted
    // amber. The outer `dark` makes the descendant `.dark .cq-surface` rule win regardless of the
    // page theme; `cq-surface` re-establishes the `--cq-accent` tokens — portaled onto <body> we're
    // outside the questionnaire surface, so without it the accent resolves to nothing and the tab's
    // text/border vanish in light mode. The wrappers are layout-inert — every child is `fixed`.
    <div className="dark">
      <div className="cq-surface">
        {/* Collapsed tab — tucked mostly off the right edge so it stays out of the way, leaving only a
            slim handle. Hovering (or focusing) it slides the full tab back into view. */}
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="group fixed top-1/2 right-0 z-50 flex translate-x-[calc(100%_-_0.625rem)] -translate-y-1/2 flex-col items-center gap-2 rounded-l-lg border border-r-0 border-[var(--cq-accent-ring)] bg-zinc-950/95 py-3.5 pr-2 pl-2.5 shadow-[0_8px_28px_-12px_rgba(0,0,0,0.7)] backdrop-blur transition-[transform,background-color] duration-200 ease-out hover:translate-x-0 hover:bg-zinc-900 focus-visible:translate-x-0 motion-reduce:transition-none"
            aria-label="Open the admin turn inspector"
          >
            <ScanSearch
              className="h-4 w-4 text-[var(--cq-accent)] transition-transform group-hover:scale-110"
              aria-hidden
            />
            <span
              className="font-mono text-[0.7rem] font-semibold tracking-[0.18em] text-zinc-100 uppercase"
              style={{ writingMode: 'vertical-rl' }}
            >
              Inspector
            </span>
            {totalCalls > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--cq-accent)] px-1.5 font-mono text-[0.65rem] leading-none font-bold text-[var(--cq-accent-foreground)]">
                {totalCalls}
              </span>
            )}
          </button>
        )}

        {/* Drawer */}
        <aside
          className={cn(
            'fixed top-0 right-0 z-50 flex h-dvh w-[min(30rem,92vw)] flex-col border-l border-[var(--cq-accent-ring)] bg-zinc-950 text-zinc-200 shadow-2xl transition-transform duration-300 ease-out',
            open ? 'translate-x-0' : 'pointer-events-none translate-x-full'
          )}
          aria-hidden={!open}
        >
          {/* Header */}
          <div className="shrink-0 border-b border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ScanSearch className="h-4 w-4 text-[var(--cq-accent)]" aria-hidden />
                <h2 className="font-mono text-sm font-semibold tracking-[0.18em] text-zinc-100 uppercase">
                  Turn Inspector
                </h2>
              </div>
              <div className="flex items-center gap-1">
                {turns.length > 0 && (
                  <CopyButton
                    getText={() => formatInspectorTurns(turns)}
                    label="Copy all turns to clipboard"
                    idleText="Copy all"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  aria-label="Close the turn inspector"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1.5 rounded border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] px-2 py-1">
              <Lock className="h-3 w-3 shrink-0 text-[var(--cq-accent)]" aria-hidden />
              <p className="text-[0.7rem] leading-tight text-[color:var(--cq-accent)]">
                <span className="font-semibold">Admin only.</span>{' '}
                <span className="text-zinc-400">
                  Not shown to respondents — preview session only.
                </span>
              </p>
            </div>
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {turns.length === 0 ? (
              <p className="px-1 py-8 text-center font-mono text-xs text-zinc-500">
                Waiting for the first turn…
              </p>
            ) : (
              <>
                <SummaryHeader totals={totals} />
                <ol className="space-y-3">
                  {turns.map((turn, i) => (
                    <TurnBlock
                      key={`${turn.turnIndex}-${i}`}
                      turn={turn}
                      sessionId={sessionId}
                      messages={messages}
                      defaultOpen={i === turns.length - 1}
                    />
                  ))}
                </ol>
              </>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-800 px-4 py-2 font-mono text-[0.65rem] text-zinc-500">
            {totals.turns} turn{totals.turns === 1 ? '' : 's'} · {totalCalls} agent call
            {totalCalls === 1 ? '' : 's'} captured this session
          </div>
        </aside>
      </div>
    </div>,
    host
  );
}

function TurnBlock({
  turn,
  sessionId,
  messages,
  defaultOpen,
}: {
  turn: TurnInspectorData;
  sessionId: string;
  messages?: QuestionnaireTurn[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const cost = totalInspectorCostUsd(turn.calls);
  const latency = totalInspectorLatencyMs(turn.calls);

  return (
    <li className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/40">
      <div className="flex w-full items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-900"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
          )}
          <span className="font-mono text-xs font-semibold tracking-wide text-zinc-100">
            Turn {turn.turnIndex + 1}
          </span>
          <span className="ml-auto flex items-center gap-3 font-mono text-[0.65rem] text-zinc-400">
            <span>
              {turn.calls.length} call{turn.calls.length === 1 ? '' : 's'}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden />
              {fmtLatency(latency)}
            </span>
            <span className="inline-flex items-center gap-1 text-[color:var(--cq-accent)]">
              <Coins className="h-3 w-3" aria-hidden />
              {fmtCost(cost)}
            </span>
          </span>
        </button>
        <CopyButton
          getText={() => formatInspectorTurn(turn)}
          label={`Copy turn ${turn.turnIndex + 1} to clipboard`}
          idleText=""
          className="mr-1.5"
        />
      </div>

      {open && (
        <>
          <ol className="space-y-px border-t border-zinc-800 bg-zinc-950/60 p-2">
            {turn.calls.map((call, i) => (
              <CallRow key={i} index={i} call={call} />
            ))}
          </ol>
          <TurnEvaluationSection turn={turn} sessionId={sessionId} messages={messages} />
        </>
      )}
    </li>
  );
}

/** EvalState — the lifecycle of one turn's on-demand evaluation. */
type EvalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      verdict: TurnEvaluation;
      costUsd: number;
      model: string;
      /** The persisted row id (null when the verdict was returned but the write failed). */
      evaluationId: string | null;
    };

/** How many prior conversation lines to send as recent context (keeps the payload lean). */
const RECENT_CONTEXT_LINES = 12;

/**
 * Derive the conversation context for one inspector turn from the live message list. The inspector
 * `turnIndex` is the 0-based respondent-answer→agent-reply round, so it maps to the
 * `(turnIndex)`-th **user** message and the first **assistant** message after it — derived by
 * walking the array (not by `index*2` math) so a leading agent greeting or any off-by-one can't
 * misalign it. Returns `{}` when the messages aren't available or the turn isn't found.
 */
function deriveTurnContext(
  messages: QuestionnaireTurn[] | undefined,
  turnIndex: number
): { respondentMessage?: string; interviewerMessage?: string; recentMessages?: string[] } {
  if (!messages || messages.length === 0) return {};

  // Find the index of the (turnIndex)-th user message.
  let seenUser = -1;
  let userIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      seenUser += 1;
      if (seenUser === turnIndex) {
        userIdx = i;
        break;
      }
    }
  }
  if (userIdx === -1) return {};

  const respondentMessage = messages[userIdx].content;
  let interviewerMessage: string | undefined;
  for (let j = userIdx + 1; j < messages.length; j++) {
    if (messages[j].role === 'assistant') {
      interviewerMessage = messages[j].content;
      break;
    }
  }

  const recentMessages = messages
    .slice(0, userIdx)
    .slice(-RECENT_CONTEXT_LINES)
    .map((m) => `${m.role === 'user' ? 'Respondent' : 'Interviewer'}: ${m.content}`);

  return {
    ...(respondentMessage ? { respondentMessage } : {}),
    ...(interviewerMessage ? { interviewerMessage } : {}),
    ...(recentMessages.length > 0 ? { recentMessages } : {}),
  };
}

/**
 * Trigger + render the interview-quality evaluation for one turn. Posts the turn dump — plus the
 * conversation context for that turn (the respondent message that opened it, the interviewer reply
 * that closed it, and recent history) — to the admin-only evaluate-turn route (which reloads the
 * questionnaire objectives AND persists the verdict), then renders the scored verdict with
 * Copy/Download/Re-run via the shared {@link TurnEvaluationVerdict}. When the verdict persisted (an
 * `evaluationId` came back) the reviewer can also comment on it and flag it for learning, inline,
 * via {@link TurnEvaluationReview}. The conversation context is what lets a flagged verdict be
 * actioned into a learning dataset — without it the action 422s with `no_content`.
 */
function TurnEvaluationSection({
  turn,
  sessionId,
  messages,
}: {
  turn: TurnInspectorData;
  sessionId: string;
  messages?: QuestionnaireTurn[];
}) {
  const [state, setState] = useState<EvalState>({ status: 'idle' });

  async function runEvaluation() {
    setState({ status: 'loading' });
    try {
      const data = await apiClient.post<{
        verdict: TurnEvaluation;
        costUsd: number;
        model: string;
        evaluationId: string | null;
      }>(API.APP.QUESTIONNAIRE_SESSIONS.evaluateTurn(sessionId), {
        body: { turn, ...deriveTurnContext(messages, turn.turnIndex) },
      });
      setState({
        status: 'done',
        verdict: data.verdict,
        costUsd: data.costUsd,
        model: data.model,
        evaluationId: data.evaluationId,
      });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Evaluation failed',
      });
    }
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/40 p-2">
      {state.status !== 'done' && (
        <button
          type="button"
          onClick={() => void runEvaluation()}
          disabled={state.status === 'loading'}
          className="inline-flex items-center gap-1.5 rounded border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] px-2.5 py-1.5 font-mono text-[0.65rem] font-semibold tracking-wide text-[color:var(--cq-accent)] uppercase transition-colors hover:bg-[var(--cq-accent)]/15 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.status === 'loading' ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <Gauge className="h-3 w-3" aria-hidden />
          )}
          {state.status === 'loading' ? 'Evaluating…' : 'Evaluate turn'}
        </button>
      )}

      {state.status === 'error' && (
        <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 font-mono text-[0.65rem] text-red-300">
          {state.message}
        </p>
      )}

      {state.status === 'done' && (
        <div className="mt-1 space-y-3">
          <TurnEvaluationVerdict
            verdict={state.verdict}
            model={state.model}
            turnIndex={turn.turnIndex}
            extraActions={
              <button
                type="button"
                onClick={() => void runEvaluation()}
                className="inline-flex shrink-0 items-center rounded px-1.5 py-1 font-mono text-[0.6rem] font-semibold tracking-wide text-zinc-400 uppercase transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                aria-label={`Re-run the evaluation for turn ${turn.turnIndex + 1}`}
              >
                Re-run
              </button>
            }
          />
          {state.evaluationId && (
            <TurnEvaluationReview
              sessionId={sessionId}
              evaluationId={state.evaluationId}
              initialFlagStatus="none"
              initialComment={null}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CallRow({ index, call }: { index: number; call: AgentCallTrace }) {
  const [open, setOpen] = useState(false);
  const isEmbedding = call.kind === 'embedding';
  return (
    <li className="rounded">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-zinc-900"
      >
        <span className="font-mono text-[0.6rem] text-zinc-600">
          {String(index + 1).padStart(2, '0')}
        </span>
        {isEmbedding ? (
          // Embedding calls are a different shape (no completion) — flag them with a "VEC" chip.
          <span className="shrink-0 rounded-sm bg-sky-500/20 px-1 font-mono text-[0.55rem] font-bold tracking-wide text-sky-300">
            VEC
          </span>
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cq-accent)]" aria-hidden />
        )}
        <span className="truncate text-xs font-medium text-zinc-200">{call.label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono text-[0.62rem] text-zinc-500">
          <span className="hidden sm:inline">{fmtLatency(call.latencyMs)}</span>
          <span className="text-[color:var(--cq-accent)]">{fmtCost(call.costUsd)}</span>
          {open ? (
            <ChevronDown className="h-3 w-3" aria-hidden />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden />
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-2.5 px-2 pt-1 pb-3">
          <div className="flex justify-end">
            <CopyButton
              getText={() => formatInspectorCall(call)}
              label={`Copy the "${call.label}" call to clipboard`}
              idleText="Copy call"
            />
          </div>

          {/* Metrics */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded border border-zinc-800 bg-zinc-900/50 p-2.5 font-mono text-[0.65rem]">
            <Metric icon={Cpu} label="Model" value={call.model || '—'} />
            <Metric label="Provider" value={call.provider || '—'} />
            <Metric icon={Clock} label="Latency" value={fmtLatency(call.latencyMs)} />
            <Metric icon={Coins} label="Est. cost" value={fmtCost(call.costUsd)} accent />
            {call.tokensIn !== undefined && (
              <Metric label="Tokens in" value={call.tokensIn.toLocaleString()} />
            )}
            {call.tokensOut !== undefined && (
              <Metric label="Tokens out" value={call.tokensOut.toLocaleString()} />
            )}
            {call.dimensions !== undefined && (
              <Metric label="Dimensions" value={call.dimensions.toLocaleString()} />
            )}
          </dl>

          {/* Prompt */}
          <div>
            <p className="mb-1 font-mono text-[0.6rem] font-semibold tracking-[0.15em] text-zinc-500 uppercase">
              Prompt
            </p>
            <div className="space-y-1.5">
              {call.prompt.map((m, i) => (
                <div key={i} className="overflow-hidden rounded border border-zinc-800">
                  <div className="border-b border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[0.58rem] tracking-wider text-zinc-400 uppercase">
                    {m.role}
                  </div>
                  <pre className="max-h-56 overflow-auto px-2.5 py-2 font-mono text-[0.68rem] leading-relaxed whitespace-pre-wrap text-zinc-300">
                    {m.content}
                  </pre>
                </div>
              ))}
            </div>
          </div>

          {/* Response (an embedding's "output" is the ranking it drove, not a completion). */}
          <div>
            <p className="mb-1 font-mono text-[0.6rem] font-semibold tracking-[0.15em] text-[color:var(--cq-accent)] uppercase">
              {isEmbedding ? 'Ranking' : 'Response'}
            </p>
            <pre className="max-h-56 overflow-auto rounded border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] px-2.5 py-2 font-mono text-[0.68rem] leading-relaxed whitespace-pre-wrap text-zinc-200">
              {call.response || '—'}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * A console-styled "copy to clipboard" button. `getText` is resolved lazily on click (so a turn's
 * text is serialized only when actually copied), and the icon/label flips to a tick for ~2s. Copy
 * failures (insecure context, permission denied) are swallowed — nothing here is destructive, and a
 * silent no-op beats throwing inside an overlay.
 */
function CopyButton({
  getText,
  label,
  idleText = 'Copy',
  className,
}: {
  getText: () => string;
  /** Accessible label (the visible text is just "Copy"/"Copied"). */
  label: string;
  /** Visible idle text. */
  idleText?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-mono text-[0.6rem] font-semibold tracking-wide text-zinc-400 uppercase transition-colors hover:bg-zinc-800 hover:text-zinc-100',
        className
      )}
      aria-label={label}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? 'Copied' : idleText}
    </button>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon?: typeof Cpu;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-hidden">
      {Icon && <Icon className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden />}
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span
        className={cn(
          'ml-auto truncate',
          accent ? 'text-[color:var(--cq-accent)]' : 'text-zinc-200'
        )}
      >
        {value}
      </span>
    </div>
  );
}
