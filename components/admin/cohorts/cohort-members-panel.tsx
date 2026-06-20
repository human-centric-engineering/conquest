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
import { Loader2, RotateCcw, UserMinus } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
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
import { CohortMemberForm } from '@/components/admin/cohorts/cohort-member-form';
import type { CohortMemberStatus, CohortMemberView } from '@/lib/app/questionnaire/rounds';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const STATUS_BADGE: Record<
  CohortMemberStatus,
  { label: string; variant: 'default' | 'secondary' }
> = {
  active: { label: 'Active', variant: 'default' },
  removed: { label: 'Removed', variant: 'secondary' },
};

export interface CohortMembersPanelProps {
  cohortId: string;
  members: CohortMemberView[];
}

export function CohortMembersPanel({ cohortId, members }: CohortMembersPanelProps) {
  const router = useRouter();
  // Id of the row whose status is currently changing (drives the spinner).
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="space-y-4">
      <CohortMemberForm cohortId={cohortId} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Added</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-10 text-center">
                  No members yet. Add people above to deliver rounds to them.
                </TableCell>
              </TableRow>
            ) : (
              members.map((member) => {
                const badge = STATUS_BADGE[member.status];
                const isPending = pendingId === member.id;
                const isRemoved = member.status === 'removed';
                return (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">{member.name}</TableCell>
                    <TableCell className="text-muted-foreground">{member.email}</TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">
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
              })
            )}
          </TableBody>
        </Table>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
