'use client';

/**
 * DatasetCasesTable — client-side rendering of a dataset's case preview
 * with per-row Edit affordance. Wraps the existing table layout from
 * the dataset detail page so the server component stays a data shell.
 *
 * Editing posts to `PATCH /datasets/:id/cases/:position`, which
 * re-hashes the dataset. Past `AiEvaluationRun` rows are unaffected —
 * their `datasetContentHash` was pinned at queue time.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { API } from '@/lib/api/endpoints';

export interface DatasetCaseRow {
  id: string;
  position: number;
  input: unknown;
  expectedOutput: string | null;
}

interface DatasetCasesTableProps {
  datasetId: string;
  initialCases: DatasetCaseRow[];
}

type ApiSuccess<T> = { success: true; data: T };
type ApiError = { success: false; error: { message: string } };

interface PatchCaseResult {
  case: {
    id: string;
    position: number;
    input: unknown;
    expectedOutput: string | null;
  };
  contentHash: string;
}

function summariseInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '[unrenderable input]';
  }
}

function stringInputOrEmpty(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

export function DatasetCasesTable({
  datasetId,
  initialCases,
}: DatasetCasesTableProps): React.ReactElement {
  const router = useRouter();
  const [cases, setCases] = React.useState<DatasetCaseRow[]>(initialCases);
  const [editing, setEditing] = React.useState<DatasetCaseRow | null>(null);
  const [inputDraft, setInputDraft] = React.useState('');
  const [expectedDraft, setExpectedDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function openEdit(row: DatasetCaseRow): void {
    setEditing(row);
    setInputDraft(stringInputOrEmpty(row.input));
    setExpectedDraft(row.expectedOutput ?? '');
    setError(null);
  }

  function closeEdit(): void {
    if (saving) return;
    setEditing(null);
    setError(null);
  }

  async function handleSave(): Promise<void> {
    if (!editing) return;
    const inputIsObject = typeof editing.input !== 'string';
    if (!inputIsObject && inputDraft.trim().length === 0) {
      setError('Input cannot be empty.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      // Object inputs (workflow subjects) are read-only in the dialog —
      // don't send the input field in that case.
      if (!inputIsObject && inputDraft !== editing.input) {
        patch.input = inputDraft;
      }
      const expectedNext = expectedDraft.length > 0 ? expectedDraft : null;
      if (expectedNext !== editing.expectedOutput) {
        patch.expectedOutput = expectedNext;
      }
      if (Object.keys(patch).length === 0) {
        setEditing(null);
        return;
      }

      const res = await fetch(
        API.ADMIN.ORCHESTRATION.evalDatasetCaseByPosition(datasetId, editing.position),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }
      );
      const payload = (await res.json()) as ApiSuccess<PatchCaseResult> | ApiError;
      if (!res.ok || !payload.success) {
        setError(!payload.success ? payload.error.message : `Failed (${res.status})`);
        return;
      }

      setCases((prev) =>
        prev.map((c) =>
          c.position === editing.position
            ? {
                ...c,
                input: payload.data.case.input,
                expectedOutput: payload.data.case.expectedOutput,
              }
            : c
        )
      );
      setEditing(null);
      // Refresh the server-rendered shell so the new contentHash chip
      // + updatedAt timestamps stay accurate.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const editingInputIsObject = editing ? typeof editing.input !== 'string' : false;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>Input</TableHead>
            <TableHead>Expected output</TableHead>
            <TableHead className="w-20"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-mono">{c.position}</TableCell>
              <TableCell className="max-w-md">
                <div className="line-clamp-3 text-xs whitespace-pre-wrap">
                  {summariseInput(c.input)}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground max-w-md">
                <div className="line-clamp-3 text-xs whitespace-pre-wrap">
                  {c.expectedOutput ?? '—'}
                </div>
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(c)}
                  aria-label={`Edit case ${c.position}`}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && closeEdit()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit case {editing?.position}</DialogTitle>
            <DialogDescription>
              Edits update the dataset&apos;s content hash. Past evaluation runs are unaffected —
              their hash was pinned at queue time.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-input">Input</Label>
              {editingInputIsObject ? (
                <p className="bg-muted/40 rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                  {summariseInput(editing?.input)}
                </p>
              ) : (
                <Textarea
                  id="edit-input"
                  rows={3}
                  value={inputDraft}
                  onChange={(e) => setInputDraft(e.target.value)}
                  className="text-sm"
                />
              )}
              {editingInputIsObject ? (
                <p className="text-muted-foreground text-xs">
                  Object inputs (workflow subjects) aren&apos;t editable here.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-expected">Expected output</Label>
              <Textarea
                id="edit-expected"
                rows={4}
                value={expectedDraft}
                onChange={(e) => setExpectedDraft(e.target.value)}
                placeholder="What a competent agent should answer. Leave blank to clear."
                className="text-sm"
              />
            </div>
          </div>

          {error ? (
            <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
              {error}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={closeEdit} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
