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
attribution control on a questionnaire. Attribution can be set **at upload time**
(the `demoClientId` field on the ingest form), **at definition-import time** (the
demo-client picker on the "Import definition" dialog — sent as a `?demoClientId=`
query param since the body is the definition file itself), or changed later via the
settings-tab picker; either way it surfaces as an owner column on the questionnaires
list.

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

| Field                   | Type     | Notes                                                                                             |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `id`                    | cuid     |                                                                                                   |
| `slug`                  | String   | `@unique`, kebab-case ("acme-bank"); admin URLs                                                   |
| `name`                  | String   | display name ("Acme Bank Demo")                                                                   |
| `description`           | String?  | internal admin note                                                                               |
| `isActive`              | Boolean  | soft-disable; excluded from the attribution picker                                                |
| `ctaColor`              | String?  | **F3.4** hex CTA / button colour; null → Sunrise default                                          |
| `accentColor`           | String?  | **F3.4** hex accent; email fallback-link colour + F7.1 CSS var; null → default                    |
| `logoUrl`               | String?  | **F3.4** absolute https logo for the invitation email; null → none                                |
| `welcomeCopy`           | String?  | **F3.4** branded invitation intro line; null → default copy                                       |
| `surfaceColor`          | String?  | **F7.1+** hex brand "chrome" colour — session header band + default logo backdrop; null → no band |
| `ctaColorEnd`           | String?  | **F7.1+** hex CTA gradient end; set → CTA renders `ctaColor → ctaColorEnd`; null → solid CTA      |
| `logoBackgroundColor`   | String?  | **F7.1+** hex colour painted behind the logo (when enabled); null → falls back to `surfaceColor`  |
| `logoBackgroundEnabled` | Boolean  | **F7.1+** "apply this colour as the logo background" toggle; default `false`                      |
| timestamps              | DateTime |                                                                                                   |

`AppQuestionnaire.demoClientId String?` — nullable FK, `onDelete: SetNull`, indexed.
`null` = a "Generic Sunrise demo" (defaults end-to-end). Pre-F2.5.1 questionnaires
keep working; **no backfill**.

**Theme columns are all nullable** (`logoBackgroundEnabled` defaults `false`) — null/off
on any field means "use the Sunrise default" (`resolveTheme()` fills it), so an unthemed
client renders exactly as before. The **F7.1+ chrome set** (`surfaceColor`, `ctaColorEnd`,
`logoBackgroundColor`, `logoBackgroundEnabled`) makes a brand _suggestive_ — a deep header
band, a gradient CTA, a backdrop for logos drawn to sit on one — without trying to clone the
client's site. They are optional on the raw `DemoClientTheme` contract (absent === null), so
older DB selects / forks / tests that pass only the F3.4 four still resolve cleanly.
`reset-sessions` (F6.4) is now built ([demo-session-reset.md](./demo-session-reset.md));
clone-for-client (P3+) is the remaining distributed P2.5 work. See the
[development plan][plan] P2.5 distributed-work table.

### Theming module (F3.4)

`lib/app/questionnaire/theming/` (Prisma-free, `DEMO-ONLY`) turns the nullable theme
columns into a usable brand:

- `resolveTheme(client | null)` → a `ResolvedTheme` with every gap filled by
  `SUNRISE_THEME_DEFAULTS` (`logoUrl` stays nullable — there is no default logo).
  `null` (generic demo) resolves to the all-defaults theme.
- `themeToCssVariables(theme)` → `--app-cta-color` / `--app-accent-color` /
  `--app-cta-gradient` (always; a `linear-gradient(...)` when `ctaColorEnd` is set, else
  the solid CTA colour) plus, when set, `--app-surface-color`, `--app-logo-bg`, and
  `--app-logo-url`. The **F7.1** user UI spreads these onto a container; the invitation
  email reads the resolved values inline instead.
- `resolveTheme` also resolves the **logo backdrop** once: `logoBackgroundColor` is null
  whenever `logoBackgroundEnabled` is off, otherwise the explicit colour falling back to
  `surfaceColor` — so renderers paint it directly without re-deriving the toggle.
- `themeFields` (Zod) validate hex colours + an absolute https logo URL (+ the boolean
  toggle); they spread into the demo-client create/update schemas. An empty colour form
  field coerces to null (= reset to the Sunrise default).

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

| Method + path                                      | Purpose                                                                            | Notable codes                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /api/v1/app/demo-clients`                     | List (active + inactive)                                                           | —                                                           |
| `POST /api/v1/app/demo-clients`                    | Create                                                                             | `409 SLUG_CONFLICT`                                         |
| `GET /api/v1/app/demo-clients/:id`                 | Detail (+ attributed-questionnaire list)                                           | `404`                                                       |
| `PATCH /api/v1/app/demo-clients/:id`               | Edit any identity or theme field                                                   | `404`, `409 SLUG_CONFLICT`                                  |
| `DELETE /api/v1/app/demo-clients/:id`              | Delete (guarded)                                                                   | `404`, `409 DEMO_CLIENT_IN_USE`                             |
| `POST /api/v1/app/demo-clients/:id/reset-sessions` | Reset session graph (F6.4)                                                         | `400 CONFIRM_SLUG_MISMATCH`, `409 ANONYMOUS_MODE_PROTECTED` |
| `GET /api/v1/app/demo-clients/:id/knowledge`       | The client's private knowledge corpus (F10.1) — grounds its Respondent Reports     | `404`                                                       |
| `PATCH /api/v1/app/questionnaires/:id`             | Attribute / detach (`demoClientId`); also renames with `{ title }` (not demo-only) | `404`, `404 DEMO_CLIENT_NOT_FOUND`                          |
| `POST /api/v1/app/questionnaires/import`           | Import a definition file; optional `?demoClientId=` attributes the new draft       | `404 DEMO_CLIENT_NOT_FOUND`, `400 VALIDATION_ERROR`         |

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
- `/admin/demo-clients/:id/…` — the detail surface, split into **route-based sub-tabs**
  (the sibling of the questionnaire workspace at `…/v/:vid/…`). A shared
  `[id]/layout.tsx` owns the chrome — breadcrumb, sticky header (name + Active/Inactive
  badge + slug · count), and the `<DemoClientSubNav>` tab bar — and resolves the client
  once via `getDemoClientDetailCached` (React `cache()`), so each tab page reuses the
  fetch for free. Tabs (registry in `lib/app/questionnaire/demo-clients/nav.ts`, all
  always-on — no per-tab flags):
  - **Overview** (`/:id`) — the **"Attributed questionnaires"** list (each row links to
    the questionnaire editor, with the make-generic / reassign menus that unblock the
    delete guard) + the saved **brand preview**.
  - **Branding** (`/:id/branding`) — the `<DemoClientForm>` (identity fields + brand
    theming + live preview), intact.
  - **Knowledge** (`/:id/knowledge`) — the `<ClientKnowledgePanel>` (below).
  - **Management** (`/:id/management`) — the destructive demo-ops: **Reset sessions** and
    **Delete** (disabled with an explanation while questionnaires are still attributed —
    act on the delete guard from the Overview tab's row menus).
- Both forms carry a **"Brand theming"** fieldset (F3.4 / F7.1+): CTA colour, accent
  colour, logo URL, welcome copy, plus a **"Session chrome"** sub-block — surface colour,
  CTA gradient end, and an **"Apply a colour behind the logo"** toggle (the requested
  device, with an optional colour that defaults to the surface colour). Each field is
  optional with a `<FieldHelp>`; blank = the Sunrise default. Colours apply to **both** the
  invitation email and the respondent question session (visible via "Preview as
  respondent"). The edit form shows a **live `<DemoClientThemePreview>`** under the fieldset
  (valid inputs only — a half-typed hex shows the default, not a broken swatch).
- **Brand preview (`<DemoClientThemePreview>`).** Surfaces the configured brand back
  to the admin — the gap that a client could set theme fields and see nothing. Reuses
  `resolveTheme()` and the same escaped `--app-logo-url` background as `BrandThemeProvider`
  (never a raw `<img src>`), and renders a **miniature of the session chrome** (surface
  band + logo backdrop + gradient send button) so the admin recognises the brand before
  opening "Preview as respondent". Two modes: **compact** on the list's
  _Branding_ column (a swatch/thumbnail only for fields actually set; "Default" when
  none) and **full** on the detail page / live form preview (the resolved brand the
  respondent sees, defaults filled).
- **Knowledge base (F10.1).** The detail surface's **Knowledge** tab carries the
  `<ClientKnowledgePanel>` (from `components/admin/demo-clients/`) — upload / list / delete for the
  client's private corpus, used to ground its **Respondent Reports**. The corpus is client-owned and
  shared across all the client's questionnaires, so it lives here (not per questionnaire); a
  questionnaire's report opts into grounding via its own toggle and links here to manage the docs.
  Backed by `GET /demo-clients/:id/knowledge` → `getClientKnowledgeViewForClient`; documents carry the
  client's dedicated `KnowledgeTag` for strict per-client isolation. See
  [respondent-report.md](./respondent-report.md#per-client-knowledge-isolation-tag-based).
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
