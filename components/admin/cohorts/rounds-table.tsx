'use client';

/**
 * Rounds table — two scopes from one component:
 *   • `scope="client"` — every round across the client's cohorts, searchable, with a
 *     Cohort column. Used on the Rounds tab.
 *   • `scope="cohort"` — one cohort's rounds, with an inline "New round" form. Used on
 *     the cohort detail page.
 *
 * SSR-provided rows (no per-row fetch). An `open` round carries a Close action behind a
 * confirm dialog (POST …/close), using the per-row pending-state pattern. Row click drills
 * into the round detail page. Status + window read as a live badge + humanised phrase;
 * completion renders as an accent bar. Empty scopes get an inviting state with the next step.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, ChevronRight, Loader2, Plus, Users, XCircle } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
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
  CohortEmptyState,
  CompletionBar,
  humanizeWindow,
  RoundStatusBadge,
} from '@/components/admin/cohorts/cohort-ui';
import {
  cohortsTabHref,
  roundDetailHref,
  type RoundDetail,
  type RoundView,
} from '@/lib/app/questionnaire/rounds';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function windowRange(opensAt: string | null, closesAt: string | null): string | null {
  if (opensAt && closesAt) return `${formatDate(opensAt)} – ${formatDate(closesAt)}`;
  if (opensAt) return `from ${formatDate(opensAt)}`;
  if (closesAt) return `until ${formatDate(closesAt)}`;
  return null;
}

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

  const colSpan = isClientScope ? 8 : 7;
  const isEmpty = rounds.length === 0;

  // Truly-empty scopes get an inviting state rather than a blank table.
  if (isEmpty && !(showForm && !isClientScope)) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border">
          {isClientScope ? (
            <CohortEmptyState
              icon={<CalendarClock className="h-5 w-5" />}
              title="No rounds yet"
              body="A round is a time-bound delivery of questionnaires to a cohort. Open a cohort to create its first round."
              action={
                <Button variant="outline" onClick={() => router.push(cohortsTabHref(demoClientId))}>
                  <Users className="mr-2 h-4 w-4" />
                  View cohorts
                </Button>
              }
            />
          ) : (
            <CohortEmptyState
              icon={<CalendarClock className="h-5 w-5" />}
              title="No rounds for this cohort"
              body="Run a round to deliver one or more questionnaires to this cohort within a set window."
              action={
                <Button onClick={() => setShowForm(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create the first round
                </Button>
              }
            />
          )}
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
    );
  }

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

      {!isEmpty && (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                {isClientScope && <TableHead>Cohort</TableHead>}
                <TableHead>Status</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Completion</TableHead>
                <TableHead className="text-right">Action</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={colSpan} className="text-muted-foreground py-10 text-center">
                    No rounds match “{query.trim()}”.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((round) => {
                  const isPending = pendingId === round.id;
                  const range = windowRange(round.opensAt, round.closesAt);
                  return (
                    <TableRow
                      key={round.id}
                      className="group cursor-pointer hover:bg-[color:var(--cq-accent-muted)]"
                      onClick={() => router.push(roundDetailHref(demoClientId, round.id))}
                    >
                      <TableCell className="font-medium">{round.name}</TableCell>
                      {isClientScope && (
                        <TableCell className="text-muted-foreground">{round.cohortName}</TableCell>
                      )}
                      <TableCell>
                        <RoundStatusBadge status={round.status} />
                      </TableCell>
                      <TableCell>
                        <div className="leading-tight">
                          <div className="text-sm">
                            {humanizeWindow(round.status, round.opensAt, round.closesAt)}
                          </div>
                          {range && (
                            <div className="text-muted-foreground text-xs tabular-nums">
                              {range}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{round.memberCount}</TableCell>
                      <TableCell>
                        <CompletionBar
                          started={round.stats.sessionsStarted}
                          completed={round.stats.sessionsCompleted}
                          rate={round.stats.completionRate}
                          variant="full"
                        />
                      </TableCell>
                      <TableCell
                        className="text-right"
                        // Stop the row-navigation click so the dialog can open in place.
                        onClick={(e) => e.stopPropagation()}
                      >
                        {round.status === 'open' ? (
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
                                  Closing ends the round — respondents can no longer start or
                                  continue it. You can reopen it from the round detail page.
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
                        ) : (
                          <span className="text-muted-foreground/50 text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:text-[color:var(--cq-accent)]" />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
