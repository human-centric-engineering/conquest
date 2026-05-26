'use client';

/**
 * CaseReviewStep — shared "review proposals" pane used by both
 * synthesis flows:
 *
 *   - GenerateCasesButton (per-dataset, KB / failure-mining modes)
 *   - GenerateFromDescriptionForm (cold-start, description mode)
 *
 * Renders a list of proposed cases with per-row checkboxes, plus a
 * compact stats strip (count, cost, tokens). The parent owns the
 * `selectedIndices` set so submit-time filtering stays simple.
 */

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

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
}

export function CaseReviewStep({
  preview,
  selectedIndices,
  toggleSelected,
}: CaseReviewStepProps): React.ReactElement {
  if (!preview) return <p className="text-muted-foreground text-sm">No proposals.</p>;
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
      </div>
      <div className="max-h-[400px] space-y-2 overflow-y-auto pr-2">
        {preview.cases.map((c, i) => (
          <div key={i} className="rounded-md border p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id={`proposal-${i}`}
                checked={selectedIndices.has(i)}
                onCheckedChange={() => toggleSelected(i)}
                className="mt-1"
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor={`proposal-${i}`} className="text-xs font-medium uppercase">
                  Input
                </Label>
                <p className="text-sm whitespace-pre-wrap">
                  {typeof c.input === 'string' ? c.input : JSON.stringify(c.input)}
                </p>
                {c.expectedOutput ? (
                  <>
                    <Label className="text-xs font-medium uppercase">Expected output</Label>
                    <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                      {c.expectedOutput}
                    </p>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
