# Admin UI — questionnaire authoring (P2 / F2.1)

The admin surface for browsing and (PR2) editing questionnaires. This doc covers
the **read surface** shipped in F2.1 PR1; the authoring/edit surface and the
version-fork lifecycle land in PR2 and extend this doc.

Every route and page here is gated by `APP_QUESTIONNAIRES_ENABLED`: the API 404s
when off, and the pages call `isQuestionnairesEnabled()` and `notFound()` so a
disabled app is indistinguishable from a missing feature. The nav entry itself is
always registered (it can't be async/DB-driven) — only the destinations are dark.

## Read API

Three admin-only (`withAdminAuth`) GET endpoints under
`app/api/v1/app/questionnaires/`. Paths are addressed via
`API.APP.QUESTIONNAIRES` in `lib/api/endpoints.ts`.

| Endpoint                 | Returns                                                                                            | Read model       |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ---------------- |
| `GET /`                  | Paginated list; each row enriched with its latest version + that version's section/question counts | `_lib/list.ts`   |
| `GET /:id`               | The questionnaire + newest-first version summaries (counts, goal/audience)                         | `_lib/detail.ts` |
| `GET /:id/versions/:vid` | One version's full section→question graph, scoped by **both** ids                                  | `_lib/detail.ts` |

The `lib/app/questionnaire/**` module stays Prisma-free, so these read models live
in the route's `_lib/` directory — the same DB seam as the F1.1 persistence
writer. The view contracts they return (client-safe, ISO-string dates) are in
`lib/app/questionnaire/views.ts`, shared verbatim by the route and the UI.

### No per-row N+1

The list endpoint is the canonical "single enriched list endpoint" the project
rule demands. It never fires a query per row — a **fixed four round-trips
regardless of page size**: one `findMany` (the page), one `count`, and two
`groupBy` sweeps (sections, questions) over the page's latest-version ids. The
detail endpoint rolls up section/question/change counts across a questionnaire's
versions the same way.

### Provenance is stored per field

The ingest merge resolves each `goal` / `audience` field by the
admin-wins-per-field rule (admin-supplied > inferred > pre-existing) and now
**persists** the outcome on the version: `goalProvenance` (a `FieldProvenance`
string) and `audienceProvenance` (a per-field `FieldProvenance` map). The
version-graph endpoint reads these columns straight back, and the UI marks a value
"inferred" when its provenance is `'inferred'` — per audience field, not a single
coarse flag. No read-time derivation from the change log. The provenance
vocabulary is the single-source `FIELD_PROVENANCES` tuple in
`lib/app/questionnaire/types.ts`; `mergeGoalAudience` produces it and `persist.ts`
writes it.

## Read UI

| Page                                     | What it shows                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `app/admin/questionnaires/page.tsx`      | List: debounced title search, status filter, pagination, row click-through to detail            |
| `app/admin/questionnaires/[id]/page.tsx` | Detail: SSR `?v=` version selector, goal/audience with `inferred` badges, section/question tree |

The list page is a thin server component (`serverFetch` the first page → client
`QuestionnairesTable` for search/filter/pagination, model on the orchestration
`AgentsTable`). The detail page is fully server-rendered, including version
switching via the `?v=` query param — no client state. `VersionGraph`
(`components/admin/questionnaires/`) is a pure presentational render of the graph.

The nav entry is registered in `lib/app/admin-nav.ts` via `registerNavSection()`
(seam 4 — no edit to `admin-sidebar.tsx`).

## Tagging (F2.2)

A per-version **tag vocabulary** plus **M:N assignment to questions**, layered onto
the `?edit=1` authoring surface. Every write follows the same F2.1 mutation pipeline
(flag-gate → `withAdminAuth` → scope-404 → `forkVersionIfLaunched` → validate → tx →
P2002→400 → `logAdminAction` → `successResponse(data, { forked })`), so editing a
launched version's tags forks a new draft exactly like a structural edit.

**Endpoints** (under `API.APP.QUESTIONNAIRES`):

| Endpoint                                     | Verb     | Action                                                             |
| -------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `…/versions/:vid/tags`                       | `POST`   | Create a vocabulary tag (`label`, optional `color`).               |
| `…/versions/:vid/tags/:tagId`                | `PATCH`  | Rename / recolour.                                                 |
| `…/versions/:vid/tags/:tagId`                | `DELETE` | Delete (cascades its assignments).                                 |
| `…/versions/:vid/questions/:questionId/tags` | `PUT`    | **Replace-set** assignment (`{ tagIds }`); empty array clears all. |

- **`normalizedLabel`** (trim + collapse-whitespace + lowercase) is the dedup key —
  a duplicate label is a 400 (`asTagConflict` maps the `@@unique` P2002).
- **Cross-version safety:** the assignment route validates every `tagId` against the
  question's version **before** forking (`resolveAssignableTagIds`), so a stray
  cross-version id is a 400 with no orphan draft. After a fork it remaps the
  question id and the tag ids through the fork's id-maps.
- Tags ride on the existing `GET …/versions/:vid` graph (no separate read): the
  version carries a `tags` vocabulary list and each question its assigned `tags`,
  loaded in the same single nested query (no N+1).

**UI** (`components/admin/questionnaires/`): `tag-vocabulary-editor.tsx` (create/
rename/recolour/delete in the version editor), `question-tags-editor.tsx` (a popover
checkbox multiselect firing the replace-set `PUT`), and `tag-chip.tsx` (the shared
coloured pill, used by both the editor and the read-only `version-graph.tsx`).

## Extraction-change review (F2.3)

A dedicated sub-route — `app/admin/questionnaires/[id]/extraction-changes?v=` —
lists a version's editorial change log (the per-version `changeCount` on the detail
page links into it) and lets an admin **revert** any change. See
[`extraction-changes.md`](./extraction-changes.md) for the revert semantics; the
admin-facing shape:

- `GET …/versions/:vid/changes` — newest-first list, filterable by `status`,
  `changeType`, `targetEntityType` (Zod query params). Each row is enriched with a
  **dry-run revert verdict** (`revertable` + `revertBlockedReason` + `revertSummary`)
  so the table can disable the Revert button and explain _why_ before a click.
- `POST …/versions/:vid/changes/:changeId/revert` — revert one change. Scope-404 →
  `409` if already reverted → **dry-run the planner before forking** (`422`
  `REVERT_IMPOSSIBLE` with a typed `reason` on a doomed revert, so no orphan draft)
  → fork a launched version → apply the inverse to the editable version → mark the
  **source** change row `reverted`. Audited as `questionnaire_change.revert`.
- **Reconciliation caveat.** `targetEntityId` is null for section/question edits,
  so an editorial revert matches the change's `afterJson` against the live graph; a
  zero/ambiguous match (or an edit made since) returns a typed reason rather than
  guessing. Merge/split/add-section have no faithful inverse from free-form JSON and
  default to `structural_inverse_unavailable` unless `beforeJson` carries enough to
  reconstruct.
- **Fork-on-launched UX.** A launched-version revert forks a draft and redirects to
  the draft's change log — which is **empty** (forks start a clean editorial
  lineage), while the now-`reverted` source row stays on the original version.

**UI** (`components/admin/questionnaires/extraction-changes-table.tsx`): rows grouped
by change family (prunes / edits / inferences / structural), client-side filters,
before/after JSON blocks, and a single confirm dialog driving the revert mutation
through the shared `authoringMutate` runner (fork-redirect / `router.refresh()`).

## Not yet (F2.4)

Creating a questionnaire is still the F1.1 ingestion endpoint (no UI). Re-ingest
(F2.4) is the remaining P2 work — see the
[development plan](../planning/development-plan.md#p2--admin-crud-over-questionnaires).
