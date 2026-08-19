'use client';

/**
 * ScopeFindingReviewCard (F17.21) — one Adaptive Scope evaluation finding in the review queue.
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
  SCOPE_EVALUATION_DIMENSION_SPECS,
  type ScopeProposedEdit,
} from '@/lib/app/questionnaire/scope-evaluation';
import type { ScopeEvaluationFindingView } from '@/lib/app/questionnaire/views';
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
  finding: ScopeEvaluationFindingView;
  questionnaireId: string;
  versionId: string;
  runId: string;
  canApply: boolean;
  onUpdate: (next: ScopeEvaluationFindingView, meta?: ApplyMeta) => void;
}

/** A one-line, human description of what a structured op will do when applied. */
function describeScopeOp(op: ScopeProposedEdit): string {
  switch (op.op) {
    case 'edit_topic_criteria':
      return 'Rewrite the topic’s criteria';
    case 'edit_topic_depth':
      return `Change depth → ${op.depth}`;
    case 'add_rule':
      return `Add a rule: ${op.action} “${op.topicKey}” when “${op.dataSlotKey}” ${op.operator}${op.value ? ` “${op.value}”` : ''}`;
    case 'edit_rule':
      return `Rewrite this rule: ${op.action} “${op.topicKey}” when “${op.dataSlotKey}” ${op.operator}${op.value ? ` “${op.value}”` : ''}`;
    case 'delete_rule':
      return 'Delete this rule';
    case 'adjust_budget': {
      const parts: string[] = [];
      if (op.sessionBudgetSeconds !== undefined) parts.push(`budget → ${op.sessionBudgetSeconds}s`);
      if (op.maxOpeningProbes !== undefined) parts.push(`opening probes → ${op.maxOpeningProbes}`);
      if (op.maxConditionalTopics !== undefined)
        parts.push(`topic cap → ${op.maxConditionalTopics}`);
      return parts.join(', ') || 'Adjust the budget';
    }
    case 'edit_planner_instructions':
      return 'Replace the planner instructions';
    case 'add_fallback_topic':
      return `Add “${op.topicKey}” to the fallback set`;
  }
}

/** Ops the inline form can edit — the two free-text fields. Others are apply-as-proposed. */
function isEditableOp(op: ScopeProposedEdit): boolean {
  return op.op === 'edit_topic_criteria' || op.op === 'edit_planner_instructions';
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

export function ScopeFindingReviewCard({
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
  const findingPath = API.APP.QUESTIONNAIRES.versionScopeEvaluationFinding(
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
    onUpdate(res.data as ScopeEvaluationFindingView);
  }

  async function apply() {
    setBusy('apply');
    setError(null);
    const res = await sendJson(
      API.APP.QUESTIONNAIRES.versionScopeEvaluationFindingApply(
        questionnaireId,
        versionId,
        runId,
        finding.id
      ),
      'POST'
    );
    setBusy(null);
    if (!res.ok) return setError(res.message);
    const data = res.data as { finding: ScopeEvaluationFindingView | null };
    if (data.finding) onUpdate(data.finding, res.meta as ApplyMeta | undefined);
  }

  function startEdit() {
    if (!op) return;
    setText(
      op.op === 'edit_topic_criteria'
        ? op.criteria
        : op.op === 'edit_planner_instructions'
          ? op.plannerInstructions
          : ''
    );
    setEditing(true);
  }

  async function saveEdit() {
    if (!op || !isEditableOp(op)) return;
    const nextOp: ScopeProposedEdit =
      op.op === 'edit_topic_criteria'
        ? { op: 'edit_topic_criteria', criteria: text.trim() }
        : { op: 'edit_planner_instructions', plannerInstructions: text.trim() };
    if (
      op.op === 'edit_topic_criteria' &&
      nextOp.op === 'edit_topic_criteria' &&
      !nextOp.criteria
    ) {
      return setError('Criteria cannot be empty');
    }
    setBusy('edit');
    setError(null);
    const res = await sendJson(findingPath, 'PATCH', { action: 'edit', editedOverride: nextOp });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    setEditing(false);
    onUpdate(res.data as ScopeEvaluationFindingView);
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
            {SCOPE_EVALUATION_DIMENSION_SPECS[finding.dimension].label.replace(/ Judge$/, '')}
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
              <span className="font-medium">{describeScopeOp(op)}</span>
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
              <Label className="text-xs">
                {op.op === 'edit_topic_criteria' ? 'New criteria' : 'New planner instructions'}
              </Label>
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
                      label={`Changes the config now — ${describeScopeOp(op).toLowerCase()}. A launched version is forked to a new draft first.`}
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
