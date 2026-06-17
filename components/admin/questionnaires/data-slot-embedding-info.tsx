/**
 * DataSlotEmbeddingInfo — an admin-facing explainer for data-slot embedding, shown on the
 * Questionnaires dashboard when the data-slots feature is on.
 *
 * Server-renderable (no hooks): a native `<details>` collapsible so it stays out of the way until
 * an admin expands it. It answers three questions an operator actually has — what the embedding is,
 * where it's used, and whether the features that consume it are currently on — and points at the
 * one place embeddings are generated (a version's Settings tab → "Generate embeddings").
 *
 * The live on/off pills reflect the resolved feature flags (passed in by the page) so the card
 * doubles as a status read-out, not just static copy.
 */

import { Boxes, Compass, Filter } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface DataSlotEmbeddingInfoProps {
  /** Whether adaptive data-slot selection is live (master + data-slots + live + sub-flag). */
  adaptiveDataSlotsEnabled: boolean;
  /** Whether the extraction candidate pre-filter is live (master + live + sub-flag). */
  extractionPrefilterEnabled: boolean;
}

function StatusPill({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
        on ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground'
      )}
    >
      {on ? 'On' : 'Off'}
    </span>
  );
}

function UseRow({
  icon: Icon,
  title,
  children,
  status,
}: {
  icon: typeof Boxes;
  title: string;
  children: React.ReactNode;
  status?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{title}</span>
          {status !== undefined && <StatusPill on={status} />}
        </div>
        <p className="text-muted-foreground mt-0.5 text-sm">{children}</p>
      </div>
    </div>
  );
}

export function DataSlotEmbeddingInfo({
  adaptiveDataSlotsEnabled,
  extractionPrefilterEnabled,
}: DataSlotEmbeddingInfoProps) {
  return (
    <details className="group bg-card rounded-xl border">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-medium select-none">
        <Boxes className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
        About data-slot embedding
        <span className="text-muted-foreground ml-auto text-xs font-normal group-open:hidden">
          What it is &amp; where it&apos;s used
        </span>
      </summary>

      <div className="space-y-4 border-t px-4 pt-4 pb-4 text-sm">
        <p className="text-muted-foreground">
          A <span className="text-foreground font-medium">data slot</span> is a named piece of
          information the conversation is trying to capture (its name + description), grouped by
          theme. Embedding turns each slot&apos;s description into a vector so the engine can rank
          slots by how closely they match what a respondent just said — instead of walking them in a
          fixed order. Generate embeddings from a version&apos;s{' '}
          <span className="text-foreground font-medium">
            Settings tab → &ldquo;Generate embeddings&rdquo;
          </span>{' '}
          (the live conversation also backfills them lazily as a fallback).
        </p>

        <div className="space-y-3">
          <UseRow icon={Boxes} title="Large questionnaires">
            Past ~50 data slots / 70 questions, fixed-order targeting loses the conversational
            thread and handing the whole slot list to the extractor every turn gets expensive.
            Embeddings keep both relevance and per-turn cost under control as a questionnaire grows.
          </UseRow>

          <UseRow
            icon={Compass}
            title="Adaptive question selection"
            status={adaptiveDataSlotsEnabled}
          >
            Ranks the unfilled slots by similarity to the respondent&apos;s last message, then a
            selector agent picks the most natural next topic — so questions follow the conversation
            rather than a list, while still letting it linger on a theme.
          </UseRow>

          <UseRow
            icon={Filter}
            title="Answer-slot completion (extraction pre-filter)"
            status={extractionPrefilterEnabled}
          >
            Narrows the candidate slots the answer extractor reads each turn to the most relevant
            ones, cutting token cost while still re-scanning already-filled slots for enrichment.
          </UseRow>
        </div>

        <p className="text-muted-foreground border-t pt-3 text-xs">
          Fail-soft by design: when embeddings are missing or an embed call fails, the conversation
          falls back to the deterministic fixed-order pick — it never breaks a turn. Embeddings are
          a launch-gate requirement while adaptive selection is on; re-generate after editing slot
          names or descriptions.
        </p>
      </div>
    </details>
  );
}
