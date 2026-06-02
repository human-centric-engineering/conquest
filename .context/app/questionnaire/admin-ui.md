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

## Not yet (PR2 onward)

Creating a questionnaire is still the F1.1 ingestion endpoint (no UI). Editing
structure, the `forkVersionIfLaunched` lifecycle, tagging (F2.2), extraction-change
review/revert (F2.3), and re-ingest (F2.4) are the remaining P2 work — see
[`../planning/features/f2.1.md`](../planning/features/f2.1.md) and the
[development plan](../planning/development-plan.md#p2--admin-crud-over-questionnaires).
