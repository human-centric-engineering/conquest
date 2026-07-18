/**
 * "How this report was created" — the shared presentational panel for a report's method record.
 *
 * One renderer, two surfaces: the respondent opens it from their completion screen (in a dialog), and
 * an admin sees it inline in the Sessions drawer's Report tab. Following the same discipline as
 * `report-body.tsx` — a single component across every surface — so the explanation an operator reviews
 * is literally the one the respondent read, plus the operational detail.
 *
 * Purely presentational: no hooks, no fetching. Everything it renders comes from
 * `buildReportMethodView`, which decides per audience what is even present (`admin` is absent from a
 * respondent view, so this component cannot leak it).
 */

import { ExternalLink } from 'lucide-react';

import type { ReportMethodClientView } from '@/lib/app/questionnaire/report/method-view';
import type { ReportMethodStage } from '@/lib/app/questionnaire/report/method-record';
import { cn } from '@/lib/utils';

/** Human labels for the pipeline stages — admin detail only. */
const STAGE_LABELS: Record<ReportMethodStage['key'], string> = {
  answers: 'Read the answers',
  coverage: 'Listed unanswered questions as gaps',
  knowledge: "Searched the client's documents",
  research_before: 'Web research (before writing)',
  write: 'Wrote the report',
  format: 'Formatting pass',
  research_after: 'Web research (after writing)',
  appendix: 'Supporting appendix',
};

/** Why a stage didn't run, in operator language. */
const SKIP_LABELS: Record<string, string> = {
  disabled: 'off in config',
  unavailable: 'not available',
  not_applicable: 'nothing to do',
  failed: 'failed',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Strip the scheme and any trailing slash so a source list reads as domains, not raw URLs. */
function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface ReportMethodPanelProps {
  view: ReportMethodClientView;
  /**
   * `screen` for the respondent dialog (roomier, warmer). `admin` for the drawer (denser, and renders
   * the operational detail when the view carries it).
   */
  variant?: 'screen' | 'admin';
  className?: string;
}

export function ReportMethodPanel({ view, variant = 'screen', className }: ReportMethodPanelProps) {
  const dense = variant === 'admin';

  return (
    <div className={cn('space-y-5 text-left', dense && 'space-y-4', className)}>
      {view.preview && (
        <p className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs">
          This is a sample report generated from a made-up respondent — no real answers, documents,
          or web sources were involved.
        </p>
      )}

      {/* The narration. */}
      <p className={cn('text-foreground leading-relaxed', dense ? 'text-sm' : 'text-[15px]')}>
        {view.summary}
      </p>

      {/* The verifiable counts beneath it — the reason the prose can be trusted. */}
      {view.facts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-muted-foreground/70 text-[11px] font-semibold tracking-wide uppercase">
            What went into it
          </h3>
          <dl className="divide-border divide-y rounded-md border">
            {view.facts.map((fact) => (
              <div key={fact.key} className="flex items-center justify-between gap-4 px-3 py-2">
                <dt className="text-muted-foreground text-sm">{fact.label}</dt>
                <dd className="text-foreground text-sm font-medium tabular-nums">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {view.checks.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-muted-foreground/70 text-[11px] font-semibold tracking-wide uppercase">
            Checks applied
          </h3>
          <ul className="space-y-1.5">
            {view.checks.map((check) => (
              <li key={check} className="text-muted-foreground flex gap-2 text-sm leading-relaxed">
                <span aria-hidden="true" className="text-muted-foreground/50 select-none">
                  •
                </span>
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.sources.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-muted-foreground/70 text-[11px] font-semibold tracking-wide uppercase">
            Web sources
          </h3>
          <ul className="space-y-1.5">
            {view.sources.map((source) => (
              <li key={source.url} className="text-sm leading-relaxed">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-foreground hover:text-primary inline-flex items-start gap-1.5 underline-offset-4 hover:underline"
                >
                  <span>{source.title || displayHost(source.url)}</span>
                  <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
                </a>
                <span className="text-muted-foreground/70 ml-1.5 text-xs">
                  {displayHost(source.url)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.admin && (
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-muted-foreground/70 text-[11px] font-semibold tracking-wide uppercase">
            Generation detail (admin only)
          </h3>

          <dl className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {view.admin.model && (
              <>
                <dt>Model</dt>
                <dd className="text-foreground truncate">
                  {view.admin.model.model} ({view.admin.model.tier})
                </dd>
                <dt>Provider</dt>
                <dd className="text-foreground">{view.admin.model.provider}</dd>
              </>
            )}
            <dt>Duration</dt>
            <dd className="text-foreground tabular-nums">
              {formatDuration(view.admin.durationMs)}
            </dd>
            <dt>Cost</dt>
            <dd className="text-foreground tabular-nums">${view.admin.costUsd.toFixed(4)}</dd>
            <dt>Explanation</dt>
            <dd className="text-foreground">
              {view.admin.summarySource === 'agent'
                ? 'agent-written (passed grounding checks)'
                : 'deterministic fallback'}
            </dd>
          </dl>

          {view.admin.documents.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-muted-foreground text-xs font-medium">Documents used</p>
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {view.admin.documents.map((doc) => (
                  <li key={doc.id} className="flex justify-between gap-3">
                    <span className="truncate">{doc.name}</span>
                    <span className="shrink-0 tabular-nums">
                      {doc.snippets} passage{doc.snippets === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.admin.searches.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-muted-foreground text-xs font-medium">Searches issued</p>
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {view.admin.searches.map((search, i) => (
                  <li key={`${search.phase}-${i}`} className="flex justify-between gap-3">
                    <span className="truncate">
                      <span className="opacity-60">{search.phase}</span>{' '}
                      {search.query || <em>(no query)</em>}
                    </span>
                    <span className="shrink-0 tabular-nums">{search.resultCount}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.admin.stages.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-muted-foreground text-xs font-medium">Stages</p>
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {view.admin.stages.map((stage) => (
                  <li key={stage.key} className="flex justify-between gap-3">
                    <span className={cn('truncate', !stage.ran && 'opacity-60')}>
                      {STAGE_LABELS[stage.key]}
                    </span>
                    <span className="shrink-0">
                      {stage.ran ? (
                        <span className="text-foreground">ran</span>
                      ) : (
                        <span className="opacity-70">
                          skipped
                          {stage.skipReason ? ` — ${SKIP_LABELS[stage.skipReason]}` : ''}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
