# Questionnaire archiving (soft delete)

A questionnaire can be **deleted** — hidden from the admin list without destroying
any data — and later **restored** to its exact prior state. This is a reversible
soft-delete: nothing is erased, so an accidental (or reconsidered) removal is always
recoverable.

> **Naming:** the admin UI labels this action **Delete** (and the trash slice
> **Deleted**), but the underlying mechanism is unchanged and still named `archivedAt`
> throughout the schema, API route (`questionnaire.archive` audit action), and list
> query param (`archived=true`). Only the user-facing wording says "delete"; every
> internal identifier below keeps the `archive` vocabulary.

## The model — `archivedAt`, orthogonal to `status`

Archiving is a single nullable timestamp on `AppQuestionnaire`:

```prisma
archivedAt   DateTime?   // non-null = archived; the moment it was archived
@@index([archivedAt])    // the list query filters on it every page load
```

It is **deliberately separate from `status`** (`draft | launched | archived`).
`status` is the lifecycle of the questionnaire's content; `archivedAt` is a
trash/soft-delete flag layered on top. Keeping them orthogonal is what makes
restore trivial: archiving never touches `status`, versions, sessions, invitations,
or any other row, so restore is just "clear the marker" — the questionnaire returns
in whatever lifecycle state it left in. (The version-level `archived` **status** is
a different, unrelated concept: it retires one _version_ of a live questionnaire.)

## API

| Method + path                                 | Effect                               | Audit                   |
| --------------------------------------------- | ------------------------------------ | ----------------------- |
| `DELETE /api/v1/app/questionnaires/:id`       | Archive — stamp `archivedAt = now()` | `questionnaire.archive` |
| `POST /api/v1/app/questionnaires/:id/restore` | Restore — clear `archivedAt`         | `questionnaire.restore` |

Both are **idempotent**: archiving an already-archived questionnaire (or restoring
an already-active one) returns `200` without a second write or a duplicate audit
entry — the handler no-ops on the current-state check, mirroring the rename no-op on
the same route. Both are admin-only (`withAdminAuth`) and inherit the 100/min `api`
section rate cap; neither needs a sub-cap (a single bounded `UPDATE`, no LLM call).

The archive handler lives alongside the detail `GET`/`PATCH` in
`app/api/v1/app/questionnaires/[id]/route.ts`; restore is its own route file at
`[id]/restore/route.ts`. Endpoints are addressed via
`API.APP.QUESTIONNAIRES.byId(id)` (DELETE) and `API.APP.QUESTIONNAIRES.restore(id)`.

## List filter

`listQuestionnaires` (the `_lib/list.ts` read model behind `GET /`) applies an
`archivedAt` gate on **every** call:

- default / `archived=false` → `where.archivedAt = null` (active rows only)
- `archived=true` → `where.archivedAt = { not: null }` (the archived slice)

The query param is a **string enum** (`'true' | 'false'`), not a coerced boolean —
`z.coerce.boolean('false')` is truthy, which would silently invert the default and
leak archived rows into the active list. Every list row (`QuestionnaireListItem`)
and the detail payload (`QuestionnaireDetail`) carry `archivedAt` as an ISO string
or `null`.

Because the default admin list — and therefore any picker built on it — excludes
archived rows, an archived questionnaire drops out of the surfaces that offer it up
for new work without further changes.

## Admin UI

On the questionnaires list (`components/admin/questionnaires/questionnaires-table.tsx`):

- An **Active / Deleted** toggle switches which slice the table shows (independent
  of the `status` filter). The two slices have independent pagination.
- In the Active view, the row-actions menu gains **Delete** (trash icon), which opens
  a confirmation dialog (the soft-delete is reversible, but the row disappears from
  the active list, so a confirm avoids accidental clicks). In the Deleted view the
  only row action is **Restore**.
- Both actions go through the shared `useArchiveQuestionnaire` hook (sibling to
  `useDuplicateQuestionnaire`); on success the table refetches the current page and
  calls `router.refresh()` so the stat tiles update.

The list page's **"Deleted"** stat tile counts soft-deleted questionnaires (a 1-row
`?archived=true` fetch read for its meta `total`) — the one tile that reflects the
soft-delete dimension rather than a `status` tally.

## Version-level archiving — the same pattern, one level down

Individual **versions** carry their own soft-archive, mirroring the questionnaire-level
one: a nullable `archivedAt` on `AppQuestionnaireVersion`, orthogonal to the version's
`status`. Archiving a version (a) tucks it out of the admin version surfaces (the version
picker and the Overview timeline) and (b) **retires it from respondents** — even while its
`status` is still `launched`, an archived version no longer serves anyone. It is restorable
(clear the marker), exactly like the questionnaire-level pair. Keeping the marker orthogonal
to `status` is what makes restore trivial and lets archiving apply to a launched version
with live work (which the terminal `status: 'archived'` transition can't).

> **Why `archivedAt`, not `status: 'archived'`.** The version lifecycle already has an
> `archived` **status**, but that state is _terminal_ (no transition back) and is
> **blocked while the version has live sessions or invitations** (the launch-blocker
> guard in the status route) — which is the very state that triggers a fork. So it's the
> wrong tool for "tidy this old version away": we'd be unable to archive exactly the
> versions we want to, and couldn't restore them if we did. The orthogonal `archivedAt`
> marker sidesteps both problems. The two can coexist (a version could be
> `status: 'archived'` _and_ `archivedAt`-archived); the admin **version list** keys its
> hide/show on `archivedAt`, not `status`.

### The archive-on-fork prompt

Editing a **launched** version forks a fresh draft (see
[`questionnaire-edit-agent.md`](../../admin/questionnaire-edit-agent.md) and `_lib/fork.ts`),
confirmed through the **"Create a new draft version?"** dialog. That dialog now offers an
opt-in checkbox — **"Archive the previous version (v_n_)"** — so the admin can retire the
version they just superseded in the same step. Default off.

The choice rides the existing fork-confirmation protocol as a second request header:

- `x-fork-confirm: confirmed` — the post-dialog retry that actually forks (unchanged).
- `x-fork-archive-source: true` — set only when the checkbox was ticked. `_lib/fork.ts`
  reads it and, **after** the new draft commits, soft-archives the version the fork
  branched from. Absent for every non-interactive caller (seeds/scripts/tests) and for an
  unticked confirm, so the fork path is otherwise unchanged.

### API

| Method + path                                               | Effect                     | Audit                           |
| ----------------------------------------------------------- | -------------------------- | ------------------------------- |
| `POST /api/v1/app/questionnaires/:id/versions/:vid/archive` | Stamp `archivedAt = now()` | `questionnaire_version.archive` |
| `POST /api/v1/app/questionnaires/:id/versions/:vid/restore` | Clear `archivedAt`         | `questionnaire_version.restore` |

Both are admin-only, scoped through `loadScopedVersion` (a cross-questionnaire `:vid`
404s), idempotent (already-in-state → `200`, no write/audit), and inherit the 100/min
section cap. The write + audit are single-sourced in `_lib/version-archive.ts`
(`setVersionArchived`), which the archive-on-fork path calls too. Endpoints:
`API.APP.QUESTIONNAIRES.versionArchive(id, vid)` / `versionRestore(id, vid)`.

### Admin UI

- **Version picker** (`workspace/version-selector.tsx`): archived versions are omitted —
  except the one currently being viewed, so landing on an archived version directly never
  blanks its own switcher.
- **Overview timeline** (`[id]/v/[vid]/page.tsx`): active versions list first, each with an
  **Archive** action; archived versions collapse into an **"Archived versions (_n_)"**
  group with a **Restore** action per row. Both go through the shared `useArchiveVersion`
  hook (sibling to `useArchiveQuestionnaire`), which `router.refresh()`es on success.

### Respondent-facing behaviour — archived versions are retired

An archived version **stops serving respondents**, even though its `status` stays
`launched`. The gate is enforced at every respondent entry point, keyed on `archivedAt`
(not `status`), and returns a distinct code so the surface shows a clear notice rather than
a generic error:

- **Code / message** — `VERSION_ARCHIVED` (HTTP `410 Gone`) +
  _"This questionnaire has been archived and is no longer available."_ Both are exported
  from `lib/app/questionnaire/version-archived.ts` (client-safe) and shared by the routes and
  the boot component.
- **Session create** — all four respondent create paths in
  `questionnaire-sessions/_lib/create.ts` (invitation, frictionless-invite token, authenticated
  walk-up, no-login anonymous) refuse an archived version with `VERSION_ARCHIVED` before any
  write. The admin **preview** path is exempt — an admin may still rehearse an archived version.
- **In-flight turns** — the live turn route (`…/[id]/messages`) refuses with `VERSION_ARCHIVED`
  when the running version is archived (via `buildTurnContext`'s new `versionArchivedAt`),
  exempting `isPreview` sessions. So a respondent mid-session when the admin archives is stopped
  at their next turn; the chat surface (`use-questionnaire-session-stream`) maps the 410 to a
  locked composer + the archived notice.
- **Cross-device resume** — `resolveAnonymousResumeByRef` excludes archived versions (folded into
  its existing generic-404 guard set).
- **Respondent notice** — both respondent surfaces show a dedicated archived screen (their own
  heading, no "Try again") when create returns `VERSION_ARCHIVED`: the no-login boot
  (`anonymous-session-boot.tsx`, an `archived` boot phase) and the authenticated start page
  (`app/(protected)/questionnaires/start/page.tsx`, which branches on `result.code` before its
  generic `StartError`).

> **Consequence at fork time.** Because the archive-on-fork prompt archives the _launched_
> source while the new draft is still a draft, ticking it can leave the questionnaire with no
> launched, non-archived version — i.e. temporarily unavailable to respondents until the new
> draft is launched. The fork dialog's help text calls this out.

Retiring a version this way is distinct from the terminal `launched → archived` **status**
transition (which is blocked while the version has live work); the `archivedAt` marker is the
reversible, always-available way to take a version offline.
