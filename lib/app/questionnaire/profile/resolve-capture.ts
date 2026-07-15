/**
 * Respondent profile capture — runtime resolution (DB seam, F-capture).
 *
 * Resolves whether (and how) a session should collect the admin-authored `profileFields` from the
 * respondent, and whether that has already happened. This resolver — NOT the pre-session
 * `start-context.ts` — owns the identity-axis decision: capture keys off `anonymousMode`, so a
 * PUBLIC no-login link can still collect a name (when the admin wants one), while a truly anonymous
 * link (`anonymousMode = true`) stays PII-free and returns `null`.
 *
 * Server-only (reads Prisma). The `profile-values` / `validate-profile-fields` helpers are pure /
 * provider-only; this is the file that touches the database.
 */

import { prisma } from '@/lib/db/client';
import {
  CAPTURE_MODES,
  narrowToEnum,
  type CaptureMode,
  type ProfileFieldConfig,
} from '@/lib/app/questionnaire/types';
import { parseProfileFields } from '@/lib/app/questionnaire/profile/profile-values';

/** The resolved capture config a respondent surface needs to decide whether to gate. */
export interface ResolvedSessionCapture {
  /** How the fields are collected — `form` gates the carousel; `conversational` does not. */
  captureMode: CaptureMode;
  /** The admin-authored fields to collect, in order (each carries its `validation` mode). */
  fields: ProfileFieldConfig[];
  /**
   * Nothing left to collect: a snapshot already exists (resume), the mode is conversational, or
   * there are no fields. A form-mode surface skips the gate when this is true.
   */
  satisfied: boolean;
}

/**
 * Resolve the capture state for an existing session. Returns `null` when the session id doesn't
 * resolve OR the version is `anonymousMode` (the PII-free path — no gate, no snapshot, ever). A
 * non-null result always carries complete fields so callers can branch without a second query.
 */
export async function resolveSessionCapture(
  sessionId: string
): Promise<ResolvedSessionCapture | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      profileSnapshot: { select: { id: true } },
      version: {
        select: {
          config: {
            select: { anonymousMode: true, profileFields: true, captureMode: true },
          },
        },
      },
    },
  });
  if (!session) return null;

  const config = session.version.config;
  // Anonymous → never collect a profile (the PII-free invariant). Treat an absent config as anon-safe.
  if (!config || config.anonymousMode) return null;

  const fields = parseProfileFields(config.profileFields);
  const captureMode = narrowToEnum<CaptureMode>(config.captureMode ?? '', CAPTURE_MODES, 'form');
  const hasSnapshot = session.profileSnapshot !== null;

  return {
    captureMode,
    fields,
    satisfied: hasSnapshot || captureMode === 'conversational' || fields.length === 0,
  };
}
