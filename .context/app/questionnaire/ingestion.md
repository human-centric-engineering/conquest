# Questionnaire — document ingestion

> How an uploaded document becomes a populated questionnaire graph. Built by
> **F1.1** ([`../planning/features/f1.1.md`](../planning/features/f1.1.md));
> **API-only** — the review/edit UI is P2. Every surface here is gated by
> `APP_QUESTIONNAIRES_ENABLED` (seeded off).

## The endpoint

`POST /api/v1/app/questionnaires` — multipart upload of one questionnaire
document. Admin-only. Synchronous: the request blocks through parse → LLM
extraction → transactional write, then returns the new ids.

| Field              | In       | Notes                                                                   |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `file`             | required | `.pdf` / `.docx` / `.md` / `.txt`. Extension is the source of truth.    |
| `goal`             | optional | Admin-set goal. Present ⇒ the extractor must **not** infer it.          |
| `audience.<field>` | optional | Dotted keys (`audience.role`, `audience.expertiseLevel`, …). Per-field. |
| `extractTables`    | optional | PDF only — truthy string turns on table extraction.                     |

Empty / whitespace-only `goal` and `audience.*` form values are treated as
**absent** (an un-filled field, not an intentional override).

### Success — `201`

```jsonc
{
  "success": true,
  "data": {
    "questionnaireId": "…",
    "versionId": "…",
    "sectionCount": 4,
    "questionCount": 18,
    "changeCount": 11,
    "goal": "…or null",
    "audience": { "role": "…" }, // or null
    "fieldProvenance": { "goal": "inferred", "audience": { "role": "admin-supplied" } },
  },
}
```

`fieldProvenance` tags each resolved field `admin-supplied | inferred |
pre-existing` (P2-ready; a fresh ingest never produces `pre-existing`).

## The pipeline (order is load-bearing)

`route.ts` runs these in sequence; each can short-circuit with a typed envelope:

1. **Flag gate** — `ensureQuestionnairesEnabled()` first. Off ⇒ `404` (the app is
   indistinguishable from a missing route), before any auth or work.
2. **Auth** — `withAdminAuth`. `401` unauth, `403` non-admin.
3. **Per-admin sub-cap** — `ingestLimiter` (10/min keyed on the admin id). Each
   ingest is ≥1 reasoning-model call, so this is far tighter than the inherited
   100/min `api` section cap (which the middleware already applied). `429` on trip.
4. **Body-size guard** — pre-parse `Content-Length` check, then a post-parse
   `file.size` check. 25 MB cap. `413 FILE_TOO_LARGE`.
5. **Extension allowlist** — `400 UNSUPPORTED_FORMAT` for anything off-list.
6. **Admin metadata** — `parseAdminMetadata` (Zod). `400` on an invalid audience
   field (bad enum, unknown key, non-positive duration).
7. **SHA-256 dedup** — `409 DUPLICATE_DOCUMENT` (with the existing ids) when the
   exact bytes were already ingested. Re-ingest-into-existing-version is **F2.4**;
   F1.1 only surfaces the collision.
8. **Parse** — `parseDocument(buffer, fileName, { extractTables })` directly (not
   the knowledge KB's `previewDocument`/`confirmPreview`, which chunk + embed into
   RAG). `422 PARSE_FAILED` on a parser throw.
9. **Scanned / empty detection** — `422 SCANNED_DOCUMENT` for a PDF whose pages all
   report `hasText: false` (or no extractable text); `422 EMPTY_DOCUMENT` otherwise.
10. **Dispatch** — load the seeded extractor agent, then
    `capabilityDispatcher.dispatch('app_extract_questionnaire_structure', …)` with
    the agent's provider-agnostic binding in `entityContext.extractorAgent`. The
    capability owns the LLM call + cost log; see
    [`../../orchestration/capabilities.md`](../../orchestration/capabilities.md) and
    the F1.1 PR3 notes. Dispatch failures map: `rate_limited → 429`,
    `no_provider_configured`/`provider_unavailable`/`capability_inactive` `→ 503`,
    everything else `→ 502 EXTRACTION_FAILED` (the upstream LLM step failed). The
    underlying capability error code rides in `error.details.capabilityError`.
11. **Coherence check** — `assertPersistable`: every question's `sectionOrdinal`
    must resolve to a declared section. A dangling reference is
    `422 EXTRACTION_INCOHERENT` (with the orphan ordinals) **before** any write —
    never a half-written graph, never a silently-dropped question.
12. **Persist** — `persistIngestion` in one `executeTransaction` (below).
13. **Audit** — `logAdminAction({ action: 'questionnaire.ingest', entityType:
'questionnaire', entityId: versionId, metadata: { counts, fileName, fileHash } })`.

## The extractor capability (the LLM step)

Extraction is a Sunrise **capability** dispatched **programmatically** from the
route (not exposed to a chat tool-loop) — `app_extract_questionnaire_structure`,
an `AppExtractQuestionnaireStructureCapability` in
`lib/app/questionnaire/capabilities/`. Two seeds back it (idempotent, both
inert until the flag is on):

- **Agent** `app-questionnaire-extractor` (`002-extractor-agent`) — empty
  `model`/`provider` (resolves dynamically), a `monthlyBudgetUsd` cap,
  `visibility: 'internal'`, KB access restricted. Carries the provider-agnostic
  binding the route passes through in the dispatch `entityContext`.
- **Capability row** (`003-extraction-capability`) — `executionType: 'internal'`,
  `executionHandler` pointing at the registered class, bound to the agent.

**Novel pattern — an LLM call _inside_ `execute()`.** No built-in Sunrise
capability calls a provider in its `execute()`; this one does, via the
`runStructuredCompletion()` primitive (resolve binding →
`resolveAgentProviderAndModel(agent, 'reasoning')` → `getProvider()` → call →
parse → **retry-once-at-temp-0** → cost-sum). It validates the model's JSON
against the PR2 Zod contract (`ingestion/extraction-schema.ts`) and **fails
loud** — a final parse failure returns a typed error (carrying the Zod issue
paths), never a silent empty result.

**Storage-agnostic.** The capability returns the structured result
(`sections`, `questions`, `inferredGoal?`, `inferredAudience?`, `changes[]`) and
**imports no Prisma** (`lib/app/**` boundary). The route — through `_lib/` —
owns persistence. It is unit-tested by `dispatch()` with a mocked provider;
persistence is tested separately at the route.

**PII + cost.** Questionnaire documents carry PII, so the capability sets
`processesPii = true` and overrides `redactProvenance()` (the registry refuses a
PII capability without it) — durable provenance rows carry counts only, never
document text or source quotes. It logs LLM spend via `logCost()`
(`CostOperation.CHAT`, against the agent id; fire-and-forget, isolated from the
extraction result) → visible in `AiCostLog` / the costs dashboard.

**Provider-agnostic.** Every call routes through `resolveAgentProviderAndModel`
and `getProvider` from the seeded agent's binding — no vendor SDK is imported
anywhere.

See [`extraction-changes.md`](./extraction-changes.md) for how the returned
`changes[]` become the revertible editorial log, and the F1.1 tracker
([`../planning/features/f1.1.md`](../planning/features/f1.1.md), "PR 3") for the
capability's design rationale.

## Persistence (`_lib/persist.ts`)

One transaction, all-or-nothing, writing the full graph:

`AppQuestionnaire` → `AppQuestionnaireVersion` (v1, `draft`, merged
`goal`/`audience`) → `AppQuestionnaireSection[]` (ordinal → id map) →
`AppQuestionSlot[]` (one `createMany`; `versionId` denormalised onto each row,
`sectionId` resolved from the map) → `AppQuestionnaireExtractionChange[]` (the
editorial log; see [`extraction-changes.md`](./extraction-changes.md)) →
`AppQuestionnaireSourceDocument` (file metadata + `extractedText`).

The capability stays **storage-agnostic** (no Prisma import — `lib/app/**`
boundary); this `_lib/` module is the only place the extraction result meets the
database.

### Goal / audience merge (admin-wins-per-field)

`mergeGoalAudience` (`_lib/merge.ts`, pure) resolves each of `goal` and every
audience field independently: **admin-supplied** value if present, else
**inferred**, else **pre-existing**, else absent. A re-ingest never blanks a
field that was already set. Each resolved field's origin is returned as the
`fieldProvenance` tag. Inference the admin suppressed (by supplying that field)
produces no `infer_*` change record — the capability drops it before persist.

### Raw bytes are not stored (F1.1)

`AppQuestionnaireSourceDocument.bytes` stays null in F1.1: no consumer until F2.4
re-ingest, and persisting every upload's bytes is a privacy surface the plan
defers (open question #5). `extractedText` **is** stored — F2.3 verifies source
quotes against it.

## Manual verification

With the flag on and a real dev provider:
`curl -F file=@tests/fixtures/app/questionnaire/sample-questionnaire.md
http://localhost:3000/api/v1/app/questionnaires` (authenticated as admin) →
populated graph + complete change log + `AiCostLog` + `AiAdminAuditLog` rows.
Flag off → `404`. Non-admin → `403`. A scanned PDF → `SCANNED_DOCUMENT`.
