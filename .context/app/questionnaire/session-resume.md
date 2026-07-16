# Respondent session resume (F7.11)

> Let a respondent return to a session they already started instead of always starting over. Covers
> the no-login (anonymous), cross-device, and authenticated paths. Purely per-version config
> (`sessionResumeEnabled`, default **on**) — no platform flag.

## The gap it closes

A no-login respondent (`/q/[versionId]`) held their session credential only in **`sessionStorage`**,
which is per-tab and wiped on browser/tab close, and `createAnonymousSession` never resumes
server-side. So closing the browser and reopening the link **silently minted a fresh session** — the
respondent lost their progress with no signal. Authenticated respondents already resumed idempotently
via `/questionnaires/start`, but with **no option to start fresh**.

Every session already carries a human-friendly `publicRef` (`7F3K-9M2P`, `@unique`, `session-ref.ts`)
and the token-authed `GET …/status` route already returns `{ status, ref, completion.answeredCount }`
— all a "welcome back" screen needs.

## Config

`AppQuestionnaireConfig.sessionResumeEnabled` (`Boolean @default(true)`) governs the whole capability.
Resolved to the run surfaces by `resolveSessionResumeEnabledForVersion` (`chat/anonymity.ts`). Off ⇒
today's behaviour (anonymous returns mint a fresh session; the by-ref endpoint 404s; no chooser).
Admin toggle lives on the **Settings** tab of the config editor ("Resume in-progress sessions").

## A. Anonymous same-device (the primary path)

`anonymous-session-boot.tsx` on the public path, when resume is on (`usesDurableResume = resumeEnabled
&& !preview && !inviteToken`):

- The credential `{ sessionId, accessToken, expiresAt }` is kept in **`localStorage`** (durable across
  close) instead of `sessionStorage`. A per-tab **`sessionStorage` marker** (`qn.anon.active.<v>`)
  records that this tab already entered the session. Storage helpers live in
  `lib/app/questionnaire/chat/anon-session-storage.ts` (shared with the by-ref form).
- Boot decision:
  - No durable creds → mint fresh, set marker, auto-start.
  - Durable creds **+ marker** (same-tab refresh) → resume silently (the pre-resume behaviour).
  - Durable creds **without marker** (new tab / after close) → `GET …/status`; if `active`/`paused`
    with `answeredCount ≥ 1`, show the **welcome-back gate** (`session-resume-gate.tsx`); otherwise
    (terminal / invalid token / zero progress) drop the stale creds and start fresh.
- **Continue** sets the marker and replays the transcript. **Start new** best-effort abandons the old
  session (`POST …/lifecycle { action: 'abandon' }`, token-authed), clears creds, and mints fresh.
- Durable creds are cleared when the session reaches a terminal status (so a shared device doesn't
  offer a finished session).

## B. Cross-device by ref

`POST /api/v1/app/questionnaire-sessions/resume-by-ref` — public, `withLiveSessionsEnabled`, no
`withAuth`. Body `{ ref }`. On a match, re-mints a fresh `accessToken` for the existing session;
returns `{ session: { id, versionId }, accessToken, expiresAt, ref }`. Reached from the welcome-back
gate ("Started on another device?") and a subtle footer entry on the public page
(`resume-by-ref-entry.tsx`); on success the form writes the durable creds, sets the tab marker, and
reloads straight into the conversation.

**Security** (a new unauthenticated mutation surface using a low-entropy 8-char code as a bearer
credential — `resolve-by-ref.ts`):

- `resolveAnonymousResumeByRef` resolves a session ONLY when every guard holds — anonymous
  (`respondentUserId === null`) **and** walk-up (`invitationId === null`; an invite-bound session
  resumes via its stronger private link, never the circulating support code) **and** non-preview
  **and** `active`/`paused` **and** the version has `sessionResumeEnabled` on. Any failure → `null`.
- The route collapses every non-match to ONE generic `404 NO_RESUMABLE_SESSION` (no enumeration
  oracle) and hard rate-limits on client IP (`resumeByRefLimiter`, 5/min) to throttle brute force.
- No session is created and no answer content is returned — only a token bound to the existing id.

## C. Authenticated Continue / Start-new

`/questionnaires/start` (versionId path only — the invitation path keeps its idempotent silent resume,
since its round/cohort context is resolved by the create seam). When resume is on and
`findAuthedResumeDetail` finds a session with `answeredCount ≥ 1`, the page renders
`AuthedResumeChooser` instead of redirecting. **Continue** links to `/questionnaires/[sessionId]`;
**Start new** runs the `startFreshAuthedSession` server action (`start/actions.ts`) — abandon old +
`createSessionForVersion` (now finds nothing resumable → mints fresh) + redirect.

## Shared abandon

The respondent `POST …/lifecycle` route accepts `pause | resume | abandon`. `abandon` is permitted for
the authed owner **and** for an anonymous token holder (it's terminal — nothing to resume — and backs
the "Start new" flows); `pause`/`resume` stay signed-in only. Drives `abandonSession` through the F4.6
state machine (`active|paused → abandoned`).

## Files

- Config: `prisma/schema/app-questionnaire.prisma` (`sessionResumeEnabled`), `types.ts`,
  `authoring/config-schema.ts`, `_lib/detail.ts`, `chat/anonymity.ts`, `config-editor.tsx`.
- Anonymous: `anon-session-storage.ts`, `anonymous-session-boot.tsx`, `session-resume-gate.tsx`,
  `resume-by-ref-form.tsx`, `resume-by-ref-entry.tsx`, `(public)/q/[versionId]/page.tsx`.
- By-ref: `resume-by-ref/route.ts`, `_lib/resume-by-ref.ts`, `_lib/rate-limit.ts`, `api/endpoints.ts`.
- Authed: `start/page.tsx`, `start/actions.ts`, `authed-resume-chooser.tsx`,
  `chat/resumable-session.ts` (`findAuthedResumeDetail`).
- Abandon: `[id]/lifecycle/route.ts`, `_lib/sessions.ts` (`abandonSession`).
