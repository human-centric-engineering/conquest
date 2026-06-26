/**
 * Diagnostics error capture (Diagnostics).
 *
 * The respondent surface is deliberately fail-soft: a turn that throws is logged and either
 * returns a 500 or continues, and a bookkeeping write that fails is swallowed. That keeps a
 * respondent moving, but it means a failure leaves no queryable trail — so "what went wrong for
 * this invitee?" was previously unanswerable. {@link recordQuestionnaireError} persists one
 * {@link AppQuestionnaireError} row per failure (or notable refusal) so the admin Diagnostics
 * surface can show it after the fact.
 *
 * Two hard rules:
 *  1. **Never throws.** It runs on already-failing paths; an error here must not make things
 *     worse. All work is wrapped — on any failure it logs and returns.
 *  2. **Low-PII by construction.** It stores the error `code`/`stage`/`message`/`stack` and a
 *     caller-supplied (redacted) `metadata` only. It MUST NOT be handed the raw respondent
 *     message; the deep-dive raw prompt/response is read from the turn's persisted
 *     `inspectorCalls`, never from here.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/** Where on the invitation → session → turn path the failure occurred. */
export const ERROR_SCOPES = [
  'turn', // a respondent turn failed (pipeline/persist/bookkeeping) — see `stage`
  'session_create', // creating/resuming a session from an invitation failed
  'invitation_send', // sending the invitation email failed
  'round_gate', // a round-scoped turn was refused (window closed / member removed)
  'cost_cap', // a turn was refused because the session's cost budget was exhausted
  'persist', // the turn's DB write failed (reply already streamed)
  'pipeline', // the deterministic turn orchestrator threw
  'unknown',
] as const;
export type ErrorScope = (typeof ERROR_SCOPES)[number];

/** `error` = a genuine failure; `warning` = a clean refusal that still ran correctly (e.g. a
 *  cost-cap stop); `info` = an expected boundary worth recording for the timeline. */
export type ErrorSeverity = 'error' | 'warning' | 'info';

export interface RecordQuestionnaireErrorInput {
  /** The version the failure belongs to. Resolved from `sessionId` when omitted. */
  versionId?: string;
  /** The session, when one exists (absent for pre-session failures like session creation). */
  sessionId?: string;
  /** The invitation, when known. Resolved from `sessionId` when omitted. */
  invitationId?: string;
  /** The 1-based turn index, for turn/persist/pipeline scopes. */
  turnOrdinal?: number;
  scope: ErrorScope;
  /** Finer locus within the scope: `extract` | `respond` | `persist` | `context_build` | `email`… */
  stage?: string;
  /** Defaults to `error`. */
  severity?: ErrorSeverity;
  /** An explicit code (e.g. an API error code). Falls back to the thrown error's name. */
  code?: string;
  /** The thrown value (Error or otherwise) — normalized into message + stack. */
  error: unknown;
  /** Redacted, JSON-serializable context. NEVER the raw respondent message. */
  metadata?: Record<string, unknown>;
}

/** Normalize an arbitrary thrown value into `{ code, message, stack }`. */
function normalizeError(error: unknown): { code?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      code: error.name && error.name !== 'Error' ? error.name : undefined,
      message: error.message || error.name || 'Unknown error',
      stack: error.stack,
    };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

/** Cap stored strings so a pathological stack/message can't bloat the row. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Persist one diagnostics error row. Best-effort: never throws, returns nothing. When only a
 * `sessionId` is known (e.g. a top-level catch), the session's `versionId`/`invitationId` are
 * resolved here so the row is attributable without the caller threading them through.
 */
export async function recordQuestionnaireError(
  input: RecordQuestionnaireErrorInput
): Promise<void> {
  try {
    let versionId = input.versionId;
    let invitationId = input.invitationId;

    // Backfill version/invitation from the session when the caller only had the session id.
    if ((!versionId || invitationId === undefined) && input.sessionId) {
      const session = await prisma.appQuestionnaireSession.findUnique({
        where: { id: input.sessionId },
        select: { versionId: true, invitationId: true },
      });
      if (session) {
        versionId = versionId ?? session.versionId;
        invitationId = invitationId ?? session.invitationId ?? undefined;
      }
    }

    // The version FK is required (it's how the Diagnostics surface scopes its query). If we still
    // can't resolve it, we can't attribute the row — log and drop rather than throw.
    if (!versionId) {
      logger.warn('Diagnostics: dropping error with no resolvable versionId', {
        scope: input.scope,
        sessionId: input.sessionId,
      });
      return;
    }

    const normalized = normalizeError(input.error);

    // Cast the loose `Record<string, unknown>` to the create call's own JSON input type (avoids a
    // restricted `@prisma/client` import in `lib/app/**`). Only included when present (see below).
    const metadataValue = input.metadata as unknown as Parameters<
      typeof prisma.appQuestionnaireError.create
    >[0]['data']['metadata'];

    await prisma.appQuestionnaireError.create({
      data: {
        versionId,
        sessionId: input.sessionId ?? null,
        invitationId: invitationId ?? null,
        turnOrdinal: input.turnOrdinal ?? null,
        scope: input.scope,
        stage: input.stage ?? null,
        severity: input.severity ?? 'error',
        code: input.code ?? normalized.code ?? null,
        message: truncate(normalized.message, 4_000),
        stack: normalized.stack ? truncate(normalized.stack, 8_000) : null,
        // Omitted when absent — the column is nullable with no default, so the row stores SQL NULL.
        ...(input.metadata ? { metadata: metadataValue } : {}),
      },
    });
  } catch (err) {
    // The capture path itself failed — log and move on. The original failure has already been
    // handled by the caller; we must not surface a secondary error.
    logger.error('Diagnostics: failed to record questionnaire error', err, {
      scope: input.scope,
      sessionId: input.sessionId,
    });
  }
}
