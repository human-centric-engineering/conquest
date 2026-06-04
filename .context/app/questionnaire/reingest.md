# Questionnaire — re-ingest

> Replacing a **draft** version's source document and re-extracting its structure.
> Built by **F2.4** ([`../planning/features/f2.4.md`](../planning/features/f2.4.md))
> — the last feature of P2. Gated by `APP_QUESTIONNAIRES_ENABLED` (seeded off).
> Builds on the F1.1 ingest pipeline ([`ingestion.md`](./ingestion.md)) and the
> F2.1 scoped-version helpers.

## What it does

An admin who is still authoring a **draft** uploads a _replacement_ document —
they fixed the source, got a newer client revision, or want to re-extract with
table extraction on. The route re-runs the same opinionated extractor and
**replaces that draft's extracted graph + editorial change log** in place. It is
the structure-refresh counterpart to F1.1's create-from-scratch ingest.

## The endpoint

`POST /api/v1/app/questionnaires/:id/versions/:vid/reingest` — multipart upload,
admin-only. Synchronous (parse → LLM extraction → transactional replace). Same
form fields as the F1.1 ingest (`file`, `goal`, `audience.<field>`,
`extractTables`).

### Pipeline (order is load-bearing)

1. **Flag gate** — `404` when `APP_QUESTIONNAIRES_ENABLED` is off (runs first).
2. **`withAdminAuth`** — `401` / `403`.
3. **Per-admin sub-cap** — the shared `ingestLimiter` (10/min, keyed on admin id);
   each re-ingest is ≥1 reasoning LLM call. `429` when exceeded.
4. **Scope-404** — `loadScopedVersion(id, vid)`; `404 NOT_FOUND` when the version
   doesn't resolve under the questionnaire (no cross-questionnaire leak).
5. **Draft-only** — `409 REINGEST_NOT_DRAFT` for a `launched`/`archived` version.
   Re-ingest is a draft editorial operation, **not** a fork (see _Decisions_). This
   is the outer check; the writer **re-asserts draft-ness inside its transaction**
   too, so a concurrent launch during extraction can't slip a launched version
   through (a TOCTOU the outer check alone would leave open).
6. **Guard the upload** — body-size, extension allowlist, admin-metadata, SHA-256.
   Same codes as ingest (`413 FILE_TOO_LARGE`, `400 UNSUPPORTED_FORMAT`, `400` on a
   bad audience field, `400` missing file).
7. **Version-scoped dedup short-circuit** — if the upload is byte-identical to the
   version's **current (most recent) source document** _and_ no admin goal/audience
   override was supplied → `200` `{ deduped: true }`, applied-change counts returned
   unchanged, **no re-extraction, no writes, no audit**. Two scopings matter: it
   matches only the _active_ source doc (a superseded doc's hash still re-extracts,
   so its structure can be restored), and an override is never silently dropped (it
   forces the full re-extract + merge path even for identical bytes).
8. **Parse → extract** — `parseDocument` → scanned/empty detection (`422
SCANNED_DOCUMENT` / `422 EMPTY_DOCUMENT` / `422 PARSE_FAILED`) → extractor
   dispatch (mapped `429` / `502` / `503`) → coherence pre-check (`422
EXTRACTION_INCOHERENT`). Identical to ingest — it is the **shared**
   `_lib/extract-pipeline.ts`.
9. **Transactional replace** — `reingestVersion` (see below).
10. **Audit** — `questionnaire.reingest` (`entityType: questionnaire_version`).
11. **`200`** with the new counts, resolved goal/audience, provenance, and
    `deduped: false`.

### Success — `200`

```jsonc
// Real re-ingest
{ "success": true, "data": {
  "questionnaireId": "…", "versionId": "…",
  "sectionCount": 6, "questionCount": 24, "changeCount": 5,
  "goal": "…", "audience": { … }, "fieldProvenance": { … },
  "deduped": false
} }

// Identical document — no-op short-circuit
{ "success": true, "data": {
  "questionnaireId": "…", "versionId": "…",
  "sectionCount": 6, "questionCount": 24, "changeCount": 5,
  "deduped": true
} }
```

## Replace-in-place semantics

`reingestVersion` (`_lib/reingest.ts`) runs one transaction:

| Step                       | Effect                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| Read current goal/audience | Feeds the merge's **pre-existing** arm (atomic read-then-replace).         |
| Delete change log          | `AppQuestionnaireExtractionChange` for the version.                        |
| Delete sections            | Cascades slots → slot-tag assignments.                                     |
| Delete tag vocabulary      | `AppQuestionTag` for the version (now unreferenced).                       |
| Update version             | Re-merged `goal` / `audience` / provenance. **id / number / status kept.** |
| Write graph                | `writeGraph` — new sections → slots → change log (shared with ingest).     |
| Append source doc          | `writeSourceDocument` — prior source docs are **kept**; newest is active.  |

**Wiped** by a re-ingest: the version's sections, slots, change log, and tag
vocabulary — and therefore any manual authoring edits and tag assignments on that
draft. **Preserved:** the questionnaire title, the version row (id / number /
status), and prior source documents. The UI confirms before calling because the
wipe is destructive.

**Goal/audience** are re-resolved through the admin-wins-per-field merge with the
**pre-existing** arm fed the version's current values, so a re-ingest whose new
extraction infers no goal/audience never blanks a field the version already had
(`fieldProvenance: pre-existing`). An admin-supplied field on the re-ingest form
still wins over both inferred and pre-existing.

## Decisions

- **Replace in place, not a new version.** The fresh extraction overwrites the
  target draft's graph; `versionNumber`/`status` are untouched. (Confirmed at
  planning — matches "against an existing draft version".)
- **Draft-only — `409`, not fork-on-launched.** A launched/archived version is
  pinned; the admin forks or creates a draft first via the F2.1 flows. This is the
  one place F2.4 diverges from the F2.1/F2.2/F2.3 fork-on-launched pattern:
  wholesale re-extraction onto a just-forked copy is heavier and muddier than a
  clean refusal.
- **Version-scoped dedup, against the active source only.** Unlike F1.1's
  **global** `409 DUPLICATE_DOCUMENT`, re-ingest's dedup is scoped to the target
  version's _current_ source doc and short-circuits to a `200` no-op — the same
  hash legitimately recurs across versions, and a superseded doc must still
  re-extract. An admin override defeats the short-circuit so it is never dropped.

## Shared pipeline

F2.4 factored the F1.1 ingest route's "uploaded bytes → validated extraction"
stretch into `_lib/extract-pipeline.ts` (`parseAndGuardUpload` +
`extractFromDocument`) and `writeGraph` / `writeSourceDocument` into
`_lib/persist.ts`. Both the new-ingest route and the re-ingest route consume
them; the **only** per-route differences are the dedup scope (global `409` vs.
version-scoped `200` no-op) and the persistence call (`persistIngestion` creates a
questionnaire; `reingestVersion` replaces a draft). The F1.1 ingest route's
integration tests are the behaviour-preserving regression net for the refactor.

## UI

`components/admin/questionnaires/reingest-dialog.tsx` — a **Re-ingest** action on
the detail page, offered only on **draft** versions. Opens a dialog (file picker +
optional goal override + extract-tables toggle, each with a `FieldHelp` ⓘ) whose
copy states the replace is destructive; the submit button is the confirm.
Multipart, so it `fetch`es a `FormData` body directly (the JSON `authoringMutate`
runner doesn't fit) and `router.refresh()`es on success. An identical upload
surfaces as "nothing changed".

## Not in F2.4

Persisting raw upload `bytes` / diff-against-stored-source (no consumer; the
`AppQuestionnaireSourceDocument.bytes` column stays reserved). Re-ingest of
launched/archived versions (draft-only). Re-ingest as a new version
(replace-in-place).
