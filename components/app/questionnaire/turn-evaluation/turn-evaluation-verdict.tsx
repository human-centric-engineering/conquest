'use client';

/**
 * Shared presentational renderer for one turn-evaluation verdict.
 *
 * The authoritative verdict view: headline score/rating chips, the eight interviewer
 * sub-scores, and the full Markdown body (identical to what Copy/Download emit, via the pure
 * `serializeTurnEvaluation`). Used by the Preview Turn Inspector drawer (live, ephemeral) and
 * the admin persisted-evaluation detail (stored) so both render a verdict identically.
 *
 * Presentational only — no data fetching. Theme-aware: it uses semantic tokens (card / muted /
 * foreground) so it follows the surrounding page theme — dark inside the always-dark hosts (the
 * inspector and admin drawer both establish a `.dark` context), light on a light admin page.
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
      className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-mono text-[0.6rem] font-semibold tracking-wide uppercase transition-colors"
      aria-label={label}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden />
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
    <div className="border-border bg-muted/40 min-w-0 rounded border px-2 py-1">
      <div className="text-muted-foreground font-mono text-[0.52rem] tracking-[0.12em] uppercase">
        {label}
      </div>
      <div
        className={cn(
          'truncate font-mono text-xs font-semibold',
          accent ? 'text-[color:var(--cq-accent)]' : 'text-foreground'
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
    <div className="bg-muted/40 flex items-center justify-between gap-2 rounded px-1.5 py-1">
      <span className="text-muted-foreground truncate">{label}</span>
      <span className="text-foreground shrink-0 font-semibold">{value}/10</span>
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
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-mono text-[0.6rem] font-semibold tracking-wide uppercase transition-colors"
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
        <p className="text-muted-foreground mb-1 font-mono text-[0.58rem] tracking-[0.15em] uppercase">
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
        className="border-border bg-muted/40 text-foreground max-h-[28rem] overflow-y-auto rounded border p-2.5 text-xs"
      />
    </div>
  );
}
