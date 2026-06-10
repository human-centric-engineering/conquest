# Demo clients (F2.5.1 · branding F3.4)

> **DEMO-ONLY.** Demo-client tenancy is an attribution + branding partition for the
> sales demo — **not** a security boundary and **not** real multi-tenancy. A real
> client engagement strips it. See [forking.md] § "Replacing demo tenancy" (P9) and
> the [development plan][plan] P2.5 section.
>
> **Spinning one up?** The end-to-end operational walkthrough — seed fast path,
> branding, content, launch, invite, first session, reset — is in
> [runbook.md](./runbook.md).

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

`AppDemoClient` (`app_demo_client`) — identity (F2.5.1) + theme (F3.4):

| Field         | Type     | Notes                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `id`          | cuid     |                                                                                |
| `slug`        | String   | `@unique`, kebab-case ("acme-bank"); admin URLs                                |
| `name`        | String   | display name ("Acme Bank Demo")                                                |
| `description` | String?  | internal admin note                                                            |
| `isActive`    | Boolean  | soft-disable; excluded from the attribution picker                             |
| `ctaColor`    | String?  | **F3.4** hex CTA / button colour; null → Sunrise default                       |
| `accentColor` | String?  | **F3.4** hex accent; email fallback-link colour + F7.1 CSS var; null → default |
| `logoUrl`     | String?  | **F3.4** absolute https logo for the invitation email; null → none             |
| `welcomeCopy` | String?  | **F3.4** branded invitation intro line; null → default copy                    |
| timestamps    | DateTime |                                                                                |

`AppQuestionnaire.demoClientId String?` — nullable FK, `onDelete: SetNull`, indexed.
`null` = a "Generic Sunrise demo" (defaults end-to-end). Pre-F2.5.1 questionnaires
keep working; **no backfill**.

**Theme columns (F3.4) are all nullable** — null on any field means "use the Sunrise
default" (`resolveTheme()` fills it), so an unthemed client renders exactly as before.
`reset-sessions` (F6.4) is now built ([demo-session-reset.md](./demo-session-reset.md));
clone-for-client (P3+) is the remaining distributed P2.5 work. See the
[development plan][plan] P2.5 distributed-work table.

### Theming module (F3.4)

`lib/app/questionnaire/theming/` (Prisma-free, `DEMO-ONLY`) turns the nullable theme
columns into a usable brand:

- `resolveTheme(client | null)` → a `ResolvedTheme` with every gap filled by
  `SUNRISE_THEME_DEFAULTS` (`logoUrl` stays nullable — there is no default logo).
  `null` (generic demo) resolves to the all-defaults theme.
- `themeToCssVariables(theme)` → `--app-cta-color` / `--app-accent-color` (+
  `--app-logo-url` when a logo is set) for the **F7.1** user UI to spread onto a
  container. The invitation email reads the resolved values inline instead.
- `themeFields` (Zod) validate hex colours + an absolute https logo URL; they spread
  into the demo-client create/update schemas. An empty form field coerces to null
  (= reset to the Sunrise default).

**First renderer = the invitation email (F3.4).** The send seam resolves the theme
from the invitation's denormalised `demoClientId` snapshot — see [invitations.md].
The F7.1 chat surface is the second consumer (via `themeToCssVariables`).

### FK delete policy (AD2)

`onDelete: SetNull` with a reverse `questionnaires` relation, **plus an app-layer
409 guard**:

- The reverse relation powers the list `questionnaireCount`, the delete guard, and the
  detail page's attributed-questionnaire list (each row links to the questionnaire editor,
  where the picker detaches/reassigns — so the guard's "detach or reassign first" has a destination).
- `DELETE /demo-clients/:id` **refuses with 409 `DEMO_CLIENT_IN_USE`** while any
  questionnaire is attributed — the admin must detach/reassign first. This is the
  happy-path UX; `SetNull` is the schema-honest backstop (a delete that bypassed
  the guard would clear attribution rather than orphan a row).

## API

All routes are flag-gated (`404` when `APP_QUESTIONNAIRES_ENABLED` is off, before
auth), `withAdminAuth` (401/403), and audited. Registry: `API.APP.DEMO_CLIENTS`.

| Method + path                                      | Purpose                                  | Notable codes                                               |
| -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `GET /api/v1/app/demo-clients`                     | List (active + inactive)                 | —                                                           |
| `POST /api/v1/app/demo-clients`                    | Create                                   | `409 SLUG_CONFLICT`                                         |
| `GET /api/v1/app/demo-clients/:id`                 | Detail (+ attributed-questionnaire list) | `404`                                                       |
| `PATCH /api/v1/app/demo-clients/:id`               | Edit any identity or theme field         | `404`, `409 SLUG_CONFLICT`                                  |
| `DELETE /api/v1/app/demo-clients/:id`              | Delete (guarded)                         | `404`, `409 DEMO_CLIENT_IN_USE`                             |
| `POST /api/v1/app/demo-clients/:id/reset-sessions` | Reset session graph (F6.4)               | `400 CONFIRM_SLUG_MISMATCH`, `409 ANONYMOUS_MODE_PROTECTED` |
| `PATCH /api/v1/app/questionnaires/:id`             | Attribute / detach (`demoClientId`)      | `404`, `404 DEMO_CLIENT_NOT_FOUND`                          |

**Slug is derive-with-override:** omit it on create and the server derives a
kebab-case slug from the name (`slugifyDemoClient`); supply it to override. A
collision surfaces as `409`, never a silent mutation.

Audit actions: `app_demo_client.create | update | delete | reset_sessions`,
`questionnaire.assign_demo_client`.

**Session reset (F6.4):** `POST /demo-clients/:id/reset-sessions` hard-deletes the
session graph for all the client's questionnaires — the between-demos clean slate, with
a typed-confirmation guard and an anonymous-mode refusal. See
[demo-session-reset.md](./demo-session-reset.md).

## Admin UI

- `/admin/demo-clients` — list + "New demo client".
- `/admin/demo-clients/new` — create form.
- `/admin/demo-clients/:id` — edit form + delete (disabled with an explanation
  while attributed) + an **"Attributed questionnaires"** list (each row links to the
  questionnaire editor) so the admin can act on the delete guard's instruction.
- Both forms carry an **"Invitation branding"** fieldset (F3.4): CTA colour, accent
  colour, logo URL, welcome copy — each optional with a `<FieldHelp>`; blank = the
  Sunrise default. The edit form shows a **live `<DemoClientThemePreview>`** under the
  fieldset (valid inputs only — a half-typed hex shows the default, not a broken
  swatch).
- **Brand preview (`<DemoClientThemePreview>`).** Surfaces the configured brand back
  to the admin — the gap that a client could set four theme fields and see nothing.
  Reuses `resolveTheme()` and the same escaped `--app-logo-url` background as
  `BrandThemeProvider` (never a raw `<img src>`). Two modes: **compact** on the list's
  _Branding_ column (a swatch/thumbnail only for fields actually set; "Default" when
  none) and **full** on the detail page / live form preview (the resolved brand the
  respondent sees, defaults filled).
- The questionnaire detail page (`/admin/questionnaires/:id`) carries the
  attribution `<DemoClientAssign>` picker (active clients + the current one) and a
  **`<CloneForClientDialog>`** "Clone for client" action (below).

Nav entry registered via `initAppNav()` (seam 4 — no sidebar edit). The admin shell
itself is **not** themed (that's for the end-user surface in P7).

## Clone for client

`POST /api/v1/app/questionnaires/:id/clone-for-client` `{ targetDemoClientId, nameSuffix? }`
(DEMO-ONLY) duplicates a questionnaire's **current** version (launched if present, else
the highest-numbered) into a brand-new questionnaire as a fresh `draft` v1, attributed to
the chosen demo client (`null` = a generic, unattributed copy) — so the same questionnaire
is re-usable for the next prospect. The structural copy (config + sections/slots + tag
vocabulary + assignments) is single-sourced with the F2.1 version-fork via
`_lib/copy-version-graph.ts` (`copyVersionGraph`); goal/audience are copied onto the new
v1; the newest source-document row is copied as provenance. **Not** copied: sessions,
invitations, evaluation runs, extraction-change records (a clone starts fresh). The new
title is `"<source title> — <suffix>"`, the suffix defaulting to the client name (or
"Copy"). Admin-only, flag-gated, audited as `questionnaire.clone_for_client`. _(Built
2026-06-07, deferred-gaps audit Item 4 — the relocated P2.5 clone-for-client, unblocked
once F2.2 tags + F3.1 config existed.)_

## Fork guidance

Everything demo-only is grep-isolated under the `DEMO-ONLY` marker:

- `lib/app/questionnaire/demo-clients/**` + `lib/app/questionnaire/theming/**`
  (domain) · `app/api/v1/app/demo-clients/**` (routes) ·
  `components/admin/demo-clients/**` + `app/admin/demo-clients/**` (UI) ·
  the `AppDemoClient` model + theme columns + the invitation `demoClientId`
  snapshot + the `AppQuestionnaire.demoClientId` column · the `API.APP.DEMO_CLIENTS`
  block · the nav item · the attribution PATCH on the questionnaire route · the theme
  resolution in the invitation send seam.

`grep -rl "DEMO-ONLY" lib app components prisma` finds the full surface. See
[forking.md] for the three replacement paths (delete · rename to `AppTenant` + RLS
· keep as `AppBrand` without the marker).

[plan]: ../planning/development-plan.md#p25--demo-client-foundation
[forking.md]: ./forking.md
[mt]: ../../architecture/multi-tenancy.md
