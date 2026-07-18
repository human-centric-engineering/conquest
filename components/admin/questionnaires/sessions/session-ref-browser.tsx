'use client';

/**
 * SessionRefBrowser — the alpha admin console for browsing respondent sessions.
 *
 * A paginated, cross-questionnaire table of every session ref, above a filter bar and a KPI + charts
 * strip. ALL filter/sort/page state lives in the URL (via `router.replace(..., { scroll: false })`), so
 * the state is shareable, back-button-safe, and — the original pain point — survives opening a session:
 * a row opens the {@link SessionDrawer} slide-over (transcript + report) IN PLACE rather than navigating
 * away, so the list never loses its position. The list + stats re-fetch from a single enriched endpoint
 * each on URL change; there are no per-row fetches.
 *
 * Alpha-gated: the page and the API both 404 unless the product is in the alpha release stage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp, BarChart3, ChevronsUpDown, FlaskConical, Split } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import { formatCompactDuration } from '@/lib/utils/format-duration';
import { formatCompactDateTime } from '@/lib/utils/format-datetime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { SessionFilters } from '@/components/admin/questionnaires/sessions/session-filters';
import { SessionStats } from '@/components/admin/questionnaires/sessions/session-stats';
import { SessionDrawer } from '@/components/admin/questionnaires/sessions/session-drawer';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import { type SessionStatus } from '@/lib/app/questionnaire/types';
import type {
  AdminSessionRefItem,
  AdminSessionFilterOptions,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import type { AdminSessionStats } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-stats';
import type { PaginationMeta } from '@/types/api';

const STATUS_BADGE: Record<SessionStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  active: 'secondary',
  paused: 'outline',
  completed: 'default',
  abandoned: 'outline',
  aborted: 'destructive',
};

export interface SessionRefBrowserProps {
  initialItems: AdminSessionRefItem[];
  initialMeta: PaginationMeta;
  initialStats: AdminSessionStats;
  options: AdminSessionFilterOptions;
}

export function SessionRefBrowser({
  initialItems,
  initialMeta,
  initialStats,
  options,
}: SessionRefBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const key = searchParams.toString();

  const [items, setItems] = useState(initialItems);
  const [meta, setMeta] = useState(initialMeta);
  const [stats, setStats] = useState(initialStats);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AdminSessionRefItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sort = searchParams.get('sort') ?? 'createdAt';
  const order = (searchParams.get('order') ?? 'desc') as 'asc' | 'desc';

  // Monotonic request id — two URL changes in quick succession (debounced search + a select) overlap,
  // and without this the slower/older response could paint over the newer one, leaving the table
  // showing data that matches neither the URL nor the visible filters.
  const reqIdRef = useRef(0);

  const refetch = useCallback(async (qs: string) => {
    const reqId = ++reqIdRef.current;
    const isStale = () => reqId !== reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const suffix = qs ? `?${qs}` : '';
      const [listRes, statsRes] = await Promise.all([
        fetch(`${API.APP.QUESTIONNAIRE_SESSIONS.REFS}${suffix}`, { credentials: 'same-origin' }),
        fetch(`${API.APP.QUESTIONNAIRE_SESSIONS.REFS_STATS}${suffix}`, {
          credentials: 'same-origin',
        }),
      ]);
      if (!listRes.ok || !statsRes.ok) throw new Error('Request failed');
      const listBody = await parseApiResponse<AdminSessionRefItem[]>(listRes);
      const statsBody = await parseApiResponse<AdminSessionStats>(statsRes);
      if (!listBody.success || !statsBody.success) throw new Error('Request failed');
      if (isStale()) return; // superseded by a newer filter/page change
      setItems(listBody.data);
      setMeta((prev) => parsePaginationMeta(listBody.meta) ?? prev);
      setStats(statsBody.data);
    } catch (err) {
      if (isStale()) return;
      setError(err instanceof Error ? err.message : 'Could not load sessions');
    } finally {
      // Only the newest request owns the spinner, so an older one settling can't clear it early.
      if (!isStale()) setLoading(false);
    }
  }, []);

  // Re-fetch on any URL change — but skip the first render, whose data the server already seeded.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void refetch(key);
  }, [key, refetch]);

  /** Clone params, mutate, and push to the URL without scrolling (list state lives here). */
  const push = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const goToPage = (page: number) =>
    push((params) => {
      if (page <= 1) params.delete('page');
      else params.set('page', String(page));
    });

  const toggleSort = (col: 'createdAt' | 'turns') =>
    push((params) => {
      const curSort = params.get('sort') ?? 'createdAt';
      const curOrder = params.get('order') ?? 'desc';
      if (curSort === col) params.set('order', curOrder === 'asc' ? 'desc' : 'asc');
      else {
        params.set('sort', col);
        params.set('order', 'desc');
      }
      params.delete('page');
    });

  const openSession = (item: AdminSessionRefItem) => {
    setSelected(item);
    setDrawerOpen(true);
  };

  const totalPages = Math.max(1, meta.totalPages);

  return (
    <div className="space-y-6">
      <SessionFilters options={options} />

      <SessionStats stats={stats} loading={loading} />

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div
        className={cn(
          'overflow-x-auto rounded-xl border transition-opacity',
          loading && 'opacity-60'
        )}
      >
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead>Reference</TableHead>
              <TableHead>Questionnaire</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Cohort</TableHead>
              <TableHead>Status</TableHead>
              <SortHeader
                label="Turns"
                col="turns"
                activeSort={sort}
                order={order}
                onClick={toggleSort}
                className="text-right"
              />
              <TableHead className="text-right">Complete</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <SortHeader
                label="Created"
                col="createdAt"
                activeSort={sort}
                order={order}
                onClick={toggleSort}
              />
              <TableHead className="text-right">Analytics</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-muted-foreground py-12 text-center">
                  {loading ? 'Loading…' : 'No sessions match these filters.'}
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow
                  key={item.sessionId}
                  onClick={() => openSession(item)}
                  className="hover:bg-muted/40 cursor-pointer"
                >
                  <TableCell>
                    <span className="text-primary font-mono font-semibold">
                      {item.refFormatted}
                    </span>
                    {item.isPreview && (
                      <span
                        title="Preview — admin rehearsal (excluded from analytics)"
                        className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                      >
                        <FlaskConical className="h-3 w-3" aria-hidden="true" />
                        Preview
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{item.questionnaireTitle}</span>
                    <span className="text-muted-foreground ml-1.5 text-xs">
                      v{item.versionNumber}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.clientName ?? <span className="italic">Unassigned</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {item.cohortName ? (
                      <span className="text-foreground">{item.cohortName}</span>
                    ) : (
                      <span>—</span>
                    )}
                    {item.roundName && <span className="block">{item.roundName}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[item.status]}>{item.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{item.turns}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span
                      title={`${item.answeredCount} of ${item.totalQuestions} question${
                        item.totalQuestions === 1 ? '' : 's'
                      } answered`}
                    >
                      {item.percentComplete}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <DurationCell item={item} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <CreatedCell iso={item.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`${workspaceVersionBase(item.questionnaireId, item.versionId)}/analytics`}
                      onClick={(e) => e.stopPropagation()}
                      title="Analytics"
                      className="text-muted-foreground hover:text-foreground inline-flex items-center text-xs"
                    >
                      <BarChart3 className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Analytics</span>
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
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
            onClick={() => goToPage(meta.page - 1)}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || meta.page >= totalPages}
            onClick={() => goToPage(meta.page + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <SessionDrawer item={selected} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  );
}

/**
 * The session duration cell: the beginning-to-end span, plus a split marker + sitting count when the
 * session was completed across more than one sitting (the tooltip breaks down active vs elapsed time).
 */
function DurationCell({ item }: { item: AdminSessionRefItem }) {
  if (item.durationMs == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const staged = (item.sittings ?? 1) > 1;
  const title = staged
    ? `${item.sittings} sittings · ~${formatCompactDuration(item.activeMs)} active over ${formatCompactDuration(
        item.durationMs
      )} elapsed`
    : 'Completed in one sitting';
  return (
    <span title={title} className="inline-flex items-center justify-end gap-1.5">
      {formatCompactDuration(item.durationMs)}
      {staged && (
        <span className="text-muted-foreground inline-flex items-center gap-0.5 text-xs">
          <Split className="h-3 w-3" aria-hidden="true" />
          {item.sittings}
        </span>
      )}
    </span>
  );
}

/** The Created cell: a compact two-tone stamp — date foreground, time muted, full value on hover. */
function CreatedCell({ iso }: { iso: string }) {
  const { date, time, full } = formatCompactDateTime(iso);
  return (
    <span title={full} className="inline-flex items-baseline gap-1.5">
      <span className="text-foreground">{date}</span>
      <span className="text-muted-foreground text-xs">{time}</span>
    </span>
  );
}

/** A clickable, sort-toggling column header with a direction indicator. */
function SortHeader({
  label,
  col,
  activeSort,
  order,
  onClick,
  className,
}: {
  label: string;
  col: 'createdAt' | 'turns';
  activeSort: string;
  order: 'asc' | 'desc';
  onClick: (col: 'createdAt' | 'turns') => void;
  className?: string;
}) {
  const active = activeSort === col;
  const Icon = active ? (order === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onClick(col)}
        className={cn(
          'hover:text-foreground -mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors',
          className?.includes('text-right') && 'flex-row-reverse',
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </TableHead>
  );
}
