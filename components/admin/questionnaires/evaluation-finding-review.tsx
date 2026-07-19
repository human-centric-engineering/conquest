'use client';

/**
 * FindingReviewCard (F5.3) — one finding in the review queue, with its triage actions.
 *
 * Shows the finding (severity, target, proposed change, rationale, quote) plus, when the judge
 * attached a structured edit, a one-line summary of what the primary action will do. The primary
 * work-action is sized by the finding's effective op; Accept/Dismiss stay as quiet secondary triage
 * so the work-action is never mistaken for "do it":
 *
 *  - `add_question` (deep-link) → primary "Add to questionnaire" (one-click apply, forks if
 *    launched) + secondary "Open in editor" (deep-links the editor with the draft pre-filled to
 *    refine before saving). No "Accept" here — both work-actions already imply acceptance; only
 *    "Dismiss" stays.
 *  - other structured op (apply) → "Edit" (tweak the op) + primary "Apply" (disabled when stale).
 *  - prose-only (manual)        → "Open in editor" (nothing to pre-fill — author it by hand).
 *
 * Accept/Dismiss/Edit hit the PATCH review route; Apply / Add hit the apply route (which may fork
 * the version — the parent shows the fork banner from the returned meta). All mutations are
 * enforced server-side; this card only renders the affordances.
 */

import { useState } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
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
import { QUESTION_TYPES, QUESTION_TYPE_LABELS } from '@/lib/app/questionnaire/types';
import type { ProposedEdit } from '@/lib/app/questionnaire/evaluation';
import type { EvaluationFindingView } from '@/lib/app/questionnaire/views';
import {
  findingReviewStatusBadge,
  findingSeverityBadge,
} from '@/components/admin/questionnaires/evaluation-status-badge';

interface ApplyMeta {
  forked: boolean;
  versionId: string;
  versionNumber: number;
}

interface Props {
  finding: EvaluationFindingView;
  questionnaireId: string;
  versionId: string;
  runId: string;
  canApply: boolean;
  /** Whether the version has data slots — drives the "slot the new question" checkbox on add_question. */
  dataSlotsAvailable?: boolean;
  /** Called with the server's updated view; `meta` is present after a successful apply. */
  onUpdate: (next: EvaluationFindingView, meta?: ApplyMeta) => void;
}

/** A one-line, human description of what a structured op will do when applied. */
function describeOp(op: ProposedEdit): string {
  switch (op.op) {
    case 'replace_prompt':
      return 'Rewrite the question prompt';
    case 'edit_guidelines':
      return op.guidelines === null ? 'Clear the author guidelines' : 'Set the author guidelines';
    case 'change_type':
      return `Change answer type → ${QUESTION_TYPE_LABELS[op.type]}`;
    case 'delete_question':
      return 'Delete this question';
    case 'reorder':
      return op.targetSectionKey
        ? `Move to “${op.targetSectionKey}”, position ${op.ordinal + 1}`
        : `Move to position ${op.ordinal + 1}`;
    case 'edit_goal':
      return 'Replace the questionnaire goal';
    case 'edit_audience':
      return `Adjust audience (${Object.keys(op.audience).join(', ')})`;
    case 'add_question':
      return `Add a new ${QUESTION_TYPE_LABELS[op.type]} question`;
  }
}

async function sendJson(
  url: string,
  method: 'PATCH' | 'POST',
  body?: unknown
): Promise<{ ok: true; data: unknown; meta?: unknown } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await parseApiResponse<unknown>(res);
    if (!res.ok || !json.success) {
      const reason = !json.success ? json.error.details?.reason : undefined;
      const message = !json.success ? json.error.message : 'Request failed';
      return {
        ok: false,
        message: typeof reason === 'string' ? `${message} (${reason})` : message,
      };
    }
    return { ok: true, data: json.data, meta: json.meta };
  } catch {
    // Network failure or a body that isn't a valid API envelope — `parseApiResponse` throws on
    // the latter, so a malformed response surfaces here rather than being cast into shape.
    return { ok: false, message: 'Network error' };
  }
}

export function FindingReviewCard({
  finding,
  questionnaireId,
  versionId,
  runId,
  canApply,
  dataSlotsAvailable = false,
  onUpdate,
}: Props) {
  const [busy, setBusy] = useState<null | 'accept' | 'decline' | 'edit' | 'apply'>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [addToDataSlots, setAddToDataSlots] = useState(true);

  const sev = findingSeverityBadge(finding.severity);
  const statusBadge = findingReviewStatusBadge(finding.status);
  const op = finding.editedOverride ?? finding.proposedEdit;
  const addOp = op && op.op === 'add_question' ? op : null;
  const isTerminal = finding.status === 'applied' || finding.status === 'declined';
  const editorBase = `/admin/questionnaires/${questionnaireId}/v/${versionId}/structure`;
  // Prose-only / refine link opens the editor in edit mode; an add_question carries the finding ref
  // so the editor can pre-fill a highlighted new-question composer (see EvaluationSeedComposer).
  const editorHref = `${editorBase}?edit=1`;
  const seedHref = `${editorBase}?edit=1&seedFinding=${encodeURIComponent(`${runId}:${finding.id}`)}`;
  const applyDisabledTitle = !canApply
    ? 'Design evaluation is disabled'
    : finding.stale
      ? 'The structure changed since this run — re-run the evaluation'
      : undefined;
  const findingPath = API.APP.QUESTIONNAIRES.versionEvaluationFinding(
    questionnaireId,
    versionId,
    runId,
    finding.id
  );

  async function decide(action: 'accept' | 'decline') {
    setBusy(action);
    setError(null);
    const res = await sendJson(findingPath, 'PATCH', { action });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    onUpdate(res.data as EvaluationFindingView);
  }

  async function apply() {
    setBusy('apply');
    setError(null);
    const res = await sendJson(
      API.APP.QUESTIONNAIRES.versionEvaluationFindingApply(
        questionnaireId,
        versionId,
        runId,
        finding.id
      ),
      'POST'
    );
    setBusy(null);
    if (!res.ok) return setError(res.message);
    const data = res.data as { finding: EvaluationFindingView | null };
    if (data.finding) onUpdate(data.finding, res.meta as ApplyMeta | undefined);

    // For a newly-added question, optionally slot it (into an existing data slot or a new one) on
    // whichever version it landed on. Best-effort fire-and-forget: the question is already added.
    if (addOp && dataSlotsAvailable && addToDataSlots) {
      const meta = res.meta as ApplyMeta | undefined;
      const targetVersionId = data.finding?.appliedToVersionId ?? meta?.versionId ?? versionId;
      void fetch(API.APP.QUESTIONNAIRES.versionDataSlotsAssign(questionnaireId, targetVersionId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).catch(() => {
        // swallow — slotting is a follow-up; the suggestion was applied.
      });
    }
  }

  async function saveEdit(nextOp: ProposedEdit) {
    setBusy('edit');
    setError(null);
    const res = await sendJson(findingPath, 'PATCH', { action: 'edit', editedOverride: nextOp });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    setEditing(false);
    onUpdate(res.data as EvaluationFindingView);
  }

  return (
    <li
      className={`rounded-md border p-3 ${isTerminal ? 'opacity-60' : ''} ${finding.stale ? 'border-amber-400' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={sev.variant} className="text-xs">
          {sev.label}
        </Badge>
        <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{finding.targetKey}</code>
        <Badge variant={statusBadge.variant} className="text-xs">
          {statusBadge.label}
        </Badge>
        {finding.stale && !isTerminal && (
          <Badge variant="outline" className="border-amber-500 text-xs text-amber-700">
            Stale — re-run
          </Badge>
        )}
      </div>

      <p className="mt-2 text-sm font-medium">{finding.proposedChange}</p>
      <p className="text-muted-foreground mt-1 text-sm">{finding.rationale}</p>
      {finding.sourceQuote && (
        <blockquote className="text-muted-foreground mt-2 border-l-2 pl-3 text-xs italic">
          {finding.sourceQuote}
        </blockquote>
      )}

      {op && (
        <p className="mt-2 text-xs">
          <span className="text-muted-foreground">Edit: </span>
          <span className="font-medium">{describeOp(op)}</span>
          {finding.editedOverride && <span className="text-muted-foreground"> · edited</span>}
        </p>
      )}

      {/* For a suggested new question, preview the drafted prompt + guidelines so the admin can
          decide to add it in one click — or open the editor to refine it first. */}
      {addOp && (
        <div className="bg-muted/40 mt-2 rounded-md border p-2.5">
          <p className="text-sm font-medium">{addOp.prompt}</p>
          {addOp.guidelines && (
            <p className="text-muted-foreground mt-1 text-xs">{addOp.guidelines}</p>
          )}
        </div>
      )}

      {finding.appliedToVersionId && (
        <p className="text-muted-foreground mt-1 text-xs">
          Applied to{' '}
          <Link
            href={`/admin/questionnaires/${questionnaireId}/v/${finding.appliedToVersionId}/structure`}
            className="underline"
          >
            a draft version
          </Link>
          .
        </p>
      )}

      {editing && op ? (
        <EditOverrideForm
          op={op}
          busy={busy === 'edit'}
          onCancel={() => setEditing(false)}
          onSave={(next) => void saveEdit(next)}
        />
      ) : (
        !isTerminal && (
          <>
            {addOp && dataSlotsAvailable && (
              <label
                htmlFor={`add-slot-${finding.id}`}
                className="text-muted-foreground mt-3 flex items-center gap-2 text-xs"
              >
                <Checkbox
                  id={`add-slot-${finding.id}`}
                  checked={addToDataSlots}
                  onCheckedChange={setAddToDataSlots}
                  disabled={busy !== null}
                />
                Add to a data slot (create one if needed)
              </label>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* Primary work-action, sized by the effective op. */}
              {addOp ? (
                <>
                  <Button
                    size="sm"
                    disabled={busy !== null || finding.stale || !canApply}
                    title={applyDisabledTitle}
                    onClick={() => void apply()}
                  >
                    {busy === 'apply' ? 'Adding…' : 'Add to questionnaire'}
                  </Button>
                  <Button asChild size="sm" variant="secondary">
                    <Link href={seedHref}>Open in editor</Link>
                  </Button>
                </>
              ) : finding.applicable === 'apply' && op ? (
                <>
                  {isEditableOp(op) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={busy !== null || finding.stale || !canApply}
                    title={applyDisabledTitle}
                    onClick={() => void apply()}
                  >
                    {busy === 'apply' ? 'Applying…' : 'Apply'}
                  </Button>
                </>
              ) : (
                <Button asChild size="sm" variant="secondary">
                  <Link href={editorHref}>Open in editor →</Link>
                </Button>
              )}

              {/* Quiet secondary triage. Dismiss always; Accept (agree-but-not-yet-applied) only
                  where it's distinct from the work-action — for add_question, "Add to
                  questionnaire"/"Open in editor" already imply acceptance, so Accept is omitted. */}
              <span className="bg-border mx-1 h-5 w-px" aria-hidden />
              {!addOp && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={busy !== null}
                  onClick={() => void decide('accept')}
                >
                  {busy === 'accept' ? 'Accepting…' : 'Accept'}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={busy !== null}
                onClick={() => void decide('decline')}
              >
                {busy === 'decline' ? 'Dismissing…' : 'Dismiss'}
              </Button>
            </div>
          </>
        )
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </li>
  );
}

/** Ops the inline form can edit (text ops + type + ordinal). Others edit via the main editor. */
function isEditableOp(op: ProposedEdit): boolean {
  return (
    op.op === 'replace_prompt' ||
    op.op === 'edit_guidelines' ||
    op.op === 'edit_goal' ||
    op.op === 'change_type' ||
    op.op === 'reorder'
  );
}

/** Compact, op-aware edit form. Covers the high-value edits; structured config edits stay in the editor. */
function EditOverrideForm({
  op,
  busy,
  onCancel,
  onSave,
}: {
  op: ProposedEdit;
  busy: boolean;
  onCancel: () => void;
  onSave: (next: ProposedEdit) => void;
}) {
  const [text, setText] = useState(initialText(op));
  const [type, setType] = useState(op.op === 'change_type' ? op.type : 'free_text');
  const [ordinal, setOrdinal] = useState(op.op === 'reorder' ? String(op.ordinal) : '0');

  function build(): ProposedEdit | null {
    switch (op.op) {
      case 'replace_prompt':
        return text.trim() ? { op: 'replace_prompt', prompt: text.trim() } : null;
      case 'edit_guidelines':
        return { op: 'edit_guidelines', guidelines: text.trim() ? text.trim() : null };
      case 'edit_goal':
        return text.trim() ? { op: 'edit_goal', goal: text.trim() } : null;
      case 'change_type':
        return { op: 'change_type', type };
      case 'reorder': {
        const n = Number.parseInt(ordinal, 10);
        if (Number.isNaN(n) || n < 0) return null;
        return {
          op: 'reorder',
          ordinal: n,
          ...(op.targetSectionKey ? { targetSectionKey: op.targetSectionKey } : {}),
        };
      }
      default:
        return op;
    }
  }

  const built = build();

  return (
    <div className="bg-muted/40 mt-3 space-y-2 rounded-md border p-3">
      {(op.op === 'replace_prompt' || op.op === 'edit_guidelines' || op.op === 'edit_goal') && (
        <div className="space-y-1">
          <Label className="text-xs">
            {op.op === 'replace_prompt'
              ? 'New prompt'
              : op.op === 'edit_goal'
                ? 'New goal'
                : 'Guidelines'}{' '}
            <FieldHelp title="Edit before applying">
              <p>
                Tweak the wording the judge proposed. Applying writes this to the draft version.
              </p>
            </FieldHelp>
          </Label>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        </div>
      )}

      {op.op === 'change_type' && (
        <div className="space-y-1">
          <Label className="text-xs">
            New answer type{' '}
            <FieldHelp title="Change answer type">
              <p>
                Applying resets the question&apos;s type configuration to this type&apos;s default —
                you can refine choices/scale afterwards in the editor.
              </p>
            </FieldHelp>
          </Label>
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger className="h-8 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUESTION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {QUESTION_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {op.op === 'reorder' && (
        <div className="space-y-1">
          <Label className="text-xs">
            Position (0-based){' '}
            <FieldHelp title="Move the question">
              <p>
                The 0-based position within its section. Out-of-range values are clamped on apply.
              </p>
            </FieldHelp>
          </Label>
          <input
            type="number"
            min={0}
            value={ordinal}
            onChange={(e) => setOrdinal(e.target.value)}
            className="border-input h-8 w-24 rounded-md border px-2 text-xs"
          />
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !built} onClick={() => built && onSave(built)}>
          {busy ? 'Saving…' : 'Save edit'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Seed the textarea from the op's editable text field. */
function initialText(op: ProposedEdit): string {
  if (op.op === 'replace_prompt') return op.prompt;
  if (op.op === 'edit_guidelines') return op.guidelines ?? '';
  if (op.op === 'edit_goal') return op.goal;
  return '';
}
