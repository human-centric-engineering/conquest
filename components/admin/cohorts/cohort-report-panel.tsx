'use client';

/**
 * CohortReportPanel — the round's Cohort Report surface (report kind `cohort`, F14.3 read view).
 *
 * Picks a bundled version, loads its cohort-report view (status + working-head content + the dataset
 * the charts render against), and offers Generate / Regenerate. Renders the woven narrative
 * (markdown), the proposed charts (resolved client-side via the shared `buildChartData` → `CohortChart`),
 * recommendations and actions. The full block editor + per-section AI-assist land in F14.5; this is
 * the read + generate surface.
 */

import * as React from 'react';
import { Loader2, Sparkles, RefreshCw, Pencil, Download, History, Globe } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CohortChart } from '@/components/admin/questionnaires/cohort-report/charts/cohort-chart';
import { CohortSectionBody } from '@/components/admin/questionnaires/cohort-report/cohort-section-body';
import { CohortReportEditor } from '@/components/admin/questionnaires/cohort-report/cohort-report-editor';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { buildChartData } from '@/lib/app/questionnaire/cohort-report/chart-series';
import type { CohortReportView } from '@/lib/app/questionnaire/cohort-report/view';
import type { CohortReportRevisionSummary } from '@/lib/app/questionnaire/cohort-report/persist';
import type { ChartSpec } from '@/lib/app/questionnaire/cohort-report/chart-types';

export interface CohortReportPanelProps {
  roundId: string;
  /** The round's bundled questionnaire versions (the analysis is per-version). */
  versions: Array<{ versionId: string; title: string }>;
}

export function CohortReportPanel({ roundId, versions }: CohortReportPanelProps) {
  const [versionId, setVersionId] = React.useState(versions[0]?.versionId ?? '');
  const [view, setView] = React.useState<CohortReportView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [revisions, setRevisions] = React.useState<CohortReportRevisionSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!versionId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get<CohortReportView>(
        `${API.APP.ROUNDS.cohortReport(roundId)}?versionId=${encodeURIComponent(versionId)}`
      );
      setView(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to load the cohort report.');
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [roundId, versionId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const data = await apiClient.post<CohortReportView>(
        API.APP.ROUNDS.cohortReportGenerate(roundId),
        { body: { versionId } }
      );
      setView(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Cohort report generation failed.');
    } finally {
      setGenerating(false);
    }
  }

  async function handlePublishToggle() {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const path = API.APP.ROUNDS.cohortReportPublish(roundId);
      const next =
        view.publishStatus === 'published'
          ? await apiClient.delete<CohortReportView>(path, { body: { versionId } })
          : await apiClient.post<CohortReportView>(path, { body: { versionId } });
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
        API.APP.ROUNDS.cohortReportRevisions(roundId)
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
      const next = await apiClient.post<CohortReportView>(
        API.APP.ROUNDS.cohortReportRevisions(roundId),
        { body: { versionId, revisionNumber } }
      );
      setView(next);
      setRevisions(null);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  }

  const pdfHref = `${API.APP.ROUNDS.cohortReportPdf(roundId)}?versionId=${encodeURIComponent(versionId)}`;

  if (versions.length === 0) {
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
        {versions.length > 1 && (
          <select
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
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
              <a href={pdfHref} target="_blank" rel="noopener noreferrer">
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
          <Loader2 className="h-4 w-4 animate-spin" /> Analysing the cohort and writing the report…
        </p>
      )}

      {!loading && !generating && !content && (
        <p className="text-muted-foreground text-sm">
          No report yet. Generate one to analyse this round&rsquo;s {dataset?.totalSessions ?? 0}{' '}
          respondents.
        </p>
      )}

      {content && dataset && editing && (
        <CohortReportEditor
          roundId={roundId}
          versionId={versionId}
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
