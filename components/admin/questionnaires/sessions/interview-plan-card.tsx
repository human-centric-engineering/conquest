/**
 * The interview plan, as an admin reads it back — Conditional Topics (P17).
 *
 * "Why did this respondent get those topics" is the question an adaptive instrument generates, and
 * it is almost always asked months later, by someone holding a report a client has challenged. The
 * plan is the answer, so it sits next to the transcript rather than only in the `AppAiRun` audit
 * table, which nobody reads by accident.
 *
 * Two things this deliberately gives equal weight to the selected topics:
 *
 * - **What was left out.** A challenge is nearly always about something the interview did NOT ask.
 *   A panel showing only what it covered cannot answer the question it exists for.
 * - **What the respondent was told.** The announcement is the one chance they had to object, so
 *   whether they got one — and in what words — is part of the record, not a UI detail.
 *
 * A server component: pure rendering over data the page already loaded.
 */

import { Compass } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import {
  SCOPE_DECISION_SOURCE_LABELS,
  TOPIC_DEPTH_LABELS,
} from '@/lib/app/questionnaire/scope/types';
import type { AdminInterviewPlanView } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

export interface InterviewPlanCardProps {
  plan: AdminInterviewPlanView;
}

export function InterviewPlanCard({ plan }: InterviewPlanCardProps) {
  return (
    <details className="bg-muted/20 rounded-md border text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <Compass className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
        <span className="font-medium">Interview plan</span>
        <span className="text-muted-foreground text-xs">
          {plan.selected.length} of {plan.selected.length + plan.excluded.length} conditional{' '}
          {plan.selected.length + plan.excluded.length === 1 ? 'topic' : 'topics'} · decided at turn{' '}
          {plan.decidedAtTurn}
        </span>
        <Badge variant="outline" className="text-[10px]">
          {SCOPE_DECISION_SOURCE_LABELS[plan.source]}
        </Badge>
        {/* Confidence is only meaningful for a judged plan. The fallback carries a
            confidence of 1 or 0 by construction, and showing it would imply a measurement. */}
        {plan.source === 'llm' && (
          <span className="text-muted-foreground text-xs">
            confidence {Math.round(plan.confidence * 100)}%
          </span>
        )}
        {/* Only for a version that set a budget. Named an estimate in the summary itself: this is
            what the plan was PRICED at, not how long the respondent actually took, and the two are
            different enough that an unlabelled number would be read as a measurement. */}
        {plan.budgetSeconds !== null && plan.estimatedSeconds !== null && (
          <span className="text-muted-foreground text-xs">
            est. {formatSeconds(plan.estimatedSeconds)} of a {formatSeconds(plan.budgetSeconds)}{' '}
            budget
          </span>
        )}
      </summary>

      <div className="space-y-3 border-t px-3 py-3">
        {/* F17.36. First in the panel, above the topics, because it changes how everything below it
            should be read: these topics were chosen from an opening that never finished. */}
        {plan.forcedClose && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            The opening did not finish. It was closed at turn {plan.forcedClose.atTurn}, the limit
            set for this questionnaire, and the topics below were chosen on what had been gathered
            by then.
            {plan.forcedClose.uncovered.length > 0 && (
              <>
                {' '}
                Never covered: {plan.forcedClose.uncovered.join(', ')}. An item that no interview
                ever covers is usually one a respondent cannot answer.
              </>
            )}
          </p>
        )}
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Covered</p>
          {plan.selected.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">
              No conditional topics — this interview ran the always-asked ones only.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {plan.selected.map((topic) => (
                <li key={topic.key} className="text-xs">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{topic.label}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {SCOPE_DECISION_SOURCE_LABELS[topic.source]}
                    </Badge>
                    {topic.depth === 'light' && (
                      <Badge variant="outline" className="text-[10px]">
                        {plan.checkTopicKey === topic.key
                          ? 'Blind-spot check — sampled, not scored'
                          : TOPIC_DEPTH_LABELS.light}
                      </Badge>
                    )}
                    {topic.partial && (
                      /* "We covered Talent" and "we asked three of Talent's ten questions" are
                         different claims, and a challenged report turns on which one was true. */
                      <Badge variant="outline" className="text-[10px]">
                        {topic.partial.asked} of {topic.partial.total} asked
                      </Badge>
                    )}
                  </span>
                  {topic.rationale && (
                    <span className="text-muted-foreground block">{topic.rationale}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium">Not covered</p>
          {plan.excluded.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">
              Nothing was left out — every conditional topic was in scope.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {plan.excluded.map((topic) => (
                <li key={topic.key} className="text-xs">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{topic.label}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {SCOPE_DECISION_SOURCE_LABELS[topic.source]}
                    </Badge>
                  </span>
                  {topic.rationale && (
                    <span className="text-muted-foreground block">{topic.rationale}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">What the respondent was told</p>
          <p className="text-muted-foreground text-xs">
            {plan.respondentMessage.trim().length > 0 ? (
              <em>“{plan.respondentMessage}”</em>
            ) : (
              // Worth stating rather than hiding: an unannounced plan is a respondent who never got
              // the chance to object to it, which is exactly what a later challenge turns on.
              'Nothing — the plan was not announced.'
            )}
          </p>
        </div>
      </div>
    </details>
  );
}
