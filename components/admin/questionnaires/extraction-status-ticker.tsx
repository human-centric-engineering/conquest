'use client';

/**
 * ExtractionStatusTicker — theatrical progress messages for the upload wait.
 *
 * While a questionnaire document is being extracted (a single long-running
 * request with no real progress signal), this cycles through reassuring status
 * messages — "Reading…", "Thinking…", … — purely to show that something is
 * happening. Each message types out character by character, holds for a random
 * 3–10 seconds, then yields to the next; the final message holds until unmount.
 * The messages are scripted, not wired to actual extraction progress.
 *
 * Screen readers get each full message once via the sr-only span; the
 * per-character animation is aria-hidden so it doesn't spam announcements.
 *
 * @see components/admin/questionnaires/upload-questionnaire-dialog.tsx
 */

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const DEFAULT_MESSAGES: readonly string[] = [
  'Reading…',
  'Thinking…',
  'Extracting sections…',
  'Identifying questions…',
  'Processing…',
  'Finishing up…',
];

/** Per-character typing cadence. */
const TYPE_INTERVAL_MS = 40;
/** Each fully typed message holds for a random duration in this range. */
const HOLD_MIN_MS = 3_000;
const HOLD_MAX_MS = 10_000;

export interface ExtractionStatusTickerProps {
  /** Override the scripted message sequence. The last entry holds indefinitely. */
  messages?: readonly string[];
  className?: string;
}

export function ExtractionStatusTicker({
  messages = DEFAULT_MESSAGES,
  className,
}: ExtractionStatusTickerProps) {
  const [messageIndex, setMessageIndex] = useState(0);
  const [typedLength, setTypedLength] = useState(0);

  const message = messages[Math.min(messageIndex, messages.length - 1)] ?? '';

  useEffect(() => {
    if (typedLength < message.length) {
      const timer = setTimeout(() => setTypedLength((n) => n + 1), TYPE_INTERVAL_MS);
      return () => clearTimeout(timer);
    }
    if (messageIndex >= messages.length - 1) return;
    const holdMs = HOLD_MIN_MS + Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS);
    const timer = setTimeout(() => {
      setMessageIndex((i) => i + 1);
      setTypedLength(0);
    }, holdMs);
    return () => clearTimeout(timer);
  }, [typedLength, messageIndex, message, messages.length]);

  return (
    <p role="status" className={cn('text-muted-foreground text-sm italic', className)}>
      <span className="sr-only">{message}</span>
      <span aria-hidden="true" data-testid="typed-text">
        {message.slice(0, typedLength)}
        <span className="animate-pulse">▍</span>
      </span>
    </p>
  );
}
