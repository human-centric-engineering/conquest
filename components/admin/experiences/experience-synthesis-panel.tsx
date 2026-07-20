'use client';

/**
 * The experience-wide synthesis panel (P15.8).
 *
 * Sits above the per-step report tabs on the Reports tab. Deliberately NOT the shared
 * `CohortReportPanel`: that component is built around a revision chain, publish state and a
 * dataset preview, none of which a synthesis has. Reusing it would mean disabling three of its four
 * affordances and explaining why.
 *
 * Generation is a plain POST rather than an SSE stream. There is one LLM call over already-loaded
 * prose, so there are no meaningful intermediate phases to report — a spinner tells the reader as
 * much as a phase label would, without a second code path.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import {
  SYNTHESIS_COVERAGE_REASON_LABELS,
  validateExperienceSynthesisContent,
  type ExperienceSynthesisContent,
  type ExperienceSynthesisCoverage,
  type ExperienceSynthesisStatus,
} from '@/lib/app/questionnaire/experiences/synthesis/types';

interface SynthesisView {
  exists: boolean;
  status: ExperienceSynthesisStatus;
  content: ExperienceSynthesisContent | null;
  coveredSteps: number;
  eligibleSteps: number;
  costUsd: number | null;
  error: string | null;
  generatedAt: string | null;
}

interface ExperienceSynthesisPanelProps {
  experienceId: string;
  /** Drives the vocabulary — a meeting has breakouts, a switcher has steps. */
  isMeeting: boolean;
}

/** Claims render identically; only the heading above them differs. */
function ClaimList({ claims }: { claims: ExperienceSynthesisContent['findings'] }) {
  return (
    <ul className="space-y-3">
      {claims.map((claim, index) => (
        <li key={index} className="text-sm">
          <p className="font-medium">{claim.statement}</p>
          {claim.detail ? <p className="text-muted-foreground mt-0.5">{claim.detail}</p> : null}
          {claim.sourceStepKeys.length > 0 ? (
            <p className="text-muted-foreground mt-1 text-xs">
              From:{' '}
              {claim.sourceStepKeys.map((key) => (
                <code key={key} className="bg-muted mr-1 rounded px-1 py-0.5">
                  {key}
                </code>
              ))}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The per-step ✓/✗ rows. Shared by the coverage block and the nothing-to-synthesise notice. */
function CoverageItems({ coverage }: { coverage: ExperienceSynthesisCoverage[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {coverage.map((entry) => (
        <li key={entry.stepKey} className="flex items-baseline gap-2 text-sm">
          <span aria-hidden className={entry.included ? 'text-emerald-600' : 'text-amber-600'}>
            {entry.included ? '✓' : '✗'}
          </span>
          <span>{entry.stepTitle}</span>
          <span className="text-muted-foreground text-xs">
            {SYNTHESIS_COVERAGE_REASON_LABELS[entry.reason]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CoverageList({
  coverage,
  isMeeting,
}: {
  coverage: ExperienceSynthesisCoverage[];
  isMeeting: boolean;
}) {
  if (coverage.length === 0) return null;
  const included = coverage.filter((c) => c.included).length;

  return (
    <div>
      <h4 className="text-sm font-medium">Coverage</h4>
      <p className="text-muted-foreground mt-0.5 text-sm">
        This synthesis covers {included} of {coverage.length}{' '}
        {isMeeting ? 'breakout(s)' : 'step(s)'}.
      </p>
      <CoverageItems coverage={coverage} />
    </div>
  );
}

export function ExperienceSynthesisPanel({
  experienceId,
  isMeeting,
}: ExperienceSynthesisPanelProps) {
  const [view, setView] = useState<SynthesisView | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Per-step coverage attached to a blocked generate (409), so the notice can name the gaps. */
  const [blockedCoverage, setBlockedCoverage] = useState<ExperienceSynthesisCoverage[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(API.APP.EXPERIENCES.synthesis(experienceId));
      const body = await parseApiResponse<SynthesisView>(res);
      if (body.success) setView(body.data);
      else setError(body.error.message);
    } catch {
      setError('Could not load the synthesis.');
    } finally {
      setLoading(false);
    }
  }, [experienceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(API.APP.EXPERIENCES.generateSynthesis(experienceId), {
        method: 'POST',
      });
      const body = await parseApiResponse<SynthesisView>(res);
      if (body.success) {
        setView(body.data);
        setBlockedCoverage([]);
      } else {
        setError(body.error.message);
        // A 409 NOTHING_TO_SYNTHESISE carries the per-step coverage precisely so the reader can be
        // told WHICH steps are still missing a report, rather than only that something is. Run it
        // through the same validator the stored content uses: `details` is an untrusted payload, and
        // a malformed one should degrade to the plain message instead of throwing.
        setBlockedCoverage(validateExperienceSynthesisContent(body.error.details).coverage);
      }
    } catch {
      setError('Generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const content = view?.content ?? null;
  const unit = isMeeting ? 'breakouts' : 'steps';

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base">Across the whole experience</CardTitle>
          <p className="text-muted-foreground mt-1 text-sm">
            One view over the finished {unit} — what held throughout, and where they diverged.
            Written from the {isMeeting ? 'breakout findings' : 'step reports'} below, never by
            re-reading responses.
          </p>
        </div>
        <Button
          onClick={() => {
            void generate();
          }}
          disabled={generating || loading}
          size="sm"
        >
          {generating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Writing…
            </>
          ) : content ? (
            <>
              <RefreshCw className="mr-2 h-4 w-4" /> Regenerate
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" /> Generate
            </>
          )}
        </Button>
      </CardHeader>

      <CardContent className="space-y-6">
        {error ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            {error}
            {blockedCoverage.length > 0 ? (
              <>
                <p className="mt-2 font-medium">
                  Waiting on {isMeeting ? 'these breakouts' : 'these steps'}:
                </p>
                <CoverageItems coverage={blockedCoverage} />
              </>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : !content ? (
          <p className="text-muted-foreground text-sm">
            Not generated yet. Generate the individual {isMeeting ? 'breakout' : 'step'} reports
            first, then synthesise across them.
          </p>
        ) : (
          <>
            {view?.status === 'failed' && view.error ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                The last regeneration failed, so this is the previous synthesis. {view.error}
              </div>
            ) : null}

            {content.narrative ? (
              <div>
                <h4 className="text-sm font-medium">Narrative</h4>
                <div className="text-muted-foreground mt-1 space-y-2 text-sm">
                  {content.narrative.split(/\n{2,}/).map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
              </div>
            ) : null}

            {content.findings.length > 0 ? (
              <div>
                <h4 className="mb-2 text-sm font-medium">Findings</h4>
                <ClaimList claims={content.findings} />
              </div>
            ) : null}

            {content.divergences.length > 0 ? (
              <div>
                <h4 className="mb-2 text-sm font-medium">Divergence</h4>
                <ClaimList claims={content.divergences} />
              </div>
            ) : null}

            <CoverageList coverage={content.coverage} isMeeting={isMeeting} />

            {content.caveats.length > 0 ? (
              <div>
                <h4 className="text-sm font-medium">Caveats</h4>
                <ul className="text-muted-foreground mt-1 list-disc space-y-1 pl-5 text-sm">
                  {content.caveats.map((caveat, i) => (
                    <li key={i}>{caveat}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {view?.generatedAt ? (
              <p className="text-muted-foreground text-xs">
                Generated {new Date(view.generatedAt).toLocaleString()}
                {view.costUsd !== null ? ` · $${view.costUsd.toFixed(4)}` : ''}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
