'use client';

/**
 * FindingReviewCard (F5.3) — one judge's finding, with the actions a reviewer can take on it.
 *
 * **Two bands.** A tinted, ruled-off header carries what the finding is *about* — one line of
 * context and, under a judge heading, the question itself; everything below the rule is the judge
 * talking. That split is the card's main job: the questionnaire's own words and the AI's opinion of
 * them are otherwise three near-identical paragraphs, and a reader landing mid-card cannot tell
 * which is which. Within the body, the lead paragraph is the suggestion and the muted one under it
 * is the reasoning — headline then deck, no eyebrow needed. See `evaluation-field.tsx` for the type
 * scale all three evaluation surfaces share.
 *
 * ## The footer says what a click will do, in words
 *
 * Four verbs — accept, dismiss, edit, apply — that are near-synonyms in English and do very
 * different things here. They used to be split by *position* alone (decision-recording left,
 * questionnaire-changing right) with the detail in tooltips, and that failed for the obvious
 * reason: a reviewer deciding whether to click is not going to hover four buttons to find out which
 * one writes to the questionnaire. So the footer is two labelled sections, each stating its own
 * consequence before its buttons:
 *
 *  - **Change the questionnaire now** — names the actual edit via {@link effectOf} ("Replaces this
 *    question's wording with the suggested version"), plus the fork caveat. Holds Apply, and Edit
 *    first where the op is inline-editable.
 *  - **Or dismiss it** — ruled off below and quieter. Rejects the suggestion and marks it decided;
 *    nothing in the questionnaire changes.
 *
 * There are exactly two verbs, and they are opposites. There used to be four — accept, dismiss,
 * edit, apply — of which "accept" was the one with no consequence: applying already records
 * agreement, and the batch-agree-then-apply habit it existed to support is not needed, because the
 * fork-lineage rule is enforced server-side (`evaluation-apply.ts` converges repeated applies from
 * one run on a single draft) rather than by the admin sequencing their clicks. The review route
 * still accepts `action: 'accept'`; the capability is intact, it is just no longer a button.
 *
 * {@link effectOf} is declarative for the same reason. Its predecessor returned imperatives —
 * "Rewrite the question prompt" — which above two buttons reads as an instruction *to the reader*:
 * am I being told to go and rewrite something, or will a click do it?
 *
 * The work-actions are sized by the finding's effective op:
 *
 *  - `add_question` (deep-link) → "Add to questionnaire" (one-click apply, forks if launched) plus
 *    "Open in editor" (deep-links the editor with the draft pre-filled).
 *  - other structured op (apply) → "Apply this change", and "Edit first" to tweak the op.
 *  - prose-only (manual)        → "Open in editor" (nothing to pre-fill — author it by hand).
 *
 * Dismiss/Edit hit the PATCH review route; Apply / Add hit the apply route (which may fork
 * the version — the parent shows the fork banner from the returned meta). All mutations are
 * enforced server-side; this card only renders the affordances.
 */

import { useState } from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { QUESTION_TYPE_LABELS, questionTypeLabel } from '@/lib/app/questionnaire/types';
import {
  EVALUATION_DIMENSION_SPECS,
  MAX_APPLY_INSTRUCTION,
} from '@/lib/app/questionnaire/evaluation';
import type { ProposedEdit } from '@/lib/app/questionnaire/evaluation';
import type { EvaluationFindingView, FindingTargetKind } from '@/lib/app/questionnaire/views';
import {
  findingReviewStatusBadge,
  findingSeverityBadge,
} from '@/components/admin/questionnaires/evaluation-status-badge';
import {
  FieldLabel,
  LabelledField,
  MetaRow,
  normalizeQuote,
  PROSE_MEASURE,
  QUESTION_FACE,
  QUESTION_MEASURE,
  QuotedProse,
  stripRestatedQuotes,
} from '@/components/admin/questionnaires/evaluation-field';

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

/**
 * What applying this op will do to the questionnaire, as a sentence about the questionnaire.
 *
 * These used to be imperative fragments — "Rewrite the question prompt", "Delete this question" —
 * printed under an eyebrow reading "Edit". In that position an imperative reads as an instruction
 * *to the reader*: the admin sees "Rewrite the question prompt" above two buttons and reasonably
 * asks whether they are being told to go and rewrite something themselves, or whether a click will
 * do it. Every one is now declarative and names its subject, so it can only be read as a
 * description of the consequence: "Replaces this question's wording with the suggested version."
 */
function effectOf(op: ProposedEdit): string {
  switch (op.op) {
    case 'replace_prompt':
      return "Replaces this question's wording with the suggested version.";
    case 'split_question':
      return 'Replaces this question with the first prompt above, and adds the second one straight after it.';
    case 'edit_guidelines':
      return op.guidelines === null
        ? 'Clears the author guidelines on this question.'
        : 'Sets the author guidelines on this question.';
    case 'change_type':
      return `Changes the answer type to ${QUESTION_TYPE_LABELS[op.type]}, and resets that question's type-specific settings.`;
    case 'delete_question':
      return 'Removes this question from the questionnaire.';
    case 'reorder':
      return op.targetSectionKey
        ? `Moves this question into “${op.targetSectionKey}”, at position ${op.ordinal + 1}.`
        : `Moves this question to position ${op.ordinal + 1}.`;
    case 'edit_goal':
      return "Replaces the questionnaire's goal statement.";
    case 'edit_audience':
      return `Updates the audience description (${Object.keys(op.audience).join(', ')}).`;
    case 'add_question':
      return `Adds this as a new ${QUESTION_TYPE_LABELS[op.type]} question.`;
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
  lead = 'target',
  onUpdate,
}: Props) {
  const [busy, setBusy] = useState<null | 'accept' | 'decline'>(null);
  // Tracked apart from `busy` so it cannot disable the decision buttons. Clicking Accept blurs the
  // instruction box, which starts this save — and a `busy` that covered both would disable the
  // button in the instant between the blur and the click landing on it, silently swallowing the
  // click that caused the save in the first place.
  const [savingSteer, setSavingSteer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The steer, held locally so typing is not a round trip per keystroke. `finding.applyInstruction`
  // is the server's copy; this is the draft of it.
  const [instruction, setInstruction] = useState(finding.applyInstruction ?? '');
  const [showInstruction, setShowInstruction] = useState(Boolean(finding.applyInstruction));

  const sev = findingSeverityBadge(finding.severity);
  const statusBadge = findingReviewStatusBadge(finding.status);
  const op = finding.editedOverride ?? finding.proposedEdit;
  const addOp = op && op.op === 'add_question' ? op : null;
  const splitOp = op && op.op === 'split_question' ? op : null;
  // Wording this card already prints in full, in the questionnaire's own face, in its own block.
  const draftedPrompts = addOp
    ? [addOp.prompt]
    : splitOp
      ? [splitOp.prompt, splitOp.secondPrompt]
      : [];
  // A judge drafting a question writes the suggestion as "Add a question on X: “<the question>”",
  // and the block below then prints that same question again. Two faces, one sentence, twice —
  // and the reviewer has to compare them word by word to find out they are identical.
  const suggestion = stripRestatedQuotes(finding.proposedChange, draftedPrompts);
  const isTerminal = finding.status === 'applied' || finding.status === 'declined';
  // The target earns its own named block in the header only when its label is real content and the
  // surrounding heading doesn't already carry it. Non-null here also means the badge row drops its
  // context chip, since this block's eyebrow carries the same context.
  const namedTarget =
    lead === 'target' && finding.target && NAMED_TARGET_KINDS.has(finding.target.kind)
      ? finding.target
      : null;
  const editorHref = `/admin/questionnaires/${questionnaireId}/v/${versionId}/structure?edit=1`;
  const findingPath = API.APP.QUESTIONNAIRES.versionEvaluationFinding(
    questionnaireId,
    versionId,
    runId,
    finding.id
  );

  /**
   * What accepting this one would put in the batch — the sentence under the Accept button.
   *
   * Still declarative and still names the actual edit, for the reason `effectOf` exists: an
   * imperative above a button reads as an instruction to the reader. What changed is the tense.
   * Nothing happens on click any more, so promising that it does would be the same lie the old
   * per-finding Apply told, just earlier.
   */
  const effect = op ? (finding.applicable === 'apply' || addOp ? effectOf(op) : null) : null;

  const dirty = instruction.trim() !== (finding.applyInstruction ?? '');

  /** Persist the steer on its own, without touching the decision. */
  async function saveInstruction() {
    if (!dirty || savingSteer) return;
    setSavingSteer(true);
    setError(null);
    const res = await sendJson(findingPath, 'PATCH', {
      action: 'set_instruction',
      instruction,
    });
    setSavingSteer(false);
    if (!res.ok) return setError(res.message);
    onUpdate(res.data as EvaluationFindingView);
  }

  /**
   * Record a decision. Neither verb touches the questionnaire — that is the whole shape of the
   * flow now: triage the run, then execute the accepted set in one batch.
   *
   * Accept carries whatever is currently in the box, so a reviewer who types a steer and presses
   * Accept without leaving the field does not lose it to a blur that never happened.
   */
  async function decide(action: 'accept' | 'decline') {
    setBusy(action);
    setError(null);
    // `instruction` only rides along when there is something unsaved to send. Omitting the key
    // (rather than sending null) is what stops an accept from clearing a steer saved earlier.
    const body: { action: string; instruction?: string } =
      action === 'accept' && dirty ? { action, instruction } : { action };
    const res = await sendJson(findingPath, 'PATCH', body);
    setBusy(null);
    if (!res.ok) return setError(res.message);
    onUpdate(res.data as EvaluationFindingView);
  }

  return (
    <li
      className={`overflow-hidden rounded-md border ${isTerminal ? 'opacity-60' : ''} ${finding.stale ? 'border-amber-400' : ''}`}
    >
      {/* Header band — what this finding is *about*: one line of context and, under a judge
          heading, the question itself. Tinted and ruled off so the questionnaire's own words are
          visibly not the AI's; below the rule, everything is the judge talking.

          One badge, not four. Severity is the only fact here a reviewer triages on, so it is the
          only one that gets colour; the judge, the status and the raw key are context, and context
          reads better as a sentence than as a row of competing pills. `stale` keeps its badge
          because it is a warning about the whole card, not a description of it. */}
      <div className="bg-muted/40 border-b px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={sev.variant} className="text-xs">
            {sev.label}
          </Badge>
          <MetaRow>
            {/* The context is the *fallback* namer. When a named target block renders below, it
                carries this same context as its eyebrow, so showing both prints "Section" twice. */}
            {lead === 'dimension'
              ? EVALUATION_DIMENSION_SPECS[finding.dimension].label
              : !namedTarget
                ? targetContext(finding)
                : null}
            {/* The raw slot key, only when nothing else identifies the target. With a resolved
                target it is a duplicate of the line above it in a face this page otherwise
                doesn't use; with none, it is the only handle the reviewer has. */}
            {finding.target ? null : finding.targetKey}
            {/* Pending is the default state of every card on the page; saying so on all of them
                says nothing. A decision that has actually been recorded is worth a word. */}
            {finding.status === 'pending' ? null : statusBadge.label}
          </MetaRow>
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
            <p className={cn(QUESTION_FACE, QUESTION_MEASURE, 'mt-1 text-base leading-snug')}>
              {namedTarget.kind === 'question' ? `“${namedTarget.label}”` : namedTarget.label}
            </p>
            {/* Out of the prompt rather than trailing it. These are facts *about* the question —
                the system's voice — and inside the paragraph they were being set in the
                questionnaire's own serif, which is the one thing that face must never say. */}
            {(namedTarget.questionType || namedTarget.removed) && (
              <MetaRow className="mt-1">
                {namedTarget.questionType ? questionTypeLabel(namedTarget.questionType) : null}
                {namedTarget.removed ? 'removed since this run' : null}
              </MetaRow>
            )}
          </div>
        )}
      </div>

      {/* Body — the judge's advice. Two paragraphs, unlabelled: the first says what to do, the
          muted one under it says why. That is the oldest reading convention there is (headline,
          then deck), and it needs no eyebrow to be understood — where three stacked eyebrows only
          taught the eye to skip all of them. The eyebrows that survive on this card name blocks
          that genuinely could be mistaken for the prose around them: the drafted question, and a
          quote the judge is citing as evidence. */}
      <div className="space-y-3 p-3">
        {/* Not bold. The quoted wording inside it already changes face; bolding the sentence
            carrying it just makes a page of suggestions heavier to read. */}
        {suggestion && (
          <p className={cn(PROSE_MEASURE, 'text-sm leading-relaxed')}>
            <QuotedProse text={suggestion} />
          </p>
        )}

        <p className={cn(PROSE_MEASURE, 'text-muted-foreground text-sm leading-relaxed')}>
          <QuotedProse text={finding.rationale} />
        </p>

        {finding.sourceQuote && !quoteRestatesTarget(finding.sourceQuote, finding.target) && (
          <LabelledField label="Evidence">
            <blockquote
              className={cn(
                QUESTION_FACE,
                PROSE_MEASURE,
                'text-muted-foreground border-l-2 pl-3 text-sm'
              )}
            >
              {finding.sourceQuote}
            </blockquote>
          </LabelledField>
        )}

        {/* For a suggested new question, preview the drafted prompt + guidelines so the admin can
            decide to add it in one click — or open the editor to refine it first. The label is
            load-bearing: the drafted prompt renders in the same weight as `proposedChange` above
            it, so unlabelled a question that does not exist yet reads as one that does. */}
        {addOp && (
          // A rule, not a frame. This sits inside a card that already sits inside a group, and a
          // third border around it flattened the hierarchy it was meant to express — the eyebrow
          // and the change of face already say "this is the drafted question, not advice about it".
          <div className="border-l-2 pl-3">
            <FieldLabel>Suggested new question · {questionTypeLabel(addOp.type)}</FieldLabel>
            <p className={cn(QUESTION_FACE, QUESTION_MEASURE, 'mt-1 text-base leading-snug')}>
              {addOp.prompt}
            </p>
            {addOp.guidelines && (
              <p className={cn(PROSE_MEASURE, 'text-muted-foreground mt-1.5 text-sm')}>
                {addOp.guidelines}
              </p>
            )}
          </div>
        )}

        {/* A split rewrites the question AND creates a second one, so both halves must be visible
            before the admin applies it. Without this the one-click Apply writes two prompts and a
            new question key they have never seen — the same reason `add_question` previews its
            draft above. Numbered rather than bulleted because the order is real: the first half
            stays on the existing question (keeping its id, type and any answers already mapped to
            it) and the second becomes a new question directly after. */}
        {splitOp && (
          <div className="border-l-2 pl-3">
            <FieldLabel>Splits into two questions</FieldLabel>
            <ol className="mt-1 space-y-1.5">
              <li className={cn(QUESTION_FACE, QUESTION_MEASURE, 'text-base leading-snug')}>
                <span className="text-muted-foreground mr-1.5 text-xs">1.</span>
                {splitOp.prompt}
              </li>
              <li className={cn(QUESTION_FACE, QUESTION_MEASURE, 'text-base leading-snug')}>
                <span className="text-muted-foreground mr-1.5 text-xs">2.</span>
                {splitOp.secondPrompt}
              </li>
            </ol>
            <p className={cn(PROSE_MEASURE, 'text-muted-foreground mt-1.5 text-sm')}>
              The first keeps this question and its answer type; the second is added straight after
              it.
            </p>
          </div>
        )}

        {/* The reviewer's own steer, and the only new control on the card.
            It replaced a typed op form (pick an answer type, pick an ordinal) that asked the
            reviewer to express a preference as an exact edit. What they actually want to say is
            "keep it under 15 words" — so let them say that, and let the batch's AI leg reconcile
            it with the judge's suggestion. Collapsed behind a link until wanted: most findings are
            accepted as proposed, and a textarea on every card in a queue of forty is noise. */}
        {!isTerminal &&
          (showInstruction ? (
            <div className="space-y-1.5">
              <Label htmlFor={`steer-${finding.id}`} className="text-xs font-medium">
                Anything to add about how this change should be made?
              </Label>
              <Textarea
                id={`steer-${finding.id}`}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onBlur={() => void saveInstruction()}
                maxLength={MAX_APPLY_INSTRUCTION}
                rows={2}
                placeholder="e.g. keep it under 15 words, and don't mention tenure"
                className="text-sm"
              />
              <p className={cn(PROSE_MEASURE, 'text-muted-foreground text-xs')}>
                Optional. Written in your words and handed to the AI when this run&apos;s accepted
                changes are applied, alongside the suggestion above.
                {savingSteer && ' Saving…'}
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowInstruction(true)}
              className="text-muted-foreground hover:text-foreground cursor-pointer text-xs underline underline-offset-2"
            >
              Add an instruction for how to make this change
            </button>
          ))}

        {/* A steer written and then left on a decided card still has to be visible, or the
            reviewer cannot tell which of forty findings they said something about. */}
        {isTerminal && finding.applyInstruction && (
          <LabelledField label="Your instruction">
            <p className={cn(PROSE_MEASURE, 'text-muted-foreground text-sm')}>
              {finding.applyInstruction}
            </p>
          </LabelledField>
        )}

        {/* Two verbs, and neither one touches the questionnaire.
            That is the shape of the whole flow: triage the run, then execute the accepted set in
            one batch, rather than deciding the order of a dozen structural edits by the order you
            happened to click. So the sentence over the buttons is in the future tense — promising
            that a click changes something would be the same lie the old per-finding Apply told,
            moved earlier. */}
        {!isTerminal && (
          <div className="mt-4 rounded-md border p-3">
            <FieldLabel>Record a decision — nothing changes yet</FieldLabel>
            <p className={cn(PROSE_MEASURE, 'text-muted-foreground mt-1 text-sm')}>
              {effect
                ? `Accepting queues this change. Applying the run then ${effect.charAt(0).toLowerCase()}${effect.slice(1)}`
                : 'There is no automatic edit for this one — accepting records that you agree, and you make the change in the editor.'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy !== null} onClick={() => void decide('accept')}>
                {busy === 'accept' ? 'Accepting…' : 'Accept'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void decide('decline')}
              >
                {busy === 'decline' ? 'Dismissing…' : 'Dismiss'}
              </Button>
              {!effect && (
                <Button asChild size="sm" variant="ghost">
                  <Link href={editorHref}>Open in editor →</Link>
                </Button>
              )}
            </div>
          </div>
        )}

        {/* The warning, on the card that earned it. Someone who accepts twenty suggestions and
            walks away must not believe the questionnaire changed — the run-level bar says so in
            aggregate, and this says so on the thing they just clicked. */}
        {finding.status === 'accepted' && (
          <p className={cn(PROSE_MEASURE, 'text-muted-foreground mt-3 text-sm')}>
            Accepted — <strong className="text-foreground font-medium">not applied yet</strong>.
            Nothing changes in the questionnaire until you apply this run&apos;s accepted changes.
          </p>
        )}

        {finding.status === 'applied' && finding.appliedToVersionId && (
          <p className="text-muted-foreground mt-3 text-sm">
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

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </div>
    </li>
  );
}
