'use client';

/**
 * DEMO-ONLY: clone a questionnaire's current version into a new questionnaire for a
 * chosen demo client — re-use the same questionnaire for the next prospect.
 *
 * POSTs `clone-for-client` and routes to the new draft on success. Picker options are
 * the *active* demo clients (resolved server-side, passed in); "None" produces a
 * generic unattributed copy. Models {@link file://./reingest-dialog.tsx} /
 * upload-questionnaire-dialog. A fork strips demo tenancy.
 */

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

const NONE = '__none__';

interface CloneResult {
  questionnaireId: string;
  versionId: string;
}

export interface CloneForClientDialogProps {
  questionnaireId: string;
  /** Active demo clients available to attribute the clone to. */
  options: AttributedDemoClient[];
}

export function CloneForClientDialog({ questionnaireId, options }: CloneForClientDialogProps) {
  const router = useRouter();
  const clientId = useId();
  const suffixId = useId();

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(NONE);
  const [nameSuffix, setNameSuffix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTarget(NONE);
    setNameSuffix('');
    setError(null);
    setBusy(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.cloneForClient(questionnaireId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDemoClientId: target === NONE ? null : target,
          ...(nameSuffix.trim() ? { nameSuffix: nameSuffix.trim() } : {}),
        }),
      });
      const parsed = await parseApiResponse<CloneResult>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      // Land on the new draft. Keep busy through navigation so the form stays disabled.
      setOpen(false);
      router.push(`/admin/questionnaires/${parsed.data.questionnaireId}`);
    } catch {
      setError('Clone failed. Please try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Copy className="mr-1.5 h-4 w-4" />
          Clone for client
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clone for another client</DialogTitle>
          <DialogDescription>
            Copies this questionnaire&apos;s current version — structure, tags, and configuration —
            into a new draft questionnaire attributed to the chosen demo client. Sessions,
            invitations, and evaluation runs are not copied.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={clientId} className="flex items-center gap-1">
              Demo client
              <FieldHelp title="Target demo client">
                The prospect the clone is for. &ldquo;None&rdquo; creates a generic, unattributed
                copy. Only active demo clients are listed.
              </FieldHelp>
            </Label>
            <Select value={target} onValueChange={setTarget} disabled={busy}>
              <SelectTrigger id={clientId}>
                <SelectValue placeholder="None (generic copy)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None (generic copy)</SelectItem>
                {options.map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={suffixId} className="flex items-center gap-1">
              Title suffix
              <FieldHelp title="Title suffix">
                Appended to the new questionnaire&apos;s title after an em dash. Leave blank to use
                the client&apos;s name (or &ldquo;Copy&rdquo; for a generic clone).
              </FieldHelp>
            </Label>
            <Input
              id={suffixId}
              value={nameSuffix}
              onChange={(e) => setNameSuffix(e.target.value)}
              disabled={busy}
              placeholder="Defaults to the client name"
              maxLength={120}
            />
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Clone questionnaire
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
