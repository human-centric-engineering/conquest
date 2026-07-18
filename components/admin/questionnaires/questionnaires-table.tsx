'use client';

/**
 * QuestionnairesTable (P2 / F2.1a).
 *
 * Read-only admin list of questionnaires. Modelled on the orchestration
 * `AgentsTable` but deliberately lean for the read-surface PR: debounced title
 * search, a status filter, prev/next pagination, and click-through to the detail
 * page. Create is the ingestion endpoint, driven by the `UploadQuestionnaireDialog`
 * (header button + empty-state CTA); edit affordances live on the detail page.
 *
 * Hydrates from server-fetched `initialItems` / `initialMeta`, then re-fetches
 * `GET /api/v1/app/questionnaires` on filter/page changes. Fetch failures keep
 * the current rows and surface an inline banner (never a thrown error).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  MoreHorizontal,
  Search,
  Trash2,
} from 'lucide-react';

import { UploadQuestionnaireDialog } from '@/components/admin/questionnaires/upload-questionnaire-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDuplicateQuestionnaire } from '@/components/admin/questionnaires/use-duplicate-questionnaire';
import { useArchiveQuestionnaire } from '@/components/admin/questionnaires/use-archive-questionnaire';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';
import { APP_QUESTIONNAIRE_STATUSES } from '@/lib/app/questionnaire/types';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';
import { QUESTIONNAIRE_STATUS_BADGE } from '@/components/admin/questionnaires/status-badge';

const STATUS_FILTER_ALL = '__all__';

/** Which slice of the list to show: live rows or the archived (soft-deleted) trash. */
type ListView = 'active' | 'archived';

function formatDate(iso: string): string {
  // Locale date only — the table doesn't need time-of-day precision.
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export interface QuestionnairesTableProps {
  initialItems: QuestionnaireListItem[];
  initialMeta: PaginationMeta;
  /** DEMO-ONLY (F2.5.1): active demo clients for the empty-state upload dialog's attribution picker. */
  demoClientOptions?: AttributedDemoClient[];
  /** Show the Data slots column — only when the data-slots feature is enabled. */
  showDataSlots?: boolean;
}

export function QuestionnairesTable({
  initialItems,
  initialMeta,
  demoClientOptions = [],
  showDataSlots = false,
}: QuestionnairesTableProps) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_FILTER_ALL);
  const [view, setView] = useState<ListView>('active');
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // The row awaiting archive confirmation (id + title for the dialog copy), or null.
  const [pendingArchive, setPendingArchive] = useState<{ id: string; title: string } | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { duplicate, isDuplicating, error: duplicateError } = useDuplicateQuestionnaire();
  const {
    archive,
    restore,
    isPending: isArchivePending,
    error: archiveError,
  } = useArchiveQuestionnaire();

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  // Page size is fixed by the server's initial fetch and never changes, so read it
  // from the stable prop rather than from `meta` state — that keeps `meta` out of
  // this callback's deps, so a debounce captured mid-flight can't fire a stale
  // closure during a concurrent page change. The meta fallback is functional
  // (`prev`) for the same reason.
  const limit = initialMeta.limit;
  const fetchPage = useCallback(
    async (page = 1, overrides?: { search?: string; statusFilter?: string; view?: ListView }) => {
      setIsLoading(true);
      setListError(null);
      try {
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const statusValue =
          overrides?.statusFilter !== undefined ? overrides.statusFilter : statusFilter;
        const viewValue = overrides?.view !== undefined ? overrides.view : view;
        const params = new URLSearchParams({ page: String(page), limit: String(limit) });
        if (searchValue) params.set('q', searchValue);
        if (statusValue && statusValue !== STATUS_FILTER_ALL) params.set('status', statusValue);
        if (viewValue === 'archived') params.set('archived', 'true');

        const res = await fetch(`${API.APP.QUESTIONNAIRES.ROOT}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('list failed');

        const body = await parseApiResponse<QuestionnaireListItem[]>(res);
        if (!body.success) throw new Error('list failed');

        setItems(body.data);
        setMeta((prev) => parsePaginationMeta(body.meta) ?? prev);
      } catch {
        setListError('Could not load questionnaires. Try again.');
      } finally {
        setIsLoading(false);
      }
    },
    [search, statusFilter, view, limit]
  );

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      void fetchPage(1, { search: value });
    }, 300);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    void fetchPage(1, { statusFilter: value });
  };

  const handleViewChange = (nextView: ListView) => {
    if (nextView === view) return;
    setView(nextView);
    // Reset to page 1 — the two slices have independent pagination.
    void fetchPage(1, { view: nextView });
  };

  // Refresh the current page after a mutation, and re-run the server component so
  // the stat tiles (active / archived counts) update too.
  const refreshAfterMutation = () => {
    void fetchPage(meta.page);
    router.refresh();
  };

  const handleConfirmArchive = async () => {
    if (!pendingArchive) return;
    const ok = await archive(pendingArchive.id);
    setPendingArchive(null);
    if (ok) refreshAfterMutation();
  };

  const handleRestore = async (id: string) => {
    const ok = await restore(id);
    if (ok) refreshAfterMutation();
  };

  const goToPage = (page: number) => {
    if (page < 1 || page > meta.totalPages || page === meta.page) return;
    void fetchPage(page);
  };

  const rangeStart = meta.total === 0 ? 0 : (meta.page - 1) * meta.limit + 1;
  const rangeEnd = Math.min(meta.page * meta.limit, meta.total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by title…"
            className="pl-8"
            aria-label="Search questionnaires by title"
          />
        </div>
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-40" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={STATUS_FILTER_ALL}>All statuses</SelectItem>
            {APP_QUESTIONNAIRE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {QUESTIONNAIRE_STATUS_BADGE[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Active / Archived slice toggle — the soft-delete dimension, separate from
            the `status` filter above. */}
        <div
          className="inline-flex rounded-md border p-0.5"
          role="group"
          aria-label="Active or deleted"
        >
          <Button
            type="button"
            variant={view === 'active' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7"
            aria-pressed={view === 'active'}
            onClick={() => handleViewChange('active')}
          >
            Active
          </Button>
          <Button
            type="button"
            variant={view === 'archived' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7"
            aria-pressed={view === 'archived'}
            onClick={() => handleViewChange('archived')}
          >
            Deleted
          </Button>
        </div>
        {isLoading && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
      </div>

      {(listError || duplicateError || archiveError) && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {listError ?? duplicateError ?? archiveError}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Demo client</TableHead>
              <TableHead className="text-right">Version</TableHead>
              <TableHead className="text-right">Sections</TableHead>
              <TableHead className="text-right">Questions</TableHead>
              {showDataSlots && <TableHead className="text-right">Data slots</TableHead>}
              <TableHead className="text-right">Last activity</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={showDataSlots ? 9 : 8} className="py-10 text-center">
                  {view === 'archived' ? (
                    <p className="text-muted-foreground">
                      No deleted questionnaires. Deleted questionnaires are hidden from the active
                      list and can be restored here.
                    </p>
                  ) : (
                    <div className="flex flex-col items-center gap-3">
                      <p className="text-muted-foreground">
                        No questionnaires yet. Upload a document to create your first one.
                      </p>
                      <UploadQuestionnaireDialog demoClientOptions={demoClientOptions} />
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => {
                const badge = QUESTIONNAIRE_STATUS_BADGE[item.status];
                return (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/admin/questionnaires/${item.id}`)}
                  >
                    <TableCell className="font-medium">{item.title}</TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {item.demoClient ? (
                        item.demoClient.name
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.latestVersion ? `v${item.latestVersion.versionNumber}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{item.sectionCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.questionCount}</TableCell>
                    {showDataSlots && (
                      <TableCell className="text-right tabular-nums">
                        {item.dataSlotCount}
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground text-right">
                      {formatDate(item.updatedAt)}
                    </TableCell>
                    {/* Row actions — stop propagation so opening the menu / acting doesn't
                        trigger the row's navigate-to-detail click. */}
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={isDuplicating || isArchivePending}
                            aria-label={`Actions for ${item.title}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {view === 'archived' ? (
                            <DropdownMenuItem
                              onSelect={() => void handleRestore(item.id)}
                              disabled={isArchivePending}
                            >
                              <ArchiveRestore className="mr-2 h-4 w-4" />
                              Restore
                            </DropdownMenuItem>
                          ) : (
                            <>
                              <DropdownMenuItem
                                onSelect={() => void duplicate(item.id)}
                                disabled={isDuplicating}
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  setPendingArchive({ id: item.id, title: item.title })
                                }
                                disabled={isArchivePending}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="text-muted-foreground flex items-center justify-between text-sm">
        <span>
          {meta.total === 0
            ? 'No questionnaires'
            : `Showing ${rangeStart}–${rangeEnd} of ${meta.total}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => goToPage(meta.page - 1)}
            disabled={meta.page <= 1 || isLoading}
            className="hover:bg-accent inline-flex h-8 items-center gap-1 rounded-md border px-2 disabled:pointer-events-none disabled:opacity-50"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" /> Prev
          </button>
          <button
            type="button"
            onClick={() => goToPage(meta.page + 1)}
            disabled={meta.page >= meta.totalPages || isLoading}
            className="hover:bg-accent inline-flex h-8 items-center gap-1 rounded-md border px-2 disabled:pointer-events-none disabled:opacity-50"
            aria-label="Next page"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Delete confirmation — this soft-delete is reversible, but it disappears from
          the active list, so a confirm avoids accidental clicks. */}
      <AlertDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this questionnaire?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingArchive
                ? `“${pendingArchive.title}” will be removed from the active list. This is reversible — nothing is destroyed, and you can restore it any time from the Deleted view.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isArchivePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog logic in our handler (async archive → refetch) rather
                // than letting the default close race the mutation.
                e.preventDefault();
                void handleConfirmArchive();
              }}
              disabled={isArchivePending}
            >
              {isArchivePending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
