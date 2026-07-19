'use client';

/**
 * InviteImportWizard (invitations Phase D) — a two-step "compose invitations" flow:
 * Import → Verify & send. Four import methods converge on one editable verify grid:
 *  - paste a scruffy list (heuristic, client-side),
 *  - CSV upload (parsed client-side, column-mapped),
 *  - PDF / image upload (AI extraction via the import/extract endpoint; gated by `importEnabled`).
 * The grid renders a column per SHOWN invitee field; the send re-validates server-side against the
 * version's config. Nothing sends without passing through the grid.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  Upload,
  ClipboardList,
  FileText,
  Image as ImageIcon,
  Plus,
  Trash2,
  UserPlus,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePastedInvitees } from '@/lib/app/questionnaire/invitations/import/parse-paste';
import { parseCsvInvitees } from '@/lib/app/questionnaire/invitations/import/parse-csv';
import type { ParsedInvitee } from '@/lib/app/questionnaire/invitations/import/types';
import {
  INVITEE_FIELD_LABELS,
  type InviteeFieldConfig,
  type InviteeFieldKey,
} from '@/lib/app/questionnaire/types';
import type { InvitationSendResult } from '@/lib/app/questionnaire/invitations';

type Method = 'paste' | 'csv' | 'pdf' | 'image';
type Step = 'import' | 'verify';

interface Props {
  questionnaireId: string;
  /** Resolved invitee-field config (email forced shown+required) — drives the grid columns. */
  inviteeFields: InviteeFieldConfig[];
  /** Whether the AI import methods (PDF/image) are offered. Callers pass `true` today. */
  importEnabled: boolean;
  /** No launched version → the whole flow is disabled. */
  disabled: boolean;
}

const PROFILE_KEYS: InviteeFieldKey[] = [
  'firstName',
  'surname',
  'jobTitle',
  'team',
  'organisation',
];

export function InviteImportWizard({
  questionnaireId,
  inviteeFields,
  importEnabled,
  disabled,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('import');
  const [method, setMethod] = useState<Method>('paste');
  const [pasteText, setPasteText] = useState('');
  const [rows, setRows] = useState<ParsedInvitee[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InvitationSendResult[] | null>(null);

  const shown = inviteeFields.filter((f) => f.shown);
  const shownProfile = shown.filter((f) => f.key !== 'email');

  function toVerify(parsed: { people: ParsedInvitee[]; warnings: string[] }) {
    setRows(parsed.people);
    setWarnings(parsed.warnings);
    setError(
      parsed.people.length === 0 ? 'No people found — check your input or add rows manually.' : null
    );
    setStep('verify');
  }

  async function onCsvFile(file: File) {
    toVerify(parseCsvInvitees(await file.text()));
  }

  async function onExtractFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(API.APP.QUESTIONNAIRES.invitationImportExtract(questionnaireId), {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      const parsed = await parseApiResponse<{ people: ParsedInvitee[]; warnings: string[] }>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      toVerify(parsed.data);
    } catch {
      setError('Extraction failed. Please try again or add people manually.');
    } finally {
      setBusy(false);
    }
  }

  function updateCell(i: number, key: InviteeFieldKey, value: string) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  }

  async function send() {
    const recipients = rows
      .map((r) => {
        const profile: Partial<Record<InviteeFieldKey, string>> = {};
        for (const k of PROFILE_KEYS) {
          const v = r[k]?.trim();
          if (v) profile[k] = v;
        }
        return { email: (r.email ?? '').trim(), profile };
      })
      .filter((r) => r.email.length > 0);
    if (recipients.length === 0) {
      setError('Add at least one row with an email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.invitations(questionnaireId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients }),
      });
      const parsed = await parseApiResponse<{ results: InvitationSendResult[] }>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      setResults(parsed.data.results);
      router.refresh();
    } catch {
      setError('Send failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setStep('import');
    setRows([]);
    setWarnings([]);
    setResults(null);
    setError(null);
    setPasteText('');
  }

  if (disabled) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        Launch a version to start inviting respondents.
      </p>
    );
  }

  // Post-send summary.
  if (results) {
    const n = (o: InvitationSendResult['outcome']) => results.filter((r) => r.outcome === o).length;
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm font-medium">
          {n('sent')} sent · {n('skipped')} skipped · {n('failed')} failed
        </p>
        {results.some((r) => r.outcome !== 'sent') && (
          <ul className="text-muted-foreground space-y-0.5 text-xs">
            {results
              .filter((r) => r.outcome !== 'sent')
              .map((r) => (
                <li key={r.email}>
                  {r.email} — {r.outcome}
                  {r.reason ? `: ${r.reason}` : ''}
                </li>
              ))}
          </ul>
        )}
        <Button size="sm" variant="outline" onClick={restart}>
          Invite more
        </Button>
      </div>
    );
  }

  const methods: { key: Method; label: string; icon: typeof Upload; show: boolean }[] = [
    { key: 'paste', label: 'Paste a list', icon: ClipboardList, show: true },
    { key: 'csv', label: 'CSV upload', icon: Upload, show: true },
    { key: 'pdf', label: 'PDF → extract', icon: FileText, show: importEnabled },
    { key: 'image', label: 'Image → extract', icon: ImageIcon, show: importEnabled },
  ];

  return (
    <div className="bg-card space-y-4 rounded-xl border shadow-sm">
      {/* Editorial header band (cq-surface) with a two-step indicator. */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]">
          <UserPlus className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight">Add invitations</p>
          <p className="text-muted-foreground text-xs">Import a list, review it, then send.</p>
        </div>
        <ol className="flex items-center gap-2 text-xs font-medium">
          {(['import', 'verify'] as const).map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={step === s ? 'text-[var(--cq-accent)]' : 'text-muted-foreground/60'}>
                {i + 1}. {s === 'import' ? 'Import' : 'Verify'}
              </span>
              {i === 0 ? (
                <span className="text-muted-foreground/40" aria-hidden>
                  →
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-4 px-4 pb-4">
        {error && <p className="text-destructive text-sm">{error}</p>}

        {step === 'import' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {methods
                .filter((m) => m.show)
                .map((m) => (
                  <Button
                    key={m.key}
                    type="button"
                    size="sm"
                    variant={method === m.key ? 'default' : 'outline'}
                    onClick={() => setMethod(m.key)}
                  >
                    <m.icon className="mr-1.5 h-3.5 w-3.5" />
                    {m.label}
                  </Button>
                ))}
            </div>

            {method === 'paste' && (
              <div className="space-y-2">
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={6}
                  placeholder={'Ada Lovelace <ada@example.com>\nGrace Hopper, grace@navy.mil\n…'}
                  aria-label="Paste a list of people"
                />
                <Button
                  size="sm"
                  disabled={!pasteText.trim()}
                  onClick={() => toVerify(parsePastedInvitees(pasteText))}
                >
                  Parse list
                </Button>
              </div>
            )}

            {method === 'csv' && (
              <Input
                type="file"
                accept=".csv,text/csv"
                aria-label="Upload a CSV"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onCsvFile(f);
                }}
              />
            )}

            {(method === 'pdf' || method === 'image') && (
              <div className="space-y-2">
                <Input
                  type="file"
                  accept={
                    method === 'pdf' ? '.pdf,application/pdf' : 'image/png,image/jpeg,image/webp'
                  }
                  disabled={busy}
                  aria-label={`Upload a ${method}`}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onExtractFile(f);
                  }}
                />
                {busy && (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2 className="h-3 w-3 animate-spin" /> Extracting people…
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {step === 'verify' && (
          <div className="space-y-3">
            {warnings.length > 0 && (
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-left text-xs">
                    {shown.map((f) => (
                      <th key={f.key} className="px-1 pb-1 font-medium">
                        {INVITEE_FIELD_LABELS[f.key]}
                        {f.required ? ' *' : ''}
                      </th>
                    ))}
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td className="px-1 py-0.5">
                        <Input
                          value={row.email ?? ''}
                          className="h-8 text-xs"
                          onChange={(e) => updateCell(i, 'email', e.target.value)}
                          aria-label={`Email row ${i + 1}`}
                        />
                      </td>
                      {shownProfile.map((f) => (
                        <td key={f.key} className="px-1 py-0.5">
                          <Input
                            value={row[f.key] ?? ''}
                            className="h-8 text-xs"
                            onChange={(e) => updateCell(i, f.key, e.target.value)}
                            aria-label={`${INVITEE_FIELD_LABELS[f.key]} row ${i + 1}`}
                          />
                        </td>
                      ))}
                      <td className="px-1 py-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Remove row ${i + 1}`}
                          onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="text-destructive h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRows((prev) => [...prev, { email: '' }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add row
              </Button>
              <Label className="text-muted-foreground ml-auto text-xs">
                {rows.length} recipient(s)
              </Label>
              <Button variant="ghost" size="sm" onClick={restart} disabled={busy}>
                Start over
              </Button>
              <Button size="sm" onClick={() => void send()} disabled={busy || rows.length === 0}>
                {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Send {rows.length} invitation{rows.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
