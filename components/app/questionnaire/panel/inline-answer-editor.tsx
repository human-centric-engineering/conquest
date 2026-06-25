'use client';

/**
 * InlineAnswerEditor — the shared "fix this answer" editor for the inline correction gesture
 * (Variant B). Mounted both beneath the most-recent chat turn (via the CorrectionStrip) and on the
 * answer-panel rows, so a respondent can correct what was just captured without sending a fresh turn.
 *
 * It always edits QUESTION slots through `PUT …/answers` (reusing {@link QuestionField} for the
 * per-type control): a question-mode fix carries one question; a data-slot fix carries the slot's
 * mapped questions, and the endpoint's reconciliation then recomputes the slot's reading. Because the
 * write goes through the form-edit path, no contradiction re-check fires on a correction.
 *
 * Local draft values stay authoritative while editing; Save persists the batch and calls `onSaved`
 * (which refetches the panel), Cancel discards. Disabled while saving.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { QuestionField } from '@/components/app/questionnaire/form/question-field';
import { useInlineCorrection, type CorrectionEntry } from '@/lib/hooks/use-inline-correction';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';
import type { EditableQuestion } from '@/lib/app/questionnaire/panel/correction-targets';

export interface InlineAnswerEditorProps {
  /** The question(s) to edit — one in question mode, the data slot's mapped questions in data-slot mode. */
  questions: EditableQuestion[];
  sessionId: string;
  /** Anonymous/preview no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** Refetch the panel/lifecycle after a successful save. */
  onSaved: (view: AnswerPanelView) => void;
  /** Close the editor without saving. */
  onCancel: () => void;
}

export function InlineAnswerEditor({
  questions,
  sessionId,
  accessToken,
  onSaved,
  onCancel,
}: InlineAnswerEditorProps) {
  // Local draft, seeded from each question's current value. Authoritative while the editor is open.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const q of questions) seed[q.slot.slotKey] = q.initialValue;
    return seed;
  });

  const { saving, error, submit } = useInlineCorrection({
    sessionId,
    accessToken,
    onSaved: (view) => {
      onSaved(view);
      onCancel();
    },
  });

  const handleSave = () => {
    const entries: CorrectionEntry[] = questions.map((q) => ({
      questionKey: q.slot.slotKey,
      value: draft[q.slot.slotKey],
    }));
    void submit(entries);
  };

  const multiple = questions.length > 1;

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {questions.map((q) => (
          <div key={q.slot.slotKey} className="space-y-1.5">
            {/* When a data-slot fix spans several questions, label each so the respondent knows what
                they're correcting; a single question (question mode) needs no redundant label. */}
            {multiple && (
              <p className="text-muted-foreground text-xs font-medium">{q.slot.prompt}</p>
            )}
            <QuestionField
              slot={q.slot}
              value={draft[q.slot.slotKey]}
              onChange={(value) => setDraft((prev) => ({ ...prev, [q.slot.slotKey]: value }))}
              disabled={saving}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        {error && (
          <span className="text-destructive text-xs" role="alert">
            Could not save — try again.
          </span>
        )}
      </div>
    </div>
  );
}
