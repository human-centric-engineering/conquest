'use client';

/**
 * StatusTicker — theatrical progress messages for any long agent wait.
 *
 * Several admin actions fire a single long-running request with no real
 * progress signal — extracting an uploaded document, generating data slots,
 * running a design evaluation, re-ingesting. While one is in flight, this
 * cycles through reassuring status messages — "Reading…", "Thinking…", … —
 * purely to show that something is happening. Each message types out character
 * by character, holds for a while, then yields to the next; the final message
 * holds until unmount. The messages are scripted, not wired to actual progress
 * — pass a `messages` set that fits the action (the exported constants below
 * cover the current callers).
 *
 * Two reassurance refinements on top of the scripted text:
 *
 *   - **Elapsed mm:ss counter** — always shown. It makes no claim about
 *     progress; it just proves the request is still alive, which is the most
 *     honest reassurance during a multi-minute wait.
 *   - **Adaptive pacing** — when the caller knows roughly how long the work
 *     will take (e.g. from the uploaded file's size/format), pass `estimatedMs`
 *     and the hold times are distributed across that estimate with a triangular
 *     weight so the middle "real work" messages dwell longest, instead of the
 *     script racing to the final message in ~40s and then sitting there for the
 *     rest of a two-minute extraction. Without `estimatedMs` the holds fall back
 *     to a random 3–10s per message.
 *
 * Screen readers get each full message once via the sr-only span; the
 * per-character animation and the counter are aria-hidden so they don't spam
 * announcements.
 *
 * @see components/admin/questionnaires/upload-questionnaire-dialog.tsx
 */

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/** Document upload / extraction wait (the default). */
export const EXTRACTION_MESSAGES: readonly string[] = [
  'Reading the document…',
  'Thinking…',
  'Extracting sections…',
  'Identifying questions…',
  'Validating structure…',
  'Saving your draft…',
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
/** Each fully typed message holds for a random duration in this range (no estimate). */
const HOLD_MIN_MS = 3_000;
const HOLD_MAX_MS = 10_000;
/** Floor for an adaptive hold so no message flashes by faster than it can be read. */
const MIN_ADAPTIVE_HOLD_MS = 1_500;

// --- Adaptive duration estimate (file size / format heuristic) -------------
//
// These are deliberately rough — the dominant cost is one opaque LLM extraction
// call whose wall-clock loosely tracks document length, which loosely tracks
// byte size. The estimate only paces the script; if it is wrong the final
// message still holds indefinitely until the real response lands, so an
// under-estimate degrades gracefully to "sit on the last message".
const ESTIMATE_BASE_MS = 15_000;
const ESTIMATE_PER_MB_MS = 9_000;
const ESTIMATE_MIN_MS = 15_000;
const ESTIMATE_MAX_MS = 180_000;

/** Per-format slowness multipliers — heavier parsers / denser documents wait longer. */
const FORMAT_FACTORS: Record<string, number> = {
  '.pdf': 1.4,
  '.xlsx': 1.5,
  '.docx': 1.2,
};

/**
 * Rough wall-clock estimate (ms) for extracting an uploaded document, from its
 * byte size and file extension. Heuristic only — see the constants above.
 */
export function estimateExtractionMs(sizeBytes: number, fileName: string): number {
  const sizeMb = Math.max(0, sizeBytes) / (1024 * 1024);
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  const formatFactor = FORMAT_FACTORS[ext] ?? 1;
  const raw = (ESTIMATE_BASE_MS + sizeMb * ESTIMATE_PER_MB_MS) * formatFactor;
  return Math.min(ESTIMATE_MAX_MS, Math.max(ESTIMATE_MIN_MS, Math.round(raw)));
}

/** Triangular weight peaking in the middle of the sequence (0-based index). */
function triangleWeight(index: number, count: number): number {
  return Math.min(index + 1, count - 1 - index);
}

/**
 * Hold (ms) for message `index` so the non-final messages span `estimatedMs`,
 * weighted toward the middle. The final message is excluded — it holds
 * indefinitely until the component unmounts.
 */
function adaptiveHold(index: number, count: number, estimatedMs: number): number {
  const lastPaced = count - 2; // indices 0..lastPaced are paced; the final one is open-ended
  if (lastPaced < 0) return 0;
  let total = 0;
  for (let i = 0; i <= lastPaced; i++) total += triangleWeight(i, count);
  if (total <= 0) return MIN_ADAPTIVE_HOLD_MS;
  return Math.max(MIN_ADAPTIVE_HOLD_MS, (estimatedMs * triangleWeight(index, count)) / total);
}

/** Format whole seconds as mm:ss (zero-padded). */
function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface StatusTickerProps {
  /** Override the scripted message sequence. The last entry holds indefinitely. */
  messages?: readonly string[];
  /**
   * Rough total duration (ms) to pace the script across. When set, holds are
   * distributed deterministically (middle messages dwell longest) instead of
   * the default random 3–10s per message. See {@link estimateExtractionMs}.
   */
  estimatedMs?: number;
  className?: string;
}

export interface ExtractionProgressProps {
  /**
   * The latest REAL phase message from the ingest stream (`extracting` → `verifying` →
   * `repairing …` → `saving`). Falls back to a neutral opener before the first event lands.
   */
  message?: string;
  className?: string;
}

/**
 * ExtractionProgress — the honest counterpart to {@link StatusTicker} for the document-upload
 * flow, which streams REAL phase events. It renders the actual current phase message (not a
 * scripted script) plus the same live elapsed mm:ss counter. Use this wherever a genuine
 * progress signal exists; keep {@link StatusTicker} only for the long single-request waits that
 * have none (data slots, design evaluation, re-ingest).
 */
export function ExtractionProgress({ message, className }: ExtractionProgressProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const text = message && message.trim().length > 0 ? message : 'Reading the document…';

  return (
    <p role="status" className={cn('text-muted-foreground text-sm italic', className)}>
      <span>{text}</span>
      <span
        aria-hidden="true"
        data-testid="elapsed"
        className="ml-2 text-xs not-italic tabular-nums opacity-70"
      >
        {formatElapsed(elapsedSeconds)}
      </span>
    </p>
  );
}

export function StatusTicker({
  messages = EXTRACTION_MESSAGES,
  estimatedMs,
  className,
}: StatusTickerProps) {
  const [messageIndex, setMessageIndex] = useState(0);
  const [typedLength, setTypedLength] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const message = messages[Math.min(messageIndex, messages.length - 1)] ?? '';

  // Elapsed counter — independent of the typing/hold cadence; ticks once a
  // second for as long as the ticker is mounted (i.e. the request is in flight).
  useEffect(() => {
    const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typedLength < message.length) {
      const timer = setTimeout(() => setTypedLength((n) => n + 1), TYPE_INTERVAL_MS);
      return () => clearTimeout(timer);
    }
    if (messageIndex >= messages.length - 1) return;
    const holdMs =
      estimatedMs != null
        ? adaptiveHold(messageIndex, messages.length, estimatedMs)
        : HOLD_MIN_MS + Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS);
    const timer = setTimeout(() => {
      setMessageIndex((i) => i + 1);
      setTypedLength(0);
    }, holdMs);
    return () => clearTimeout(timer);
  }, [typedLength, messageIndex, message, messages.length, estimatedMs]);

  return (
    <p role="status" className={cn('text-muted-foreground text-sm italic', className)}>
      <span className="sr-only">{message}</span>
      <span aria-hidden="true" data-testid="typed-text">
        {message.slice(0, typedLength)}
        <span className="animate-pulse">▍</span>
      </span>
      <span
        aria-hidden="true"
        data-testid="elapsed"
        className="ml-2 text-xs not-italic tabular-nums opacity-70"
      >
        {formatElapsed(elapsedSeconds)}
      </span>
    </p>
  );
}
