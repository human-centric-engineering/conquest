'use client';

/**
 * Admin list of experiences — searchable by title, filterable by kind and status.
 *
 * SSR-provided rows with no per-row fetch (the list endpoint already carries the client name and
 * step count); search and filters run client-side over that enriched list. Row click drills into
 * the experience workspace.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Route } from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ExperienceEmptyState,
  ExperienceKindBadge,
  ExperienceStatusBadge,
} from '@/components/admin/experiences/experience-ui';
import type { ExperienceListView } from '@/lib/app/questionnaire/experiences/views';
import {
  EXPERIENCE_CONTINUITY_MODE_LABELS,
  EXPERIENCE_KIND_LABELS,
  EXPERIENCE_KINDS,
  EXPERIENCE_STATUSES,
} from '@/lib/app/questionnaire/experiences/types';
import { experienceWorkspaceBase } from '@/lib/app/questionnaire/experiences/workspace-nav';

/** Sentinel for "no filter" — Radix Select cannot hold an empty-string item value. */
const ALL = 'all';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function ExperiencesTable({ initialItems }: { initialItems: ExperienceListView[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return initialItems.filter((item) => {
      if (kind !== ALL && item.kind !== kind) return false;
      if (status !== ALL && item.status !== status) return false;
      if (q === '') return true;
      return (
        item.title.toLowerCase().includes(q) ||
        (item.description ?? '').toLowerCase().includes(q) ||
        (item.demoClientName ?? '').toLowerCase().includes(q)
      );
    });
  }, [initialItems, query, kind, status]);

  if (initialItems.length === 0) {
    return (
      <div className="rounded-xl border">
        <ExperienceEmptyState
          icon={<Route className="h-5 w-5" />}
          title="No experiences yet"
          body="An experience turns questionnaires you have already authored into a journey — routing a respondent to the right follow-up, or running one short questionnaire across a whole room at once."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search experiences…"
          className="max-w-xs"
          aria-label="Search experiences"
        />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-[190px]" aria-label="Filter by kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All kinds</SelectItem>
            {EXPERIENCE_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {EXPERIENCE_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {EXPERIENCE_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Title</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Steps</TableHead>
              <TableHead>Continuity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-muted-foreground py-10 text-center">
                  No experiences match these filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((item) => (
                <TableRow
                  key={item.id}
                  className="group cursor-pointer hover:bg-[color:var(--cq-accent-muted)]"
                  onClick={() => router.push(experienceWorkspaceBase(item.id))}
                >
                  <TableCell className="font-medium">{item.title}</TableCell>
                  <TableCell>
                    <ExperienceKindBadge kind={item.kind} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.demoClientName ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{item.stepCount}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {item.kind === 'agentic_switcher'
                      ? EXPERIENCE_CONTINUITY_MODE_LABELS[item.continuityMode]
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <ExperienceStatusBadge status={item.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                    {formatDate(item.createdAt)}
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
    </div>
  );
}
