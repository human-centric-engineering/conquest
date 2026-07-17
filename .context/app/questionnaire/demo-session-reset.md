# Demo session reset (F6.4)

> **DEMO-ONLY.** The between-demos "clean slate" for a sales prospect. Destructive,
> admin-only, and stripped by a real client engagement — see [demo-clients.md]
> § "Fork guidance". Built on the F4.6 session graph + the F6.1 live surface.

`POST /api/v1/app/demo-clients/:id/reset-sessions` hard-deletes the session graph
(sessions + answer slots + turns + events) for **every version of every questionnaire
attributed to the client**, so the next prospect starts fresh. The demo client, its
questionnaires, versions, and config are untouched — only respondent run data is wiped.

## Request

| Part                       | Shape                                | Notes                                                                       |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Body                       | `{ "confirmSlug": "<client-slug>" }` | Typed-confirmation guard. Must equal the client's own slug (→ 400 on miss). |
| Query `?resetInvitations=` | `true` opts into invitation cleanup  | Absent / anything-but-`true` → no invitation rows are touched.              |

## Gate order

The route is `withAdminAuth(...)` — admin-only, consistent with the other demo-client
routes. It's a free, synchronous, admin-only DB op (no LLM cost, no respondent surface),
already triple-gated by admin auth + the typed confirmation + the anonymousMode refusal.

1. **Unauthenticated / non-admin** → `401` / `403`. "403 on ownership" _is_ the admin-role
   guard — `AppDemoClient` has no per-user owner column; it's a global admin fixture.
2. **Unknown client id** → `404 NOT_FOUND`.
3. **Malformed body** (missing / non-kebab `confirmSlug`) → `400 VALIDATION_ERROR`.
4. **Any version runs `anonymousMode`** → `409 ANONYMOUS_MODE_PROTECTED`. Too destructive
   for research-sensitive data. **This is a structural block and wins over a correct slug** —
   it's evaluated before the confirmation, so a valid `confirmSlug` is still refused here.
5. **`confirmSlug` ≠ client slug** → `400 CONFIRM_SLUG_MISMATCH`.
6. **Success** → `200` with `{ id, deletedCounts, resetInvitations }`.

## What gets deleted

`performReset` (`app/api/v1/app/demo-clients/_lib/reset.ts`) runs one
`prisma.$transaction`, deleting **children before the parent session** so each
`deleteMany().count` is accurate — the `onDelete: Cascade` FKs would otherwise zero the
child counts before they're read:

```
answer slots → turns → session events → sessions   (then, opt-in, invitations)
```

- **Preview sessions are included** by design. The filter is `versionId`-scoped and does
  not exclude `isPreview` — a clean slate clears admin preview exercises too.
- **No Profile table.** The original spec named "profiles"; profile data is not a
  session-scoped model (it's `AppQuestionnaireConfig.profileFields`, config not run data),
  so `deletedCounts` covers `sessions`, `answerSlots`, `turns`, `events`, `invitations`.
- **Invitation cleanup is opt-in.** With `?resetInvitations=true`, invitations whose status
  is **not** in `RESET_PRESERVED_INVITATION_STATUSES` (`started | completed | revoked`) are
  deleted — i.e. `pending | sent | opened | registered` are cleared, real progress and
  admin revocations survive. Without the flag, no invitation is touched.
- **Empty graph** (client with no questionnaires) short-circuits: no transaction, all-zero
  counts, still `200` **and still audited** (operator intent recorded; reruns are visible).
- **Idempotent** — a second call deletes nothing and returns all-zero counts.

`deletedCounts` shape:

```json
{ "sessions": 2, "answerSlots": 5, "turns": 4, "events": 6, "invitations": 0 }
```

## Admin UI

The demo-client **detail page** (`app/admin/demo-clients/[id]/page.tsx`) surfaces this
via `components/admin/demo-clients/reset-sessions-dialog.tsx` (`ResetSessionsDialog`), a
destructive Dialog next to the Delete action. It mirrors the route's guards in the UI:

- The confirm button is **disabled until the typed input equals the client slug** (the
  same value the 400 `CONFIRM_SLUG_MISMATCH` guard checks server-side).
- An optional checkbox sends `?resetInvitations=true`.
- The `409 ANONYMOUS_MODE_PROTECTED` and `400 CONFIRM_SLUG_MISMATCH` error codes are
  mapped to inline messages; on success it shows the `deletedCounts` and `router.refresh()`es
  on close so freshly-cleared session/analytics reads re-fetch.

## Audit

On success the route fires `logAdminAction({ action: 'app_demo_client.reset_sessions',
entityType: 'app_demo_client', entityId, entityName, metadata: { slug, resetInvitations,
deletedCounts } })`. The audit row records what a reset wiped and is itself **never
deleted** — a reset never touches `AiAdminAuditLog`.

## Files

- `app/api/v1/app/demo-clients/[id]/reset-sessions/route.ts` — handler + gate order.
- `app/api/v1/app/demo-clients/_lib/reset.ts` — `loadResetTargets` (version collection +
  `anyAnonymous` signal) + `performReset` (transactional delete).
- `components/admin/demo-clients/reset-sessions-dialog.tsx` — the admin UI dialog (typed-slug
  confirmation), mounted on the demo-client detail page.
- `lib/app/questionnaire/demo-clients/schemas.ts` — `resetSessionsSchema`,
  `resetSessionsQuerySchema`.
- `lib/app/questionnaire/invitations/types.ts` — `RESET_PRESERVED_INVITATION_STATUSES`.

## Fork guidance

Grep-isolated under the `DEMO-ONLY` marker like the rest of demo tenancy
(`grep -rl "DEMO-ONLY"`). A fork that drops the demo surface deletes the route +
`_lib/reset.ts`, the `ResetSessionsDialog` component, and the two reset schemas; the `RESET_PRESERVED_INVITATION_STATUSES`
constant rides with the invitations module. See [demo-clients.md] § "Fork guidance" for
the full demo-tenancy replacement paths.

[demo-clients.md]: ./demo-clients.md
