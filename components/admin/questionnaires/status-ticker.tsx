'use client';

/**
 * StatusTicker — theatrical progress messages for any long agent wait.
 *
 * Several admin actions fire a single long-running request with no real
 * progress signal — extracting an uploaded document, generating data slots,
 * running a design evaluation, re-ingesting. While one is in flight, this
 * cycles through reassuring status messages — "Reading…", "Thinking…", … —
 * purely to show that something is happening. Each message types out character
 * by character, holds for a random 3–10 seconds, then yields to the next; the
 * final message holds until unmount. The messages are scripted, not wired to
 * actual progress — pass a `messages` set that fits the action (the exported
 * constants below cover the current callers).
 *
 * Screen readers get each full message once via the sr-only span; the
 * per-character animation is aria-hidden so it doesn't spam announcements.
 *
 * @see components/admin/questionnaires/upload-questionnaire-dialog.tsx
 */

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/** Document upload / extraction wait (the default). */
export const EXTRACTION_MESSAGES: readonly string[] = [
  'Reading…',
  'Thinking…',
  'Extracting sections…',
  'Identifying questions…',
  'Processing…',
  'Finishing up…',
];

/** Re-ingesting a replacement document onto an existing draft. */
export const REINGEST_MESSAGES: readonly string[] = [
  'Reading the new document…',
  'Re-extracting sections…',
  'Identifying questions…',
  'Reconciling changes…',
  'Finishing up…',
];

/** Generating proposed data slots from the version's questions. */
export const DATA_SLOT_MESSAGES: readonly string[] = [
  'Reading your questions…',
  'Thinking…',
  'Grouping related questions…',
  'Drafting data slots…',
  'Naming each slot…',
  'Finishing up…',
];

/** Running the multi-judge design evaluation panel. */
export const EVALUATION_MESSAGES: readonly string[] = [
  'Assembling the panel…',
  'Reading the questionnaire…',
  'Consulting each judge…',
  'Scoring dimensions…',
  'Collecting findings…',
  'Finishing up…',
];

/** Per-character typing cadence. */
const TYPE_INTERVAL_MS = 40;
/** Each fully typed message holds for a random duration in this range. */
const HOLD_MIN_MS = 3_000;
const HOLD_MAX_MS = 10_000;

export interface StatusTickerProps {
  /** Override the scripted message sequence. The last entry holds indefinitely. */
  messages?: readonly string[];
  className?: string;
}

export function StatusTicker({ messages = EXTRACTION_MESSAGES, className }: StatusTickerProps) {
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
