# Invitations (P3 / F3.2)

How an admin invites respondents to a launched questionnaire, how the tokenised
link binds them to an account, and how a live invitation pins its version. API-first,
gated by `APP_QUESTIONNAIRES_ENABLED` (404 when off).

## Model — `AppQuestionnaireInvitation`

`prisma/schema/app-questionnaire.prisma`. One row per invited respondent, **pinned
to the launched version** it targets (`versionId` FK, `onDelete: Cascade`).

| Field                                          | Notes                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `versionId`                                    | The launched version at send time. In-flight invitees stay pinned when it forks.                                |
| `email`, `name?`                               | Recipient. The invitation is keyed by token, not email — duplicates are allowed across versions / after revoke. |
| `tokenHash` `@unique`                          | SHA-256 of the opaque token. Plaintext lives **only** in the emailed URL.                                       |
| `status`                                       | Lifecycle (below). Default `pending`.                                                                           |
| `userId?`                                      | Respondent `User.id`, set on registration. Plain `String`, **no `@relation`** (UG-1).                           |
| `invitedByUserId`                              | Admin `User.id`. Plain `String`, no `@relation` (UG-1).                                                         |
| `expiresAt`                                    | `INVITATION_TOKEN_EXPIRY_DAYS` (7) from mint.                                                                   |
| `sentAt`/`openedAt`/`registeredAt`/`revokedAt` | Lifecycle timestamps.                                                                                           |

Indexes: `versionId`, `status`, `email`, `userId`, unique `tokenHash`. No
`(versionId, email)` unique — dedup is application-layer (revoke → re-invite must work).

There is **no `questionnaireId` column**: the admin list scopes through the version
relation (`where: { version: { questionnaireId } }`). F3.4 adds a `demoClientId`
denormalisation for demo-client theming — F3.2 leaves that seam open.

## Lifecycle

```
pending → sent → opened → registered → started → completed
                    └──────── revoked (from pending | sent | opened) ────────┘
```

- **F3.2 drives `pending → sent → opened → registered`** and `revoked`.
- **`started`/`completed` are seam states** — enum values only; P6/P7 sessions
  transition them. The pure transition table (`invitations/status.ts`) already
  encodes the edges, but no F3.2 route walks them.

Transition legality is pure (`isInvitationTransitionAllowed`,
`isInvitationResendable` in `lib/app/questionnaire/invitations/`); the routes map an
illegal transition to a 409 and the UI never offers an action the server would reject.

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

| Route                              | Method | Purpose                                                                        |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `/api/v1/app/invitations/metadata` | GET    | Validate token → `{ questionnaireTitle, inviteeName, status }`, mark `opened`. |
| `/api/v1/app/invitations/accept`   | POST   | Register (better-auth `signUpEmail`) + bind `userId` → `registered`.           |

Accept reuses the platform `accept-invite` machinery (sign-up → set `emailVerified`
→ sign-in → forward Set-Cookie for auto-login). An already-registered email returns
`409 ACCOUNT_EXISTS` (claim-via-login deferred to P7).

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

`started`/`completed` transitions (P6/P7). Demo-client branding + themed email
(F3.4). Cost estimation (F3.3). Anonymous-mode session entry (P6/P7).
