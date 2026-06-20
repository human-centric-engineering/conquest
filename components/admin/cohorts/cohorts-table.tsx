'use client';

/**
 * Admin list of a demo client's cohorts — searchable by name, with a "New cohort"
 * dialog. SSR-provided rows (no per-row fetch); the search filters client-side over
 * the enriched list. Row click drills into the cohort detail page. A truly-empty client
 * gets an inviting empty state with the create CTA inline.
 *
 * Gated by `APP_QUESTIONNAIRES_COHORTS` at the page boundary.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CohortForm } from '@/components/admin/cohorts/cohort-form';
import { CohortEmptyState, CompletionBar } from '@/components/admin/cohorts/cohort-ui';
import { cohortDetailHref, type CohortView } from '@/lib/app/questionnaire/rounds';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export interface CohortsTableProps {
  demoClientId: string;
  cohorts: CohortView[];
}

export function CohortsTable({ demoClientId, cohorts }: CohortsTableProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return cohorts;
    return cohorts.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q)
    );
  }, [cohorts, query]);

  const isEmpty = cohorts.length === 0;

  return (
    <div className="space-y-3">
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <div className="flex items-center gap-2">
          {!isEmpty && (
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cohorts by name…"
              className="max-w-xs"
              aria-label="Search cohorts"
            />
          )}
          <div className="flex-1" />
          {!isEmpty && (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New cohort
            </Button>
          )}
        </div>

        <DialogContent>
          <DialogHeader>
            <DialogTitle>New cohort</DialogTitle>
            <DialogDescription>
              Group people under this demo client. You can add members and create rounds after.
            </DialogDescription>
          </DialogHeader>
          <CohortForm
            demoClientId={demoClientId}
            onSuccess={() => setDialogOpen(false)}
            onCancel={() => setDialogOpen(false)}
          />
        </DialogContent>

        {isEmpty ? (
          <div className="rounded-xl border">
            <CohortEmptyState
              icon={<Users className="h-5 w-5" />}
              title="No cohorts yet"
              body="Group the people you'll deliver questionnaires to — a team, a class, a panel — then run time-bound rounds against them."
              action={
                <Button onClick={() => setDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create the first cohort
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">Rounds</TableHead>
                  <TableHead>Completion</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                      No cohorts match “{query.trim()}”.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((cohort) => (
                    <TableRow
                      key={cohort.id}
                      className="group cursor-pointer hover:bg-[color:var(--cq-accent-muted)]"
                      onClick={() => router.push(cohortDetailHref(demoClientId, cohort.id))}
                    >
                      <TableCell className="font-medium">{cohort.name}</TableCell>
                      <TableCell className="text-muted-foreground max-w-xs truncate">
                        {cohort.description ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cohort.memberCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{cohort.roundCount}</TableCell>
                      <TableCell>
                        <CompletionBar
                          started={cohort.stats.sessionsStarted}
                          completed={cohort.stats.sessionsCompleted}
                          rate={cohort.stats.completionRate}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                        {formatDate(cohort.createdAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:text-[color:var(--cq-accent)]" />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </Dialog>
    </div>
  );
}
