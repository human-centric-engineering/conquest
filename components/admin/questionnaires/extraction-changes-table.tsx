'use client';

/**
 * ExtractionChangesTable (F2.3) — the review surface for one version's editorial
 * change log, rendered on the `…/[id]/extraction-changes` sub-route.
 *
 * Rows are grouped by change family (prunes, edits, inferences, structural) and
 * ordered newest-first. Three client-side Selects filter by status, change type,
 * and target. Each applied row shows before/after JSON, the source quote, and the
 * extractor's rationale, plus a Revert button — disabled with a tooltip when the
 * server's dry-run verdict (`revertable`) says the revert can't be done cleanly.
 * Revert goes through `authoringMutate`; a launched-version revert forks a draft,
 * so the success handler redirects to the draft's (fresh) change log.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Blocks,
  FileCheck,
  Lightbulb,
  Loader2,
  PenLine,
  RotateCcw,
  Scissors,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { API } from '@/lib/api/endpoints';
import {
  CHANGE_TYPES,
  type ChangeType,
  type TargetEntityType,
} from '@/lib/app/questionnaire/ingestion/types';
import {
  EXTRACTION_CHANGE_STATUSES,
  type ExtractionChangeStatus,
  type RevertImpossibleReason,
} from '@/lib/app/questionnaire/extraction-review';
import type { ExtractionChangeView } from '@/lib/app/questionnaire/extraction-review/views';
import {
  AuthoringError,
  authoringMutate,
} from '@/components/admin/questionnaires/authoring-mutate';

/** Human labels for each change type (presentational; the tuple is the source). */
const CHANGE_TYPE_LABELS: Record<ChangeType, string> = {
  prune_section: 'Pruned section',
  prune_question: 'Pruned question',
  correct_spelling: 'Spelling fix',
  correct_grammar: 'Grammar fix',
  rewrite_prompt: 'Rewrote prompt',
  infer_type: 'Inferred type',
  merge_questions: 'Merged questions',
  split_question: 'Split question',
  add_section: 'Added section',
  augment_question: 'Augmented question',
  infer_goal: 'Inferred goal',
  infer_audience: 'Inferred audience',
};

/** The four display families, in render order. Each carries an icon so the kind of edit
 *  reads at a glance — pruning, wording, inference, or restructuring. */
const FAMILIES: {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  types: ChangeType[];
}[] = [
  {
    key: 'prunes',
    label: 'Pruned content',
    hint: 'Boilerplate the extractor dropped — kept here so you can restore it.',
    icon: Scissors,
    types: ['prune_section', 'prune_question'],
  },
  {
    key: 'edits',
    label: 'Edits',
    hint: 'Wording the extractor tidied or sharpened, and types it inferred.',
    icon: PenLine,
    types: [
      'correct_spelling',
      'correct_grammar',
      'rewrite_prompt',
      'infer_type',
      'augment_question',
    ],
  },
  {
    key: 'inferences',
    label: 'Inferences',
    hint: 'Goal and audience the extractor read between the lines of the document.',
    icon: Lightbulb,
    types: ['infer_goal', 'infer_audience'],
  },
  {
    key: 'structural',
    label: 'Structural',
    hint: 'Where the extractor merged, split, or added sections and questions.',
    icon: Blocks,
    types: ['merge_questions', 'split_question', 'add_section'],
  },
];

/** Why a revert is blocked — admin-readable expansion of the typed reason. */
const BLOCKED_REASON_LABELS: Record<RevertImpossibleReason, string> = {
  target_not_found:
    'No current entity matches this change — it may have been edited or deleted since.',
  ambiguous_target: 'Several entities match this change; revert it manually in the editor.',
  missing_before_json: 'The pre-change state was not recorded, so it can’t be restored.',
  structural_inverse_unavailable:
    'This structural change can’t be reversed automatically; redo it manually.',
  graph_drift: 'The target was edited after extraction, so reverting would undo that work.',
};

const ALL = '__all__';

interface Props {
  questionnaireId: string;
  versionId: string;
  changes: ExtractionChangeView[];
  counts: { applied: number; reverted: number; superseded: number };
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-muted-foreground mb-1 text-xs font-medium">{label}</p>
      <pre className="bg-muted/50 max-h-48 overflow-auto rounded-md p-2 text-xs break-words whitespace-pre-wrap">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function ExtractionChangesTable({ questionnaireId, versionId, changes, counts }: Props) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<ExtractionChangeStatus | typeof ALL>(ALL);
  const [typeFilter, setTypeFilter] = useState<ChangeType | typeof ALL>(ALL);
  const [targetFilter, setTargetFilter] = useState<TargetEntityType | typeof ALL>(ALL);
  const [confirming, setConfirming] = useState<ExtractionChangeView | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      changes.filter(
        (c) =>
          (statusFilter === ALL || c.status === statusFilter) &&
          (typeFilter === ALL || c.changeType === typeFilter) &&
          (targetFilter === ALL || c.targetEntityType === targetFilter)
      ),
    [changes, statusFilter, typeFilter, targetFilter]
  );

  const runRevert = async (change: ExtractionChangeView) => {
    setPendingId(change.id);
    setError(null);
    try {
      const { meta } = await authoringMutate(
        'POST',
        API.APP.QUESTIONNAIRES.versionChangeRevert(questionnaireId, versionId, change.id)
      );
      setConfirming(null);
      if (meta?.forked) {
        // The launched version forked a draft; its change log lives on the new draft.
        router.replace(
          `/admin/questionnaires/${questionnaireId}/v/${meta.versionId}/extraction-changes`
        );
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(
        err instanceof AuthoringError ? err.message : 'Could not revert this change. Try again.'
      );
    } finally {
      setPendingId(null);
    }
  };

  return (
    <TooltipProvider>
      <div className="space-y-5">
        {/* Filters + tallies */}
        <div className="flex flex-wrap items-center gap-3 border-b pb-3">
          <FilterSelect
            label="Status"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as ExtractionChangeStatus | typeof ALL)}
            options={EXTRACTION_CHANGE_STATUSES.map((s) => ({ value: s, label: s }))}
          />
          <FilterSelect
            label="Type"
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as ChangeType | typeof ALL)}
            options={CHANGE_TYPES.map((t) => ({ value: t, label: CHANGE_TYPE_LABELS[t] }))}
          />
          <FilterSelect
            label="Target"
            value={targetFilter}
            onChange={(v) => setTargetFilter(v as TargetEntityType | typeof ALL)}
            options={[
              { value: 'section', label: 'Section' },
              { value: 'question', label: 'Question' },
              { value: 'version', label: 'Version' },
            ]}
          />
          <p className="text-muted-foreground ml-auto text-xs">
            {counts.applied} applied · {counts.reverted} reverted
            {counts.superseded > 0 ? ` · ${counts.superseded} superseded` : ''}
          </p>
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}

        {filtered.length === 0 ? (
          changes.length === 0 ? (
            // No records at all — explain *why* that's the expected, healthy outcome (a verbatim
            // extraction leaves nothing to log) rather than a bare line that reads like an error.
            <div className="bg-card/40 rounded-xl border border-dashed px-6 py-10 text-center">
              <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] text-[var(--cq-accent)]">
                <FileCheck className="h-5 w-5" />
              </span>
              <p className="text-sm font-semibold tracking-tight">
                No editorial changes — the extractor used your document as-is
              </p>
              <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm">
                The extraction agent didn’t need to prune, rewrite, or infer anything for this
                version — every section and question matches the source document. A verbatim
                extraction produces no change records.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm italic">
              No changes match the current filters.
            </p>
          )
        ) : (
          FAMILIES.map((family) => {
            const rows = filtered.filter((c) => family.types.includes(c.changeType));
            if (rows.length === 0) return null;
            const FamilyIcon = family.icon;
            return (
              <section key={family.key} className="space-y-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--cq-accent-muted)] text-[var(--cq-accent)]">
                      <FamilyIcon className="h-3.5 w-3.5" />
                    </span>
                    <h3 className="text-sm font-semibold tracking-tight">{family.label}</h3>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {rows.length}
                    </span>
                  </div>
                  <p className="text-muted-foreground pl-8 text-xs">{family.hint}</p>
                </div>
                <ul className="space-y-3">
                  {rows.map((change) => (
                    <li
                      key={change.id}
                      className={`group bg-card rounded-lg border p-3 transition-shadow hover:border-[var(--cq-accent-ring)] hover:shadow-sm ${change.status !== 'applied' ? 'opacity-60' : ''}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="text-xs">
                          {CHANGE_TYPE_LABELS[change.changeType]}
                        </Badge>
                        <span className="text-muted-foreground text-xs">
                          {change.targetEntityType}
                          {change.resolvedTargetLabel ? ` · ${change.resolvedTargetLabel}` : ''}
                        </span>
                        {change.confidence !== null && (
                          <span className="text-muted-foreground text-xs">
                            {Math.round(change.confidence * 100)}% confidence
                          </span>
                        )}
                        {change.status === 'reverted' && (
                          <Badge variant="outline" className="text-xs">
                            reverted
                          </Badge>
                        )}
                        {change.status === 'superseded' && (
                          <Badge
                            variant="outline"
                            className="text-xs"
                            title="A full-structure rewrite replaced the graph this change describes. It is kept for the record but can no longer be reverted."
                          >
                            superseded
                          </Badge>
                        )}
                        <div className="ml-auto">
                          <RevertControl
                            change={change}
                            pending={pendingId === change.id}
                            onRequest={() => {
                              setError(null);
                              setConfirming(change);
                            }}
                          />
                        </div>
                      </div>

                      {change.rationale && (
                        <p className="text-muted-foreground mt-2 text-sm">{change.rationale}</p>
                      )}
                      {change.sourceQuote && (
                        <blockquote className="text-muted-foreground mt-2 border-l-2 pl-3 text-xs italic">
                          {change.sourceQuote}
                        </blockquote>
                      )}

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
                        {change.beforeJson !== null && (
                          <JsonBlock label="Before" value={change.beforeJson} />
                        )}
                        {change.beforeJson !== null && change.afterJson !== null && (
                          <div
                            className="text-muted-foreground/60 hidden items-center sm:flex"
                            aria-hidden
                          >
                            <ArrowRight className="h-4 w-4" />
                          </div>
                        )}
                        {change.afterJson !== null && (
                          <JsonBlock label="After" value={change.afterJson} />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      {/* Single confirm dialog, driven by `confirming`. */}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this change?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.revertSummary ??
                'This restores the questionnaire to its pre-change state.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirming) void runRevert(confirming);
              }}
              disabled={pendingId !== null}
            >
              {pendingId !== null ? 'Reverting…' : 'Revert'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

/** The per-row revert button: hidden for reverted rows, disabled+tooltip when blocked. */
function RevertControl({
  change,
  pending,
  onRequest,
}: {
  change: ExtractionChangeView;
  pending: boolean;
  onRequest: () => void;
}) {
  if (change.status !== 'applied') return null;

  if (!change.revertable) {
    const reason = change.revertBlockedReason
      ? BLOCKED_REASON_LABELS[change.revertBlockedReason]
      : 'This change can’t be reverted automatically.';
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button doesn't emit pointer events, so the wrapping span is
              the tooltip's hover/focus target. */}
          <span className="inline-block">
            <Button variant="outline" size="sm" disabled className="pointer-events-none">
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Revert
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={onRequest} disabled={pending}>
      {pending ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
      )}
      Revert
    </Button>
  );
}

/** A labelled filter Select with an "All" sentinel option. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
