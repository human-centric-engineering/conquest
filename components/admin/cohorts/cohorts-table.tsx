'use client';

/**
 * Admin list of a demo client's cohorts — searchable by name, with a "New cohort"
 * dialog. SSR-provided rows (no per-row fetch); the search filters client-side over
 * the enriched list. Row click drills into the cohort detail page.
 *
 * Gated by `APP_QUESTIONNAIRES_COHORTS` at the page boundary.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { cohortDetailHref, type CohortView } from '@/lib/app/questionnaire/rounds';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cohorts by name…"
          className="max-w-xs"
          aria-label="Search cohorts"
        />
        <div className="flex-1" />
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New cohort
            </Button>
          </DialogTrigger>
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
        </Dialog>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Rounds</TableHead>
              <TableHead className="text-right">Completion</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                  {cohorts.length === 0
                    ? 'No cohorts yet. Create one to group people and run rounds.'
                    : 'No cohorts match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((cohort) => (
                <TableRow
                  key={cohort.id}
                  className="cursor-pointer"
                  onClick={() => router.push(cohortDetailHref(demoClientId, cohort.id))}
                >
                  <TableCell className="font-medium">{cohort.name}</TableCell>
                  <TableCell className="text-muted-foreground max-w-xs truncate">
                    {cohort.description ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{cohort.memberCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{cohort.roundCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {cohort.stats.sessionsStarted === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatRate(cohort.stats.completionRate)
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right">
                    {formatDate(cohort.createdAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
