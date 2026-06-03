# Demo clients (F2.5.1)

> **DEMO-ONLY.** Demo-client tenancy is an attribution + branding partition for the
> sales demo — **not** a security boundary and **not** real multi-tenancy. A real
> client engagement strips it. See [forking.md] § "Replacing demo tenancy" (P9) and
> the [development plan][plan] P2.5 section.

## What it is (and isn't)

A **demo client** lets a questionnaire be attributed to a prospect, so the sales
surface is theirs ("this is the Acme Bank demo"). F2.5.1 ships the **foundation**:
the identity table, the `AppQuestionnaire` foreign key, the admin CRUD, and the
attribution control on a questionnaire.

| It **is**                                           | It is **not**                                        |
| --------------------------------------------------- | ---------------------------------------------------- |
| An application-layer attribution/branding partition | A security or data-isolation boundary                |
| Adequate because demo clients aren't adversarial    | Row-level security / per-tenant DB / the `Org` model |
| The thing later phases hang branding + scoping off  | Real multi-tenancy (that's Sunrise's RLS seam)       |

A fork that becomes a multi-customer product activates Sunrise's RLS tenancy seam
(`TENANCY_MODE=multi`, `Org`/`orgId` retrofit at `lib/db/client.ts`) — it does
**not** harden this table into an isolation mechanism. That trap is exactly what
Sunrise's [multi-tenancy doc][mt] warns against.

## Data model

`AppDemoClient` (`app_demo_client`) — **identity only** at F2.5.1:

| Field         | Type     | Notes                                              |
| ------------- | -------- | -------------------------------------------------- |
| `id`          | cuid     |                                                    |
| `slug`        | String   | `@unique`, kebab-case ("acme-bank"); admin URLs    |
| `name`        | String   | display name ("Acme Bank Demo")                    |
| `description` | String?  | internal admin note                                |
| `isActive`    | Boolean  | soft-disable; excluded from the attribution picker |
| timestamps    | DateTime |                                                    |

`AppQuestionnaire.demoClientId String?` — nullable FK, `onDelete: SetNull`, indexed.
`null` = a "Generic Sunrise demo" (defaults end-to-end). Pre-F2.5.1 questionnaires
keep working; **no backfill**.

**Theme fields are deliberately absent.** Colours, fonts, logo, and copy land with
their first renderer (F3.4 invitation email / F7.1 user UI) — additive nullable
columns later, no backfill. So are the `reset-sessions` (F6.4) and clone-for-client
(P3+) utilities. See the [development plan][plan] P2.5 distributed-work table.

### FK delete policy (AD2)

`onDelete: SetNull` with a reverse `questionnaires` relation, **plus an app-layer
409 guard**:

- The reverse relation powers the list `questionnaireCount` and the delete guard.
- `DELETE /demo-clients/:id` **refuses with 409 `DEMO_CLIENT_IN_USE`** while any
  questionnaire is attributed — the admin must detach/reassign first. This is the
  happy-path UX; `SetNull` is the schema-honest backstop (a delete that bypassed
  the guard would clear attribution rather than orphan a row).

## API

All routes are flag-gated (`404` when `APP_QUESTIONNAIRES_ENABLED` is off, before
auth), `withAdminAuth` (401/403), and audited. Registry: `API.APP.DEMO_CLIENTS`.

| Method + path                          | Purpose                             | Notable codes                      |
| -------------------------------------- | ----------------------------------- | ---------------------------------- |
| `GET /api/v1/app/demo-clients`         | List (active + inactive)            | —                                  |
| `POST /api/v1/app/demo-clients`        | Create                              | `409 SLUG_CONFLICT`                |
| `GET /api/v1/app/demo-clients/:id`     | Detail                              | `404`                              |
| `PATCH /api/v1/app/demo-clients/:id`   | Edit any identity field             | `404`, `409 SLUG_CONFLICT`         |
| `DELETE /api/v1/app/demo-clients/:id`  | Delete (guarded)                    | `404`, `409 DEMO_CLIENT_IN_USE`    |
| `PATCH /api/v1/app/questionnaires/:id` | Attribute / detach (`demoClientId`) | `404`, `404 DEMO_CLIENT_NOT_FOUND` |

**Slug is derive-with-override:** omit it on create and the server derives a
kebab-case slug from the name (`slugifyDemoClient`); supply it to override. A
collision surfaces as `409`, never a silent mutation.

Audit actions: `app_demo_client.create | update | delete`,
`questionnaire.assign_demo_client`.

## Admin UI

- `/admin/demo-clients` — list + "New demo client".
- `/admin/demo-clients/new` — create form.
- `/admin/demo-clients/:id` — edit form + delete (disabled with an explanation
  while attributed).
- The questionnaire detail page (`/admin/questionnaires/:id`) carries the
  attribution `<DemoClientAssign>` picker (active clients + the current one).

Nav entry registered via `initAppNav()` (seam 4 — no sidebar edit). The admin shell
itself is **not** themed (that's for the end-user surface in P7).

## Fork guidance

Everything demo-only is grep-isolated under the `DEMO-ONLY` marker:

- `lib/app/questionnaire/demo-clients/**` (domain) ·
  `app/api/v1/app/demo-clients/**` (routes) ·
  `components/admin/demo-clients/**` + `app/admin/demo-clients/**` (UI) ·
  the `AppDemoClient` model + `demoClientId` column · the `API.APP.DEMO_CLIENTS`
  block · the nav item · the attribution PATCH on the questionnaire route.

`grep -rl "DEMO-ONLY" lib app components prisma` finds the full surface. See
[forking.md] for the three replacement paths (delete · rename to `AppTenant` + RLS
· keep as `AppBrand` without the marker).

[plan]: ../planning/development-plan.md#p25--demo-client-foundation
[forking.md]: ./forking.md
[mt]: ../../architecture/multi-tenancy.md
