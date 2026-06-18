'use client';

/**
 * Shared presentational renderer for one turn-evaluation verdict.
 *
 * The authoritative verdict view: headline score/rating chips, the eight interviewer
 * sub-scores, and the full Markdown body (identical to what Copy/Download emit, via the pure
 * `serializeTurnEvaluation`). Used by the Preview Turn Inspector drawer (live, ephemeral) and
 * the admin persisted-evaluation detail (stored) so both render a verdict identically.
 *
 * Presentational only — no data fetching. Styled as a dark "console" panel to match the
 * inspector; the admin detail wraps it in a dark container.
 */

import { useMemo, useState } from 'react';
import { Check, Copy, Download, Gauge } from 'lucide-react';

import { cn } from '@/lib/utils';
import { MarkdownContent } from '@/components/admin/orchestration/markdown-or-raw-view';
import { serializeTurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/serialize';
import type { TurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/schema';

/** Trigger a client-side download of `text` as a `.md` file. */
function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Small copy-to-clipboard button matching the inspector's console styling. */
function CopyButton({ getText, label }: { getText: () => string; label: string }) {
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
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-mono text-[0.6rem] font-semibold tracking-wide text-zinc-400 uppercase transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      aria-label={label}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A labelled score/rating chip in the verdict header. */
function VerdictChip({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1">
      <div className="font-mono text-[0.52rem] tracking-[0.12em] text-zinc-500 uppercase">
        {label}
      </div>
      <div
        className={cn(
          'truncate font-mono text-xs font-semibold',
          accent ? 'text-[color:var(--cq-accent)]' : 'text-zinc-100'
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** A 1–10 interviewer sub-score cell. */
function SubScore({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded bg-zinc-900/50 px-1.5 py-1">
      <span className="truncate text-zinc-400">{label}</span>
      <span className="shrink-0 font-semibold text-zinc-100">{value}/10</span>
    </div>
  );
}

export interface TurnEvaluationVerdictProps {
  verdict: TurnEvaluation;
  /** Resolved evaluator model id (shown as a chip). */
  model: string;
  /** 0-based turn index — drives the serialized heading + download filename. */
  turnIndex: number;
  /** Optional extra buttons rendered in the action bar (e.g. Re-run in the live drawer). */
  extraActions?: React.ReactNode;
}

/** Render a completed verdict: headline chips, interviewer sub-scores, and the full markdown body. */
export function TurnEvaluationVerdict({
  verdict,
  model,
  turnIndex,
  extraActions,
}: TurnEvaluationVerdictProps) {
  const markdown = useMemo(() => serializeTurnEvaluation(verdict, turnIndex), [verdict, turnIndex]);
  const i = verdict.interviewer;

  return (
    <div className="space-y-3">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[0.6rem] tracking-[0.15em] text-[color:var(--cq-accent)] uppercase">
          <Gauge className="h-3 w-3" aria-hidden />
          Evaluation
        </div>
        <div className="flex items-center gap-1">
          <CopyButton
            getText={() => markdown}
            label={`Copy turn ${turnIndex + 1} evaluation to clipboard`}
          />
          <button
            type="button"
            onClick={() => downloadMarkdown(`turn-${turnIndex + 1}-evaluation.md`, markdown)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-mono text-[0.6rem] font-semibold tracking-wide text-zinc-400 uppercase transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            aria-label={`Download turn ${turnIndex + 1} evaluation as Markdown`}
          >
            <Download className="h-3 w-3" aria-hidden />
            Download
          </button>
          {extraActions}
        </div>
      </div>

      {/* Headline chips */}
      <div className="grid grid-cols-3 gap-1.5">
        <VerdictChip label="Overall" value={`${verdict.overallScore}/100`} accent />
        <VerdictChip label="Effectiveness" value={verdict.effectiveness} />
        <VerdictChip label="Info gain" value={verdict.informationGain.rating} />
        <VerdictChip label="Extraction" value={`${verdict.extraction.score}/100`} />
        <VerdictChip label="Selection" value={`${verdict.questionSelection.score}/100`} />
        <VerdictChip label="Efficiency" value={verdict.efficiency.rating} />
        <VerdictChip label="Prompt drift" value={verdict.promptDrift.rating} />
        <VerdictChip label="Model" value={model || '—'} />
      </div>

      {/* Interviewer sub-scores */}
      <div>
        <p className="mb-1 font-mono text-[0.58rem] tracking-[0.15em] text-zinc-500 uppercase">
          Interviewer question quality
        </p>
        <div className="grid grid-cols-2 gap-1 font-mono text-[0.62rem]">
          <SubScore label="Open-endedness" value={i.openEndedness} />
          <SubScore label="Single-topic" value={i.singleTopicFocus} />
          <SubScore label="Non-leading" value={i.nonLeading} />
          <SubScore label="Conversational" value={i.conversational} />
          <SubScore label="Cognitive load" value={i.cognitiveLoad} />
          <SubScore label="Specificity" value={i.specificity} />
          <SubScore label="Warmth" value={i.warmth} />
          <SubScore label="Stage fit" value={i.stageAlignment} />
        </div>
      </div>

      {/* Full markdown verdict (authoritative — identical to Copy/Download). */}
      <MarkdownContent
        content={markdown}
        className="max-h-[28rem] overflow-y-auto rounded border border-zinc-800 bg-zinc-900/40 p-2.5 text-xs text-zinc-300"
      />
    </div>
  );
}
