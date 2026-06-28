'use client';

/**
 * Structure Edit Agent panel (precise + rewrite) on the version Structure editor.
 *
 * Accepts a plain-English instruction for the WHOLE questionnaire, asks the server to PLAN the change
 * (no write), renders a preview, and APPLIES only on an explicit confirm — the preview→apply contract
 * the user asked for. Two modes: `precise` (deterministic edit-ops, shown as before→after rows) is the
 * default; `rewrite` (whole-doc LLM regenerate, shown as a new outline) is offered for broader edits.
 *
 * Hidden entirely unless the edit-agent flag is on (the parent gates on `editAgentEnabled`). Edits
 * require a draft with no respondent sessions; on a non-draft the panel shows a disabled hint and the
 * server is the final guard (409) either way. On apply success it calls `onApplied` so the parent can
 * refetch the SSR graph.
 */

import { useState } from 'react';
import { Sparkles, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';
import type { EditOp } from '@/lib/app/questionnaire/edit-agent/edit-ops';
import type { ResolvedChange } from '@/lib/app/questionnaire/edit-agent/types';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';

type EditMode = 'precise' | 'rewrite';

interface PrecisePlan {
  mode: 'precise';
  summary: string;
  operations: EditOp[];
  changes: ResolvedChange[];
}
interface RewritePlan {
  mode: 'rewrite';
  summary: string;
  structure: ExtractQuestionnaireStructureData;
  outline: { title: string; questionCount: number }[];
}
type PlanResponse = PrecisePlan | RewritePlan;

const MAX_INSTRUCTION = 1_000;

/** Friendly verb for the field a precise change touches. */
function changeVerb(field: ResolvedChange['field']): string {
  switch (field) {
    case 'section.title':
      return 'Rename section';
    case 'section.ordinal':
      return 'Reorder section';
    case 'question.prompt':
      return 'Reword prompt';
    case 'question.required':
      return 'Set required';
    case 'question.weight':
      return 'Set weight';
    case 'question.ordinal':
      return 'Reorder question';
    case 'question.section':
      return 'Move question';
  }
}

export function EditAgentPanel({
  questionnaireId,
  versionId,
  status,
  busy,
  onApplied,
}: {
  questionnaireId: string;
  versionId: string;
  status: AppQuestionnaireStatus;
  /** Parent's mutation lock — disables the panel while another edit is saving. */
  busy: boolean;
  /** Called after a successful apply so the parent can refetch the graph. */
  onApplied: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<EditMode>('precise');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [phase, setPhase] = useState<'idle' | 'planning' | 'applying'>('idle');
  const [error, setError] = useState<string | null>(null);

  const editable = status === 'draft';
  const working = phase !== 'idle' || busy;

  const preview = async () => {
    setError(null);
    setPhase('planning');
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.editAgentPlan(questionnaireId, versionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ instruction, mode }),
      });
      const parsed = await parseApiResponse<PlanResponse>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        setPhase('idle');
        return;
      }
      setPlan(parsed.data);
      setPhase('idle');
    } catch {
      setError('Could not reach the edit agent. Please try again.');
      setPhase('idle');
    }
  };

  const apply = async () => {
    if (!plan) return;
    setError(null);
    setPhase('applying');
    const body =
      plan.mode === 'precise'
        ? { mode: 'precise', operations: plan.operations }
        : { mode: 'rewrite', structure: plan.structure };
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.editAgentApply(questionnaireId, versionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const parsed = await parseApiResponse<{ changeCount: number }>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        setPhase('idle');
        return;
      }
      setPlan(null);
      setInstruction('');
      setPhase('idle');
      onApplied();
    } catch {
      setError('Could not apply the changes. Please try again.');
      setPhase('idle');
    }
  };

  const discard = () => {
    setPlan(null);
    setError(null);
  };

  return (
    <div className="bg-card/60 rounded-xl border border-[var(--cq-accent)]/40 p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]">
          <Wand2 className="h-4 w-4" />
        </span>
        <div>
          <p className="flex items-center gap-1 text-sm font-semibold tracking-tight">
            Edit with AI
            <FieldHelp title="Edit with AI">
              <p>
                Describe a change for the whole questionnaire — e.g. “renumber the sections”, “use
                CAPS for every section title”, or “remove required from all free-text questions”.
                You always see a preview of exactly what will change before anything is saved.
              </p>
              <p className="mt-2">
                <strong>Precise edits</strong> turns your instruction into surgical edits and leaves
                everything else untouched. <strong>Full rewrite</strong> lets the AI regenerate the
                whole structure for broader, more open-ended changes.
              </p>
            </FieldHelp>
          </p>
          <p className="text-muted-foreground text-xs">
            Instruction-driven changes across every section &amp; question — preview, then apply.
          </p>
        </div>
      </div>

      {!editable ? (
        <p className="text-muted-foreground mt-3 rounded-md border border-dashed p-3 text-xs italic">
          AI editing is available on draft versions only. Un-launch this version to edit it.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {/* Mode toggle */}
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-muted-foreground text-xs">Mode</Label>
            <div className="flex overflow-hidden rounded-md border">
              <Button
                type="button"
                variant={mode === 'precise' ? 'default' : 'ghost'}
                size="sm"
                className="rounded-none"
                disabled={working}
                onClick={() => setMode('precise')}
              >
                Precise edits
              </Button>
              <Button
                type="button"
                variant={mode === 'rewrite' ? 'default' : 'ghost'}
                size="sm"
                className="rounded-none"
                disabled={working}
                onClick={() => setMode('rewrite')}
              >
                Full rewrite
              </Button>
            </div>
          </div>

          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value.slice(0, MAX_INSTRUCTION))}
            placeholder="e.g. Remove required from all free-text questions and CAPS every section title"
            rows={2}
            disabled={working}
            aria-label="Edit instruction"
          />

          {error && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-xs">
              {error}
            </div>
          )}

          {/* Preview / apply controls */}
          {!plan ? (
            <Button
              type="button"
              size="sm"
              disabled={working || instruction.trim().length === 0}
              onClick={() => void preview()}
            >
              <Sparkles className="mr-1 h-4 w-4" />
              {phase === 'planning' ? 'Previewing…' : 'Preview changes'}
            </Button>
          ) : (
            <div className="bg-background/60 space-y-3 rounded-md border p-3">
              <p className="text-sm font-medium">{plan.summary}</p>

              {plan.mode === 'precise' ? (
                plan.changes.length === 0 ? (
                  <p className="text-muted-foreground text-xs italic">
                    No changes — the instruction didn’t match anything to edit.
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-xs">
                    {plan.changes.map((c, i) => (
                      <li key={`${c.entityId}-${c.field}-${i}`} className="flex flex-col">
                        <span className="text-muted-foreground">
                          {changeVerb(c.field)} · <span className="font-mono">{c.label}</span>
                        </span>
                        <span>
                          <span className="text-destructive/80 line-through">{c.before}</span>
                          {' → '}
                          <span className="text-foreground font-medium">{c.after}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <div className="text-xs">
                  <p className="text-muted-foreground mb-1">New structure:</p>
                  <ol className="list-decimal space-y-0.5 pl-5">
                    {plan.outline.map((s, i) => (
                      <li key={i}>
                        {s.title}{' '}
                        <span className="text-muted-foreground">
                          ({s.questionCount} question{s.questionCount === 1 ? '' : 's'})
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={working || (plan.mode === 'precise' && plan.changes.length === 0)}
                  onClick={() => void apply()}
                >
                  {phase === 'applying' ? 'Applying…' : 'Apply changes'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={working}
                  onClick={discard}
                >
                  Discard
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
