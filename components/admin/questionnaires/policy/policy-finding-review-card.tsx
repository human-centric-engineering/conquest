'use client';

/**
 * PolicyFindingReviewCard (F17.21) — one Conditional Topics evaluation finding in the review queue.
 *
 * Deliberately leaner than `FindingReviewCard` (F5.3): the scope panel has no `add_question`
 * analogue (no op drafts something that doesn't exist yet), so there is no "deep-link" case and
 * no pre-fill-the-editor path — every structured op is directly appliable or it is nothing.
 * Inline editing is offered only for the two free-text ops (`edit_topic_criteria`,
 * `edit_planner_instructions`); the others (a rule's fields, a budget number, a topic's depth)
 * are reviewed as proposed and either applied as-is or dismissed — tweaking them is what the
 * Topics tab itself is for.
 *
 * Dismiss/Edit hit the PATCH review route; Apply hits the apply route (which may fork the
 * version — the parent shows the fork banner from the returned meta).
 */

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import {
  POLICY_EVALUATION_DIMENSION_SPECS,
  describePolicyProposedEdit,
  type PolicyProposedEdit,
} from '@/lib/app/questionnaire/policy-evaluation';
import type { PolicyEvaluationFindingView } from '@/lib/app/questionnaire/views';
import {
  findingReviewStatusBadge,
  findingSeverityBadge,
} from '@/components/admin/questionnaires/evaluation-status-badge';
import {
  FieldLabel,
  LabelledField,
  MetaRow,
  PROSE_MEASURE,
  QuotedProse,
} from '@/components/admin/questionnaires/evaluation-field';

/** Turn an imperative op description into the middle of a sentence: "Applying will reword…". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

interface ApplyMeta {
  forked: boolean;
  versionId: string;
  versionNumber: number;
}

interface Props {
  finding: PolicyEvaluationFindingView;
  questionnaireId: string;
  versionId: string;
  runId: string;
  canApply: boolean;
  onUpdate: (next: PolicyEvaluationFindingView, meta?: ApplyMeta) => void;
}

/**
 * Ops the inline form can edit. Only the free-text one: a house rule's wording.
 *
 * Everything else this panel proposes is an enum or a number — an approach, a pace, a fidelity
 * stop, a tone dial — and those are chosen from the Settings tab's own controls, not retyped into a
 * textarea. Offering a free-text box for them would invite a value the schema then rejects.
 */
function isEditableOp(op: PolicyProposedEdit): boolean {
  return op.op === 'edit_house_rule';
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
    return { ok: false, message: 'Network error' };
  }
}

export function PolicyFindingReviewCard({
  finding,
  questionnaireId,
  versionId,
  runId,
  canApply,
  onUpdate,
}: Props) {
  const [busy, setBusy] = useState<null | 'decline' | 'edit' | 'apply'>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  const sev = findingSeverityBadge(finding.severity);
  const statusBadge = findingReviewStatusBadge(finding.status);
  const op = finding.editedOverride ?? finding.proposedEdit;
  const isTerminal = finding.status === 'applied' || finding.status === 'declined';
  const applyDisabledTitle = !canApply
    ? 'Scope evaluation is disabled'
    : finding.stale
      ? 'The config changed since this run — re-run the evaluation'
      : undefined;
  const findingPath = API.APP.QUESTIONNAIRES.versionPolicyEvaluationFinding(
    questionnaireId,
    versionId,
    runId,
    finding.id
  );

  /**
   * Reject the suggestion. Nothing in the questionnaire changes.
   *
   * The review route also accepts `action: 'accept'` and still does; it is simply no longer offered
   * here. Four verbs on one card (accept, dismiss, edit, apply) is three too many when two of them
   * are English near-synonyms that do opposite things, and "accept" was the one carrying no
   * consequence — applying already records agreement. Kept in step with the design-evaluation card.
   */
  async function dismiss() {
    setBusy('decline');
    setError(null);
    const res = await sendJson(findingPath, 'PATCH', { action: 'decline' });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    onUpdate(res.data as PolicyEvaluationFindingView);
  }

  async function apply() {
    setBusy('apply');
    setError(null);
    const res = await sendJson(
      API.APP.QUESTIONNAIRES.versionPolicyEvaluationFindingApply(
        questionnaireId,
        versionId,
        runId,
        finding.id
      ),
      'POST'
    );
    setBusy(null);
    if (!res.ok) return setError(res.message);
    const data = res.data as { finding: PolicyEvaluationFindingView | null };
    if (data.finding) onUpdate(data.finding, res.meta as ApplyMeta | undefined);
  }

  function startEdit() {
    if (!op) return;
    setText(op.op === 'edit_house_rule' ? op.text : '');
    setEditing(true);
  }

  async function saveEdit() {
    if (!op || op.op !== 'edit_house_rule') return;
    const trimmed = text.trim();
    if (!trimmed) return setError('The rule cannot be empty');
    // `kind` and `trigger` carry through from the judge's proposal — the admin is editing the
    // WORDING, not re-classifying the rule. Re-sending them keeps the payload valid against
    // `houseRuleBodySchema`, whose invariant is that `trigger` belongs to `if_asked` and nothing
    // else; dropping either here would fail that check on the way in.
    const nextOp: PolicyProposedEdit = {
      op: 'edit_house_rule',
      kind: op.kind,
      text: trimmed,
      ...(op.trigger ? { trigger: op.trigger } : {}),
    };
    setBusy('edit');
    setError(null);
    const res = await sendJson(findingPath, 'PATCH', { action: 'edit', editedOverride: nextOp });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    setEditing(false);
    onUpdate(res.data as PolicyEvaluationFindingView);
  }

  return (
    <li
      className={`overflow-hidden rounded-md border ${isTerminal ? 'opacity-60' : ''} ${finding.stale ? 'border-amber-400' : ''}`}
    >
      <div className="bg-muted/40 border-b px-3 py-2.5">
        {/* One badge, not three — severity is the only fact here a reviewer triages on, so it is
            the only one that gets colour. The judge, the rule key and the recorded decision are
            context, and context reads better as a sentence than as a row of competing pills.
            Kept in step with the design-evaluation card: these three surfaces are the same card
            wearing different data, and they only stay legible while they stay identical. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={sev.variant} className="text-xs">
            {sev.label}
          </Badge>
          <MetaRow>
            {POLICY_EVALUATION_DIMENSION_SPECS[finding.dimension].label.replace(/ Judge$/, '')}
            {finding.targetKey}
            {/* Pending is the default state of every card here; saying so on all of them says
                nothing. A decision actually recorded is worth a word. */}
            {finding.status === 'pending' ? null : statusBadge.label}
          </MetaRow>
          {finding.stale && !isTerminal && (
            <Badge variant="outline" className="border-amber-500 text-xs text-amber-700">
              Stale — re-run
            </Badge>
          )}
        </div>
      </div>

      {/* Two paragraphs, unlabelled: the first says what to do, the muted one under it says why.
          Headline then deck — the oldest reading convention there is, and it needs no eyebrow.
          Three stacked eyebrows only taught the eye to skip all of them; the one that survives
          names a block that genuinely could be misread as prose. */}
      <div className="space-y-3 p-3">
        <p className={`${PROSE_MEASURE} text-sm leading-relaxed`}>
          <QuotedProse text={finding.proposedChange} />
        </p>

        <p className={`${PROSE_MEASURE} text-muted-foreground text-sm leading-relaxed`}>
          <QuotedProse text={finding.rationale} />
        </p>

        {finding.sourceQuote && (
          <LabelledField label="Evidence">
            <blockquote
              className={`${PROSE_MEASURE} text-muted-foreground border-l-2 pl-3 text-sm`}
            >
              {finding.sourceQuote}
            </blockquote>
          </LabelledField>
        )}

        {finding.appliedToVersionId && (
          <p className="text-muted-foreground mt-1 text-xs">
            Applied to a draft version — see the Topics tab on that version.
          </p>
        )}

        {editing && op ? (
          <div className="bg-muted/40 mt-3 space-y-2 rounded-md border p-3">
            <div className="space-y-1">
              <Label className="text-xs">New wording for this rule</Label>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === 'edit'} onClick={() => void saveEdit()}>
                {busy === 'edit' ? 'Saving…' : 'Save edit'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === 'edit'}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          !isTerminal && (
            /* What the buttons DO, said in words above them. Four verbs — accept, dismiss, edit,
               apply — that are near-synonyms in English and do very different things here, and a
               divider between them was carrying the whole distinction. Tooltips did not help: a
               reviewer deciding whether to click is not going to hover four buttons to find out
               which one writes to the questionnaire. Kept in step with the design-evaluation card,
               which is the same card wearing different data. */
            <div className="mt-4 rounded-md border">
              <div className="p-3">
                {op && finding.applicable === 'apply' ? (
                  <>
                    <FieldLabel>Change the interviewer’s house rules now</FieldLabel>
                    <p className={`${PROSE_MEASURE} text-muted-foreground mt-1 text-sm`}>
                      Applying will {lowerFirst(describePolicyProposedEdit(op))}
                      {finding.editedOverride ? ' (your edited version)' : ''}. A launched version
                      is forked to a new draft first.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={busy !== null || finding.stale || !canApply}
                        title={applyDisabledTitle}
                        onClick={() => void apply()}
                      >
                        {busy === 'apply' ? 'Applying…' : 'Apply this change'}
                      </Button>
                      {isEditableOp(op) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy !== null}
                          onClick={startEdit}
                        >
                          Edit first
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <FieldLabel>Make this change by hand</FieldLabel>
                    {/* Not "record your decision below": Accept left this card when the two verbs
                        were cut to one, and for a finding with no one-click edit that leaves
                        Dismiss as the only verb there is. Promising a decision the card cannot
                        record sends the reviewer looking for a button that is not on screen. */}
                    <p className={`${PROSE_MEASURE} text-muted-foreground mt-1 text-sm`}>
                      There is no one-click edit for this one — make the change on the Topics tab,
                      then dismiss this suggestion to clear it from the queue.
                    </p>
                  </>
                )}
              </div>

              {/* Ruled off, below, and quieter — the geometry says this is the lesser action
                  before a word is read. It is also the only other one: two verbs that are plainly
                  opposites, each under a heading saying which is which. */}
              <div className="bg-muted/40 border-t p-3">
                <FieldLabel>Or dismiss it</FieldLabel>
                <p className={`${PROSE_MEASURE} text-muted-foreground mt-1 text-sm`}>
                  Rejects this suggestion and marks it decided. Nothing in the questionnaire
                  changes.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void dismiss()}
                  >
                    {busy === 'decline' ? 'Dismissing…' : 'Dismiss'}
                  </Button>
                </div>
              </div>
            </div>
          )
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </li>
  );
}
