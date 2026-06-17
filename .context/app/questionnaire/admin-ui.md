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

| Page                                              | What it shows                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `app/admin/questionnaires/page.tsx`               | List: summary stat tiles, debounced title search, status filter, pagination, demo-client owner column (DEMO-ONLY) |
| `app/admin/questionnaires/[id]/v/[vid]/page.tsx`  | **Overview** tab — status, launch readiness, quick actions, version timeline                                      |
| `app/admin/questionnaires/[id]/v/[vid]/structure` | **Structure** tab — goal/audience with `inferred` badges, section/question tree/editor                            |

The list page is a thin server component (`serverFetch` the first page → client
`QuestionnairesTable` for search/filter/pagination, model on the orchestration
`AgentsTable`). `VersionGraph` (`components/admin/questionnaires/`) is a pure
presentational render of the graph.

The nav entry is registered in `lib/app/admin-nav.ts` via `registerNavSection()`
(seam 4 — no edit to `admin-sidebar.tsx`).

## Workspace layout (tabbed)

The questionnaire detail surface is a **tabbed workspace**, not a single page. The
version is a **path segment** — `app/admin/questionnaires/[id]/v/[vid]/…` — because
a Next.js layout can read `params` but never `searchParams`, and the shared layout
must render the version selector and highlight the active version against `[vid]`.

```
/admin/questionnaires/[id]                  → redirector → newest version's Overview (honours ?v=)
/admin/questionnaires/[id]/v/[vid]          → Overview tab (default landing)
            …/v/[vid]/structure             → Structure (goal/audience + sections/questions/tags; editor/graph, ?edit=1 toggle)
            …/v/[vid]/data-slots            → (flag: data-slots)
            …/v/[vid]/invitations           → questionnaire-scoped; vid ignored, targets newest launched
            …/v/[vid]/analytics
            …/v/[vid]/evaluations[/[runId]] → (flag: design-evaluation)
            …/v/[vid]/extraction-changes
            …/v/[vid]/settings              → questionnaire Name (rename) + run-time Configuration (F3.1, version-scoped, fork-on-launch) + demo-client attribution + clone (DEMO-ONLY)
```

- **`[id]/v/[vid]/layout.tsx`** owns the breadcrumb, sticky header (title + status +
  `VersionSelector`), and the `QuestionnaireSubNav` tab bar. It resolves the detail
  and feature flags **once** via `lib/app/questionnaire/workspace-data.ts` and
  `notFound()`s when the master flag is off, the questionnaire is missing, or `[vid]`
  isn't a real version. Switching version preserves the active tab segment.
- **`workspace-data.ts`** wraps the detail / graph / data-slot-count fetchers in
  React `cache()` so the layout and the active tab share one HTTP call per render
  (`serverFetch` is `no-store`). `resolveQuestionnaireWorkspaceFlags()` resolves all
  workspace flags in one `Promise.all` (sub-flags ANDed with the master), instead of
  the layered per-helper re-queries in `feature-flag.ts`.
- **`workspace-nav.ts`** is the declarative tab registry; `visibleWorkspaceTabs(flags)`
  filters by flag (Data slots / Evaluations hidden when their sub-flag is off — the
  master flag is already enforced by the layout). Each moved tab keeps its own
  `notFound()` flag gate as defense-in-depth.
- **Legacy routes** (`[id]`, `[id]/{analytics,data-slots,extraction-changes,evaluations,invitations}`)
  are thin **redirectors** that resolve `?v=` (or the newest version) and forward to
  the path-segment URL, so old bookmarks and the editor's fork-redirect keep working.

### Structure editor — bulk requiredness

The editing band (`components/admin/questionnaires/version-editor.tsx`, shown under
`?edit=1`) carries an **All questions required** tri-state checkbox: checked when every
question is required, unchecked when none are, indeterminate (a dash) when mixed —
derived from the live `sections` graph, the dash set on the native input via a `ref`
(the project's `Checkbox` has no `indeterminate` prop). Toggling it bulk-sets every
question in one call — `PATCH /api/v1/app/questionnaires/:id/versions/:vid/questions`
`{ required }` → `updateMany` — routed through the same `run` runner as every other
edit, so it forks a launched version and redirects to the new draft. Per-question
`Required` switches (`question-editor.tsx`) still work independently. New questions and
questionnaires default to required (the import radio / compose checkbox); this checkbox
is the after-the-fact bulk lever.

The list and demo-clients surfaces wear a scoped **app identity** — accent tokens
(`.cq-surface` in `globals.css`), applied by the `app/admin/questionnaires/layout.tsx`
and `app/admin/demo-clients/layout.tsx` wrappers and used by
`components/admin/cq-stat-tiles.tsx`. Scoped so orchestration and the rest of
`/admin` are untouched; typography stays on the platform's default sans.

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

A workspace tab — `app/admin/questionnaires/[id]/v/[vid]/extraction-changes` (the
**Changes** tab) — lists a version's editorial change log (the per-version
`changeCount` on the Overview tab links into it) and lets an admin **revert** any
change. See
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

## Re-ingest (F2.4)

A **Re-ingest** action in the **Structure** tab header — offered only on **draft** versions —
uploads a replacement document and **replaces that draft's structure, change log,
and tags** with a fresh extraction. `components/admin/questionnaires/reingest-dialog.tsx`
(file picker + optional goal override + extract-tables toggle, each with
`FieldHelp`) states the replace is destructive; the submit button is the confirm.
An identical document short-circuits to a no-op. Full behaviour — replace-in-place
semantics, the draft-only `409`, and the version-scoped dedup — is in
[`reingest.md`](./reingest.md).

Creating a _new_ questionnaire is still the F1.1 ingestion endpoint (no UI). With
re-ingest shipped, an admin can ingest, review, edit, tag, version, and re-ingest
a questionnaire end-to-end through the UI — **P2 is complete**.

## Prompt library — read the real prompts

`/admin/questionnaires/prompts` is a **read-only** transparency surface: every
questionnaire AI agent paired with the exact prompt(s) it sends to the model.

It exists because **most** questionnaire agents are dispatched **programmatically** — the
load-bearing system prompt is assembled in a TypeScript builder (e.g.
`buildAnswerExtractionPrompt`), **not** read from the agent's editable
`AiAgent.systemInstructions` field. For those agents that field is descriptive only;
editing it in the platform agent form changes nothing at run time. The prompts were
therefore invisible to an operator. This page closes that gap by invoking each real
builder with **placeholder inputs** (`{{ questionnaire goal }}`, `{{ question 1 }}`, …)
and rendering the messages verbatim — the tokens make clear it's the prompt _shape_,
filled at run time with the real questionnaire + transcript, not example data.

**Exception — the Question Selector.** It runs through `streamChat`, so its
`systemInstructions` **are** its system prompt (load-bearing — editing it changes
selection). Its catalog entry sets `instructionsAreLoadBearing: true`, and the UI flips
the per-agent note accordingly. Only its per-turn **user** message is code-built (by
`buildSelectorPrompt`).

- **Catalog** — `app/api/v1/app/questionnaires/_lib/prompt-catalog.ts`. Pure,
  server-only. `buildPromptCatalog()` returns one entry per agent (authoring · live ·
  evaluation stages), each with one or more **specimens** — a named builder invocation
  (e.g. the answer extractor's _question_, _data-slot_, _sensitivity_, and _seriousness_
  variants). Each specimen is built behind a try/catch, so one bad sample renders an
  inline error instead of 500ing the page. The seven evaluation judges are generated
  from `EVALUATION_DIMENSION_SPECS` (same source the panel uses), so they can't drift.
- **API** — `GET /api/v1/app/questionnaires/prompts` (`API.APP.QUESTIONNAIRES.prompts`).
  `withQuestionnairesEnabled(withAdminAuth(...))`. Merges the catalog with each agent's
  seeded `AiAgent` row (provider/model binding, budget, the inert stored instructions)
  and returns `{ agents }`. `resolvesAtRuntime` is true when provider+model are empty
  (the agent-resolver picks at run time); `seeded: false` when no row exists.
- **UI** — `components/admin/questionnaires/prompt-library.tsx`. Stage-grouped
  master/detail: a rail of agents, a detail pane with the binding strip, a per-agent note
  that reflects `instructionsAreLoadBearing` (stored instructions are _not_ the prompt for
  the code-built agents; _are_ the system prompt for the selector), and the prompt rendered
  as a system/user **transcript** in monospace with per-message + copy-all actions.

When a builder's input contract changes and a sample no longer satisfies it, the
specimen renders an error and `tests/unit/app/api/v1/app/questionnaires/_lib/prompt-catalog.test.ts`
fails — surfacing the drift before an admin sees a broken prompt. To add an agent or a
variant, add a `specimen(...)` (or a catalog entry) in `prompt-catalog.ts`; the API,
page, and UI pick it up with no other change.
