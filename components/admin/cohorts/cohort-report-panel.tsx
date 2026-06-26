'use client';

/**
 * CohortReportPanel — the cohort (synthesis) report surface (report kind `cohort`).
 *
 * Owner-agnostic: it consumes a {@link ReportApi} (round- or version-scoped) rather than building
 * round URLs itself, so the SAME panel serves both a round's report and a version-wide report. It
 * loads the report view (status + working-head content + the dataset the charts render against) and
 * offers Generate / Regenerate, Edit, Publish, PDF and revision history. Generation STREAMS its build
 * phases over SSE — the admin watches the report assemble ("Reading responses…", "Writing the
 * report…") instead of waiting on a 90-second spinner; on the terminal `done` event the view is
 * re-fetched.
 *
 * Round mode passes `versions` (a round bundles several) → a version selector; switching versions is
 * lifted to the parent (`onVersionChange`) which rebuilds the `api`. Version mode passes a single
 * `api` and no `versions` → no selector.
 */

import * as React from 'react';
import { Loader2, Sparkles, RefreshCw, Pencil, Download, History, Globe } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CohortChart } from '@/components/admin/questionnaires/cohort-report/charts/cohort-chart';
import { CohortSectionBody } from '@/components/admin/questionnaires/cohort-report/cohort-section-body';
import { CohortReportEditor } from '@/components/admin/questionnaires/cohort-report/cohort-report-editor';
import type { ReportApi } from '@/components/admin/cohorts/report-api';
import { apiClient, APIClientError } from '@/lib/api/client';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { buildChartData } from '@/lib/app/questionnaire/cohort-report/chart-series';
import type { CohortReportView } from '@/lib/app/questionnaire/cohort-report/view';
import type { CohortReportRevisionSummary } from '@/lib/app/questionnaire/cohort-report/persist';
import type { ChartSpec } from '@/lib/app/questionnaire/cohort-report/chart-types';
import type {
  ReportGenEvent,
  ReportGenProgressEvent,
} from '@/lib/app/questionnaire/cohort-report/report-events';

export interface CohortReportPanelProps {
  /** Endpoint/body bundle for the active scope (round + selected version, or a single version). */
  api: ReportApi;
  /**
   * Bundled questionnaire versions (round mode — a round bundles several). Renders a selector when
   * more than one. Omit for version mode (single version, no selector).
   */
  versions?: Array<{ versionId: string; title: string }>;
  /** The selected version id (drives the selector's value). */
  versionId?: string;
  /** Called when the selector changes — the parent rebuilds `api` for the new version. */
  onVersionChange?: (versionId: string) => void;
}

/** Friendly copy for a streamed generation phase. */
function phaseLabel(ev: ReportGenProgressEvent): string {
  switch (ev.type) {
    case 'started':
      return 'Starting…';
    case 'dataset_built':
      return `Analysed ${ev.sessionCount ?? 0} respondents across ${ev.segmentCount ?? 0} segments`;
    case 'material_built':
      return 'Reading responses…';
    case 'context_loaded':
      return 'Loading context…';
    case 'synthesizing':
      return 'Writing the report…';
    default:
      return 'Working…';
  }
}

export function CohortReportPanel({
  api,
  versions,
  versionId,
  onVersionChange,
}: CohortReportPanelProps) {
  const [view, setView] = React.useState<CohortReportView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [genPhase, setGenPhase] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [revisions, setRevisions] = React.useState<CohortReportRevisionSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const { viewUrl } = api;

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get<CohortReportView>(viewUrl);
      setView(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to load the cohort report.');
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [viewUrl]);

  // Round mode with zero bundled versions has no scope to load — skip the fetch (the render below
  // shows the "attach a questionnaire" prompt instead).
  const noVersions = versions !== undefined && versions.length === 0;
  React.useEffect(() => {
    if (noVersions) return;
    void load();
  }, [load, noVersions]);

  async function handleGenerate() {
    setGenerating(true);
    setGenPhase('Starting…');
    setError(null);
    try {
      const res = await fetch(api.generateStreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ...api.body }),
      });

      // A non-2xx (rate limit, flag off, validation) returns the JSON error envelope, not a stream.
      if (!res.ok || !res.body) {
        let message: string | undefined;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          message = body.error?.message;
        } catch {
          // Non-JSON body — fall through to the generic message.
        }
        setError(message ?? `Cohort report generation failed (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      let streamError: string | null = null;

      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            const ev = parsed.data as unknown as ReportGenEvent;
            if (ev.type === 'done') {
              done = true;
            } else if (ev.type === 'error') {
              streamError = ev.message;
            } else {
              setGenPhase(phaseLabel(ev));
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (streamError) {
        setError(streamError);
      } else if (done) {
        await load();
      } else {
        setError('Generation did not complete. Try again.');
      }
    } catch {
      setError('Cohort report generation failed.');
    } finally {
      setGenerating(false);
      setGenPhase(null);
    }
  }

  async function handlePublishToggle() {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const next =
        view.publishStatus === 'published'
          ? await apiClient.delete<CohortReportView>(api.publishUrl, { body: { ...api.body } })
          : await apiClient.post<CohortReportView>(api.publishUrl, { body: { ...api.body } });
      setView(next);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Publish failed.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory() {
    if (revisions) {
      setRevisions(null);
      return;
    }
    try {
      const data = await apiClient.get<{ revisions: CohortReportRevisionSummary[] }>(
        api.revisionsUrl
      );
      setRevisions(data.revisions);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to load history.');
    }
  }

  async function restore(revisionNumber: number) {
    setBusy(true);
    setError(null);
    try {
      const next = await apiClient.post<CohortReportView>(api.revisionsUrl, {
        body: { ...api.body, revisionNumber },
      });
      setView(next);
      setRevisions(null);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  }

  // Round mode with no bundled versions: nothing to analyse yet.
  if (versions && versions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Attach a questionnaire to this round to generate a cohort report.
      </p>
    );
  }

  const content = view?.content ?? null;
  const dataset = view?.dataset ?? null;
  const chartById = new Map<string, ChartSpec>((content?.charts ?? []).map((c) => [c.id, c]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {versions && versions.length > 1 && (
          <select
            value={versionId ?? ''}
            onChange={(e) => onVersionChange?.(e.target.value)}
            className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            aria-label="Questionnaire version"
          >
            {versions.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                {v.title}
              </option>
            ))}
          </select>
        )}
        <Button onClick={() => void handleGenerate()} disabled={generating || loading} size="sm">
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : view?.exists ? (
            <RefreshCw className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {view?.exists ? 'Regenerate' : 'Generate report'}
        </Button>
        {content && !editing && (
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handlePublishToggle()}
              disabled={busy}
            >
              <Globe className="h-4 w-4" />
              {view?.publishStatus === 'published' ? 'Unpublish' : 'Publish'}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={api.pdfUrl} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4" /> PDF
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void toggleHistory()}>
              <History className="h-4 w-4" /> History
            </Button>
          </>
        )}
        {view?.status === 'ready' && view.revisionNumber !== null && (
          <span className="text-muted-foreground text-xs">
            Revision {view.revisionNumber} · {view.publishStatus}
            {view.publishedRevisionNumber !== null && ` (r${view.publishedRevisionNumber} live)`}
          </span>
        )}
      </div>

      {revisions && (
        <div className="rounded-lg border p-3" data-testid="cohort-report-history">
          <h4 className="mb-2 text-sm font-semibold">Revision history</h4>
          <ul className="space-y-1 text-sm">
            {revisions.map((r) => (
              <li key={r.revisionNumber} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  r{r.revisionNumber} · {r.authoredBy}
                  {r.summary ? ` · ${r.summary}` : ''}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void restore(r.revisionNumber)}
                  disabled={busy}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading && !content && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}

      {generating && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {genPhase ?? 'Analysing the cohort and writing the report…'}
        </p>
      )}

      {!loading && !generating && !content && (
        <p className="text-muted-foreground text-sm">
          No report yet. Generate one to analyse {dataset?.totalSessions ?? 0} respondents.
        </p>
      )}

      {content && dataset && editing && (
        <CohortReportEditor
          patchUrl={api.patchUrl}
          body={api.body}
          {...(api.refineUrl ? { refineUrl: api.refineUrl } : {})}
          content={content}
          onSaved={(v) => {
            setView(v);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {content && dataset && !editing && (
        <article className="space-y-6" data-testid="cohort-report-body">
          {content.summary && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Summary</h3>
              <CohortSectionBody body={content.summary} format="html" />
            </section>
          )}

          {content.sections.map((section, i) => (
            <section key={i} className="space-y-3">
              <h3 className="text-base font-semibold">{section.heading}</h3>
              <CohortSectionBody body={section.body} format={section.format} />
              {section.chartIds
                .map((id) => chartById.get(id))
                .filter((spec): spec is ChartSpec => !!spec)
                .map((spec) => (
                  <CohortChart key={spec.id} data={buildChartData(spec, dataset)} />
                ))}
            </section>
          ))}

          {content.recommendations.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Recommendations</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {content.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </section>
          )}

          {content.actions.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Actions</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {content.actions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}
        </article>
      )}
    </div>
  );
}
