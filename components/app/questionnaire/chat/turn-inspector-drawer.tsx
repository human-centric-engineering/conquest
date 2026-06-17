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
  Lock,
  ScanSearch,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  formatInspectorCall,
  formatInspectorTurn,
  formatInspectorTurns,
  totalInspectorCostUsd,
  totalInspectorLatencyMs,
  type AgentCallTrace,
  type TurnInspectorData,
} from '@/lib/app/questionnaire/inspector';

export interface TurnInspectorDrawerProps {
  turns: TurnInspectorData[];
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

export function TurnInspectorDrawer({ turns }: TurnInspectorDrawerProps) {
  const [open, setOpen] = useState(false);
  const totalCalls = useMemo(() => turns.reduce((n, t) => n + t.calls.length, 0), [turns]);

  // Pop open the first time data arrives so the admin notices it (once, not on every turn).
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (!autoOpened && turns.length > 0) {
      setOpen(true);
      setAutoOpened(true);
    }
  }, [turns.length, autoOpened]);

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
        {/* Collapsed tab — always reachable on the right edge. */}
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="group fixed top-1/2 right-0 z-50 flex -translate-y-1/2 flex-col items-center gap-2 rounded-l-lg border border-r-0 border-[var(--cq-accent-ring)] bg-zinc-950/95 py-3.5 pr-2 pl-2.5 shadow-[0_8px_28px_-12px_rgba(0,0,0,0.7)] backdrop-blur transition-colors hover:bg-zinc-900"
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
              <ol className="space-y-3">
                {turns.map((turn, i) => (
                  <TurnBlock
                    key={`${turn.turnIndex}-${i}`}
                    turn={turn}
                    defaultOpen={i === turns.length - 1}
                  />
                ))}
              </ol>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-800 px-4 py-2 font-mono text-[0.65rem] text-zinc-500">
            {turns.length} turn{turns.length === 1 ? '' : 's'} · {totalCalls} agent call
            {totalCalls === 1 ? '' : 's'} captured this session
          </div>
        </aside>
      </div>
    </div>,
    host
  );
}

function TurnBlock({ turn, defaultOpen }: { turn: TurnInspectorData; defaultOpen: boolean }) {
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
        <ol className="space-y-px border-t border-zinc-800 bg-zinc-950/60 p-2">
          {turn.calls.map((call, i) => (
            <CallRow key={i} index={i} call={call} />
          ))}
        </ol>
      )}
    </li>
  );
}

function CallRow({ index, call }: { index: number; call: AgentCallTrace }) {
  const [open, setOpen] = useState(false);
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
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cq-accent)]" aria-hidden />
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

          {/* Response */}
          <div>
            <p className="mb-1 font-mono text-[0.6rem] font-semibold tracking-[0.15em] text-[color:var(--cq-accent)] uppercase">
              Response
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
