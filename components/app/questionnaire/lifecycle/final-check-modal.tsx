'use client';

/**
 * FinalCheckModal — the submit-time contradiction "final check" for the early-finish path (F7.3).
 *
 * When a respondent clicks "Finish up & get my report" and the completion sweep finds a conflict, the
 * submit is HELD: the reconciliation probe is recorded as a chat turn AND this modal opens over the
 * exit action they just took (reopening the chat would fight their intent to leave). It states what
 * looks inconsistent and offers two ways forward:
 *
 *   - **Clarify in chat** — dismiss the modal; the probe is already the latest chat message, so they
 *     answer it in the conversation. Their reply reconciles the answer in the background, after which
 *     finishing again completes cleanly.
 *   - **Get my report anyway** — finish despite the conflict (`skipSweep`); the report is generated
 *     from the answers as they stand. The escape hatch, so they are never trapped.
 *
 * The normal (mid-conversation) submit does NOT use this modal — there the probe simply continues in
 * the chat. Presentational only; the workspace owns the actions.
 *
 * `// DEMO-ONLY (F7.3):` questionnaire-domain lifecycle surface.
 */

import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export interface FinalCheckModalProps {
  /** Whether the modal is shown (the held probe is present). */
  open: boolean;
  /** The reconciliation probe text (question + consequence) — the same text recorded as a chat turn. */
  probeText: string;
  /** Dismiss the modal to answer the probe in the chat. */
  onClarify: () => void;
  /** Finish anyway — generate the report despite the unreconciled conflict. */
  onFinishAnyway: () => void;
  /** A finish is in flight. */
  busy: boolean;
}

export function FinalCheckModal({
  open,
  probeText,
  onClarify,
  onFinishAnyway,
  busy,
}: FinalCheckModalProps) {
  return (
    // Closing the dialog (overlay click / Esc / ✕) is treated as "clarify in chat" — the least
    // destructive default: it never completes the session, just steps back into the conversation.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClarify();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles
              className="h-4 w-4 shrink-0"
              style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
              aria-hidden="true"
            />
            One quick thing before your report
          </DialogTitle>
          <DialogDescription className="text-left whitespace-pre-line">
            {probeText}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onFinishAnyway} disabled={busy}>
            {busy ? 'Finishing…' : 'Get my report anyway'}
          </Button>
          <Button
            type="button"
            onClick={onClarify}
            disabled={busy}
            className="text-white"
            style={{ backgroundColor: 'var(--app-cta-color, var(--color-primary))' }}
          >
            Clarify in chat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
