# Questionnaire — document ingestion

> How an uploaded document becomes a populated questionnaire graph. Built by
> **F1.1** ([`../planning/features/f1.1.md`](../planning/features/f1.1.md)); the
> review/edit UI is P2. Admins drive ingestion from the `UploadQuestionnaireDialog`
> on `/admin/questionnaires` (header button + empty-state CTA), which POSTs to the
> endpoint below. Every surface here is gated by `APP_QUESTIONNAIRES_ENABLED`
> (seeded off).

## The endpoint

`POST /api/v1/app/questionnaires` — multipart upload of one questionnaire
document. Admin-only. Synchronous: the request blocks through parse → LLM
extraction → transactional write, then returns the new ids. **Still supported and
tested** (API clients, the F1.1 regression net), but the UI no longer uses it — see
the streaming variant below.

**`POST /api/v1/app/questionnaires/stream`** (the surface the `UploadQuestionnaireDialog`
now uses) runs the identical pipeline over **SSE**. A multi-page PDF's extractor call is
bounded at 120s and the table pass adds to it, which can outrun a synchronous request's
idle timeout; streaming keeps the socket alive (the `sseResponse` bridge emits keepalive
frames on an independent timer) and hands back the draft's ids on a terminal `done` event.
Pre-stream validation (rate-limit, upload guard, demo-client check) still returns a normal
JSON error envelope; once the stream opens, a failure is a terminal `error` event (never a
5xx). Events: `phase` (`extracting` → `verifying` → `repairing` → `saving` — the middle two
only when the verify+repair sub-flag is on), then `done { questionnaireId, versionId, counts }`
or `error { code, message }`. Mirrors `compose/stream`'s `drive()` pattern; the route drives
`orchestrateExtraction` (which wraps the shared `extractFromDocument` + the optional
verify/repair pass) and reuses `parseAndGuardUpload` / `persistIngestion`, so the streaming and
non-streaming endpoints can't drift on the core pipeline. The phase messages the admin sees are
the **real** ones the orchestrator emits (no scripted ticker — `ExtractionProgress`). Event
contract: `lib/app/questionnaire/ingestion/extraction-stream-events.ts`. See
[Streaming ingest + the verify / repair pass](#streaming-ingest--the-verify--repair-pass).

| Field              | In       | Notes                                                                              |
| ------------------ | -------- | ---------------------------------------------------------------------------------- |
| `file`             | required | `.pdf` / `.docx` / `.md` / `.txt` / `.xlsx`. Extension is the source of truth.     |
| `title`            | optional | Questionnaire name. Present ⇒ wins over the document-derived title (≤200 char).    |
| `demoClientId`     | optional | DEMO-ONLY (F2.5.1) — attribute the new questionnaire to this demo client.          |
| `goal`             | optional | Admin-set goal. Present ⇒ the extractor must **not** infer it.                     |
| `instructions`     | optional | Free-text steering for the extractor (≤4 000 char). **Guidance, not suppression.** |
| `audience.<field>` | optional | Dotted keys (`audience.role`, `audience.expertiseLevel`, …). Per-field.            |
| `requiredMode`     | optional | `all` (default) or `source` — how imported questions are marked required.          |
| `extractTables`    | optional | PDF only — **defaults to on**; send an explicit falsy string to force it off.      |

Empty / whitespace-only `title`, `goal`, and `audience.*` form values are treated
as **absent** (an un-filled field, not an intentional override). A `title` over the
200-char cap is `400`. When `title` is absent the server falls back to the parsed
document title, else the filename.

### Requiredness (`requiredMode`)

The upload dialog offers two modes, defaulting to **all required** (the checked-by-default
choice that mirrors create + edit):

- **`all`** (default) — every extracted question is written `required: true`.
- **`source`** — honour the document's own required markers. The extractor reads an asterisk,
  `(required)`, `mandatory`, a "Required" column, etc. into an optional per-question `required`
  flag (`extractedQuestionSchema.required`); questions the source doesn't flag stay optional.

A present-but-unrecognised `requiredMode` is a `400` (it's a client bug, not "infer"). The mode
maps onto the persist writer's `RequirednessPolicy` (`'all' | 'optional' | 'source'`) — see
[Persistence](#persistence-_libpersistts). The same policy backs compose (`requiredAll` toggle) and
the editor's bulk "All questions required" checkbox.

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
   field (bad enum, unknown key, non-positive duration) or an over-cap `title`.
7. **Demo-client existence** — DEMO-ONLY: when `demoClientId` is supplied, a cheap
   `findUnique` pre-check (before the expensive extract) returns
   `404 DEMO_CLIENT_NOT_FOUND` for an unknown id rather than a foreign-key `500` at
   persist time — mirrors the `PATCH …/:id` attribution guard.
8. **SHA-256 dedup** — `409 DUPLICATE_DOCUMENT` (with the existing ids) when the
   exact bytes were already ingested. This is the **global** new-ingest dedup;
   re-ingest-into-an-existing-draft is **F2.4**, which scopes its dedup to the
   target version and short-circuits to a `200` no-op ([`reingest.md`](./reingest.md)).
9. **Parse** — for `.xlsx`, the app-tier `flattenWorkbook(buffer, fileName)`
   (`lib/app/questionnaire/ingestion/xlsx-flatten.ts`); for every other format,
   `parseDocument(buffer, fileName, { extractTables })` directly (not the knowledge
   KB's `previewDocument`/`confirmPreview`, which chunk + embed into RAG). Either
   path yields the same `ParsedDocument` shape. `422 PARSE_FAILED` on a throw. See
   [Spreadsheet ingestion](#spreadsheet-ingestion-xlsx). **Table extraction is on by
   default** (`parseExtractTablesFlag` defaults `true`): a questionnaire's rating
   grids, 1–5 scales, and option lists are usually PDF _tables_, and with table
   parsing off they reach the extractor as scrambled loose text — the classic cause
   of a matrix collapsing into one `multi_choice` or a scale losing its bounds. The
   pass is self-detecting: `applyPageTables` merges rendered tables only where the
   parser actually finds them (`tablesRendered > 0`), so it's a no-op on prose PDFs.
   The dialog checkbox is an **override** (default checked), not a prerequisite the
   admin must know to tick.
10. **Scanned / empty detection** — `422 SCANNED_DOCUMENT` for a PDF whose pages all
    report `hasText: false` (or no extractable text); `422 EMPTY_DOCUMENT` otherwise.
11. **Dispatch** — load the seeded extractor agent, then
    `capabilityDispatcher.dispatch('app_extract_questionnaire_structure', …)` with
    the agent's provider-agnostic binding in `entityContext.extractorAgent`. The
    capability owns the LLM call + cost log; see
    [`../../orchestration/capabilities.md`](../../orchestration/capabilities.md) and
    the F1.1 PR3 notes. Dispatch failures map: `rate_limited → 429`,
    `no_provider_configured`/`provider_unavailable`/`capability_inactive` `→ 503`,
    everything else `→ 502 EXTRACTION_FAILED` (the upstream LLM step failed). The
    underlying capability error code rides in `error.details.capabilityError`.
12. **Coherence check** — `assertPersistable`: every question's `sectionOrdinal`
    must resolve to a declared section. A dangling reference is
    `422 EXTRACTION_INCOHERENT` (with the orphan ordinals) **before** any write —
    never a half-written graph, never a silently-dropped question.
13. **Persist** — `persistIngestion` in one `executeTransaction` (below). The
    resolved `title` and (when supplied) `demoClientId` are written onto the new
    `AppQuestionnaire` row.
14. **Audit** — `logAdminAction({ action: 'questionnaire.ingest', entityType:
'questionnaire', entityId: versionId, metadata: { counts, fileName, fileHash, demoClientId } })`.

## Streaming ingest + the verify / repair pass

The **streaming** ingest surface (`POST …/questionnaires/stream`, the "watch it extract"
dialog) does not call `extractFromDocument` directly — it drives
`orchestrateExtraction` (`_lib/orchestrate-extraction.ts`), an async generator that yields
**real** phase events (`extracting → verifying → repairing → saving`) and returns the same
`PipelineResult` the non-streaming route uses. The non-streaming `POST /questionnaires` and
`reingest` routes keep the single synchronous extractor pass unchanged.

When the **`APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_ENABLED`** sub-flag is on
(`isIngestVerifyRepairEnabled()`, AND-ed with the master flag), the orchestrator inserts a
critic + repair pass between extract and coherence:

1. **Verify** — dispatch `app_verify_extraction_structure` (the Extraction Verifier agent)
   once over all questions + the source. It returns per-question verdicts (`ok` / `suspect`
   - an `issue`) and any detected rating-grid spans. Flags only; never rewrites. Small
     (flags-only) output, so one call stays cheap even for a long questionnaire.
2. **Repair** — only when questions are flagged (and ≤ `REPAIR_FLAG_CEILING = 20`), dispatch
   `app_repair_questions` (the Scales & Matrix Repair Specialist) over the **flagged subset
   only**. It re-reads each source span and returns corrected questions (`action: 'correct'`
   replaces in place; `action: 'merge'` collapses mis-split rows into one matrix).
3. **Merge guard (`mergeRepairs`)** — the "never worse" core: a `correct` is accepted only
   if it keeps the key and its config passes the **tight write schema**; a `merge` only if
   it yields a valid `matrix` from ≥2 originals. Rejected repairs leave the original
   untouched. Accepted repairs append revertible `infer_type` / `augment_question` /
   `merge_questions` change intents. Coherence is then re-checked after the merge.

**Fail-soft throughout:** a missing/failing verifier or repair agent, a repair that doesn't
validate, or > 20 flags (systemic) all fall back to persisting the raw extraction — the
draft is never worse than the single-extractor pass. Both agents seed **disabled** with the
sub-flag; when off, ingestion is exactly today's behaviour. The agents/capabilities are
seeded by `065`–`068`; the flag by `064`. The verifier + repair prompts (load-bearing) live
in `ingestion/verify-prompt.ts` and `ingestion/repair-prompt.ts`; both appear in the Prompt
Library and the "Questionnaire ingestion" workflow diagram (a "Fidelity check & repair"
group). **Scoring of matrix rows is out of scope for v1** — a composite answer contributes
nothing to the numeric `scoring/compute.ts` aggregate (non-crashing); per-row scoring is a
follow-up.

## Live "questions so far" count (extract phase)

Extraction is the longest wait. On the **streaming** surface the extractor's first pass is
run **streamed** so the admin sees a rising count — "…12 questions so far" — instead of one
opaque spinner. The count is real, parsed out of the JSON as it arrives; it is not scripted.

The signal path, outermost to innermost:

1. **Route → pipeline.** `orchestrateExtraction` passes an `onExtractionProgress(count)` sink
   into `extractFromDocument`, which forwards it onto the capability dispatch's
   `entityContext` under the `onExtractionProgress` key (the one documented free-form seam
   from caller to capability). Producer/consumer share the key + narrowing via
   `ingestion/extraction-progress-context.ts` so they can't drift. The non-streaming ingest /
   re-ingest routes pass **no** sink — the presence of the sink is exactly what flips the
   extractor onto the streamed path, so those routes keep their single blocking call.
2. **Capability.** When the sink is present, `extract-questionnaire-structure` runs
   `runStreamingStructuredExtraction` (`ingestion/stream-structured-extraction.ts`) instead
   of the blocking `runStructuredCompletion`: it drives attempt 1 through
   `provider.chatStream`, feeding each text delta to a `createQuestionCountScanner`
   (`ingestion/question-count-scanner.ts`) and calling the sink on each **strict increase**.
   The retry policy is unchanged — one non-streaming temp-0 retry, no echo of malformed
   output, tokens summed across attempts. The scanner is a minimal forward-only JSON state
   machine that counts objects closing directly inside the top-level `questions` array; it is
   **key-anchored** (order-independent) and split-safe (a chunk boundary can fall mid-string
   or mid-escape). It counts, it does not validate — the authoritative parse still runs once
   on the assembled text.
3. **Back out to SSE.** `orchestrateExtraction` bridges the push-based sink into its
   pull-based generator with a tiny queue + one-shot notifier, coalescing a burst of
   callbacks to the latest count, and yields `phase: 'extracting'` events whose `message`
   states the count in prose and whose `progress: { done }` carries it structurally
   (`total` is omitted — the model doesn't know its own count up front). The upload dialog
   already renders `message` verbatim, so the count shows with no client change.

**Requires provider streaming that honours the request timeout.** The extractor bounds its
call at 300 s (`EXTRACTION_TIMEOUT_MS`); the platform `chatStream` now forwards a per-request
`timeoutMs`/`signal` to the SDK create call (mirroring non-streaming `chat`) so a long stream
isn't silently capped at the client's 120 s construction default. That fix is in both
`openai-compatible.ts` and `anthropic.ts` and should be upstreamed to Sunrise.

**Graceful when there's nothing to stream.** A zero-question document, a blocking fallback,
or tool-based (Anthropic json-schema) extraction that streams no countable text simply yields
no progress events — the admin still sees the opener message and the live elapsed timer.

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

### Admin instructions (`instructions`)

A free-text box on the upload + re-ingest dialogs, carried verbatim to the
extractor as `adminProvidedInstructions`. Unlike `goal`/`audience` it does **not**
suppress inference — it is steering the model applies while extracting. Two
canonical uses: telling the agent where the questions live in an unusual layout
("the questions are in the Activities tab, grouped by Subsection"), and
genericising brand terms ("replace every mention of 'HPE' with 'our
organisation'").

`buildExtractionPrompt` injects it inside a fenced `ADMIN INSTRUCTIONS` block
that explicitly states it cannot change the required output format — so a pasted
instruction can't break the JSON contract. The rewrite is **cosmetic**: it
changes the produced question/section text, but the original wording is retained
in each change's `sourceQuote` (the audit trail) and in the persisted
`AppQuestionnaireSourceDocument.extractedText` (the raw parse). It is length-capped
at 4 000 chars (`MAX_INSTRUCTIONS_LENGTH`); over-cap is a `400`. The value is
redacted from durable capability provenance, same as the other admin fields.

## Spreadsheet ingestion (`.xlsx`)

A questionnaire is often authored as a multi-tab workbook — questions on one tab,
section/scoring/metadata on others, wired together by id columns. ConQuest accepts
these without a bespoke per-schema parser: the **only** deterministic step is a
faithful flatten; **all** structural intelligence stays in the extractor agent, so
arbitrarily-organised workbooks are handled by the model, not by hard-coded
assumptions about this or any one layout.

**Flattener** (`lib/app/questionnaire/ingestion/xlsx-flatten.ts`, app-tier,
`exceljs`). `flattenWorkbook()` renders each tab as a `## Sheet: <name>` block
containing a GitHub-flavoured Markdown table — first used row as headers, **every**
used column preserved (id / foreign-key / type / flag columns included, since
those are what let the agent join tabs). It makes no decision about what is a
question. Cells are normalised for table safety (newlines collapsed, `|` escaped,
giant cells capped). A `MAX_FLATTENED_CHARS` budget (~600 k chars) bounds the text
fed to the single extraction call; exhausting it truncates and emits a warning
naming the cut tabs — never a silent drop. Lives app-tier (not the shared KB
parser router) to keep the questionnaire-tuned output out of Sunrise platform code
and avoid a fork.

**Extraction** then runs exactly as for any other document. The prompt builder
detects a spreadsheet by extension (`.xlsx` / `.xls` / `.csv`) and prepends
tabular **heuristics** (not rules): tabs relate through shared id columns; one tab
usually holds the questions while others are supporting data; id/order/weighting
columns are structure not questions; an internal on/off flag column may be mostly
off and is not, by itself, a signal to drop rows; a `type` column is a strong
answer-type hint. The admin `instructions` field overrides any of these per
document.

`.xlsx` is wired into both the upload (`UploadQuestionnaireDialog`) and re-ingest
(`ReingestDialog`) flows; the latter inherits the flatten + instructions path for
free through the shared `parseAndGuardUpload` / `extractFromDocument` helpers
(`_lib/extract-pipeline.ts`). Legacy `.xls` is **not** supported (exceljs reads the
modern OOXML format only) — re-save as `.xlsx`.

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

### Requiredness policy

`writeGraph` resolves each slot's `required` flag from a `RequirednessPolicy`
(`persistIngestion`'s `requiredness` input, default `'all'`):

| Policy       | Slot `required`       | Set by                                                          |
| ------------ | --------------------- | --------------------------------------------------------------- |
| `'all'`      | `true`                | upload `requiredMode=all`; compose `requiredAll≠false`          |
| `'source'`   | `q.required ?? false` | upload `requiredMode=source`                                    |
| `'optional'` | `false`               | compose `requiredAll=false`; refine (`replaceVersionStructure`) |

`writeGraph`'s own default is `'optional'`, so the conversational-refine path
(`replaceVersionStructure`) is unchanged — only `persistIngestion` defaults to
`'all'`. The editor's bulk "All questions required" checkbox writes `required`
directly via `updateMany` (`PATCH …/versions/:vid/questions`), not through this
policy.

### Choice-option normalisation

The extractor's structured-output schema keeps `suggestedTypeConfig` loose
(`z.record(z.string(), z.unknown())`), so a model may shape a `single_choice` /
`multi_choice` question's options however it likes — including a bare string
array (`{"choices":["Never","Once or twice"]}`). Every downstream reader
(`readChoicesConfig`, the interviewer's `choiceOptions`, the admin
`ChoicesEditor`) parses through the **tight** authoring schema, which requires
`choices: [{ value, label }, …]` with ≥2 distinct values — so an unnormalised
string array persists verbatim and then renders as **nothing selectable**.

`writeGraph` closes that gap deterministically: it runs each slot's config
through `normalizeSuggestedTypeConfig(type, raw)`
(`lib/app/questionnaire/ingestion/normalize-type-config.ts`, pure) before
storage. For choice types it coerces every entry into `{ value, label }` (string
→ derive a snake_case `value` from the label; half-object → fill the missing
side; object → pass through), de-dupes colliding values, and drops empties. A
config that yields fewer than 2 usable options, a non-object config, or any
non-choice type is returned untouched (the admin corrects a degenerate list in
the Structure editor). Because both `persistIngestion` (ingest, compose,
compose-stream) and `replaceVersionStructure` (re-ingest) go through
`writeGraph`, this one step covers every extraction path. The prompts
(`extraction-prompt.ts`, `compose-prompt.ts`) also instruct the model to emit the
object shape directly; the normaliser is the belt-and-braces defence since
prompts are probabilistic.

`normalizeSuggestedTypeConfig` also turns a trailing **"Other" escape hatch** into
`allowOther`: an option whose label is "Other", "Other (please specify)", "Prefer to
self-describe", or "Something else" is dropped from the fixed list and the config gets
`allowOther: true` (the form renders its own "Other…" free-text input). It is
deliberately conservative — "Prefer not to say", "None"/"None of the above", and "No
preference" are **real** selectable answers, not escape hatches, and are never touched —
and it never drops below the ≥2-option floor. The prompt asks the model to do this too;
the normaliser makes it reliable.

### Question-type fidelity (matrix, scales)

Two extraction rules in `extraction-prompt.ts` keep the model faithful to richer source
layouts:

- **Rating grid / matrix → one `matrix` question.** A table where several row items share
  one rating scale (a "Factor" column beside `1 2 3 4 5`, or a "Rate each: 1 = … 5 = …"
  instruction over a list) is a **single question of type `matrix`** — its rows are not
  choice options, and it is **not** split into one question per row. The model sets
  `suggestedTypeConfig.rows` to `[{key,label}, …]` (distinct keys) and
  `suggestedTypeConfig.scale` to the shared scale (a likert config — bounds + a `labels`
  array OR `minLabel`/`maxLabel` anchors). The answer is a composite `{ rowKey: point }`
  map in the single `AppAnswerSlot`. `matrix` is a first-class type end to end (form grid,
  admin grid editor, per-row report formatting, per-row analytics distributions); only the
  conversational surface asks it row-by-row. This relies on table extraction (above)
  surfacing the grid as a Markdown table in the first place. Row keys are canonicalised at
  persist by `normalizeSuggestedTypeConfig` (slugify + de-dupe, mirroring choices).
- **Endpoint-anchored scales.** When a 1–5 scale anchors only its ends ("1 — Not at all …
  5 — Very much"), the model stores `min`/`max` + `minLabel`/`maxLabel` **verbatim** and
  does not fabricate middle labels. This is now a first-class, launchable `likert` shape:
  `likertWriteConfigSchema` accepts a scale labelled **either** with a complete per-point
  `labels` array **or** both endpoint labels (`isLikertLabelled`). A fully _unlabelled_
  scale is still rejected (use `numeric`). `hasCompleteLikertLabels` stays stricter — the
  report maps every value to a per-point word — so an endpoint-anchored answer renders as
  `"4/5 — Not at all → Very much"` (`formatSlotAnswer`) rather than a bare number.

### Goal / audience merge (admin-wins-per-field)

`mergeGoalAudience` (`_lib/merge.ts`, pure) resolves each of `goal` and every
audience field independently: **admin-supplied** value if present, else
**inferred**, else **pre-existing**, else absent. A re-ingest never blanks a
field that was already set. Each resolved field's origin is returned as the
`fieldProvenance` tag. Inference the admin suppressed (by supplying that field)
produces no `infer_*` change record — the capability drops it before persist.

### Raw bytes are not stored

`AppQuestionnaireSourceDocument.bytes` stays null. F2.4 re-ingest **re-uploads** a
replacement document rather than diffing against a stored copy, so it added no
consumer either — the column stays reserved, and persisting every upload's bytes
remains a privacy surface the plan defers (open question #5). `extractedText`
**is** stored — F2.3 verifies source quotes against it.

## Manual verification

With the flag on and a real dev provider:
`curl -F file=@tests/fixtures/app/questionnaire/sample-questionnaire.md
http://localhost:3000/api/v1/app/questionnaires` (authenticated as admin) →
populated graph + complete change log + `AiCostLog` + `AiAdminAuditLog` rows.
Flag off → `404`. Non-admin → `403`. A scanned PDF → `SCANNED_DOCUMENT`.
