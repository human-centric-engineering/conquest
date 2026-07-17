# Questionnaire archiving (soft delete)

A questionnaire can be **archived** — hidden from the admin list without deleting
any data — and later **restored** to its exact prior state. This is the app's
"delete" affordance: nothing is destroyed, so an accidental (or reconsidered)
removal is always reversible.

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

- An **Active / Archived** toggle switches which slice the table shows (independent
  of the `status` filter). The two slices have independent pagination.
- In the Active view, the row-actions menu gains **Archive**, which opens a
  confirmation dialog (soft-delete is reversible, but the row disappears from the
  active list, so a confirm avoids accidental clicks). In the Archived view the
  only row action is **Restore**.
- Both actions go through the shared `useArchiveQuestionnaire` hook (sibling to
  `useDuplicateQuestionnaire`); on success the table refetches the current page and
  calls `router.refresh()` so the stat tiles update.

The list page's **"Archived"** stat tile counts archived questionnaires (a 1-row
`?archived=true` fetch read for its meta `total`) — the one tile that reflects the
soft-delete dimension rather than a `status` tally.
