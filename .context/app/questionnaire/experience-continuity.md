# Experience continuity — the respondent's journey

How a respondent moves between the legs of an experience run, and how the seam is presented.
Shipped in F15.3. Companions: [`experiences.md`](./experiences.md) (the model),
[`experience-routing.md`](./experience-routing.md) (how the fork is decided).

## What F15.3 actually fixed

F15.2 built the run machinery — advance, carry-over, poll, leg minting — and a `HandoffCard`
component, but **nothing mounted the card**. The submit route returned a `runId` that no client
read. A respondent who finished a leg landed on the terminal completion screen and the journey
stopped there.

Three gaps had to close before `stitched` meant anything:

1. **Nothing joined the run backend to the respondent UI.** Now the workspace mounts the handoff.
2. **The no-login surface could not address leg B.** `/q/<versionId>` boots a NEW session; it
   cannot open an existing one. Now `/x/<publicRef>` does.
3. **No respondent entry point existed at all.** No start route, no share link. Now `/x/new/<id>`
   and the admin's Share panel.

## Run membership rides the STATUS VIEW

`SessionStatusView.experience` carries `SessionExperienceContext` — run id, public ref, ordinal,
continuity mode, seam marker, step title — or `null` for an ordinary standalone session.

**Not the submit response.** The submit response is seen exactly once. A respondent who reloads a
completed leg, or comes back to the tab an hour later, would otherwise land on the completion
screen and never learn the journey continues. The status view is re-read on every mount.

The cost is one indexed lookup on the leg table's `@unique` `sessionId` per status read, and a null
result short-circuits before the second query. The read is fail-soft: an experience read that
errors must not take down the lifecycle status the whole respondent UI depends on.

The continuity mode is read **live from the experience**, never frozen onto the run. An author
switching modes mid-flight changes what in-flight respondents see — which is the point of the two
modes being presentation-only.

## The two seams

| Mode       | Presentation                     | Continuing is           |
| ---------- | -------------------------------- | ----------------------- |
| `linked`   | `HandoffCard` — a card with copy | the respondent's choice |
| `stitched` | `StitchedContinuation`           | automatic               |

Both wait on the same `useRunHandoff` hook. It was extracted from the card precisely so the two
presentations cannot drift on the parts that are easy to get wrong: the timeout, the hidden-tab
back-off, and stopping.

**Why auto-continue is safe in `stitched` but not `linked`.** The objection to moving someone
without their agreement is real and is why `linked` refuses to. It does not apply here: from the
respondent's side the interviewer simply carried on, which is what one continuous conversation
means, and the author chose it explicitly per experience. Back still returns to the completed leg.

**Endings never auto-advance.** A `conclude` or `failed` outcome settles and renders a terminal
screen. An ending deserves to be read, not skipped past.

## The seam marker

`settings.stitchedSeamMarker` — `divider` (default) or `none`. A key plus a default, no migration,
exactly as the settings blob promises.

`divider` renders a thin labelled rule carrying the next step's title. **Defaulting to `divider` is
deliberate**: a respondent moving from a broad opener into a materially more probing follow-up
should be able to see the subject changed rather than discover it mid-answer. Hiding the seam stays
an explicit author choice.

The control appears in Settings only when `stitched` is selected. The stored value survives a mode
switch away and back — it is hidden, not cleared.

## Stitched history is a READ

`GET /api/v1/app/experiences/runs/:runId/transcript?sessionId=` returns the legs **before** the
caller's own, oldest first, as `StitchedSegment[]`. No rows are written, merged or rewritten. That
is what lets `linked` and `stitched` share a persistence shape.

It is rendered as a **separate prop**, not concatenated into the live `turns` array, and
`QuestionnaireTurn` was deliberately NOT widened with a `seam` role. The turn array feeds the
reveal cursor, the inspector drawer, and `report/craft.ts` — which maps `turn.role` straight onto
an `LlmMessage`. A synthetic role would have travelled into a real LLM call as a role the provider
does not accept.

Fetched client-side, not SSR-seeded: the stitched surface is reached by navigation from the
previous leg, so an SSR-only seed would be missing exactly on the hop that creates the seam. A
failed history read degrades to "this leg alone" — the live conversation does not depend on the
replay above it.

## Addressing: `/x/<publicRef>`

One address for a whole journey, resolving server-side to whichever leg the run is on.
`AppExperienceRun.publicRef` was reserved for this from the start.

- **`/x/new/<experienceId>`** — the shareable link. Mints a run, then `router.replace`s to the
  stable address. `replace`, never `push`: this URL creates a run every time it loads, so leaving
  it in history means Back mints a second journey and abandons the first.
- **`/x/<publicRef>`** — opens the journey. Not indexable.

**Continuing on this surface must REFRESH, not push.** The URL for leg B is the URL already in the
address bar; `router.push` there is a no-op and the handoff would silently do nothing. This is why
`HandoffCard` and `StitchedContinuation` take an `onContinue` **callback** rather than an href —
the authenticated surface navigates, `/x/` refreshes.

## The credential

**The ref addresses; it never authorises.** `publicRef` is an eight-character human-quotable
support code — guessable in a way a credential must never be.

Authorisation is an **httpOnly cookie**, `cq_run_<publicRef>`, minted at run creation for no-login
respondents (`run-access-token.ts`). An authenticated respondent uses their own session cookie and
is issued nothing extra.

### Why a cookie rather than `?t=<token>` in the URL

The rejected alternative was `/q/s/<sessionId>?t=<token>`. It is the wrong trade **because of what
this credential guards**: experience transcripts can contain raw safeguarding disclosures — F15.2
carries sensitivity state between legs as summaries precisely because the raw text stays in the
source leg's transcript — and the stitched transcript endpoint replays exactly those legs. A
URL-borne credential to that lands in browser history, `Referer` headers, and any accidental paste.
`httpOnly` also puts it out of reach of injected script.

### Details that matter

- **Run-scoped, not session-scoped.** The thing authorised is a journey. A per-session credential
  must be re-minted at every hop, which is why the poll grew a minting side-effect.
- **Domain-separated HMAC.** A session token and a run token are structurally near-identical JSON
  signed with the same secret. The run token's HMAC is prefixed with a domain string so one can
  never be replayed against the other's verifier. Cheap now, impossible to retrofit.
- **Cookie names are untrusted.** `canReadRun` scans every `cq_run_*` cookie and trusts only the
  signed payload. A cookie called `cq_run_ANYTHING` carrying another run's token fails.
- **Namespaced per run**, so a respondent starting a second journey does not lock themselves out
  of the first.
- **`SameSite=Lax`, not `Strict`** — a respondent commonly arrives from an email or chat app, and
  `Strict` would withhold the cookie on that first navigation and gate a genuine respondent out.

## Access rules

`canReadRun` (`_lib/run-access.ts`) is shared by the poll and transcript routes. Two routes
enforcing the same rule separately is how the weaker one becomes the way in.

The transcript route narrows it twice more:

- **No admin bypass.** An admin may poll any run's status, but reading a respondent's conversation
  belongs on the audited admin session viewer, not behind a respondent-shaped endpoint.
- **Only legs strictly before the caller's own**, by ordinal — never the whole run. A caller must
  also name the leg their credential actually proved.

`loadStitchedHistory` fails **closed**: a session that is not part of the run returns empty, not
everything.

## Known limitation — cross-device

The credential is deliberately not in the URL, so it **cannot travel with a copied link**. A
respondent opening `/x/<ref>` on a different device, or after clearing cookies, gets an explanatory
notice (not an error) that says plainly their answers are safe and quotes the ref for support.

This is the honest cost of the security posture, not an oversight. A run-level resume-by-code —
the equivalent of the questionnaire surface's `ResumeByRefEntry` — is the natural follow-up.

## Gotchas

**`router.push` is a no-op on `/x/`.** See above. This is the single easiest thing to get wrong
here and it fails silently.

**A handoff-minted leg opens already "resumed".** Leg B's bridging line is persisted as its first
turn, so the transcript is non-empty from the start and the generic welcome is correctly skipped.

**The authenticated surface still changes URL between legs.** `/questionnaires/<id>` addresses a
session, so a stitched journey there hops URLs even though the conversation reads as continuous.
Converging both surfaces on `/x/` is a deliberate follow-up, not part of F15.3.

## Related

- `.context/app/planning/features/f15.3.md` — what shipped and why
- `.context/app/questionnaire/experiences.md` — the model and continuity modes
- `.context/app/questionnaire/experience-routing.md` — how the fork is decided
