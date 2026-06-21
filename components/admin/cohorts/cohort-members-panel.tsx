'use client';

/**
 * A cohort's roster: the add-member form plus a table with per-row remove / reactivate.
 *
 * Removing a member is a SOFT delete (DELETE → status `removed`, the row survives so
 * its sessions stay intact); reactivating is `PATCH { status: 'active' }`. Both use the
 * per-row pending-state pattern from `<AttributedQuestionnaires>` (one spinner keyed on
 * the acting row), and refresh on success so the SSR roster + headline counts re-read.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw, UserMinus, UserPlus } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CohortMemberForm } from '@/components/admin/cohorts/cohort-member-form';
import {
  CohortEmptyState,
  MemberAvatar,
  MemberStatusPill,
} from '@/components/admin/cohorts/cohort-ui';
import type { CohortMemberView, CohortSubgroupView } from '@/lib/app/questionnaire/rounds';

/** Sentinel for the "no subgroup" option — `<Select>` can't use an empty-string value. */
const NO_SUBGROUP = '__none__';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export interface CohortMembersPanelProps {
  cohortId: string;
  members: CohortMemberView[];
  /**
   * The cohort's subgroups, when round phasing is enabled — renders a per-member subgroup selector.
   * Omitted/empty hides the column entirely (the feature is off, or no subgroups exist yet).
   */
  subgroups?: CohortSubgroupView[];
}

export function CohortMembersPanel({ cohortId, members, subgroups = [] }: CohortMembersPanelProps) {
  const router = useRouter();
  // Id of the row whose status is currently changing (drives the spinner).
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Id of the row whose subgroup assignment is in flight (separate so it doesn't disable remove).
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showSubgroups = subgroups.length > 0;

  const assignSubgroup = async (memberId: string, value: string) => {
    setAssigningId(memberId);
    setError(null);
    try {
      await apiClient.patch<CohortMemberView>(API.APP.COHORTS.member(cohortId, memberId), {
        body: { subgroupId: value === NO_SUBGROUP ? null : value },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not change the subgroup.');
    } finally {
      setAssigningId(null);
    }
  };

  const removeMember = async (memberId: string) => {
    setPendingId(memberId);
    setError(null);
    try {
      await apiClient.delete<CohortMemberView>(API.APP.COHORTS.member(cohortId, memberId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not remove the member.');
    } finally {
      setPendingId(null);
    }
  };

  const reactivateMember = async (memberId: string) => {
    setPendingId(memberId);
    setError(null);
    try {
      await apiClient.patch<CohortMemberView>(API.APP.COHORTS.member(cohortId, memberId), {
        body: { status: 'active' },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not reactivate the member.');
    } finally {
      setPendingId(null);
    }
  };

  const activeCount = members.filter((m) => m.status === 'active').length;

  return (
    <div className="space-y-4">
      <CohortMemberForm cohortId={cohortId} />

      {members.length === 0 ? (
        <div className="rounded-xl border">
          <CohortEmptyState
            icon={<UserPlus className="h-5 w-5" />}
            title="No members yet"
            body="Add people by name and email above. They’ll receive a secure link when you run a round — and you can add or remove members at any time, even mid-round."
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <div className="text-muted-foreground bg-muted/40 flex items-center justify-between border-b px-4 py-2 text-xs">
            <span>
              <span className="text-foreground font-medium tabular-nums">{activeCount}</span> active
              {members.length > activeCount && <> · {members.length - activeCount} removed</>}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Member</TableHead>
                <TableHead>Status</TableHead>
                {showSubgroups && <TableHead>Subgroup</TableHead>}
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const isPending = pendingId === member.id;
                const isRemoved = member.status === 'removed';
                return (
                  <TableRow
                    key={member.id}
                    className={cn('hover:bg-transparent', isRemoved && 'opacity-60')}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <MemberAvatar name={member.name} dimmed={isRemoved} />
                        <div className="min-w-0 leading-tight">
                          <div className="truncate font-medium">{member.name}</div>
                          <div className="text-muted-foreground truncate text-xs">
                            {member.email}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <MemberStatusPill status={member.status} />
                    </TableCell>
                    {showSubgroups && (
                      <TableCell>
                        <Select
                          value={member.subgroupId ?? NO_SUBGROUP}
                          disabled={isRemoved || assigningId === member.id}
                          onValueChange={(v) => void assignSubgroup(member.id, v)}
                        >
                          <SelectTrigger className="h-8 w-[180px]">
                            <SelectValue placeholder="No subgroup" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_SUBGROUP}>No subgroup</SelectItem>
                            {subgroups.map((sg) => (
                              <SelectItem key={sg.id} value={sg.id}>
                                {sg.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                      {formatDate(member.addedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isRemoved ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isPending}
                          onClick={() => void reactivateMember(member.id)}
                        >
                          {isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-2 h-4 w-4" />
                          )}
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={isPending}
                          onClick={() => void removeMember(member.id)}
                        >
                          {isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <UserMinus className="mr-2 h-4 w-4" />
                          )}
                          Remove
                        </Button>
                      )}
                    </TableCell>
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
