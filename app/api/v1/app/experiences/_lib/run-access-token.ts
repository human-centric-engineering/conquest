/**
 * Run-scoped access credential for the no-login experience surface (P15.3).
 *
 * The sibling of `session-access-token.ts`, bound to a RUN rather than a session, and delivered as
 * an httpOnly cookie rather than a header. Both differences are deliberate.
 *
 * ## Why run-scoped
 *
 * The thing being authorised is a journey, not a session. A per-session credential has to be
 * re-minted at every hop, which is why the poll endpoint grew a minting side-effect: a respondent
 * holding leg A's token has no way to open leg B. A credential scoped to the run covers every leg
 * it will ever have, including ones that do not exist yet.
 *
 * ## Why a cookie, not a URL parameter or a header
 *
 * The alternative was `/q/s/<sessionId>?t=<token>`, which puts a live credential in the address
 * bar. That is the wrong trade here specifically because of what it guards. Experience transcripts
 * can contain raw safeguarding disclosures — F15.2 carries sensitivity state between legs as
 * summaries precisely BECAUSE the raw text stays in the source leg's transcript — and the stitched
 * transcript endpoint replays exactly those earlier legs. A URL-borne credential to that data
 * lands in browser history, in `Referer` headers, and in any accidental paste.
 *
 * `httpOnly` also puts it out of reach of injected script, which the header-plus-client-storage
 * approach cannot claim.
 *
 * ## What the publicRef is and is not
 *
 * `publicRef` addresses the run (`/x/<publicRef>`); it does NOT authorise it. It is short and
 * human-quotable by design — a support code, guessable in a way a credential must never be. The
 * cookie is the only thing that grants access, exactly as `AppQuestionnaireSession.publicRef` is
 * addressable while the session token is what authorises.
 *
 * Token format matches the session token: `<base64url-payload>.<base64url-signature>`, payload
 * `{ runId, expiresAt }`, signed with HMAC-SHA256 over `BETTER_AUTH_SECRET`. Purely cryptographic
 * — no DB storage, no migration.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { env } from '@/lib/env';

/**
 * Run credential lifetime. Matches {@link SESSION_TOKEN_EXPIRY_HOURS} — a run is a sitting, and a
 * credential that outlived the sessions it covers would be a loose end for no benefit.
 */
export const RUN_TOKEN_EXPIRY_HOURS = 24;

const payloadSchema = z.object({
  runId: z.string().min(1),
  expiresAt: z.string().min(1),
});
type RunTokenPayload = z.infer<typeof payloadSchema>;

/**
 * The signing key is namespaced away from the session token's.
 *
 * Both sign a JSON object over the same secret, and `{ sessionId, expiresAt }` and
 * `{ runId, expiresAt }` are structurally identical. Without a domain separator a token minted for
 * one purpose could be replayed against a verifier for the other if the field names ever
 * converged. Cheap now, impossible to retrofit once tokens are in the wild.
 */
const DOMAIN = 'conquest.experience-run.v1';

function sign(payloadJson: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update(DOMAIN, 'utf8')
    .update(payloadJson, 'utf8')
    .digest('base64url');
}

/** Mint a signed run credential. */
export function mintRunToken(
  runId: string,
  expiresInHours: number = RUN_TOKEN_EXPIRY_HOURS,
  now: Date = new Date()
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000);
  const payloadJson = JSON.stringify({ runId, expiresAt: expiresAt.toISOString() });
  const encoded = Buffer.from(payloadJson, 'utf8').toString('base64url');
  return { token: `${encoded}.${sign(payloadJson)}`, expiresAt };
}

export type RunTokenResult =
  { ok: true; runId: string } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a run credential: constant-time signature check, then expiry. Never throws — a
 * malformed, forged or expired token is a typed failure the caller maps to "no access".
 */
export function verifyRunToken(token: string, now: Date = new Date()): RunTokenResult {
  const dot = token.indexOf('.');
  if (dot === -1) return { ok: false, reason: 'malformed' };

  const encodedPayload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let payloadJson: string;
  try {
    payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expectedSig = sign(payloadJson);
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: RunTokenPayload;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(payloadJson));
    if (!parsed.success) return { ok: false, reason: 'malformed' };
    payload = parsed.data;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expiresAt = new Date(payload.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, runId: payload.runId };
}

/**
 * The cookie name for one run's credential.
 *
 * Namespaced per run rather than a single `cq_run` cookie, so a respondent who starts a second
 * journey does not silently lock themselves out of the first. `publicRef` is Crockford-alphabet
 * uppercase alphanumerics (`session-ref.ts`), so it needs no escaping to sit in a cookie name.
 */
export function runCookieName(publicRef: string): string {
  return `cq_run_${publicRef}`;
}

/**
 * The `Set-Cookie` header value carrying a run credential.
 *
 * Serialised by hand because `successResponse` returns a plain `Response`, not a `NextResponse`,
 * so there is no `.cookies` helper to reach for — the same reason `invitations/accept` appends its
 * header directly.
 *
 * `sameSite: Lax` rather than `Strict`: a respondent commonly arrives from an email or a chat app,
 * and `Strict` would withhold the cookie on that first cross-site navigation, presenting a
 * "journey not found" gate to someone following their own link. `Lax` still withholds it on
 * cross-site POSTs, which is the case that matters. `Secure` in production only, so local
 * development over plain HTTP still works.
 */
export function runCookieHeader(publicRef: string, token: string): string {
  const parts = [
    `${runCookieName(publicRef)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${RUN_TOKEN_EXPIRY_HOURS * 60 * 60}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}
