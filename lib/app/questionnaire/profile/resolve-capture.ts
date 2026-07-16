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
import { splitFieldsByPlacement } from '@/lib/app/questionnaire/profile/capture-placement';

/**
 * The resolved capture config a respondent surface needs to decide whether to gate. This resolver owns
 * only the FORM-gate half of capture — the fields that ride the blocking carousel gate. The
 * conversational half is resolved independently by the interviewer turn loop (`messages/route.ts`), so
 * a hybrid version (some `form` fields, some `conversational`) is served by both without either seeing
 * the other's subset.
 */
export interface ResolvedSessionCapture {
  /** The version-wide DEFAULT placement (a label/back-compat hint; the gate keys off `formFields`). */
  captureMode: CaptureMode;
  /**
   * The subset of admin-authored fields whose effective placement is `form` (their own `captureVia`,
   * else the `captureMode` default), in authored order — exactly what the form gate renders and the
   * PUT re-validates. Empty when every field is collected conversationally (or there are no fields).
   */
  formFields: ProfileFieldConfig[];
  /**
   * The form gate has nothing to do: a snapshot already exists (resume, or the form pass ran), or the
   * `formFields` subset is empty. The form-mode surface skips the gate when this is true.
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

  const captureMode = narrowToEnum<CaptureMode>(config.captureMode ?? '', CAPTURE_MODES, 'form');
  const { formFields } = splitFieldsByPlacement(
    parseProfileFields(config.profileFields),
    captureMode
  );
  const hasSnapshot = session.profileSnapshot !== null;

  return {
    captureMode,
    formFields,
    // The form gate is done once a snapshot exists (its write is what creates one, and it always
    // precedes any conversational turn) or when there is no form subset to collect. A hybrid version's
    // conversational subset is NOT this resolver's concern, so it never keeps the gate open.
    satisfied: hasSnapshot || formFields.length === 0,
  };
}
