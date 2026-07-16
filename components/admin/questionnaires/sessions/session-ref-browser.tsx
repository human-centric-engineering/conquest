'use client';

/**
 * SessionRefBrowser — the alpha-only admin surface for browsing session support references.
 *
 * A paginated, cross-questionnaire table of every session ref with its date + status. Each ref
 * deep-links to the session viewer (where the admin inspects the conversation and, via the re-run
 * panel, regenerates its report); a sibling link opens the version's analytics. Ref-substring search
 * and status filter drive a single enriched list endpoint — no per-row fetches.
 *
 * Alpha-gated: the page and the API both 404 unless the product is in the alpha release stage.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3, Search } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import { SESSION_STATUSES, type SessionStatus } from '@/lib/app/questionnaire/types';
import type { AdminSessionRefItem } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import type { PaginationMeta } from '@/types/api';

const STATUS_BADGE: Record<SessionStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  active: 'secondary',
  paused: 'outline',
  completed: 'default',
  abandoned: 'outline',
  aborted: 'destructive',
};

/** Sentinel for "no status filter" — Radix Select can't hold an empty-string value. */
const ANY_STATUS = 'all';

export interface SessionRefBrowserProps {
  initialItems: AdminSessionRefItem[];
  initialMeta: PaginationMeta;
}

export function SessionRefBrowser({ initialItems, initialMeta }: SessionRefBrowserProps) {
  const [items, setItems] = useState(initialItems);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<SessionStatus | typeof ANY_STATUS>(ANY_STATUS);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (q: string, s: SessionStatus | typeof ANY_STATUS, p: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ page: String(p), limit: String(meta.limit) });
        if (q.trim()) params.set('q', q.trim());
        if (s !== ANY_STATUS) params.set('status', s);

        const res = await fetch(`${API.APP.QUESTIONNAIRE_SESSIONS.REFS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('List request failed');
        const body = await parseApiResponse<AdminSessionRefItem[]>(res);
        if (!body.success) throw new Error('List request failed');
        setItems(body.data);
        setMeta((prev) => parsePaginationMeta(body.meta) ?? prev);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load sessions');
      } finally {
        setLoading(false);
      }
    },
    [meta.limit]
  );

  // Re-fetch on filter/page change (skip the first render — the server seeded page 1).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!mounted) {
      setMounted(true);
      return;
    }
    void fetchPage(search, status, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (page !== 1) setPage(1);
    else void fetchPage(search, status, 1);
  };

  const totalPages = Math.max(1, meta.totalPages);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <form onSubmit={onSearchSubmit} className="flex items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="ref-search" className="text-muted-foreground text-xs font-medium">
              Support reference
            </label>
            <Input
              id="ref-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. 7F3K9M2P"
              className="w-48 font-mono"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={loading}>
            <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Search
          </Button>
        </form>
        <div className="space-y-1">
          <label htmlFor="status-filter" className="text-muted-foreground text-xs font-medium">
            Status
          </label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as SessionStatus | typeof ANY_STATUS);
              setPage(1);
            }}
          >
            <SelectTrigger id="status-filter" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_STATUS}>Any status</SelectItem>
              {SESSION_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs">
            <tr>
              <th className="px-3 py-2 font-medium">Reference</th>
              <th className="px-3 py-2 font-medium">Questionnaire</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Analytics</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground px-3 py-8 text-center">
                  {loading ? 'Loading…' : 'No sessions found.'}
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const base = workspaceVersionBase(item.questionnaireId, item.versionId);
                return (
                  <tr key={item.sessionId} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        href={`${base}/sessions/${item.sessionId}`}
                        className="text-primary font-mono font-semibold hover:underline"
                        title="Open the session — view it and regenerate its report"
                      >
                        {item.refFormatted}
                      </Link>
                      {item.isPreview && (
                        <Badge variant="secondary" className="ml-2">
                          Preview
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-medium">{item.questionnaireTitle}</span>
                      <span className="text-muted-foreground ml-1.5 text-xs">
                        v{item.versionNumber}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_BADGE[item.status]}>{item.status}</Badge>
                    </td>
                    <td className="text-muted-foreground px-3 py-2 tabular-nums">
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`${base}/analytics`}
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
                      >
                        <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
                        Analytics
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {meta.total} session{meta.total === 1 ? '' : 's'} · page {meta.page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || meta.page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || meta.page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
