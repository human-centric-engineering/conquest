'use client';

/**
 * CorrectionStrip — the chat-side half of the inline correction gesture (Variant B).
 *
 * Rendered beneath the most-recent assistant turn once its reply has settled, it lists what that
 * turn just recorded ("<prompt> → <value>") with a quiet "Fix" affordance per item. Clicking Fix
 * expands the shared {@link InlineAnswerEditor} inline, so a respondent can correct a mis-captured
 * answer right where they said it — without sending a corrective chat turn (which would risk a false
 * same-slot contradiction warning). Renders nothing when there's nothing fixable.
 *
 * The targets are resolved upstream (in SessionWorkspace) from the panel view + the keys the latest
 * turn filled, so this component stays presentational.
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InlineAnswerEditor } from '@/components/app/questionnaire/panel/inline-answer-editor';
import type { CorrectionTarget } from '@/lib/app/questionnaire/panel/correction-targets';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

export interface CorrectionStripProps {
  /** The slots the most-recent turn captured, resolved to editable targets. */
  targets: CorrectionTarget[];
  sessionId: string;
  /** Anonymous/preview no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** Refetch the panel/lifecycle after a successful correction. */
  onCorrected: (view: AnswerPanelView) => void;
}

export function CorrectionStrip({
  targets,
  sessionId,
  accessToken,
  onCorrected,
}: CorrectionStripProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);

  if (targets.length === 0) return null;

  return (
    <div
      className="mt-2 rounded-lg border border-dashed px-3 py-2"
      style={{
        borderColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 35%, transparent)',
      }}
    >
      <p className="text-muted-foreground mb-1.5 text-xs">Not quite right? You can fix it here:</p>
      <ul className="flex flex-col gap-1.5">
        {targets.map((target) => {
          const editing = editingKey === target.key;
          return (
            <li key={target.key} className="text-sm">
              {editing ? (
                <div className="space-y-2">
                  <p className="text-foreground text-xs font-medium">{target.label}</p>
                  <InlineAnswerEditor
                    questions={target.questions}
                    sessionId={sessionId}
                    accessToken={accessToken}
                    onSaved={onCorrected}
                    onCancel={() => setEditingKey(null)}
                  />
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground">{target.label}</span>
                    {target.summary && (
                      <span className="text-muted-foreground"> → {target.summary}</span>
                    )}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => setEditingKey(target.key)}
                  >
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                    Fix
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
