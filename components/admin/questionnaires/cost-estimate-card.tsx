'use client';

/**
 * CostEstimateCard (F3.3) — surfaces the pre-launch cost estimate for a
 * questionnaire version. Used in two places:
 *
 *   - `variant="card"` inside the config editor, next to the budget/cap inputs,
 *     with an expected-respondents control and an over-budget note that compares
 *     the per-session figure against the (live, possibly unsaved) `costBudgetUsd`.
 *   - `variant="banner"` on the invitations page, a compact one-line read-out.
 *
 * Fetches the version estimate once (`?respondents=1`) and scales the
 * per-questionnaire figure client-side as the admin changes the respondent count
 * — `perQuestionnaire = perSession × respondents` is pure multiplication, so a
 * single GET per surface suffices (no refetch per keystroke). Re-fetches only when
 * `reloadKey` changes (the config editor bumps it after a successful save, since
 * the cap/floor affect the per-session figure).
 *
 * The estimate is heuristic (no real session history exists until P6); the copy
 * says so, and `pricingKnown === false` is surfaced as "pricing not configured"
 * rather than a misleading $0.00.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { formatUsd } from '@/lib/utils/format-currency';
import { scaleRange } from '@/lib/app/questionnaire/cost-estimation';
import type { SessionCostEstimate } from '@/lib/app/questionnaire/cost-estimation';

/** Server caps `respondents` at 10 000; mirror it so the client multiplier can't overflow to Infinity. */
const MAX_RESPONDENTS = 10_000;

/** Coerce a raw input value to an integer respondent count in `[1, MAX_RESPONDENTS]`. */
function clampRespondents(raw: number): number {
  return Math.min(MAX_RESPONDENTS, Math.max(1, Math.floor(raw) || 1));
}

export interface CostEstimateCardProps {
  questionnaireId: string;
  versionId: string;
  /** Bump to force a re-fetch (e.g. after a config save changes the cap/floor). */
  reloadKey?: string | number;
  /**
   * Live per-session budget cap to compare against — drives the over-budget note
   * in the config editor. `null`/omitted = no comparison.
   */
  costBudgetUsd?: number | null;
  variant?: 'card' | 'banner';
}

export function CostEstimateCard({
  questionnaireId,
  versionId,
  reloadKey,
  costBudgetUsd = null,
  variant = 'card',
}: CostEstimateCardProps) {
  const [estimate, setEstimate] = useState<SessionCostEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [respondents, setRespondents] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient
      .get<SessionCostEstimate>(
        API.APP.QUESTIONNAIRES.versionCostEstimate(questionnaireId, versionId),
        {
          params: { respondents: 1 },
        }
      )
      .then((data) => {
        if (!cancelled) setEstimate(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof APIClientError ? err.message : 'Could not load cost estimate.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [questionnaireId, versionId, reloadKey]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Estimating cost…
      </div>
    );
  }

  if (error || !estimate) {
    return <p className="text-muted-foreground text-sm">{error ?? 'Cost estimate unavailable.'}</p>;
  }

  const perQuestionnaire = scaleRange(estimate.perSession, respondents);

  // Pricing unknown or no questions: token volume is estimated but USD is withheld.
  if (!estimate.pricingKnown || estimate.assumptions.effectiveQuestionsPerSession === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="cost-estimate-unavailable">
        {estimate.notes}
      </p>
    );
  }

  const overBudget =
    costBudgetUsd !== null && costBudgetUsd > 0 && estimate.perSession.midUsd > costBudgetUsd;

  if (variant === 'banner') {
    return (
      <div className="bg-muted/30 rounded-md border px-3 py-2 text-sm">
        <span className="font-medium">≈ {formatUsd(perQuestionnaire.midUsd)}</span>{' '}
        <span className="text-muted-foreground">
          to invite{' '}
          <input
            type="number"
            min={1}
            max={MAX_RESPONDENTS}
            value={respondents}
            onChange={(e) => setRespondents(clampRespondents(Number(e.target.value)))}
            className="border-input bg-background w-16 rounded border px-1.5 py-0.5 text-sm"
            aria-label="Expected respondents"
          />{' '}
          respondent{respondents === 1 ? '' : 's'} (≈ {formatUsd(estimate.perSession.midUsd)}
          /session, heuristic)
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="cost-estimate-card">
      <div className="flex items-center gap-2">
        <h4 className="font-medium">Estimated cost</h4>
        <FieldHelp title="Estimated cost">
          A heuristic projection of LLM spend per respondent session, priced against the default
          chat model. There is no real session history yet (the conversation engine lands later), so
          treat the range as indicative, not a quote.
        </FieldHelp>
      </div>

      <div className="grid gap-1">
        <div>
          <span className="font-medium">{formatUsd(estimate.perSession.midUsd)}</span>{' '}
          <span className="text-muted-foreground">
            per session (range {formatUsd(estimate.perSession.lowUsd)}–
            {formatUsd(estimate.perSession.highUsd)})
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Label className="text-muted-foreground text-sm font-normal">Expected respondents</Label>
          <Input
            type="number"
            min={1}
            max={MAX_RESPONDENTS}
            value={respondents}
            onChange={(e) => setRespondents(clampRespondents(Number(e.target.value)))}
            className="h-7 w-20"
            aria-label="Expected respondents"
          />
          <span className="text-muted-foreground">
            →{' '}
            <span className="text-foreground font-medium">
              {formatUsd(perQuestionnaire.midUsd)}
            </span>{' '}
            total (range {formatUsd(perQuestionnaire.lowUsd)}–{formatUsd(perQuestionnaire.highUsd)})
          </span>
        </div>
      </div>

      {overBudget && (
        <p className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
          The per-session estimate exceeds your cost budget of {formatUsd(costBudgetUsd)}.
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        Heuristic — {estimate.assumptions.effectiveQuestionsPerSession} question
        {estimate.assumptions.effectiveQuestionsPerSession === 1 ? '' : 's'}/session against{' '}
        {estimate.model}.
      </p>
    </div>
  );
}
