'use client';

/**
 * Round phases: staggered access windows per cohort subgroup, so one group can take the round before
 * the rest. The add form offers subgroups that don't yet have a phase; each phase row shows its
 * window + end mode with inline edit and delete. Windows are datetime-local inputs (converted to ISO
 * with offset on submit) and must nest inside the round window — the server enforces this and surfaces
 * a 422 message. Mirrors the per-row pending-state + `router.refresh()` discipline of the sibling
 * round panels; all mutations re-read the SSR round detail.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
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
import { CohortEmptyState, CompletionBar } from '@/components/admin/cohorts/cohort-ui';
import type {
  CohortSubgroupView,
  RoundDetail,
  RoundPhaseEndMode,
  RoundPhaseView,
} from '@/lib/app/questionnaire/rounds';

/** ISO string → the `yyyy-MM-ddThh:mm` value a datetime-local input expects (local time). */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/** A datetime-local value (local wall-clock) → an ISO string with offset, or null if blank. */
function localInputToIso(value: string): string | null {
  if (value.trim() === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatWindow(opensAt: string | null, closesAt: string | null): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const from = opensAt ? fmt(opensAt) : 'round open';
  const to = closesAt ? fmt(closesAt) : 'round close';
  return `${from} → ${to}`;
}

export interface RoundPhasesPanelProps {
  roundId: string;
  /** The round's own window, shown as the nesting bound for new phases. */
  roundOpensAt: string | null;
  roundClosesAt: string | null;
  phases: RoundPhaseView[];
  /** The cohort's subgroups — the add form offers those without a phase yet. */
  subgroups: CohortSubgroupView[];
}

interface EditDraft {
  opensAt: string;
  closesAt: string;
  endMode: RoundPhaseEndMode;
}

export function RoundPhasesPanel({
  roundId,
  roundOpensAt,
  roundClosesAt,
  phases,
  subgroups,
}: RoundPhasesPanelProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Add form state.
  const [subgroupId, setSubgroupId] = useState('');
  const [addOpensAt, setAddOpensAt] = useState('');
  const [addClosesAt, setAddClosesAt] = useState('');
  const [addEndMode, setAddEndMode] = useState<RoundPhaseEndMode>('hard');
  const [creating, setCreating] = useState(false);

  // Per-row state.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft>({ opensAt: '', closesAt: '', endMode: 'hard' });

  const phasedSubgroupIds = new Set(phases.map((p) => p.subgroupId));
  const availableSubgroups = subgroups.filter((sg) => !phasedSubgroupIds.has(sg.id));

  const createPhase = async () => {
    if (subgroupId === '') return;
    setCreating(true);
    setError(null);
    try {
      await apiClient.post<RoundDetail>(API.APP.ROUNDS.phases(roundId), {
        body: {
          subgroupId,
          opensAt: localInputToIso(addOpensAt),
          closesAt: localInputToIso(addClosesAt),
          endMode: addEndMode,
        },
      });
      setSubgroupId('');
      setAddOpensAt('');
      setAddClosesAt('');
      setAddEndMode('hard');
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not add the phase.');
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (phase: RoundPhaseView) => {
    setEditingId(phase.id);
    setDraft({
      opensAt: isoToLocalInput(phase.opensAt),
      closesAt: isoToLocalInput(phase.closesAt),
      endMode: phase.endMode,
    });
  };

  const saveEdit = async (phaseId: string) => {
    setPendingId(phaseId);
    setError(null);
    try {
      await apiClient.patch<RoundDetail>(API.APP.ROUNDS.phase(roundId, phaseId), {
        body: {
          opensAt: localInputToIso(draft.opensAt),
          closesAt: localInputToIso(draft.closesAt),
          endMode: draft.endMode,
        },
      });
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not save the phase.');
    } finally {
      setPendingId(null);
    }
  };

  const deletePhase = async (phaseId: string) => {
    setPendingId(phaseId);
    setError(null);
    try {
      await apiClient.delete(API.APP.ROUNDS.phase(roundId, phaseId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete the phase.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {subgroups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This cohort has no subgroups yet. Create subgroups on the cohort, then assign members, to
          stagger access here.
        </p>
      ) : (
        <div className="grid items-end gap-3 rounded-md border px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="phase-subgroup" className="flex items-center gap-1">
              Subgroup
              <FieldHelp title="Subgroup">
                The group of members this window applies to. Each subgroup can have one phase per
                round; members with no phase use the round&rsquo;s own window.
              </FieldHelp>
            </Label>
            <Select value={subgroupId} onValueChange={setSubgroupId} disabled={creating}>
              <SelectTrigger id="phase-subgroup">
                <SelectValue placeholder="Pick a subgroup" />
              </SelectTrigger>
              <SelectContent>
                {availableSubgroups.length === 0 ? (
                  <SelectItem value="__none__" disabled>
                    All subgroups have a phase
                  </SelectItem>
                ) : (
                  availableSubgroups.map((sg) => (
                    <SelectItem key={sg.id} value={sg.id}>
                      {sg.name} ({sg.memberCount})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="phase-opensAt" className="flex items-center gap-1">
              Opens at
              <FieldHelp title="Phase opens at">
                When this subgroup can start (your local time). Must be on or after the round opens.
                Leave blank to inherit the round&rsquo;s open time.
              </FieldHelp>
            </Label>
            <Input
              id="phase-opensAt"
              type="datetime-local"
              value={addOpensAt}
              disabled={creating}
              onChange={(e) => setAddOpensAt(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phase-closesAt" className="flex items-center gap-1">
              Closes at
              <FieldHelp title="Phase closes at">
                The phase&rsquo;s end (your local time). Must be on or before the round closes.
                Leave blank to inherit the round&rsquo;s close time.
              </FieldHelp>
            </Label>
            <Input
              id="phase-closesAt"
              type="datetime-local"
              value={addClosesAt}
              disabled={creating}
              onChange={(e) => setAddClosesAt(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phase-endMode" className="flex items-center gap-1">
              End mode
              <FieldHelp title="End mode">
                <strong>Hard</strong>: members lose access at the phase close.{' '}
                <strong>Relaxed</strong>: the phase close is just a target — members keep access
                until the round closes.
              </FieldHelp>
            </Label>
            <Select
              value={addEndMode}
              onValueChange={(v) => setAddEndMode(v as RoundPhaseEndMode)}
              disabled={creating}
            >
              <SelectTrigger id="phase-endMode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hard">Hard cutoff</SelectItem>
                <SelectItem value="relaxed">Relaxed (until round close)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button
              type="button"
              disabled={creating || subgroupId === ''}
              onClick={() => void createPhase()}
            >
              {creating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Add phase
            </Button>
            <span className="text-muted-foreground ml-3 text-xs">
              Round window: {formatWindow(roundOpensAt, roundClosesAt)}
            </span>
          </div>
        </div>
      )}

      {phases.length === 0 ? (
        <div className="rounded-xl border">
          <CohortEmptyState
            icon={<CalendarClock className="h-5 w-5" />}
            title="No phases yet"
            body="Without phases, every member uses the round's own window. Add a phase to let a subgroup start (and optionally finish) earlier than the rest."
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Subgroup</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>End mode</TableHead>
                <TableHead>Completion</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {phases.map((phase) => {
                const isPending = pendingId === phase.id;
                const isEditing = editingId === phase.id;
                return (
                  <TableRow key={phase.id} className="hover:bg-transparent">
                    <TableCell>
                      <div className="min-w-0 leading-tight">
                        <div className="truncate font-medium">{phase.subgroupName}</div>
                        <div className="text-muted-foreground text-xs">
                          {phase.memberCount} {phase.memberCount === 1 ? 'member' : 'members'}
                        </div>
                      </div>
                    </TableCell>
                    {isEditing ? (
                      <>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Input
                              type="datetime-local"
                              value={draft.opensAt}
                              disabled={isPending}
                              onChange={(e) => setDraft({ ...draft, opensAt: e.target.value })}
                              className="h-8 w-[200px]"
                            />
                            <Input
                              type="datetime-local"
                              value={draft.closesAt}
                              disabled={isPending}
                              onChange={(e) => setDraft({ ...draft, closesAt: e.target.value })}
                              className="h-8 w-[200px]"
                            />
                          </div>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={draft.endMode}
                            onValueChange={(v) =>
                              setDraft({ ...draft, endMode: v as RoundPhaseEndMode })
                            }
                            disabled={isPending}
                          >
                            <SelectTrigger className="h-8 w-[180px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="hard">Hard cutoff</SelectItem>
                              <SelectItem value="relaxed">Relaxed</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <CompletionBar
                            started={phase.stats.sessionsStarted}
                            completed={phase.stats.sessionsCompleted}
                            rate={phase.stats.completionRate}
                            variant="full"
                          />
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => void saveEdit(phase.id)}
                          >
                            {isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => setEditingId(null)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="text-sm tabular-nums">
                          {formatWindow(phase.opensAt, phase.closesAt)}
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground text-xs">
                            {phase.endMode === 'hard' ? 'Hard cutoff' : 'Relaxed'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <CompletionBar
                            started={phase.stats.sessionsStarted}
                            completed={phase.stats.sessionsCompleted}
                            rate={phase.stats.completionRate}
                            variant="full"
                          />
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => startEdit(phase)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={isPending}
                            onClick={() => void deletePhase(phase.id)}
                          >
                            {isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
