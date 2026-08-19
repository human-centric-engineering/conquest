'use client';

/**
 * EvaluationRunDetail (F5.2 read view → F5.3 review queue → question-centric view).
 *
 * The shell for one run: a headline band, a sticky control row, and the active view mode.
 *
 * Two modes over the same findings and the same review actions:
 *  - **By question** (default) — one card per target, every judge's findings about it together.
 *    This is the shape of the admin's actual job (fix the questionnaire) and the only view that
 *    shows cross-judge consensus.
 *  - **By judge** — the original per-dimension sections, still the right view for "how did the
 *    Clarity judge do?" and for reading a dimension's score in context.
 *
 * Three filters compose across both modes (status ∧ severity ∧ judge). Severity filtering is new:
 * `severity` used to be display-only, which left "show me what blocks launch" — the whole point of
 * the `major` level — impossible to ask.
 *
 * By-question cards behave as an **accordion** — one open at a time — and lead with the panel's
 * consolidated verdict (the verb, its backing, any dissent, and the reconciled wording) rather than
 * with the individual judgements, which are the drill-down.
 *
 * Findings live in component state so a review action updates its card in place. When an apply
 * forks a launched version the returned meta raises a banner pointing at the new draft.
 *
 * The run header itself is state too, because a **judge retry** rewrites it: a failed judge leaves
 * this run's totals an undercount, and the retry route re-dispatches that one judge *into the same
 * run* (rather than spawning a second one, which would strand the review decisions already made
 * here). This component owns that fetch — it is the one that holds the run — and swaps in the
 * refreshed detail wholesale; the review statuses it returns are the persisted ones, so nothing
 * local is lost.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { Badge } from '@/components/ui/badge';
import {
  EVALUATION_DIMENSION_SPECS,
  FINDING_REVIEW_STATUSES,
  FINDING_SEVERITIES,
  type EvaluationDimension,
  type FindingReviewStatus,
  type FindingSeverity,
} from '@/lib/app/questionnaire/evaluation';
import type {
  EvaluationFindingView,
  EvaluationRunDetail as EvaluationRunDetailView,
} from '@/lib/app/questionnaire/views';
import { runStatusBadge } from '@/components/admin/questionnaires/evaluation-status-badge';
import { FindingReviewCard } from '@/components/admin/questionnaires/evaluation-finding-review';
import { EvaluationRunHeadline } from '@/components/admin/questionnaires/evaluation-run-headline';
import { EvaluationByQuestion } from '@/components/admin/questionnaires/evaluation-by-question';
import {
  JudgeFailureIcon,
  RetryJudgeButton,
  judgeFailureReason,
} from '@/components/admin/questionnaires/evaluation-judge-failure';
import {
  groupFindingsByTarget,
  GROUP_SORTS,
  GROUP_SORT_LABELS,
  type GroupSort,
} from '@/lib/app/questionnaire/evaluation/group-findings';
import {
  summariseGroupActions,
  type GroupActionSummary,
} from '@/lib/app/questionnaire/evaluation/group-actions';

interface ForkNotice {
  versionId: string;
  versionNumber: number;
}

interface Props {
  run: EvaluationRunDetailView;
  questionnaireId: string;
  versionId: string;
  canApply: boolean;
  /** Whether the version has data slots — drives the "slot the new question" checkbox on add_question. */
  dataSlotsAvailable?: boolean;
}

type ViewMode = 'question' | 'judge';

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'question', label: 'By question' },
  { value: 'judge', label: 'By judge' },
];

const STATUS_FILTERS: ('all' | FindingReviewStatus)[] = ['all', ...FINDING_REVIEW_STATUSES];
const SEVERITY_FILTERS: ('all' | FindingSeverity)[] = ['all', ...FINDING_SEVERITIES];

/**
 * A labelled select for the filter row.
 *
 * Shared rather than repeated so the three controls cannot drift in height or type scale — the row
 * reads as one instrument only while they match exactly.
 */
function ControlSelect({
  label,
  ariaLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  /** Fuller accessible name when the visible label is too terse on its own ("Sort" → what?). */
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground font-medium">{label}</span>
      <select
        value={value}
        aria-label={ariaLabel ?? label}
        onChange={(e) => onChange(e.target.value)}
        className="bg-background focus-visible:ring-ring rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function EvaluationRunDetail({
  run,
  questionnaireId,
  versionId,
  canApply,
  dataSlotsAvailable = false,
}: Props) {
  // The run header changes under a judge retry (status, tallies, per-judge summary), so it is
  // state rather than the prop read directly.
  const [runState, setRunState] = useState<EvaluationRunDetailView>(run);
  const badge = runStatusBadge(runState.status);
  const [findings, setFindings] = useState<EvaluationFindingView[]>(run.findings);
  const [fork, setFork] = useState<ForkNotice | null>(null);
  const [retrying, setRetrying] = useState<EvaluationDimension | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const [mode, setMode] = useState<ViewMode>('question');
  const [sort, setSort] = useState<GroupSort>('natural');
  // Exactly one question card open at a time. These cards are tall when open — several finding
  // cards, each with its own apply controls — so two at once means scrolling past finished work to
  // reach unfinished work. Clicking the open one closes it, leaving a scannable index.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [status, setStatus] = useState<'all' | FindingReviewStatus>('all');
  const [severity, setSeverity] = useState<'all' | FindingSeverity>('all');
  const [dimension, setDimension] = useState<EvaluationDimension | null>(null);

  function handleUpdate(
    next: EvaluationFindingView,
    meta?: { forked: boolean; versionId: string; versionNumber: number }
  ) {
    setFindings((prev) => prev.map((f) => (f.id === next.id ? next : f)));
    if (meta?.forked) setFork({ versionId: meta.versionId, versionNumber: meta.versionNumber });
  }

  async function handleRetryJudge(judge: EvaluationDimension) {
    setRetrying(judge);
    setRetryError(null);
    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionEvaluationRetryJudge(questionnaireId, versionId, run.id),
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dimension: judge }),
        }
      );
      const json = await parseApiResponse<EvaluationRunDetailView>(res);
      if (!res.ok || !json.success) {
        setRetryError(json.success ? 'Request failed' : json.error.message);
        return;
      }
      // The response is the whole run, re-read after the merge — including the judge's fresh
      // diagnostic if it failed again, which is exactly what the band should then say.
      setRunState(json.data);
      setFindings(json.data.findings);
    } catch {
      // `parseApiResponse` throws on a body that isn't a valid envelope; a network failure lands
      // here too. Either way the run on screen is untouched.
      setRetryError('Network error');
    } finally {
      setRetrying(null);
    }
  }

  /** The void-returning handler the retry buttons take (they don't await). */
  const retryJudge = (judge: EvaluationDimension) => void handleRetryJudge(judge);

  const visible = useMemo(
    () =>
      findings.filter(
        (f) =>
          (status === 'all' || f.status === status) &&
          (severity === 'all' || f.severity === severity) &&
          (dimension === null || f.dimension === dimension)
      ),
    [findings, status, severity, dimension]
  );

  const groups = useMemo(() => groupFindingsByTarget(visible, sort), [visible, sort]);

  // The verdict band describes what the *panel* said about a question, so it is derived from every
  // finding on that target — not from the filtered set the cards below render.
  //
  // Filtering the verdict would let the filter manufacture the consensus `group-actions` is built
  // never to manufacture: narrow to Severity = Major on a question that Clarity wants reworded
  // (major) and Duplicates wants deleted (minor), and the band would read "Reword it · 1 judge"
  // with no dissent line — reporting agreement that does not exist and hiding the deletion. Same
  // reasoning as the headline above: a filter changes what you are *looking at*, never what the
  // panel *found*.
  const verdictByKey = useMemo(() => {
    const map = new Map<string, GroupActionSummary>();
    for (const group of groupFindingsByTarget(findings)) {
      map.set(group.key, summariseGroupActions(group));
    }
    return map;
  }, [findings]);

  // The run's cross-judge alternatives, indexed for the card that renders them. Empty for a run
  // made before reconciliation existed, or one where nothing was contested — in both cases the
  // cards fall back to the judges' own suggestions, which is what they showed before.
  const reconciledByKey = useMemo(
    () => new Map(run.reconciled.map((r) => [r.targetKey, r])),
    [run.reconciled]
  );

  // The headline describes the *run*, so it counts every finding regardless of filter. Only the
  // number of distinct targets is needed, so count keys directly rather than grouping and sorting.
  const targetCount = useMemo(
    () => new Set(findings.map((f) => f.target?.key ?? f.targetKey)).size,
    [findings]
  );

  // Bucket the (already dimension/ordinal-ordered) visible findings per dimension.
  const byDimension = useMemo(() => {
    const map = new Map<string, EvaluationFindingView[]>();
    for (const f of visible) {
      const list = map.get(f.dimension) ?? [];
      list.push(f);
      map.set(f.dimension, list);
    }
    return map;
  }, [visible]);

  const filtered = status !== 'all' || severity !== 'all' || dimension !== null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="text-muted-foreground text-sm">
          {runState.totalFindings} finding{runState.totalFindings === 1 ? '' : 's'} from{' '}
          {runState.dimensionsRun} judge{runState.dimensionsRun === 1 ? '' : 's'}
        </span>
        <span className="text-muted-foreground ml-auto text-xs">
          {new Date(runState.createdAt).toLocaleString()}
        </span>
      </div>

      <EvaluationRunHeadline
        dimensionSummary={runState.dimensionSummary}
        findings={findings}
        dimensionsRun={runState.dimensionsRun}
        dimensionsRequested={runState.dimensionsRequested}
        dimensionsFailed={runState.dimensionsFailed}
        targetCount={targetCount}
        activeDimension={dimension}
        onDimensionChange={setDimension}
        onRetryJudge={retryJudge}
        retryingDimension={retrying}
        retryError={retryError}
      />

      {fork && (
        <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          A new draft <strong>v{fork.versionNumber}</strong> was created from this launched version.
          Applied suggestions land there.{' '}
          <Link
            href={`/admin/questionnaires/${questionnaireId}/v/${fork.versionId}/structure`}
            className="underline"
          >
            Open the draft →
          </Link>
        </div>
      )}

      {/* Sticky so the filters stay reachable while working down a long queue.
          ONE row, not two. This row used to carry eleven buttons — five status, four severity, the
          mode toggle and the sort — which is more control surface than a page whose actual content
          is a queue of decisions can afford. The two filters that are set once per session and then
          forgotten became selects; the mode toggle, which is switched constantly, stayed a
          one-click segmented control. */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-1 px-1 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <div className="bg-muted inline-flex items-center rounded-lg p-1">
            {VIEW_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                aria-pressed={mode === m.value}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  mode === m.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'question' && (
            <ControlSelect
              label="Sort"
              ariaLabel="Sort questions"
              value={sort}
              onChange={(v) => setSort(v as GroupSort)}
              options={GROUP_SORTS.map((s) => ({ value: s, label: GROUP_SORT_LABELS[s] }))}
            />
          )}

          <ControlSelect
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as 'all' | FindingReviewStatus)}
            options={STATUS_FILTERS.map((s) => ({
              value: s,
              label: s === 'all' ? 'Any status' : s[0].toUpperCase() + s.slice(1),
            }))}
          />

          <ControlSelect
            label="Severity"
            value={severity}
            onChange={(v) => setSeverity(v as 'all' | FindingSeverity)}
            options={SEVERITY_FILTERS.map((s) => ({
              value: s,
              label: s === 'all' ? 'Any severity' : s[0].toUpperCase() + s.slice(1),
            }))}
          />

          {dimension && (
            <Badge variant="outline" className="gap-1 text-xs">
              {EVALUATION_DIMENSION_SPECS[dimension].label}
              <button
                type="button"
                onClick={() => setDimension(null)}
                aria-label="Clear judge filter"
                className="hover:text-foreground"
              >
                ×
              </button>
            </Badge>
          )}

          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {visible.length} of {findings.length} shown
          </span>
        </div>
      </div>

      {mode === 'question' ? (
        <EvaluationByQuestion
          groups={groups}
          questionnaireId={questionnaireId}
          versionId={versionId}
          runId={run.id}
          canApply={canApply}
          dataSlotsAvailable={dataSlotsAvailable}
          reconciledByKey={reconciledByKey}
          verdictByKey={verdictByKey}
          openKey={openKey}
          onToggle={(key) => setOpenKey((prev) => (prev === key ? null : key))}
          onUpdate={handleUpdate}
        />
      ) : (
        <div className="space-y-6">
          {runState.dimensionSummary.map((dim) => {
            const spec = EVALUATION_DIMENSION_SPECS[dim.dimension];
            const dimFindings = byDimension.get(dim.dimension) ?? [];
            // Hide a clean dimension entirely once a filter is active and it has nothing to show.
            if (filtered && dimFindings.length === 0) return null;
            return (
              <section key={dim.dimension} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{spec.label}</h3>
                  {dim.diagnostic ? (
                    <Badge variant="destructive" className="text-xs">
                      Failed
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      score {dim.score !== null ? dim.score.toFixed(2) : '—'} · {dim.findingCount}{' '}
                      finding{dim.findingCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>

                {/* A failed judge's section is otherwise empty, which reads as "nothing to say"
                    rather than "this judge never spoke" — so it states the reason and offers
                    the retry, the same treatment the headline strip gives it. */}
                {dim.diagnostic && (
                  <div className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs">
                    <JudgeFailureIcon />
                    <span className="leading-snug" title={dim.diagnostic}>
                      {judgeFailureReason(dim.diagnostic)} Findings from this judge are missing from
                      the queue below.
                    </span>
                    <RetryJudgeButton
                      dimension={dim.dimension}
                      busy={retrying === dim.dimension}
                      disabled={retrying !== null}
                      onRetry={(d) => retryJudge(d as EvaluationDimension)}
                      className="ml-auto"
                    />
                  </div>
                )}

                {!filtered && !dim.diagnostic && dimFindings.length === 0 && (
                  <p className="text-muted-foreground text-sm italic">No issues raised.</p>
                )}

                <ul className="space-y-3">
                  {dimFindings.map((f) => (
                    <FindingReviewCard
                      key={f.id}
                      finding={f}
                      questionnaireId={questionnaireId}
                      versionId={versionId}
                      runId={run.id}
                      canApply={canApply}
                      dataSlotsAvailable={dataSlotsAvailable}
                      onUpdate={handleUpdate}
                    />
                  ))}
                </ul>
              </section>
            );
          })}

          {filtered && visible.length === 0 && (
            <p className="text-muted-foreground rounded-xl border border-dashed py-10 text-center text-sm">
              No findings match these filters.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
