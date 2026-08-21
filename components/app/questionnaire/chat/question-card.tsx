'use client';

/**
 * QuestionCard — the question's REAL answer control, rendered inside a chat turn.
 *
 * Shown when the author marked a question `must_ask` (see `question-fidelity.md`), or as a last
 * resort when a re-ask still couldn't be mapped. For an instrument question — a validated scale, a
 * matrix, a fixed choice set — reading the options out in prose and inferring which one they meant
 * is precisely the behaviour fidelity exists to switch off. So the respondent answers it directly.
 *
 * Reuses {@link QuestionField} (the raw form's per-type dispatcher) and {@link useInlineCorrection}
 * (the `PUT …/answers` write path already used by the correction strip) — no new control and no new
 * endpoint. The write records provenance `direct`, confidence 1, and `respondentEdited`, which is
 * exactly right: the respondent picked this themselves, so no later chat turn may overwrite it.
 *
 * The prompt is rendered VERBATIM. That is the entire point; never summarise or reword it here.
 *
 * Escape hatch: "I'd rather answer in my own words" dismisses the control for this turn and hands
 * the respondent back to the composer. It does NOT mark the question answered — the interviewer will
 * come back to it — so it can't be used to dodge a required item, but it does stop the card feeling
 * like a wall. A non-required question additionally offers Skip once dismissed.
 */

import { useState } from 'react';
import { PencilLine } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { QuestionField } from '@/components/app/questionnaire/form/question-field';
import { useInlineCorrection } from '@/lib/hooks/use-inline-correction';
import type { QuestionCardPayload } from '@/lib/app/questionnaire/chat/question-card';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

export interface QuestionCardProps {
  card: QuestionCardPayload;
  sessionId: string;
  /** Anonymous/preview no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /**
   * The answer has been persisted. The chat re-runs a turn (with no user message) so the
   * interviewer acknowledges it and moves on, and refetches the answer panel.
   */
  onAnswered: (view: AnswerPanelView) => void;
  /** The respondent chose to answer in prose instead — hand them back to the composer. */
  onDismiss: () => void;
  /** Suppresses every control once the conversation has moved past this turn. */
  disabled?: boolean;
}

/** A value the respondent hasn't actually supplied yet — Submit stays disabled. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  // A matrix answer is a per-row record; an untouched grid is `{}`.
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

export function QuestionCard({
  card,
  sessionId,
  accessToken,
  onAnswered,
  onDismiss,
  disabled,
}: QuestionCardProps) {
  const [value, setValue] = useState<unknown>(undefined);

  const { saving, error, submit } = useInlineCorrection({
    sessionId,
    accessToken,
    onSaved: onAnswered,
  });

  const busy = saving || disabled === true;

  return (
    <div
      className="bg-card mt-3 rounded-xl border p-4 shadow-sm"
      style={{
        borderColor:
          'color-mix(in srgb, var(--app-cta-color, var(--color-primary)) 40%, transparent)',
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {card.reason === 'must_ask' ? 'Asked as written' : 'Answer directly'}
        </span>
        {card.required && (
          <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Required
          </span>
        )}
      </div>

      {/* Verbatim. This is the instrument. */}
      <p className="text-foreground mb-3 text-sm font-medium">{card.prompt}</p>

      <QuestionField
        slot={{
          slotKey: card.questionKey,
          prompt: card.prompt,
          type: card.type,
          typeConfig: card.typeConfig,
        }}
        value={value}
        onChange={setValue}
        disabled={busy}
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || isEmpty(value)}
          onClick={() => void submit([{ questionKey: card.questionKey, value }])}
        >
          {saving ? 'Saving…' : 'Submit'}
        </Button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-2 disabled:opacity-50"
          disabled={busy}
          onClick={onDismiss}
        >
          <PencilLine className="h-3 w-3" />
          I&apos;d rather answer in my own words
        </button>
        {error && (
          <span className="text-destructive text-xs" role="alert">
            Could not save — try again.
          </span>
        )}
      </div>
    </div>
  );
}
