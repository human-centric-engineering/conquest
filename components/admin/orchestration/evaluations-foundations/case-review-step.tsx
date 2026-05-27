'use client';

/**
 * CaseReviewStep — shared "review proposals" pane used by both
 * synthesis flows:
 *
 *   - GenerateCasesButton (per-dataset, KB / failure-mining modes)
 *   - GenerateFromDescriptionForm (cold-start, description mode)
 *
 * Renders proposed cases with per-row checkboxes, plus a compact stats
 * strip (count, cost, tokens). When `onEdit` is provided, the input
 * and expectedOutput fields are editable textareas; the parent owns
 * the edited cases array and re-renders. Object inputs (workflow
 * subjects) stay read-only — freeform JSON editing is fragile and the
 * generator only emits string inputs in current flows.
 */

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface ProposedCase {
  input: string | Record<string, unknown>;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
}

export interface PreviewResult {
  cases: ProposedCase[];
  costUsd: number;
  tokenUsage: { input: number; output: number };
}

interface CaseReviewStepProps {
  preview: PreviewResult | null;
  selectedIndices: Set<number>;
  toggleSelected: (i: number) => void;
  /** Patch a single case in the parent's state. Omit to render read-only. */
  onEdit?: (i: number, patch: Partial<Pick<ProposedCase, 'input' | 'expectedOutput'>>) => void;
}

export function CaseReviewStep({
  preview,
  selectedIndices,
  toggleSelected,
  onEdit,
}: CaseReviewStepProps): React.ReactElement {
  if (!preview) return <p className="text-muted-foreground text-sm">No proposals.</p>;
  const editable = Boolean(onEdit);
  return (
    <div className="space-y-3 py-2">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Badge variant="outline" className="text-[10px]">
          {preview.cases.length} proposals
        </Badge>
        <span>·</span>
        <span>${preview.costUsd.toFixed(4)} generator cost</span>
        <span>·</span>
        <span>
          {preview.tokenUsage.input} in / {preview.tokenUsage.output} out tokens
        </span>
        {editable ? (
          <>
            <span>·</span>
            <span>Edit the input or expected output before saving</span>
          </>
        ) : null}
      </div>
      <div className="max-h-[500px] space-y-2 overflow-y-auto pr-2">
        {preview.cases.map((c, i) => {
          const inputIsObject = typeof c.input !== 'string';
          return (
            <div key={i} className="rounded-md border p-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id={`proposal-${i}`}
                  checked={selectedIndices.has(i)}
                  onCheckedChange={() => toggleSelected(i)}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <Label htmlFor={`proposal-${i}-input`} className="text-xs font-medium uppercase">
                    Input
                  </Label>
                  {editable && !inputIsObject ? (
                    <Textarea
                      id={`proposal-${i}-input`}
                      rows={2}
                      value={c.input as string}
                      onChange={(e) => onEdit?.(i, { input: e.target.value })}
                      className="text-sm"
                    />
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">
                      {typeof c.input === 'string' ? c.input : JSON.stringify(c.input)}
                    </p>
                  )}
                  <Label
                    htmlFor={`proposal-${i}-expected`}
                    className="text-xs font-medium uppercase"
                  >
                    Expected output
                  </Label>
                  {editable ? (
                    <Textarea
                      id={`proposal-${i}-expected`}
                      rows={3}
                      value={c.expectedOutput ?? ''}
                      onChange={(e) =>
                        onEdit?.(i, {
                          expectedOutput: e.target.value.length > 0 ? e.target.value : undefined,
                        })
                      }
                      placeholder="What a competent agent should answer. Optional unless using a reference grader."
                      className="text-muted-foreground text-sm"
                    />
                  ) : c.expectedOutput ? (
                    <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                      {c.expectedOutput}
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-xs italic">No expected output.</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
