'use client';

/**
 * FindingReviewCard (F5.3) — one finding in the review queue, with its triage actions.
 *
 * **Two bands.** A tinted, ruled-off header carries what the finding is *about* — the badges and,
 * under a judge heading, the question itself; everything below the rule is the judge talking. That
 * split is the card's main job: the questionnaire's own words and the AI's opinion of them are
 * otherwise three near-identical paragraphs, and a reader landing mid-card cannot tell which is
 * which. Inside the body every block is introduced by a `FieldLabel` eyebrow — Suggestion,
 * Rationale, Evidence, Edit — from `evaluation-field.tsx`, shared so the treatment is one thing
 * across evaluation surfaces rather than per-file class strings.
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
 *
 * **Apply vs Accept.** These are the two easiest actions to confuse — the words are near-synonyms
 * in English but do very different things, and a divider alone did not carry that. So the two are
 * split by position — decision-recording on the left under a "Record a decision:" label, the
 * questionnaire-changing work-actions pushed to the far right — and every action carries a `Tip`
 * naming its exact effect (Apply's is generated from `describeOp`, so it states the actual edit):
 *
 *  - **Apply** writes to the questionnaire now, forking a launched version into a draft first.
 *  - **Accept** changes nothing — it records agreement so an admin can triage a whole run first
 *    and then apply the survivors, landing every edit in one draft (the fork-lineage rule).
 *  - **Dismiss** rejects the suggestion; nothing changes.
 */

import { useState } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
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
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  questionTypeLabel,
} from '@/lib/app/questionnaire/types';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation';
import type { ProposedEdit } from '@/lib/app/questionnaire/evaluation';
import type { EvaluationFindingView, FindingTargetKind } from '@/lib/app/questionnaire/views';
import {
  findingReviewStatusBadge,
  findingSeverityBadge,
} from '@/components/admin/questionnaires/evaluation-status-badge';
import { FieldLabel, LabelledField } from '@/components/admin/questionnaires/evaluation-field';

/**
 * Kinds whose `label` is real content — a question's prompt, a section's title — and so earn their
 * own named block in the header band.
 *
 * `goal` / `audience` / `unknown` are deliberately absent: their label ("Questionnaire goal") only
 * restates the kind, which the badge row's context chip already carries. Giving them a block would
 * print the same word twice under an eyebrow saying it a third time.
 */
const NAMED_TARGET_KINDS = new Set<FindingTargetKind>(['question', 'section']);

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
  /**
   * Which fact the card leads with — the one its surrounding heading does *not* already supply.
   * Under a judge heading (`'target'`, the default) that's which question is meant; under a
   * question heading (`'dimension'`) the question is already named, so the missing fact is which
   * judge said this.
   */
  lead?: 'target' | 'dimension';
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

/**
 * Where the finding's subject sits, as a short chip ("Question 3 · Background", "Section",
 * "Goal"). Falls back to "Question" when the target couldn't be resolved server-side — the raw
 * key chip beside it still identifies it.
 */
function targetContext(finding: EvaluationFindingView): string {
  const target = finding.target;
  if (!target) return 'Target';
  switch (target.kind) {
    case 'question':
      return [
        target.position === null ? 'Question' : `Question ${target.position}`,
        target.sectionTitle,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'section':
      return 'Section';
    case 'goal':
      return 'Goal';
    case 'audience':
      return 'Audience';
    case 'unknown':
      return 'Target';
  }
}

/** Fold away the differences that don't change what a reader takes from a line of text. */
function normalizeQuote(text: string): string {
  return text
    .replace(/[“”„‟"'‘’]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.?!,;:\s]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Whether a finding's `sourceQuote` merely repeats the question it is about.
 *
 * Judges routinely quote the prompt verbatim as their evidence, which is useful in a raw payload
 * and pure noise on screen: both this card's target line and the by-question card's heading already
 * show that prompt, so the quote renders the same sentence a second time, indented, as if it were a
 * further detail. Containment (either direction) counts as a restatement — a quote that is a slice
 * of the prompt adds nothing the prompt didn't. A quote that reaches outside the prompt — guidelines,
 * a neighbouring question, an answer option — survives, because that is evidence the reader can't
 * see anywhere else on the card.
 */
function quoteRestatesTarget(quote: string, target: EvaluationFindingView['target']): boolean {
  if (!target) return false;
  const q = normalizeQuote(quote);
  const label = normalizeQuote(target.label);
  if (!q || !label) return false;
  return q === label || q.includes(label) || label.includes(q);
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
  lead = 'target',
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
  // The target earns its own named block in the header only when its label is real content and the
  // surrounding heading doesn't already carry it. Non-null here also means the badge row drops its
  // context chip, since this block's eyebrow carries the same context.
  const namedTarget =
    lead === 'target' && finding.target && NAMED_TARGET_KINDS.has(finding.target.kind)
      ? finding.target
      : null;
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
      className={`overflow-hidden rounded-md border ${isTerminal ? 'opacity-60' : ''} ${finding.stale ? 'border-amber-400' : ''}`}
    >
      {/* Header band — what this finding is *about*: the badges and, under a judge heading, the
          question itself. Tinted and ruled off so the questionnaire's own words are visibly not
          the AI's; below the rule, everything is the judge talking. */}
      <div className="bg-muted/40 border-b px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={sev.variant} className="text-xs">
            {sev.label}
          </Badge>
          {/* The context chip is the *fallback* namer. When a named target block renders below, it
              carries this same context as its eyebrow, so showing both prints "Section" twice. */}
          {lead === 'dimension' ? (
            <span className="text-muted-foreground text-xs">
              {EVALUATION_DIMENSION_SPECS[finding.dimension].label}
            </span>
          ) : (
            !namedTarget && (
              <span className="text-muted-foreground text-xs">{targetContext(finding)}</span>
            )
          )}
          <code className="bg-background rounded px-1.5 py-0.5 text-xs">{finding.targetKey}</code>
          <Badge variant={statusBadge.variant} className="text-xs">
            {statusBadge.label}
          </Badge>
          {finding.stale && !isTerminal && (
            <Badge variant="outline" className="border-amber-500 text-xs text-amber-700">
              Stale — re-run
            </Badge>
          )}
        </div>

        {/* Without this the card names only the slot key, and the reviewer has to open the
            structure editor to know which question is meant. Omitted under a question heading
            (`lead === 'dimension'`), which already carries the prompt. */}
        {namedTarget && (
          <div className="mt-2">
            {/* The full context, not just the kind — "Question 4 · Business Execution" — because
                this eyebrow replaces the badge-row chip rather than sitting alongside it. */}
            <FieldLabel>{targetContext(finding)}</FieldLabel>
            <p className="mt-0.5 text-sm font-semibold">
              {namedTarget.kind === 'question' ? `“${namedTarget.label}”` : namedTarget.label}
              {namedTarget.questionType && (
                <span className="text-muted-foreground font-normal">
                  {' '}
                  · {questionTypeLabel(namedTarget.questionType)}
                </span>
              )}
              {namedTarget.removed && (
                <span className="text-muted-foreground font-normal"> · removed since this run</span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* Body — the judge's advice, every block named so no sentence has to be decoded. */}
      <div className="space-y-2.5 p-3">
        <LabelledField label="Suggestion">
          <p className="text-sm font-medium">{finding.proposedChange}</p>
        </LabelledField>

        <LabelledField label="Rationale">
          <p className="text-muted-foreground text-sm">{finding.rationale}</p>
        </LabelledField>

        {finding.sourceQuote && !quoteRestatesTarget(finding.sourceQuote, finding.target) && (
          <LabelledField label="Evidence">
            <blockquote className="text-muted-foreground border-l-2 pl-3 text-xs italic">
              {finding.sourceQuote}
            </blockquote>
          </LabelledField>
        )}

        {op && (
          <LabelledField label="Edit">
            <p className="text-xs">
              <span className="font-medium">{describeOp(op)}</span>
              {finding.editedOverride && <span className="text-muted-foreground"> · edited</span>}
            </p>
          </LabelledField>
        )}

        {/* For a suggested new question, preview the drafted prompt + guidelines so the admin can
            decide to add it in one click — or open the editor to refine it first. The label is
            load-bearing: the drafted prompt renders in the same weight as `proposedChange` above
            it, so unlabelled a question that does not exist yet reads as one that does. */}
        {addOp && (
          <div className="bg-background rounded-md border p-2.5">
            <FieldLabel>Suggested new question · {questionTypeLabel(addOp.type)}</FieldLabel>
            <p className="mt-0.5 text-sm font-medium">{addOp.prompt}</p>
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
                  {/* Names its subject explicitly: under a gap group the surrounding heading is about
                    the questionnaire's coverage, so a bare "add to a data slot" reads as if the
                    slot attaches to that heading rather than to the question being drafted. */}
                  Also add the new question to a data slot (create one if needed)
                </label>
              )}
              {/* Two groups, pushed apart: the quiet "record a decision" triage sits left, the
                questionnaire-changing work-actions sit far right. Separating them by position
                rather than a divider is what keeps "Apply" from reading as a peer of "Accept". */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                {/* Quiet secondary triage — these only record a decision, they never touch the
                  questionnaire. "Apply" and a bare "Accept" read as near-synonyms, so the group is
                  named for what it does — records a decision — which is the whole contrast with
                  Apply. (The verbs stay verbs rather than becoming "Accepted"/"Dismissed": those
                  are the status-badge strings, and the same word as both a button and a state
                  reads as ambiguous.) Accept is omitted for add_question, where the work-actions
                  ("Add to questionnaire" / "Open in editor") already imply acceptance. */}
                <div className="flex flex-wrap items-center gap-1">
                  <Tip label="These only record what you decided — neither one edits the questionnaire.">
                    <span className="text-muted-foreground mr-1 cursor-help text-xs font-normal">
                      Record a decision:
                    </span>
                  </Tip>
                  {!addOp && (
                    <Tip label="Records that you agree, without changing the questionnaire. Triage a whole run this way, then apply the ones you kept — every applied edit then lands in one draft.">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={busy !== null}
                        onClick={() => void decide('accept')}
                      >
                        {busy === 'accept' ? 'Accepting…' : 'Accept'}
                      </Button>
                    </Tip>
                  )}
                  <Tip label="Rejects this suggestion. Nothing in the questionnaire changes.">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      disabled={busy !== null}
                      onClick={() => void decide('decline')}
                    >
                      {busy === 'decline' ? 'Dismissing…' : 'Dismiss'}
                    </Button>
                  </Tip>
                </div>

                {/* Primary work-action, sized by the effective op. */}
                <div className="flex flex-wrap items-center gap-2">
                  {addOp ? (
                    <>
                      <Tip label="Adds this question to the questionnaire now, as drafted. A launched version is forked to a new draft first.">
                        <Button
                          size="sm"
                          disabled={busy !== null || finding.stale || !canApply}
                          title={applyDisabledTitle}
                          onClick={() => void apply()}
                        >
                          {busy === 'apply' ? 'Adding…' : 'Add to questionnaire'}
                        </Button>
                      </Tip>
                      <Tip label="Opens the structure editor with this question pre-filled, so you can reword it before saving.">
                        <Button asChild size="sm" variant="secondary">
                          <Link href={seedHref}>Open in editor</Link>
                        </Button>
                      </Tip>
                    </>
                  ) : finding.applicable === 'apply' && op ? (
                    <>
                      {isEditableOp(op) && (
                        <Tip label="Adjust the suggested change before applying it.">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => setEditing(true)}
                          >
                            Edit
                          </Button>
                        </Tip>
                      )}
                      <Tip
                        label={`Changes the questionnaire now — ${describeOp(op).toLowerCase()}. A launched version is forked to a new draft first.`}
                      >
                        <Button
                          size="sm"
                          disabled={busy !== null || finding.stale || !canApply}
                          title={applyDisabledTitle}
                          onClick={() => void apply()}
                        >
                          {busy === 'apply' ? 'Applying…' : 'Apply'}
                        </Button>
                      </Tip>
                    </>
                  ) : (
                    <Button asChild size="sm" variant="secondary">
                      <Link href={editorHref}>Open in editor →</Link>
                    </Button>
                  )}
                </div>
              </div>
            </>
          )
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
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
