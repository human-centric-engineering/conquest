# Invitations (P3 / F3.2)

How an admin invites respondents to a launched questionnaire, how the tokenised
link binds them to an account, and how a live invitation pins its version. API-first,
gated by `APP_QUESTIONNAIRES_ENABLED` (404 when off).

## Model — `AppQuestionnaireInvitation`

`prisma/schema/app-questionnaire.prisma`. One row per invited respondent, **pinned
to the launched version** it targets (`versionId` FK, `onDelete: Cascade`).

| Field                                          | Notes                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `versionId`                                    | The launched version at send time. In-flight invitees stay pinned when it forks.                                                                 |
| `email`, `name?`                               | Recipient. The invitation is keyed by token, not email — duplicates are allowed across versions / after revoke.                                  |
| `tokenHash` `@unique`                          | SHA-256 of the opaque token. Plaintext lives **only** in the emailed URL.                                                                        |
| `status`                                       | Lifecycle (below). Default `pending`.                                                                                                            |
| `userId?`                                      | Respondent `User.id`, set on registration. Plain `String`, **no `@relation`** (UG-1).                                                            |
| `invitedByUserId`                              | Admin `User.id`. Plain `String`, no `@relation` (UG-1).                                                                                          |
| `demoClientId?`                                | **F3.4** `DEMO-ONLY` brand snapshot (the attributed demo client at send time). Real `@relation`, `onDelete: SetNull`, indexed. Themes the email. |
| `expiresAt`                                    | `INVITATION_TOKEN_EXPIRY_DAYS` (7) from mint.                                                                                                    |
| `sentAt`/`openedAt`/`registeredAt`/`revokedAt` | Lifecycle timestamps.                                                                                                                            |

Indexes: `versionId`, `status`, `email`, `userId`, `demoClientId`, unique `tokenHash`.
No `(versionId, email)` unique — dedup is application-layer (revoke → re-invite must work).

There is **no `questionnaireId` column**: the admin list scopes through the version
relation (`where: { version: { questionnaireId } }`).

### Demo-client branding (F3.4, `DEMO-ONLY`)

The send seam snapshots the questionnaire's attributed `demoClientId` onto each
invitation at creation (`null` = generic Sunrise demo). The snapshot points at the
**client directly**, so reattributing the questionnaire later doesn't change an
already-sent invitation's brand. The email theme is resolved from it:

- **Create** (`POST …/invitations`): resolve the questionnaire's `demoClientId` once,
  write it onto every row, and resolve the brand once per batch.
- **Resend** (`POST …/invitations/:id/resend`): theme from the invitation's **own**
  snapshot — the respondent keeps the brand they were originally invited under.
- `resolveDemoClientTheme()` (route-local) loads the four theme columns and runs the
  pure `resolveTheme()` (`lib/app/questionnaire/theming`); `null`/unthemed → the
  all-Sunrise theme, so a generic invite renders exactly as pre-F3.4. The themed email
  is `emails/questionnaire-invitation.tsx` (CTA colour, logo, welcome copy). See
  [demo-clients.md] § "Theming module".

## Lifecycle

```
pending → sent → opened → registered → started → completed
                    └──────── revoked (from pending | sent | opened) ────────┘
```

- **F3.2 drives `pending → sent → opened → registered`** and `revoked`.
- **`started`/`completed`** are walked by sessions: the frictionless flow advances
  `→ started` on first boot, and `transitionSession` stamps `→ completed` when the
  bound session completes.
- **Frictionless (no-account) direct-to-started:** `pending | sent | opened → started`
  edges exist so a token can boot a session WITHOUT the account-registration
  `registered` step (see below).

Transition legality is pure (`isInvitationTransitionAllowed`,
`isInvitationResendable` in `lib/app/questionnaire/invitations/`); the routes map an
illegal transition to a 409 and the UI never offers an action the server would reject.

## Frictionless invite links (Phase B)

Gated by `APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_ENABLED` (+ live-sessions). A per-invitee
token boots a **no-login** session — the respondent answers without creating an account:

- `POST /api/v1/app/questionnaire-sessions/from-invite { inviteToken }` →
  `createSessionFromInviteToken` resolves the invitation by `tokenHash`, validates
  not-revoked / not-expired / version-launched, then creates a session with
  `respondentUserId: null` and `invitationId` set, mints the HMAC `accessToken`, and
  advances the invitation `→ started`. Idempotent: a re-opened link resumes the existing
  non-terminal session (`findResumableSessionByInvitation`).
- **Turns are unchanged**: a frictionless session is `respondentUserId: null`, so the
  existing anonymous turn path (`X-Session-Token`) drives every turn.
- The public page reads `?i=<token>` and forwards it to `AnonymousSessionBoot`, which POSTs
  `/from-invite` (storage keyed on the token, so a shared device never crosses invitees).
- **No profile snapshot** is written — the admin captured invitee details at invite time
  (`invitation.profile`); identity lives on the invitation and is read only for STATUS
  (the completion-tracking-only invariant, `invitations/linkage.ts`).
- The account-registration accept flow still works (optional, for cross-device resume);
  when off, invitations fall back to it. (Linking a token-bound session to a later-created
  account for cross-device resume is a follow-up.)

## Token security

`mintInvitationToken()` (`invitations/token.ts`) — 32 random bytes as hex, SHA-256
hashed at rest, exactly the platform recipe (`lib/utils/invitation-token.ts`). The DB
stores only `tokenHash`; the metadata + accept endpoints hash the URL token and match.
The **email is derived server-side** from the row, so the link carries only `?token=`.
No view (`InvitationView`, `InvitationLandingView`) ever projects `tokenHash`.

## Launch-blocker wiring

A live invitation **pins** its launched version: editing the version forks a draft
and un-launch/archive is refused. `INVITATION_BLOCKER_STATUSES` (`pending`, `sent`,
`opened`, `registered`, `started` — i.e. not `revoked`/`completed`) defines "live".

The seam splits across the `lib/app` boundary:

- **Pure** (`lib/app/questionnaire/authoring/launch-blockers.ts`): the `LaunchBlockers`
  shape + `hasLaunchBlockers()` predicate.
- **Route-local** (`app/api/v1/app/questionnaires/_lib/launch-blockers.ts`): the
  Prisma `countLaunchBlockers(versionId)` (real for invitations as of F3.2; sessions
  slot in at P4). The fork writer and the status route import the counter from here.

## API

Admin (flag-gate → `withAdminAuth` → audit):

| Route                                                   | Method | Purpose                                                 |
| ------------------------------------------------------- | ------ | ------------------------------------------------------- |
| `…/questionnaires/:id/invitations`                      | GET    | List (status filter, pagination). Never returns tokens. |
| `…/questionnaires/:id/invitations`                      | POST   | Send single/bulk. `inviteLimiter` sub-cap.              |
| `…/questionnaires/:id/invitations/:invitationId`        | PATCH  | Revoke (`{ action: "revoke" }`).                        |
| `…/questionnaires/:id/invitations/:invitationId/resend` | POST   | Regenerate token + re-send.                             |

`POST` resolves the questionnaire's launched version (`409 INVITE_NO_LAUNCHED_VERSION`
if none), then per recipient: app-layer dedup (live invite → `skipped`), mint, create,
send. A send failure keeps the row at `pending` (resend later) and does **not** fail
the request — the response is a per-recipient result array (`sent`/`skipped`/`failed`).

Public, token-gated (F3.2 PR2 — no auth guard, rate-limited):

| Route                              | Method | Purpose                                                                                              |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `/api/v1/app/invitations/metadata` | GET    | Validate token → `{ questionnaireTitle, inviteeName, status, accountExists }`, mark `opened`.        |
| `/api/v1/app/invitations/accept`   | POST   | New email: register (`signUpEmail`) + bind. Existing email: sign-in-and-claim + bind → `registered`. |

Accept reuses the platform `accept-invite` machinery (set `emailVerified` → sign-in →
forward Set-Cookie for auto-login). **A fresh email** registers a new account. **An
already-registered email claims the invitation by signing in** — the supplied password
is verified via `signInEmail` (a wrong one is `401 INVALID_CREDENTIALS`, binding
nothing) and the invitation is bound to that existing account; binding happens _after_
sign-in so a failed credential never half-registers. The metadata route reports
`accountExists` so the landing form asks for the existing password ("sign in to claim")
instead of offering to set a new one. _(Closed 2026-06-07, deferred-gaps audit Item 3 —
was the P7-deferred `409 ACCOUNT_EXISTS` dead-end.)_

## Admin UI

Dedicated sub-route `app/admin/questionnaires/[id]/invitations/` (mirrors the F2.3
extraction-changes sub-route), linked from the detail page. `InviteForm` (paste single
or bulk emails) plus `InvitationsTable` (status badge, resend, revoke). The respondent
landing + registration page lives at `/questionnaire-invite?token=` (F3.2 PR2).

## Data erasure (first app→User references)

`userId`/`invitedByUserId` are the **first** questionnaire columns pointing at `User`.
They are plain `String` (UG-1), so they carry no FK and do **not** block
`eraseUser()`'s deletes (Prisma `Restrict` applies only to modelled relations). They
are also **not** automatically scrubbed. The F3.2 decision: this is acceptable for the
demo profile — invitation rows are operational/config data, and a respondent's `userId`
becoming a dangling id after erasure leaks no personal data (the `User` row, with the
PII, is gone; the email on the invitation is the admin-supplied invite target, not
erasure-managed profile data). A fork that productionises invitations should revisit
`eraseUser()` (`lib/privacy/erase-user.ts`) to null `userId` on erasure if respondent
invitations must be fully anonymised. See `.context/privacy/data-erasure.md`.

## Not here

`started`/`completed` transitions (P6/P7). Cost estimation (F3.3). Anonymous-mode
session entry (P6/P7). (Demo-client branding + themed email shipped in F3.4 — see
above.)

[demo-clients.md]: ./demo-clients.md
