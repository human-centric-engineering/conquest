'use client';

/**
 * SlotHistoryDialog — the "Edited" affordance + evolution modal for a data slot (Data Slots feature).
 *
 * Replaces the old inline strikethrough "Earlier: …" list, which crowded the row. When a slot's
 * captured position changed at least once, the row shows a quiet "Edited" pill; opening it reveals
 * the full evolution as a newest-first timeline — the current reading, then each prior step with its
 * paraphrase, confidence, the agent's rationale at the time, and when it changed. So a correction
 * (e.g. 25-year-old male → female) is inspectable on demand instead of cluttering the list.
 *
 * Renders nothing when the slot has no prior states. Read-only display; inherits the brand CSS vars
 * from the `BrandThemeProvider` the panel renders under.
 *
 * `// DEMO-ONLY (F7.2):` questionnaire-domain affordance.
 */

import { History } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ConfidenceScore } from '@/components/app/questionnaire/panel/confidence-score';
import type { DataSlotPanelSlot } from '@/lib/app/questionnaire/panel/types';

type HistoryEntry = DataSlotPanelSlot['history'][number];

/** Compact, locale-aware stamp for a prior step ("24 Jun, 14:30"), or null when absent/invalid. */
function formatChangedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TimelineStep({
  label,
  current = false,
  paraphrase,
  confidence,
  rationale,
}: {
  label: string;
  current?: boolean;
  paraphrase: string | null;
  confidence: number | null;
  rationale: string | null;
}) {
  return (
    <li className="relative pl-5">
      <span
        className={cn(
          'absolute top-1 left-0 h-2.5 w-2.5 rounded-full border',
          current ? 'border-primary bg-primary' : 'border-muted-foreground/40 bg-muted'
        )}
        aria-hidden="true"
      />
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-xs font-medium',
            current ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {label}
        </span>
        <ConfidenceScore confidence={confidence} />
      </div>
      {paraphrase ? (
        <p className="text-foreground mt-1 text-sm">&ldquo;{paraphrase}&rdquo;</p>
      ) : null}
      {rationale ? (
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          <span className="font-medium">Why:</span> {rationale}
        </p>
      ) : !current ? (
        // A prior step whose rationale predates per-change capture — label the absence so it reads
        // as intentional, not a missing "Why:".
        <p className="text-muted-foreground/60 mt-1 text-xs italic">Reason not recorded</p>
      ) : null}
    </li>
  );
}

export function SlotHistoryDialog({ slot }: { slot: DataSlotPanelSlot }) {
  // Only prior states that actually carried a reading — mirrors the row's old filter.
  const changes: HistoryEntry[] = slot.history.filter((h) => h.paraphrase);
  if (changes.length === 0) return null;

  // Timeline reads newest-first: current reading on top, then prior steps (history is oldest-first).
  const priorNewestFirst = [...changes].reverse();
  const editCount = changes.length;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground hover:border-foreground/30 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium transition-colors"
          aria-label={`See how this answer evolved — ${editCount} ${editCount === 1 ? 'edit' : 'edits'}`}
        >
          <History className="h-3 w-3" aria-hidden="true" />
          {editCount} {editCount === 1 ? 'Edit' : 'Edits'}
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>How this answer evolved</DialogTitle>
          <DialogDescription>{slot.name}</DialogDescription>
        </DialogHeader>
        <ol className="space-y-4">
          <TimelineStep
            label="Current"
            current
            paraphrase={slot.paraphrase}
            confidence={slot.confidence}
            rationale={slot.rationale}
          />
          {priorNewestFirst.map((h, i) => (
            <TimelineStep
              key={i}
              label={formatChangedAt(h.changedAt) ?? 'Earlier'}
              paraphrase={h.paraphrase}
              confidence={h.confidence}
              rationale={h.rationale}
            />
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
