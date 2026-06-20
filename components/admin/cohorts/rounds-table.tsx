'use client';

/**
 * Rounds table — two scopes from one component:
 *   • `scope="client"` — every round across the client's cohorts, searchable, with a
 *     Cohort column. Used on the Rounds tab.
 *   • `scope="cohort"` — one cohort's rounds, with an inline "New round" form. Used on
 *     the cohort detail page.
 *
 * SSR-provided rows (no per-row fetch). An `open` round carries a Close action behind a
 * confirm dialog (POST …/close), using the per-row pending-state pattern. Row click
 * drills into the round detail page.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, XCircle } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RoundForm } from '@/components/admin/cohorts/round-form';
import {
  roundDetailHref,
  type RoundDetail,
  type RoundStatus,
  type RoundView,
} from '@/lib/app/questionnaire/rounds';

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

function formatWindow(opensAt: string | null, closesAt: string | null): string {
  if (!opensAt && !closesAt) return '—';
  if (opensAt && closesAt) return `${formatDate(opensAt)} – ${formatDate(closesAt)}`;
  if (opensAt) return `from ${formatDate(opensAt)}`;
  return `until ${formatDate(closesAt as string)}`;
}

const STATUS_BADGE: Record<
  RoundStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  draft: { label: 'Draft', variant: 'outline' },
  open: { label: 'Open', variant: 'default' },
  closed: { label: 'Closed', variant: 'secondary' },
};

interface CohortScopeProps {
  scope: 'cohort';
  /** The cohort whose rounds these are (drives the inline create form). */
  cohortId: string;
}

interface ClientScopeProps {
  scope: 'client';
}

export type RoundsTableProps = (CohortScopeProps | ClientScopeProps) & {
  demoClientId: string;
  rounds: RoundView[];
};

export function RoundsTable(props: RoundsTableProps) {
  const { demoClientId, rounds, scope } = props;
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  // Id of the round currently being closed (drives the spinner + disabled state).
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isClientScope = scope === 'client';

  const filtered = useMemo(() => {
    if (!isClientScope) return rounds;
    const q = query.trim().toLowerCase();
    if (q === '') return rounds;
    return rounds.filter(
      (r) => r.name.toLowerCase().includes(q) || r.cohortName.toLowerCase().includes(q)
    );
  }, [rounds, query, isClientScope]);

  const closeRound = async (roundId: string) => {
    setPendingId(roundId);
    setError(null);
    try {
      await apiClient.post<RoundDetail>(API.APP.ROUNDS.close(roundId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not close the round.');
    } finally {
      setPendingId(null);
    }
  };

  const colSpan = isClientScope ? 9 : 8;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {isClientScope && (
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rounds by name or cohort…"
            className="max-w-xs"
            aria-label="Search rounds"
          />
        )}
        <div className="flex-1" />
        {!isClientScope && !showForm && (
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New round
          </Button>
        )}
      </div>

      {!isClientScope && showForm && (
        <RoundForm
          demoClientId={demoClientId}
          cohortId={props.cohortId}
          onSuccess={() => setShowForm(false)}
          onCancel={() => setShowForm(false)}
        />
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              {isClientScope && <TableHead>Cohort</TableHead>}
              <TableHead>Status</TableHead>
              <TableHead>Window</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Started</TableHead>
              <TableHead className="text-right">Completed</TableHead>
              <TableHead className="text-right">Completion</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-muted-foreground py-10 text-center">
                  {rounds.length === 0 ? 'No rounds yet.' : 'No rounds match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((round) => {
                const badge = STATUS_BADGE[round.status];
                const isPending = pendingId === round.id;
                return (
                  <TableRow
                    key={round.id}
                    className="cursor-pointer"
                    onClick={() => router.push(roundDetailHref(demoClientId, round.id))}
                  >
                    <TableCell className="font-medium">{round.name}</TableCell>
                    {isClientScope && (
                      <TableCell className="text-muted-foreground">{round.cohortName}</TableCell>
                    )}
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatWindow(round.opensAt, round.closesAt)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{round.memberCount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {round.stats.sessionsStarted}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {round.stats.sessionsCompleted}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {round.stats.sessionsStarted === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatRate(round.stats.completionRate)
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right"
                      // Stop the row-navigation click so the dialog can open in place.
                      onClick={(e) => e.stopPropagation()}
                    >
                      {round.status === 'open' && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              disabled={isPending}
                            >
                              {isPending ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <XCircle className="mr-2 h-4 w-4" />
                              )}
                              Close
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Close “{round.name}”?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Closing ends the round — respondents can no longer start or continue
                                it. This can&rsquo;t be undone from here (you&rsquo;d reopen it on
                                the round detail page).
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => void closeRound(round.id)}>
                                Close round
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
