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
import { Button } from '@/components/ui/button';
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
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import { runStatusBadge } from '@/components/admin/questionnaires/evaluation-status-badge';
import { FieldLabel } from '@/components/admin/questionnaires/evaluation-field';
import {
  FindingReviewCard,
  whenSteersSettled,
} from '@/components/admin/questionnaires/evaluation-finding-review';
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

/** One accepted finding the batch could not execute, and why. */
interface BatchSkipped {
  findingId: string;
  targetKey: string;
  reason: string;
  detail?: string;
}

/** The batch route's response body. */
interface BatchApplyResponse {
  versionId: string;
  versionNumber: number;
  forked: boolean;
  applied: {
    findingId: string;
    targetKey: string;
    op: string;
    /** Present only where the reviewer's instruction shaped the change the AI wrote. */
    steer?: { note: string; unhonoured: string | null };
  }[];
  skipped: BatchSkipped[];
  findings: EvaluationFindingView[];
}

/**
 * Why one change did not land, in the reviewer's terms.
 *
 * The engine's reasons are its own vocabulary (`stale`, `target_gone`) and mean nothing to someone
 * who has just pressed a button — and this list is the only place a dropped change is ever
 * mentioned, so an unexplained code here is a change that silently disappeared.
 */
const SKIP_REASONS: Record<string, string> = {
  stale: 'the question changed since this evaluation ran — re-run it to judge the new wording',
  target_gone: 'the question it was about no longer exists',
  op_invalid: 'the suggested edit does not fit the question as it now stands',
  needs_authoring: 'there is no automatic edit for it — make this one in the editor',
  needs_ai: 'the AI could not rewrite it to follow your instruction — try applying again',
  steer_unsupported:
    'your instruction needs wording to change, and this one moves, retypes or removes the question — clear the instruction, or make this change in the editor',
};

function skipReason(skip: BatchSkipped): string {
  return SKIP_REASONS[skip.reason] ?? skip.detail ?? skip.reason;
}

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
  /**
   * Whether Conditional Topics is ON for this version.
   *
   * Passed rather than inferred from "the version has topics", because ingest seeds one `core`
   * topic per section on EVERY questionnaire — so topics existing says nothing about whether
   * routing can withhold a question.
   */
  conditionalTopicsEnabled?: boolean;
  /**
   * Questions belonging to no topic, server-computed by `uncoveredQuestionKeys` — the same
   * function the `orphaned_questions` finding uses, including its "stay silent when the version
   * has no topics at all" suppression. Counting client-side would report orphans on a version
   * whose own issue list is deliberately quiet.
   */
  uncoveredQuestionCount?: number;
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
  conditionalTopicsEnabled = false,
  uncoveredQuestionCount = 0,
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

  // The batch. `confirming` holds the unreviewed-count the dialog is warning about; `outcome` is
  // the last batch's report, which stays on screen because it is the only place the skipped
  // findings and their reasons are named.
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BatchApplyResponse | null>(null);

  /** The applied changes the reviewer's own instruction shaped — reported apart from the rest. */
  const steered = outcome?.applied.filter((a) => a.steer) ?? [];

  function handleUpdate(
    next: EvaluationFindingView,
    meta?: { forked: boolean; versionId: string; versionNumber: number }
  ) {
    setFindings((prev) => prev.map((f) => (f.id === next.id ? next : f)));
    if (meta?.forked) setFork({ versionId: meta.versionId, versionNumber: meta.versionNumber });
  }

  /**
   * Execute every accepted finding, in one call.
   *
   * The response carries the whole run re-derived, so the queue re-renders from it rather than
   * from optimistic local edits — findings that were skipped as stale come back with the fresh
   * `stale` flag that explains why, which no client-side guess could produce.
   */
  async function handleApplyAccepted() {
    setApplying(true);
    setApplyError(null);
    try {
      // Pressing this button blurs whichever instruction box was open, which STARTS that steer's
      // save — it does not finish it. Firing the batch in the same tick let the server read the
      // finding before the PATCH committed and apply the judge's wording with the reviewer's
      // sentence discarded: the exact silent substitution the AI leg exists to prevent, and
      // invisible afterwards, since the result panel would report no steer at all.
      await whenSteersSettled();

      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionEvaluationApply(questionnaireId, versionId, run.id),
        { method: 'POST', credentials: 'same-origin' }
      );
      const json = await parseApiResponse<BatchApplyResponse>(res);
      if (!res.ok || !json.success) {
        setApplyError(json.success ? 'Request failed' : json.error.message);
        return;
      }
      setOutcome(json.data);
      setFindings(json.data.findings);
      if (json.data.forked) {
        setFork({ versionId: json.data.versionId, versionNumber: json.data.versionNumber });
      }

      // Slot any newly-added questions, once for the whole batch rather than once per card as the
      // per-finding apply did. Best-effort and deliberately unawaited: the questions are already
      // added, and a failure here must not read as the batch having failed.
      const addedQuestions = json.data.applied.some((a) => a.op === 'add_question');
      if (addedQuestions && dataSlotsAvailable) {
        void fetch(
          API.APP.QUESTIONNAIRES.versionDataSlotsAssign(questionnaireId, json.data.versionId),
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        ).catch(() => {
          // swallow — slotting is a follow-up; the questions landed.
        });
      }
    } catch {
      setApplyError('Network error');
    } finally {
      setApplying(false);
      setConfirming(false);
    }
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

  /**
   * The run's decision state — the numbers the header tiles and the batch bar both read.
   *
   * Counted from every finding, never from the filtered set: a reviewer who has narrowed to Major
   * has not thereby decided fewer things, and a batch bar that said "3 accepted" while eleven were
   * about to be applied would be actively dangerous.
   */
  const tally = useMemo(() => {
    let accepted = 0;
    let dismissed = 0;
    let pending = 0;
    let applied = 0;
    for (const f of findings) {
      if (f.status === 'accepted') accepted += 1;
      else if (f.status === 'declined') dismissed += 1;
      else if (f.status === 'applied') applied += 1;
      else pending += 1;
    }
    return { accepted, dismissed, pending, applied };
  }, [findings]);

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

      {/* The batch bar — the run's only route to the questionnaire, and the standing answer to
          "have my decisions taken effect?".

          It is a permanent band rather than a toast on each Accept, deliberately. The reviewer
          needs to be told that accepting changes nothing, and being told that twenty times in a
          row through a dialog teaches them to dismiss it without reading; a count that sits there
          saying "6 accepted, not applied" is unmissable and never in the way. It reports from the
          whole run, never the filtered view — a bar reading "3 accepted" while eleven were about
          to be applied would be worse than no bar. */}
      {(tally.accepted > 0 || tally.pending > 0) && (
        <div className="bg-card flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {tally.accepted === 0
                ? 'Nothing accepted yet'
                : `${tally.accepted} accepted change${tally.accepted === 1 ? '' : 's'}, not applied yet`}
            </p>
            <p className="text-muted-foreground mt-0.5 max-w-[68ch] text-sm">
              {tally.accepted === 0
                ? 'Work through the suggestions below, accepting the ones you want. Nothing reaches the questionnaire until you apply them together.'
                : 'Nothing has changed in the questionnaire. Applying writes every accepted change at once — a launched version is copied to a new draft first, and you review the result in Build.'}
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            {tally.pending > 0 && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {tally.pending} still to review
              </span>
            )}
            <Button
              size="sm"
              disabled={applying || tally.accepted === 0 || !canApply}
              title={canApply ? undefined : 'Design evaluation is disabled'}
              onClick={() => (tally.pending > 0 ? setConfirming(true) : void handleApplyAccepted())}
            >
              {applying
                ? 'Applying…'
                : `Apply ${tally.accepted} accepted change${tally.accepted === 1 ? '' : 's'}`}
            </Button>
          </div>

          {applyError && <p className="w-full text-xs text-red-600">{applyError}</p>}
        </div>
      )}

      {/* Pressing apply with the queue half-triaged is not an error — it is a legitimate "do the
          ones I have looked at" — so this states what will and will not happen and lets it
          through, rather than blocking on a rule the reviewer did not agree to. */}
      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>You haven&apos;t finished reviewing this evaluation</AlertDialogTitle>
            <AlertDialogDescription>
              {tally.pending} suggestion{tally.pending === 1 ? '' : 's'} still{' '}
              {tally.pending === 1 ? 'has' : 'have'} no decision. Applying now writes the{' '}
              {tally.accepted} you accepted and leaves the rest alone — you can carry on reviewing
              and apply again afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleApplyAccepted()}>
              Apply {tally.accepted} anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The result. Stays on screen until the next batch, because it is the only place a change
          that did NOT land is ever named — a batch that quietly drops three of eleven is worse
          than no batch, and the reviewer has to be able to act on each reason. */}
      {outcome && (
        <div className="bg-card rounded-xl border p-4">
          <h3 className="text-sm font-medium">
            {outcome.applied.length === 0
              ? 'Nothing could be applied'
              : `${outcome.applied.length} change${outcome.applied.length === 1 ? '' : 's'} applied to v${outcome.versionNumber}`}
          </h3>

          {outcome.applied.length > 0 && (
            <p className="text-muted-foreground mt-1 max-w-[68ch] text-sm">
              {outcome.forked
                ? 'The launched version was copied to a new draft, and the changes landed there.'
                : 'The changes landed on this draft.'}{' '}
              <Link
                href={`/admin/questionnaires/${questionnaireId}/v/${outcome.versionId}/structure`}
                className="underline"
              >
                Open v{outcome.versionNumber} in Build →
              </Link>
            </p>
          )}

          {/* What the AI did with the reviewer's own words. `unhonoured` is the load-bearing half:
              a steer that only partly landed has to be visible at the moment it lands, or
              "applied" reads as "all of it applied" and the gap is found later in the
              questionnaire. */}
          {steered.length > 0 && (
            <div className="mt-3">
              <FieldLabel>
                {steered.length === 1
                  ? '1 change written to your instruction'
                  : `${steered.length} changes written to your instructions`}
              </FieldLabel>
              <ul className="mt-1.5 space-y-1">
                {steered.map((item) => (
                  <li key={item.findingId} className="text-muted-foreground max-w-[68ch] text-sm">
                    <span className="text-foreground">{item.targetKey}</span> — {item.steer?.note}
                    {item.steer?.unhonoured && (
                      <span className="text-foreground block text-xs">
                        Not done: {item.steer.unhonoured}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {outcome.skipped.length > 0 && (
            <div className="mt-3">
              <FieldLabel>{outcome.skipped.length} not applied</FieldLabel>
              <ul className="mt-1.5 space-y-1">
                {outcome.skipped.map((skip) => (
                  <li key={skip.findingId} className="text-muted-foreground max-w-[68ch] text-sm">
                    <span className="text-foreground">{skip.targetKey}</span> — {skipReason(skip)}
                    {/* Still accepted, not dropped: the reviewer's decision stands, so fixing the
                        cause and applying again picks it up without re-triaging. */}
                    {skip.reason !== 'target_gone' && ' (still accepted).'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

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

      {/* Questions no topic claims, while routing is on — they can never be asked, and this is the
          one screen where an admin is actively adding and removing questions. Placed above the
          queue rather than on a card: it is a fact about the questionnaire, not about any one
          finding. Silent when routing is off, where an uncovered question is simply asked. */}
      {conditionalTopicsEnabled && uncoveredQuestionCount > 0 && (
        <div
          role="status"
          className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/30"
        >
          {uncoveredQuestionCount === 1
            ? '1 question in this questionnaire belongs to no topic, so it is never asked.'
            : `${uncoveredQuestionCount} questions in this questionnaire belong to no topic, so they are never asked.`}{' '}
          <Link
            href={`${workspaceVersionBase(questionnaireId, versionId)}/topics`}
            className="underline"
          >
            Put {uncoveredQuestionCount === 1 ? 'it' : 'them'} in a topic →
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
