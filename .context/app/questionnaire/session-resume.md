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
- **A stored credential the server no longer honours is replaced, not entered.** Every path that
  enters a STORED session goes through `enterStoredSession`, which reads the transcript first:
  `fetchTranscript` reports `sessionGone` on a `404` (the row is not there) or a `401`/`403` (the
  token no longer authorises it), and the boot then clears the credential + tab marker and mints a
  real session. Without it the boot entered the dead session anyway — every boot read fails soft to
  nothing, so the surface seeded a welcome and the FIRST turn came back "Session not found", with a
  Try again that asked the same dead session every time and a credential nothing cleared, so a
  reload landed in the same place. It applies to the ephemeral paths too (admin preview,
  frictionless invite), which reuse a stored token with no status check of their own.
  Deliberately narrow: a 500, a timeout, or a malformed body leave the session alone, because
  abandoning a live one over a blip would lose a respondent's thread to fix a problem they did not
  have. Recovery happens once — the replacement is entered through `enterFreshSession`, which
  surfaces a failure rather than recovering again.

## B. Cross-device by ref

`POST /api/v1/app/questionnaire-sessions/resume-by-ref` — public, no `withAuth`. Body `{ ref }`. On a match, re-mints a fresh `accessToken` for the existing session;
returns `{ session: { id, versionId }, accessToken, expiresAt, ref }`. Reached from the welcome-back
gate ("Continue a session from another device") and a footer entry on the public page
(`resume-by-ref-entry.tsx`); on success the form writes the durable creds, sets the tab marker, and
reloads straight into the conversation.

**Entering the code** (`session-ref-input.tsx` → `resume-by-ref-form.tsx`):

- The code is entered in a **segmented field** — eight cells in the code's own 4+4 shape — over ONE
  real `<input>` held invisibly on top. One labelled field for assistive tech and for the browser
  (paste anywhere in the group, one mobile keyboard); the cells are presentation driven by `value`.
- Every keystroke is folded through `normalizeSessionRef` **in the field**, so a respondent cannot
  type a code the lookup would reject on formatting (case, grouping dash, `O`→`0`, `I`/`L`→`1`).
- The field carries **no `maxLength`**: the browser clamps before the dash is stripped, which eats
  the last character of a pasted `7F3K-9M2P`. The ceiling is applied after normalisation instead.
- It **submits itself on the eighth character** (guarded by an in-flight ref, and fired only on the
  transition into a complete code) — someone copying a code off a second screen is looking at that
  screen, not this one. The button stays for keyboard and retry. Success latches a "found it" state
  before the reload, so the navigation does not read as a hang.
- The public-page entry **owns no row**. `/q/[versionId]` builds the node and passes it down
  (`AnonymousSessionBoot` → `SessionEntry` → `SessionWorkspace`) as `resumeByRef`; the _workspace_
  picks the host, because only it knows which surfaces exist:
  - intro enabled → `QuestionnaireSplash`'s `footerAside`, in the footer's left cluster beside "you
    can return to this overview anytime";
  - intro disabled → `SessionLifecycleBar`'s `leading` slot, beside the anonymity indicator.
    Both are rows that already exist, so the affordance costs zero height either way.
- **The `error` boot phase renders it too**, below "Try again". The page auto-creates before anything
  else, so a second-device return hits a failed create _first_ — and several failures that land there
  leave resume-by-ref working: the session-start 429 is per-IP on a **separate** limiter window, and
  `resolveAnonymousResumeByRef` checks neither launch status nor `accessMode`. Without it, a
  respondent whose session is alive and whose code resolves gets only a reload button that re-runs
  the same failing create. The other phases omit it deliberately: `creating` is a transient spinner,
  `welcome-back` carries its own in-place form, and `archived` implies `archivedAt` is set — which
  the resolver rejects outright, so no code could resolve there anyway.
- **Do not put it back below the conversation.** As a sibling under `BrandThemeProvider` it escaped
  the page's `h-[calc(100dvh-9rem)]` budget and painted over the site footer; bounded inside the
  provider it merely traded that for a whole line of the conversation's height, spent on a control
  almost no one needs. The same reasoning applies to anything else added under the surface here.
- The trigger is **typographic, not a button**, and **two stacked centred lines**: a muted question
  above, one underlined accent action word below. An outlined pill in that footer reads as a rival
  call-to-action to "Begin your conversation" sitting right beside it; set on ONE line it runs to a
  ~330px sentence competing with the other footnote and the CTA for the same row. Stacked, the block
  is half as wide, needs nothing hidden at `sm` (so the accessible name is never abridged on the
  phones most likely to _be_ the second device), and the action word lands on its own line.
- The splash footer is a **three-slot row**: note (`flex-1`, left), aside (`shrink-0`, centre), CTA
  (`flex-1`, right). The flanking `flex-1`s are what put the aside on the row's true centre — hung
  off the end of the note instead, it reads as an afterthought bolted to the footnote.
- The public-page entry opens a **dialog**, not an inline expansion: it sits in a dense footer row,
  and the panel is where "where do I find my code?" gets answered. It
  portals to `document.body`, outside `BrandThemeProvider`, so `/q/[versionId]` hands it the
  client's CSS variables explicitly (`brandStyle={themeToCssVariables(theme)}`) — without that a
  white-labelled questionnaire opens a platform-coloured panel. The welcome-back gate expands the
  same form in place instead: it is already the focused surface, and a modal there would be a gate
  on a gate.

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
