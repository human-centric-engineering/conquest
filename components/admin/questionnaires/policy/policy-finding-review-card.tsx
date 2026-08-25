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
 * Accept/Dismiss/Edit hit the PATCH review route; Apply hits the apply route (which may fork the
 * version — the parent shows the fork banner from the returned meta).
 */

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
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
  LabelledField,
  PROSE_MEASURE,
  QuotedProse,
} from '@/components/admin/questionnaires/evaluation-field';

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
  const [busy, setBusy] = useState<null | 'accept' | 'decline' | 'edit' | 'apply'>(null);
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

  async function decide(action: 'accept' | 'decline') {
    setBusy(action);
    setError(null);
    const res = await sendJson(findingPath, 'PATCH', { action });
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
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={sev.variant} className="text-xs">
            {sev.label}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {POLICY_EVALUATION_DIMENSION_SPECS[finding.dimension].label.replace(/ Judge$/, '')}
          </span>
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
      </div>

      <div className="space-y-2.5 p-3">
        <LabelledField label="Suggestion">
          <p className={`${PROSE_MEASURE} text-sm`}>
            <QuotedProse text={finding.proposedChange} />
          </p>
        </LabelledField>

        <LabelledField label="Rationale">
          <p className={`${PROSE_MEASURE} text-muted-foreground text-sm`}>
            <QuotedProse text={finding.rationale} />
          </p>
        </LabelledField>

        {finding.sourceQuote && (
          <LabelledField label="Evidence">
            <blockquote
              className={`${PROSE_MEASURE} text-muted-foreground border-l-2 pl-3 text-xs italic`}
            >
              {finding.sourceQuote}
            </blockquote>
          </LabelledField>
        )}

        {op && (
          <LabelledField label="Edit">
            <p className="text-xs">
              <span className="font-medium">{describePolicyProposedEdit(op)}</span>
              {finding.editedOverride && <span className="text-muted-foreground"> · edited</span>}
            </p>
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
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1">
                <Tip label="These only record what you decided — neither one edits the config.">
                  <span className="text-muted-foreground mr-1 cursor-help text-xs font-normal">
                    Record a decision:
                  </span>
                </Tip>
                <Tip label="Records that you agree, without changing the config. Triage the whole run, then apply the ones you kept.">
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
                <Tip label="Rejects this suggestion. Nothing in the config changes.">
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

              <div className="flex flex-wrap items-center gap-2">
                {op && finding.applicable === 'apply' ? (
                  <>
                    {isEditableOp(op) && (
                      <Tip label="Adjust the suggested text before applying it.">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={startEdit}
                        >
                          Edit
                        </Button>
                      </Tip>
                    )}
                    <Tip
                      label={`Changes the config now — ${describePolicyProposedEdit(op).toLowerCase()}. A launched version is forked to a new draft first.`}
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
                  <span className="text-muted-foreground text-xs">
                    No structured edit — make this change on the Topics tab, then mark it decided
                    above.
                  </span>
                )}
              </div>
            </div>
          )
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </li>
  );
}
