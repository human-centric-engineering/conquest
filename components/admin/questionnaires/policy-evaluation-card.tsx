'use client';

/**
 * The interviewer-policy judge panel (F18.8) — a third structural review, alongside the
 * design-evaluation panel (questions) and the Conditional Topics panel (routing). This one scores the
 * INTERVIEWER POLICY: house rules, the questioning arc, and the per-question ask-as-written dial.
 *
 * Ephemeral, like both siblings' first phase: this card runs the panel against `evaluate-preview`
 * and shows the result in place, persisting nothing.
 *
 * **The dirty-editor guard is load-bearing and has no precedent on the Topics tab.** The Settings
 * page holds *unsaved* editor state while the panel judges *saved* config. Without the guard an
 * admin runs four paid judges against a version that does not match what is on screen, reads
 * findings about text they already changed, and reasonably concludes the panel is broken. So the
 * run button is disabled while the editor is dirty, and the card says why.
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
  POLICY_EVALUATION_DIMENSION_SPECS,
  describePolicyProposedEdit,
  type PolicyEvaluationDimension,
  type PolicyJudgeFinding,
} from '@/lib/app/questionnaire/policy-evaluation';

interface PolicyDimensionResultView {
  dimension: PolicyEvaluationDimension;
  verdict?: { dimension: PolicyEvaluationDimension; score: number; findings: PolicyJudgeFinding[] };
  diagnostic?: string;
}

interface PolicyEvaluationPreviewResponse {
  results: PolicyDimensionResultView[];
  summary: {
    dimensionsRequested: number;
    dimensionsRun: number;
    dimensionsFailed: number;
    totalFindings: number;
  };
}

export interface PolicyEvaluationCardProps {
  questionnaireId: string;
  versionId: string;
  /** Rule id → its text, so a `house_rule:<id>` finding names the rule rather than an opaque id. */
  ruleTextById: Readonly<Record<string, string>>;
  /** Question key → prompt, for a `question:<key>` finding. */
  questionPromptByKey: Readonly<Record<string, string>>;
  /** True when the questionnaire never runs a conversation — the panel has nothing to judge. */
  formOnly?: boolean;
  /** True while the Settings editor holds unsaved changes. See the module doc. */
  dirty?: boolean;
}

/** A score in [0, 1] rendered the way an author reads a percentage. */
function scoreLabel(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function scoreVariant(score: number): 'default' | 'secondary' | 'destructive' {
  if (score >= 0.8) return 'default';
  if (score >= 0.5) return 'secondary';
  return 'destructive';
}

export function PolicyEvaluationCard({
  questionnaireId,
  versionId,
  ruleTextById,
  questionPromptByKey,
  formOnly = false,
  dirty = false,
}: PolicyEvaluationCardProps) {
  const [result, setResult] = useState<PolicyEvaluationPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  /** Resolve a finding's `targetKey` into something an admin recognises. */
  function resolveTarget(targetKey: string): string {
    if (targetKey === 'house_rules') return 'House rules';
    if (targetKey === 'strategy') return 'Questioning approach';
    if (targetKey === 'fidelity') return 'Asking questions as written';
    if (targetKey === 'tone') return 'Interviewer tone';
    if (targetKey.startsWith('house_rule:')) {
      const id = targetKey.slice('house_rule:'.length);
      return ruleTextById[id] ?? `Rule ${id}`;
    }
    if (targetKey.startsWith('question:')) {
      const key = targetKey.slice('question:'.length);
      // Named as a fidelity finding, so it can never be confused with the question-design panel's
      // findings about the same question's wording.
      return `Fidelity — “${questionPromptByKey[key] ?? key}”`;
    }
    return targetKey;
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(
        await apiClient.post<PolicyEvaluationPreviewResponse>(
          API.APP.QUESTIONNAIRES.versionPolicyEvaluatePreview(questionnaireId, versionId),
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gavel className="text-muted-foreground h-4 w-4" aria-hidden="true" />
          Interviewer review
          <FieldHelp title="What this does">
            <p>
              Runs four independent reviewers over how your interviewer is set up — your house
              rules, the questioning approach and pace, and which questions must be asked as
              written. Each scores one thing: whether the rules say something the interviewer can
              act on, whether the approach suits this questionnaire, whether the ask-as-written dial
              is set consistently, and whether any of these settings quietly work against each
              other.
            </p>
            <p className="mt-2">
              It writes nothing. Each run costs four model calls, and it reviews your setup — never
              a respondent’s answers.
            </p>
          </FieldHelp>
        </CardTitle>
        <CardDescription>
          A second opinion on how this interviewer is set up, beyond the checks above.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {formOnly ? (
          <p className="text-muted-foreground text-sm">
            This questionnaire is filled in as a form, so there is no conversation and nothing here
            to review.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={() => void run()}
                disabled={running || dirty}
                size="sm"
              >
                {running ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <PlayCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
                )}
                {running ? 'Reviewing…' : 'Run review'}
              </Button>
              <Button asChild type="button" variant="ghost" size="sm">
                <Link
                  href={`/admin/questionnaires/${questionnaireId}/v/${versionId}/settings/policy-evaluations`}
                >
                  <History className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  View past runs
                </Link>
              </Button>
              {result && (
                <span className="text-muted-foreground text-xs">
                  {result.summary.totalFindings} finding
                  {result.summary.totalFindings === 1 ? '' : 's'}
                  {result.summary.dimensionsFailed > 0 &&
                    ` · ${result.summary.dimensionsFailed} reviewer${result.summary.dimensionsFailed === 1 ? '' : 's'} unavailable`}
                </span>
              )}
            </div>

            {dirty && (
              <p className="text-muted-foreground text-xs">
                Save your changes first — the review reads the saved version, so it would not see
                what you have just edited.
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

            {result && (
              <div className="space-y-4 border-t pt-4">
                {result.results.map((dimensionResult) => {
                  const spec = POLICY_EVALUATION_DIMENSION_SPECS[dimensionResult.dimension];
                  return (
                    <div key={dimensionResult.dimension} className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{spec.label}</span>
                        {dimensionResult.verdict ? (
                          <Badge variant={scoreVariant(dimensionResult.verdict.score)}>
                            {scoreLabel(dimensionResult.verdict.score)}
                          </Badge>
                        ) : (
                          <Badge variant="outline">
                            {dimensionResult.diagnostic ?? 'unavailable'}
                          </Badge>
                        )}
                      </div>
                      {dimensionResult.verdict && dimensionResult.verdict.findings.length === 0 && (
                        <p className="text-muted-foreground text-xs">
                          Nothing to raise on this one.
                        </p>
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
                                  {finding.proposedEdit && (
                                    <Badge variant="outline">
                                      {describePolicyProposedEdit(finding.proposedEdit)}
                                    </Badge>
                                  )}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
