'use client';

/**
 * Persisted turn-evaluation search surface (admin).
 *
 * A filterable, sortable, paginated table of stored Turn Inspector verdicts across every preview
 * session, with a slide-over detail that fetches the full verdict + snapshot and exposes the
 * human-review controls (comment, learning flag, action-into-dataset). All list data comes from
 * the single enriched list endpoint (no per-row fetches); the detail is fetched once per open.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { parseApiResponse } from '@/lib/api/parse-response';
import { API } from '@/lib/api/endpoints';
import { TURN_EFFECTIVENESS } from '@/lib/app/questionnaire/turn-evaluation/schema';
import { validateTurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/schema';
import type { TurnEvaluationListItem, TurnEvaluationDetail } from '@/lib/app/questionnaire/views';
import type { PaginationMeta } from '@/types/api';
import { parsePaginationMeta } from '@/lib/validations/common';

/** The learning-flag vocabulary surfaced as filter options (mirrors the store's tuple). */
const FLAG_FILTER_OPTIONS = ['none', 'flagged', 'reviewed', 'actioned', 'dismissed'] as const;
import { TurnEvaluationVerdict } from '@/components/app/questionnaire/turn-evaluation/turn-evaluation-verdict';
import {
  TurnEvaluationReview,
  type ReviewFlagStatus,
} from '@/components/app/questionnaire/turn-evaluation/turn-evaluation-review';

interface Filters {
  flagStatus: string;
  effectiveness: string;
  model: string;
  minScore: string;
  maxScore: string;
  sortBy: 'createdAt' | 'overallScore';
  sortOrder: 'asc' | 'desc';
}

const EMPTY_FILTERS: Filters = {
  flagStatus: '',
  effectiveness: '',
  model: '',
  minScore: '',
  maxScore: '',
  sortBy: 'createdAt',
  sortOrder: 'desc',
};

const FLAG_BADGE: Record<string, string> = {
  none: 'bg-zinc-100 text-zinc-600',
  flagged: 'bg-amber-100 text-amber-700',
  reviewed: 'bg-blue-100 text-blue-700',
  actioned: 'bg-emerald-100 text-emerald-700',
  dismissed: 'bg-zinc-200 text-zinc-500',
};

export function TurnEvaluationsTable({
  initialItems,
  initialMeta,
}: {
  initialItems: TurnEvaluationListItem[];
  initialMeta: PaginationMeta;
}) {
  const [items, setItems] = useState(initialItems);
  const [meta, setMeta] = useState(initialMeta);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const fetchPage = useCallback(async (f: Filters, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), limit: '25' });
      params.set('sortBy', f.sortBy);
      params.set('sortOrder', f.sortOrder);
      if (f.flagStatus) params.set('flagStatus', f.flagStatus);
      if (f.effectiveness) params.set('effectiveness', f.effectiveness);
      if (f.model.trim()) params.set('model', f.model.trim());
      if (f.minScore) params.set('minScore', f.minScore);
      if (f.maxScore) params.set('maxScore', f.maxScore);

      const res = await fetch(`${API.APP.TURN_EVALUATIONS.ROOT}?${params.toString()}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('List request failed');
      const body = await parseApiResponse<TurnEvaluationListItem[]>(res);
      if (!body.success) throw new Error('List request failed');
      setItems(body.data);
      setMeta((prev) => parsePaginationMeta(body.meta) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load evaluations');
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch on filter/page change (skip the very first render — the server seeded page 1).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!mounted) {
      setMounted(true);
      return;
    }
    void fetchPage(filters, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function patchRow(id: string, next: { flagStatus: ReviewFlagStatus; comment: string | null }) {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? {
              ...it,
              flagStatus: next.flagStatus,
              commentPreview: next.comment
                ? next.comment.slice(0, 140) + (next.comment.length > 140 ? '…' : '')
                : null,
            }
          : it
      )
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-card flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <Field label="Flag">
          <select
            value={filters.flagStatus}
            onChange={(e) => updateFilter('flagStatus', e.target.value)}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="">Any</option>
            {FLAG_FILTER_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Effectiveness">
          <select
            value={filters.effectiveness}
            onChange={(e) => updateFilter('effectiveness', e.target.value)}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="">Any</option>
            {TURN_EFFECTIVENESS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model contains">
          <input
            value={filters.model}
            onChange={(e) => updateFilter('model', e.target.value)}
            placeholder="e.g. claude"
            className="rounded border px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Min score">
          <input
            type="number"
            min={0}
            max={100}
            value={filters.minScore}
            onChange={(e) => updateFilter('minScore', e.target.value)}
            className="w-20 rounded border px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Max score">
          <input
            type="number"
            min={0}
            max={100}
            value={filters.maxScore}
            onChange={(e) => updateFilter('maxScore', e.target.value)}
            className="w-20 rounded border px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Sort">
          <select
            value={`${filters.sortBy}:${filters.sortOrder}`}
            onChange={(e) => {
              const [sortBy, sortOrder] = e.target.value.split(':') as [
                Filters['sortBy'],
                Filters['sortOrder'],
              ];
              setPage(1);
              setFilters((prev) => ({ ...prev, sortBy, sortOrder }));
            }}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="createdAt:desc">Newest</option>
            <option value="createdAt:asc">Oldest</option>
            <option value="overallScore:desc">Score high→low</option>
            <option value="overallScore:asc">Score low→high</option>
          </select>
        </Field>
        {loading && <Loader2 className="text-muted-foreground mb-1 h-4 w-4 animate-spin" />}
      </div>

      {error && (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs tracking-wide uppercase">
            <tr>
              <th className="px-3 py-2">Questionnaire</th>
              <th className="px-3 py-2">Turn</th>
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Effectiveness</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Rubric</th>
              <th className="px-3 py-2">Flag</th>
              <th className="px-3 py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="text-muted-foreground px-3 py-8 text-center">
                  No evaluations match these filters.
                </td>
              </tr>
            )}
            {items.map((it) => (
              <tr
                key={it.id}
                onClick={() => setOpenId(it.id)}
                className="hover:bg-muted/40 cursor-pointer border-t"
              >
                <td className="px-3 py-2">
                  <div className="font-medium">{it.questionnaireTitle ?? '—'}</div>
                  {it.versionNumber !== null && (
                    <div className="text-muted-foreground text-xs">v{it.versionNumber}</div>
                  )}
                </td>
                <td className="px-3 py-2">#{it.turnOrdinal}</td>
                <td className="px-3 py-2 font-semibold">{it.overallScore}</td>
                <td className="px-3 py-2">{it.effectiveness}</td>
                <td className="px-3 py-2 font-mono text-xs">{it.evaluatorModel}</td>
                <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                  {it.rubricVersion}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                      FLAG_BADGE[it.flagStatus] ?? FLAG_BADGE.none
                    }`}
                  >
                    {it.flagStatus}
                  </span>
                </td>
                <td className="text-muted-foreground px-3 py-2 text-xs">
                  {new Date(it.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {meta.total} evaluation{meta.total === 1 ? '' : 's'} · page {meta.page} /{' '}
          {meta.totalPages}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded border px-3 py-1 disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page >= meta.totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
            className="rounded border px-3 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>

      {openId && (
        <DetailDrawer evalId={openId} onClose={() => setOpenId(null)} onUpdated={patchRow} />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

/** Slide-over detail: fetches the full evaluation, renders the verdict + the review controls. */
function DetailDrawer({
  evalId,
  onClose,
  onUpdated,
}: {
  evalId: string;
  onClose: () => void;
  onUpdated: (id: string, next: { flagStatus: ReviewFlagStatus; comment: string | null }) => void;
}) {
  const [detail, setDetail] = useState<TurnEvaluationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await apiClient.get<{ evaluation: TurnEvaluationDetail }>(
          API.APP.TURN_EVALUATIONS.byId(evalId)
        );
        if (active) setDetail(data.evaluation);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not load the evaluation');
      }
    })();
    return () => {
      active = false;
    };
  }, [evalId]);

  // Validate the opaque verdict JSON before handing it to the renderer (external data → never `as`).
  const verdictValidation = detail ? validateTurnEvaluation(detail.verdict) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div className="relative h-full w-full max-w-xl overflow-y-auto bg-zinc-950 p-4 text-zinc-100 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">
            Turn evaluation
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
            {error}
          </p>
        )}

        {!detail && !error && (
          <div className="flex items-center gap-2 py-8 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {detail && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
              <Meta label="Questionnaire" value={detail.questionnaireTitle ?? '—'} />
              <Meta
                label="Version"
                value={detail.versionNumber !== null ? `v${detail.versionNumber}` : '—'}
              />
              <Meta label="Turn" value={`#${detail.turnOrdinal}`} />
              <Meta label="Rubric" value={detail.rubricVersion} />
              <Meta label="App version" value={detail.appVersion} />
              <Meta label="Provider" value={detail.evaluatorProvider} />
              <Meta
                label="Cost"
                value={detail.costUsd !== null ? `$${detail.costUsd.toFixed(4)}` : '—'}
              />
              <Meta label="When" value={new Date(detail.createdAt).toLocaleString()} />
            </dl>

            <TurnEvaluationReview
              sessionId={detail.sessionId}
              evaluationId={detail.id}
              initialFlagStatus={detail.flagStatus as ReviewFlagStatus}
              initialComment={detail.comment}
              datasetId={detail.datasetId}
              onUpdated={(next) => onUpdated(detail.id, next)}
            />

            {verdictValidation?.ok ? (
              <TurnEvaluationVerdict
                verdict={verdictValidation.value}
                model={detail.evaluatorModel}
                turnIndex={detail.turnOrdinal - 1}
              />
            ) : (
              <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
                The stored verdict could not be rendered (schema mismatch).
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[0.6rem] tracking-wide text-zinc-600 uppercase">{label}</dt>
      <dd className="truncate font-mono text-zinc-200">{value}</dd>
    </div>
  );
}
