'use client';

/**
 * What routing actually did — the record of the plans this version has produced (F17.16).
 *
 * Every other card on this tab is about intent: the criteria you wrote, the limits you set, what a
 * plan would do against an opening you typed. This one is the only account of what happened when
 * real respondents met them.
 *
 * ## Why it loads itself
 *
 * The two failures it reports are both INVISIBLE by nature. A criteria sentence that never fires
 * produces no error and no empty state — the topic simply never appears in anyone's interview. A
 * criteria sentence respondents keep correcting produces a perfectly ordinary-looking plan. Putting
 * either behind a "show me" button would reproduce the problem in miniature: a finding nobody
 * clicks is a finding nobody has. So the card fetches on mount whenever there is a decision to have
 * been made, and stays silent only when there is genuinely nothing to say.
 *
 * ## Findings lead, counts follow
 *
 * The table is the evidence; the findings are the reading of it. An author scanning selection rates
 * has to notice a zero and know what it implies — which is precisely the noticing that has not been
 * happening. Stated as observations with their sample size rather than verdicts, because a topic
 * that never fires may be a rare-case safety net working exactly as designed, and only the author
 * knows which.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScopeEmptyState } from '@/components/admin/questionnaires/topics/scope-empty-state';
import { API } from '@/lib/api/endpoints';
import { apiClient } from '@/lib/api/client';
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import type { RoutingAnalyticsResult } from '@/lib/app/questionnaire/analytics/views';

export interface RoutingQualityCardProps {
  questionnaireId: string;
  versionId: string;
  /** True when conditional topics is switched on. With it off, no plan is ever written. */
  enabled: boolean;
  /** How many conditional topics the version has — with none, there is no decision to report on. */
  conditionalCount: number;
  /**
   * Hand the loaded analytics up to the tab, so the routing map can weight each topic by how often
   * it was really chosen (F17.29). A copy for a second reader, not a move: this card still owns the
   * fetch and the table.
   */
  onLoaded?: (result: RoutingAnalyticsResult | null) => void;
}

/** One percentage, rendered the way an author reads a rate: `72%`, and `0%` rather than a blank. */
function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function RoutingQualityCard({
  questionnaireId,
  versionId,
  enabled,
  conditionalCount,
  onLoaded,
}: RoutingQualityCardProps) {
  const [result, setResult] = useState<RoutingAnalyticsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const active = enabled && conditionalCount > 0;

  // Held in a ref so the effect does not re-run — and re-fetch — every time the tab re-renders with
  // a fresh callback identity. The effect's dependencies are what it actually reads. Written in an
  // effect rather than during render: a ref touched while rendering is not safe under concurrent
  // rendering, and the compiler rejects it.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    // Cleared per run, not just on first mount: without this a failed read leaves its red alert on
    // screen next to the fresh table when the effect re-runs, and a later failure would sit under a
    // stale table that reads as current.
    setError(null);
    setResult(null);
    onLoadedRef.current?.(null);
    apiClient
      .get<RoutingAnalyticsResult>(
        API.APP.QUESTIONNAIRES.versionAnalyticsRouting(questionnaireId, versionId)
      )
      .then((data) => {
        if (cancelled) return;
        setResult(data);
        onLoadedRef.current?.(data);
      })
      .catch((err: unknown) => {
        // A failed read must not imply "nothing to report" — that is the same silence the card
        // exists to break — so the failure is stated rather than degraded to an empty table.
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Routing quality unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, questionnaireId, versionId]);

  // Same reason as the preview card: on a tab of its own, silence reads as a broken page.
  if (!active) {
    return (
      <ScopeEmptyState
        title="No interviews to report on yet"
        body="Once conditional topics is on and respondents have completed interviews, this is where you see which topics were actually chosen, how often the fallback ran, and what respondents asked to change."
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" aria-hidden="true" />
          What happened in real interviews
        </CardTitle>
        <CardDescription>
          The plans this version produced over the last 30 days — which topics your criteria chose,
          which were sampled as a blind-spot check, which were chosen part-way through the opening,
          which were left out, and which ones respondents asked for themselves. Counts only; no
          respondent&rsquo;s words leave the interview.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Reading the interviews so far…
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
          >
            {error}
          </div>
        )}

        {result && result.plans === 0 && (
          <p className="text-muted-foreground text-sm">
            No interview has reached a plan yet, so there is nothing to report. This fills in as
            respondents complete the opening.
          </p>
        )}

        {result && result.plans > 0 && result.suppressed && (
          <p className="text-muted-foreground text-sm">
            {result.plans} {result.plans === 1 ? 'interview has' : 'interviews have'} reached a
            plan. Per-topic detail appears once {K_ANONYMITY_THRESHOLD} have — below that, the
            counts describe individual respondents rather than a pattern.
          </p>
        )}

        {result && result.plans > 0 && !result.suppressed && (
          <>
            {result.findings.length > 0 && (
              <ul className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                {result.findings.map((f) => (
                  <li key={`${f.code}-${f.topicKey}`} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th className="py-1.5 pr-3 font-medium">Topic</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Chosen</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Sampled</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Chosen early</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Left out</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Dropped for time</th>
                    <th className="py-1.5 text-right font-medium">Respondent asked</th>
                  </tr>
                </thead>
                <tbody>
                  {result.topics.map((row) => (
                    <tr key={row.key} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">
                        {row.label}
                        {row.phase === null && (
                          <Badge variant="outline" className="ml-2 text-xs">
                            deleted
                          </Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {row.chosen}{' '}
                        <span className="text-muted-foreground">({percent(row.chosenRate)})</span>
                      </td>
                      {/* Its own column rather than folded into "Chosen": the blind-spot check
                          seats a topic BECAUSE nothing chose it, so showing the two together would
                          render a dormant topic at 100%. */}
                      <td className="py-1.5 pr-3 text-right tabular-nums">{row.sampled}</td>
                      {/* Its own column, never folded into "Chosen", and the rule is the one
                          "Respondent asked" already follows: an area chosen part-way through the
                          opening is a decision taken on less evidence than the full one. Counting
                          it as a planner success would make the criteria look better the harder
                          the early-seating floor was tuned. */}
                      <td className="py-1.5 pr-3 text-right tabular-nums">{row.bySource.early}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{row.excluded}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{row.droppedByBudget}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.amended}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-muted-foreground text-xs">
              {result.plans} {result.plans === 1 ? 'plan' : 'plans'} · {result.amendedPlans}{' '}
              corrected by the respondent · {result.earlySeatedPlans} chose an area during the
              opening · {result.fallbackPlans} fell back to your safe default ·{' '}
              {result.checkTopicPlans} carried a blind-spot check · mean confidence{' '}
              {percent(result.meanConfidence)}
              {result.truncated && ' · showing the most recent plans only'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
