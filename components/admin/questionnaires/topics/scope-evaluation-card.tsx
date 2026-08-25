'use client';

/**
 * The Conditional Topics judge panel — a second, structural review alongside the design-evaluation
 * panel, scoring the SCOPE CONFIG (topics, hard rules, planner instructions, budget) rather than
 * the question structure.
 *
 * Ephemeral, like F5.1's own preview: this card runs the panel against the `evaluate-preview`
 * route and shows the result in place, without persisting anything — the fast way to sanity-check
 * a change before committing to a saved run. A "View past runs" link opens the persisted run
 * history (F17.21 phase B/C: saved runs, a review queue, and one-click apply), which is where an
 * admin actually triages and applies findings.
 *
 * Findings are shown per dimension rather than grouped by target: with four judges and a config
 * small enough to read topic-by-topic already (the list above this card), the by-question grouping
 * the persisted review queue needs to tame dozens of questions across seven judges would be
 * over-built for this quick preview.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Gavel, History, Loader2, PlayCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { findingSeverityBadge } from '@/components/admin/questionnaires/evaluation-status-badge';
import { API } from '@/lib/api/endpoints';
import { apiClient } from '@/lib/api/client';
import {
  SCOPE_EVALUATION_DIMENSION_SPECS,
  type ScopeEvaluationDimension,
  type ScopeJudgeFinding,
} from '@/lib/app/questionnaire/scope-evaluation';
import { describeScopeRule } from '@/lib/app/questionnaire/scope/rule-format';
import type { ScopeRule, Topic } from '@/lib/app/questionnaire/scope/types';

/** One dimension's outcome, as the preview route returns it. */
interface ScopeDimensionResultView {
  dimension: ScopeEvaluationDimension;
  verdict?: { dimension: ScopeEvaluationDimension; score: number; findings: ScopeJudgeFinding[] };
  diagnostic?: string;
}

interface ScopeEvaluationPreviewResponse {
  results: ScopeDimensionResultView[];
  summary: {
    dimensionsRequested: number;
    dimensionsRun: number;
    dimensionsFailed: number;
    totalFindings: number;
  };
}

export interface ScopeEvaluationCardProps {
  questionnaireId: string;
  versionId: string;
  topics: readonly Topic[];
  rules: readonly ScopeRule[];
  dataSlots: readonly { key: string; name: string }[];
  disabled?: boolean;
}

/** A score in [0, 1] rendered the way an author reads a percentage. */
function scoreLabel(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Tone for a score badge — green/amber/red bands, matching the severity badge's traffic-light logic. */
function scoreVariant(score: number): 'default' | 'secondary' | 'destructive' {
  if (score >= 0.8) return 'default';
  if (score >= 0.5) return 'secondary';
  return 'destructive';
}

export function ScopeEvaluationCard({
  questionnaireId,
  versionId,
  topics,
  rules,
  dataSlots,
  disabled = false,
}: ScopeEvaluationCardProps) {
  const [result, setResult] = useState<ScopeEvaluationPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const topicLabelByKey = new Map(topics.map((t) => [t.key, t.label] as const));
  const dataSlotLabelByKey = new Map(dataSlots.map((d) => [d.key, d.name] as const));
  const ruleSentenceById = new Map(
    rules.map((r) => [r.id, describeScopeRule(r, topicLabelByKey, dataSlotLabelByKey)] as const)
  );

  /** Resolve a finding's `targetKey` (`topic:<key>` | `rule:<id>` | `settings`) into a readable label. */
  function resolveTarget(targetKey: string): string {
    if (targetKey === 'settings') return 'Conditional topics settings';
    if (targetKey.startsWith('topic:')) {
      const key = targetKey.slice('topic:'.length);
      return topicLabelByKey.get(key) ?? key;
    }
    if (targetKey.startsWith('rule:')) {
      const id = targetKey.slice('rule:'.length);
      return ruleSentenceById.get(id) ?? id;
    }
    return targetKey;
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(
        await apiClient.post<ScopeEvaluationPreviewResponse>(
          API.APP.QUESTIONNAIRES.versionScopeEvaluatePreview(questionnaireId, versionId),
          { body: {} }
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The evaluation could not be run.');
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  if (topics.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gavel className="text-muted-foreground h-4 w-4" aria-hidden="true" />
          AI review of this setup
          <FieldHelp title="What this does">
            <p>
              Runs four judges over your topics, hard rules, budget and planner instructions —
              independent of each other, each scoring one thing: whether topic criteria are specific
              and observable, whether the rules are sound, whether the budget is realistic, and
              whether any topic risks being unreachable or the set overburdens a respondent.
            </p>
            <p className="mt-2">
              It writes nothing. Each run costs four model calls. This is a structural review of
              your config — it does not read any respondent session.
            </p>
          </FieldHelp>
        </CardTitle>
        <CardDescription>
          A second opinion on how this scope config is designed, independent of the coherence checks
          above.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void run()} disabled={disabled || running} size="sm">
            {running ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <PlayCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
            )}
            {running ? 'Evaluating…' : 'Run evaluation'}
          </Button>
          <Button asChild type="button" variant="ghost" size="sm">
            <Link
              href={`/admin/questionnaires/${questionnaireId}/v/${versionId}/topics/evaluations`}
            >
              <History className="mr-1.5 h-4 w-4" aria-hidden="true" />
              View past runs
            </Link>
          </Button>
          {result && (
            <span className="text-muted-foreground text-xs">
              {result.summary.totalFindings} finding{result.summary.totalFindings === 1 ? '' : 's'}
              {result.summary.dimensionsFailed > 0 &&
                ` · ${result.summary.dimensionsFailed} judge${result.summary.dimensionsFailed === 1 ? '' : 's'} unavailable`}
            </span>
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

        {result && (
          <div className="space-y-4 border-t pt-4">
            {result.results.map((dimensionResult) => {
              const spec = SCOPE_EVALUATION_DIMENSION_SPECS[dimensionResult.dimension];
              return (
                <div key={dimensionResult.dimension} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{spec.label}</span>
                    {dimensionResult.verdict ? (
                      <Badge variant={scoreVariant(dimensionResult.verdict.score)}>
                        {scoreLabel(dimensionResult.verdict.score)}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{dimensionResult.diagnostic ?? 'unavailable'}</Badge>
                    )}
                  </div>
                  {dimensionResult.verdict && dimensionResult.verdict.findings.length === 0 && (
                    <p className="text-muted-foreground text-xs">No findings on this dimension.</p>
                  )}
                  {dimensionResult.verdict && dimensionResult.verdict.findings.length > 0 && (
                    <ul className="space-y-1.5">
                      {dimensionResult.verdict.findings.map((finding, i) => {
                        const sev = findingSeverityBadge(finding.severity);
                        return (
                          <li key={i} className="bg-muted/25 rounded-md border p-2 text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={sev.variant}>{sev.label}</Badge>
                              <span className="font-medium">
                                {resolveTarget(finding.targetKey)}
                              </span>
                            </div>
                            <p className="mt-1 leading-relaxed">{finding.proposedChange}</p>
                            <p className="text-muted-foreground mt-1 leading-relaxed">
                              {finding.rationale}
                            </p>
                            {finding.sourceQuote && (
                              <p className="text-muted-foreground mt-1 leading-relaxed italic">
                                “{finding.sourceQuote}”
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
