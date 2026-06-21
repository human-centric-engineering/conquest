'use client';

/**
 * A cohort's subgroups: the create form plus a table with inline rename and per-row delete.
 *
 * A subgroup is a reusable partition of the roster (e.g. "Senior Leadership Team"). Rounds use it to
 * STAGGER access — a round attaches a window + end mode to each subgroup (see the round Phases panel).
 * Deleting a subgroup unassigns its members (it never deletes anyone) and drops any round phases that
 * targeted it. Members are assigned to a subgroup from the Roster panel. Mirrors the per-row
 * pending-state + `router.refresh()` discipline of `<CohortMembersPanel>`.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Layers, Loader2, Pencil, Trash2, X } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CohortEmptyState } from '@/components/admin/cohorts/cohort-ui';
import type { CohortSubgroupView } from '@/lib/app/questionnaire/rounds';

export interface CohortSubgroupsPanelProps {
  cohortId: string;
  subgroups: CohortSubgroupView[];
}

export function CohortSubgroupsPanel({ cohortId, subgroups }: CohortSubgroupsPanelProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Id of the row whose action (delete / save) is in flight, drives its spinner.
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Id of the row currently being renamed inline (null = none), plus its draft name.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const createSubgroup = async () => {
    if (name.trim() === '') return;
    setCreating(true);
    setError(null);
    try {
      await apiClient.post<CohortSubgroupView>(API.APP.COHORTS.subgroups(cohortId), {
        body: { name: name.trim(), description: description.trim() || null },
      });
      setName('');
      setDescription('');
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not create the subgroup.');
    } finally {
      setCreating(false);
    }
  };

  const saveRename = async (subgroupId: string) => {
    if (editName.trim() === '') return;
    setPendingId(subgroupId);
    setError(null);
    try {
      await apiClient.patch<CohortSubgroupView>(API.APP.COHORTS.subgroup(cohortId, subgroupId), {
        body: { name: editName.trim() },
      });
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not rename the subgroup.');
    } finally {
      setPendingId(null);
    }
  };

  const deleteSubgroup = async (subgroupId: string) => {
    setPendingId(subgroupId);
    setError(null);
    try {
      await apiClient.delete(API.APP.COHORTS.subgroup(cohortId, subgroupId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete the subgroup.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-md border px-4 py-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="subgroup-name" className="flex items-center gap-1">
            Subgroup name
            <FieldHelp title="Subgroup name">
              A reusable partition of this cohort&rsquo;s roster (e.g. &ldquo;Senior Leadership
              Team&rdquo;). Rounds give each subgroup its own access window so one group can go
              before the rest. Unique within the cohort.
            </FieldHelp>
          </Label>
          <Input
            id="subgroup-name"
            placeholder="Senior Leadership Team"
            value={name}
            disabled={creating}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="subgroup-description" className="flex items-center gap-1">
            Description
            <FieldHelp title="Internal note">
              A private admin note about this subgroup. Never shown to respondents.
            </FieldHelp>
          </Label>
          <Input
            id="subgroup-description"
            placeholder="Optional"
            value={description}
            disabled={creating}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Button
            type="button"
            disabled={creating || name.trim() === ''}
            onClick={() => void createSubgroup()}
          >
            {creating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Layers className="mr-2 h-4 w-4" />
            )}
            Add subgroup
          </Button>
        </div>
      </div>

      {subgroups.length === 0 ? (
        <div className="rounded-xl border">
          <CohortEmptyState
            icon={<Layers className="h-5 w-5" />}
            title="No subgroups yet"
            body="Create a subgroup to split this cohort into groups that can take a round at different times — for example, a leadership team that goes first."
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Subgroup</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {subgroups.map((sg) => {
                const isPending = pendingId === sg.id;
                const isEditing = editingId === sg.id;
                return (
                  <TableRow key={sg.id} className="hover:bg-transparent">
                    <TableCell>
                      {isEditing ? (
                        <Input
                          value={editName}
                          disabled={isPending}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-8 max-w-xs"
                        />
                      ) : (
                        <div className="min-w-0 leading-tight">
                          <div className="truncate font-medium">{sg.name}</div>
                          {sg.description && (
                            <div className="text-muted-foreground truncate text-xs">
                              {sg.description}
                            </div>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                      {sg.memberCount}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {isEditing ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isPending || editName.trim() === ''}
                            onClick={() => void saveRename(sg.id)}
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
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => {
                              setEditingId(sg.id);
                              setEditName(sg.name);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={isPending}
                            onClick={() => void deleteSubgroup(sg.id)}
                          >
                            {isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </>
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
