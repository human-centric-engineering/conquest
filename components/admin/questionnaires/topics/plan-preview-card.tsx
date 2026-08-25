'use client';

/**
 * "Try it" — dry-run the plan against an opening you type.
 *
 * The one thing this tab could not previously answer: *what will this actually do?* Coherence
 * findings say the setup is well-formed; the cost table says what it would take. Neither says which
 * topics a respondent gets, and until this card the only way to find out was to run a whole
 * interview as a respondent and infer the plan backwards from what got asked.
 *
 * ## What it has to show, and why each part earns its space
 *
 * A plan alone is not a diagnosis. An author looking at a topic that did not make the cut needs to
 * know **which layer dropped it**, because each one points at a different fix:
 *
 * - the model never picked it → the criteria are wrong
 * - the model picked it and the cap trimmed it → the limit is too tight
 * - the budget dropped it → the seconds, not the criteria
 * - a hard rule excluded it → the rule, and only the rule
 *
 * The plan already carries `source` on every topic in and out. The one thing it cannot carry is the
 * difference between the first two, which is why `proposedKeys` comes back separately.
 *
 * ## The fills are hand-set, and that is the point
 *
 * In a live interview a data-slot fill is an EXTRACTION from the answers. Here the author sets them
 * directly, which makes a fill a hypothesis rather than a prediction — stated plainly beneath the
 * editor rather than left to be discovered. It buys the one demonstration that matters: a
 * `not_exists` veto fires on an ABSENT fill, so the slots a veto watches are marked and leaving them
 * empty is presented as a deliberate act rather than an unfinished form.
 */

import { useState } from 'react';
import { FlaskConical, Loader2, PlayCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScopeEmptyState } from '@/components/admin/questionnaires/topics/scope-empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { apiClient } from '@/lib/api/client';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import {
  SCOPE_DECISION_SOURCE_LABELS,
  type ScopeDecisionSource,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { PlanPreviewForm, PlanPreviewResult } from '@/lib/app/questionnaire/scope/views';

export interface PlanPreviewCardProps {
  questionnaireId: string;
  versionId: string;
  form: PlanPreviewForm;
  topics: readonly Topic[];
  /** True when adaptive scope is switched on — a preview against an off version still runs. */
  enabled: boolean;
  disabled?: boolean;
}

/**
 * What a decision source means on a topic that was left OUT.
 *
 * `SCOPE_DECISION_SOURCE_LABELS` was written for a topic that made it into the plan, where `llm`
 * reads "Chosen by the agent". On an excluded topic that same value means the exact opposite — the
 * agent considered it and did not choose it — so reusing the shared labels here badges every
 * ordinary non-selection "Chosen by the agent", directly under a heading that says "Not in this
 * interview".
 */
const EXCLUDED_SOURCE_LABELS: Record<ScopeDecisionSource, string> = {
  llm: 'Not chosen by the agent',
  rule: 'Excluded by a rule you set',
  budget: 'Dropped — over the time budget',
  // Structurally unreachable on an excluded topic; present so the map stays exhaustive and a future
  // source cannot silently fall through to `undefined`.
  phase: 'Not applicable',
  fallback: 'Not in the fallback set',
  check: 'Not the blind-spot check',
  respondent: 'Not requested',
};

/** Shown instead of the stored source when the agent proposed a topic a later layer removed. */
const EXCLUDED_TAKEN_BACK_LABEL = 'Removed by a limit you set';

/** Tone per decision source, so a rule and a model pick never read the same at a glance. */
const SOURCE_TONE: Record<ScopeDecisionSource, string> = {
  phase: 'bg-muted text-muted-foreground',
  rule: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  llm: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  fallback: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  check: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  budget: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  respondent: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
};

export function PlanPreviewCard({
  questionnaireId,
  versionId,
  form,
  topics,
  enabled,
  disabled = false,
}: PlanPreviewCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fills, setFills] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PlanPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const labelByKey = new Map(topics.map((t) => [t.key, t.label] as const));
  const conditionalCount = topics.filter((t) => t.phase === 'conditional').length;

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(
        await apiClient.post<PlanPreviewResult>(
          API.APP.QUESTIONNAIRES.versionTopicsPreview(questionnaireId, versionId),
          {
            body: {
              answers: Object.entries(answers)
                .map(([key, text]) => ({ key, text: text.trim() }))
                .filter((a) => a.text !== ''),
              // A blank box means "the extractor captured nothing", which is a real input rather
              // than a missing one — so blanks are dropped here instead of being sent as empties.
              fills: Object.entries(fills)
                .map(([key, paraphrase]) => ({ key, paraphrase: paraphrase.trim() }))
                .filter((f) => f.paraphrase !== ''),
            },
          }
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The preview could not be run.');
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  // A whole tab that can render blank needs copy, not nothing. Before the sub-tab split this card
  // was one of a dozen on a long page, so vanishing was invisible; on the Check tab it would be
  // most of what the tab has to show.
  if (conditionalCount === 0) {
    return (
      <ScopeEmptyState
        title="Nothing to preview yet"
        body="A dry run decides between your conditional topics. Mark at least one topic as conditional on the Topics tab and you can try the decision here before any respondent sees it."
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="text-muted-foreground h-4 w-4" aria-hidden="true" />
          Try it
          <FieldHelp title="What this does">
            <p>
              Runs the planner over an opening you type and shows the plan your current settings
              would produce — the same rules, the same agent, the same limits, in the same order.
            </p>
            <p className="mt-2">
              It writes nothing. No session is created and no respondent is affected. Each run costs
              one model call.
            </p>
          </FieldHelp>
        </CardTitle>
        <CardDescription>
          {enabled
            ? 'Check what a respondent would be asked before anyone is asked it.'
            : 'Adaptive scope is off, so this changes nothing for respondents yet — the switch is at the top of this tab. The preview runs against your settings exactly as they stand.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {form.openingQuestions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No opening topic names any question that still exists, so there is nothing for a
            respondent to answer before the plan is decided. Add an opening topic first — the
            planner reads its answers and nothing else.
          </p>
        ) : (
          <div className="space-y-3">
            {form.openingQuestions.map((question) => (
              <div key={question.key} className="space-y-1.5">
                <Label htmlFor={`preview-a-${question.key}`} className="text-sm font-medium">
                  {question.prompt}
                </Label>
                <Textarea
                  id={`preview-a-${question.key}`}
                  value={answers[question.key] ?? ''}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [question.key]: e.target.value }))
                  }
                  placeholder="What a respondent might say"
                  rows={2}
                  disabled={disabled || running}
                />
              </div>
            ))}
          </div>
        )}

        {form.fillTargets.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-medium">What the extractor captured</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {form.fillTargets.map((target) => (
                <div key={target.key} className="space-y-1">
                  <Label
                    htmlFor={`preview-f-${target.key}`}
                    className="text-muted-foreground flex items-center gap-1.5 text-xs"
                  >
                    {target.name}
                    {target.watchedByVeto && (
                      <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                        a rule watches this
                      </span>
                    )}
                  </Label>
                  <Input
                    id={`preview-f-${target.key}`}
                    value={fills[target.key] ?? ''}
                    onChange={(e) =>
                      setFills((prev) => ({ ...prev, [target.key]: e.target.value }))
                    }
                    placeholder="Leave empty to capture nothing"
                    disabled={disabled || running}
                  />
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              In a real interview these are read out of the answers above, so what you set here is a
              hypothesis rather than a prediction. Leaving one empty is a real case, not an
              unfinished form — a rule that tests for something being <em>absent</em> can only be
              seen firing that way.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 border-t pt-4">
          <Button type="button" onClick={() => void run()} disabled={disabled || running} size="sm">
            {running ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <PlayCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
            )}
            {running ? 'Working it out…' : 'Preview the decision'}
          </Button>
          {result && (
            <span className="text-muted-foreground text-xs">cost ${result.costUsd.toFixed(4)}</span>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
          >
            {error}
          </div>
        )}

        {result && <PreviewOutcome result={result} labelByKey={labelByKey} />}
      </CardContent>
    </Card>
  );
}

/** The plan as a diagnosis: what was chosen, what was not, and which layer decided. */
function PreviewOutcome({
  result,
  labelByKey,
}: {
  result: PlanPreviewResult;
  labelByKey: ReadonlyMap<string, string>;
}) {
  const { plan } = result;
  const proposed = new Set(result.proposedKeys);
  const name = (key: string) => labelByKey.get(key) ?? key;

  return (
    <div className="space-y-4 border-t pt-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary">{SCOPE_DECISION_SOURCE_LABELS[plan.source]}</Badge>
        <span className="text-muted-foreground">
          confidence {Math.round(plan.confidence * 100)}%
        </span>
        {plan.estimatedSeconds !== undefined && plan.budgetSeconds !== undefined && (
          <span className="text-muted-foreground">
            · {formatSeconds(plan.estimatedSeconds)} of {formatSeconds(plan.budgetSeconds)}
          </span>
        )}
      </div>

      {result.skippedModelReason && (
        <p className="text-muted-foreground text-xs leading-relaxed">{result.skippedModelReason}</p>
      )}

      <div className="space-y-1.5">
        <p className="text-xs font-medium">In this interview</p>
        {plan.topics.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No conditional topic was selected — the respondent gets the always-run topics only.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {plan.topics.map((topic) => (
              <li key={topic.key} className="bg-muted/25 rounded-md border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{name(topic.key)}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${SOURCE_TONE[topic.source]}`}
                  >
                    {SCOPE_DECISION_SOURCE_LABELS[topic.source]}
                  </span>
                  {topic.depth === 'light' && (
                    <span className="text-muted-foreground text-[10px]">sampled</span>
                  )}
                </div>
                {topic.rationale && (
                  <p className="text-muted-foreground mt-1 leading-relaxed">{topic.rationale}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {plan.excluded.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Not in this interview</p>
          <ul className="space-y-1.5">
            {plan.excluded.map((topic) => {
              // The agent wanted this one and a deterministic layer took it back. This is the whole
              // reason `proposedKeys` is returned, and it OVERRIDES the stored record: a topic the
              // cap trimmed is written as `source: 'llm'` with the rationale "nothing in the opening
              // pointed at this area", which is the opposite of what happened and would send the
              // author to rewrite criteria that worked.
              const takenBack = proposed.has(topic.key);
              return (
                <li key={topic.key} className="rounded-md border border-dashed p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{name(topic.key)}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        takenBack ? SOURCE_TONE.budget : SOURCE_TONE[topic.source]
                      }`}
                    >
                      {takenBack ? EXCLUDED_TAKEN_BACK_LABEL : EXCLUDED_SOURCE_LABELS[topic.source]}
                    </span>
                  </div>
                  {takenBack ? (
                    <p className="text-muted-foreground mt-1 leading-relaxed">
                      The agent chose this area, and a limit you set removed it — the cap on how
                      many topics one interview may cover, or the time budget. Widen the limit
                      rather than the criteria.
                    </p>
                  ) : (
                    topic.rationale && (
                      <p className="text-muted-foreground mt-1 leading-relaxed">
                        {topic.rationale}
                      </p>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {plan.respondentMessage && (
        <div className="space-y-1">
          <p className="text-xs font-medium">What the respondent would hear</p>
          <p className="text-muted-foreground rounded-md border border-dashed p-2 text-xs leading-relaxed italic">
            “{plan.respondentMessage}”
          </p>
          <p className="text-muted-foreground text-[11px]">
            The interviewer weaves this into its own voice rather than reading it out.
          </p>
        </div>
      )}
    </div>
  );
}
