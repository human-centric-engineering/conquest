# Generative Authoring — compose a questionnaire from a brief

> "Describe your goal, watch it build." An admin types a plain-English brief and an
> agent composes the whole questionnaire — sections + questions + types — streaming
> it into existence, then refines it conversationally before it lands in the
> Structure editor. The **sibling input path** to document extraction: same
> `extractionSchema` output, same persistence graph, no new Prisma models.

## When this runs vs. document extraction

| Path                     | Input                    | Capability                            | Change log                                               |
| ------------------------ | ------------------------ | ------------------------------------- | -------------------------------------------------------- |
| **Extraction** (F1.1)    | uploaded PDF/DOCX/MD/TXT | `app_extract_questionnaire_structure` | editorial (prune/rewrite/infer)                          |
| **Generative authoring** | a plain-English brief    | `app_compose_questionnaire`           | **empty** — nothing was edited; everything was generated |

Both emit the same contract (`lib/app/questionnaire/ingestion/extraction-schema.ts`)
and persist through the same writer (`persistIngestion` / `writeGraph`), so a
composed questionnaire is indistinguishable downstream from an extracted one.

## Two-phase streaming (the wow moment)

The single LLM call would pop the whole questionnaire into existence at once. The
streaming orchestrator (`lib/app/questionnaire/ingestion/stream-compose.ts`) instead
fans the work out so the admin watches it build — mirroring the data-slot
`generate-stream.ts`:

1. **Outline** — one fast call plans the sections + goal/audience (no questions). Emits `outline`.
2. **Sections** — one structured call per section, in parallel (`SECTION_CONCURRENCY = 4`), each writing only its own questions. Emits `section_done` / `section_error` as each settles.
3. **Terminal** — assemble the structure, **de-duplicate question keys across sections** (parallel calls can collide), `assertPersistable`, then `persistIngestion` creates a new draft questionnaire+version. The route emits `done` with the new ids.

Event lifecycle (`compose-events.ts`): `outline` → (`section_done` | `section_error`)\* → (`done` | `error`). `done` is emitted by the **route** (it owns the terminal persist); the orchestrator emits everything up to it and `error` on a fatal failure (no provider, outline failed).

Every question's `sectionOrdinal` is **forced** to its section's ordinal — never trust the model's self-reported linkage — so the assembled graph always passes coherence.

## Conversational refine

After the draft is persisted, each refine turn POSTs an instruction
("make it shorter", "add a section on pricing") against the draft version. The
`app_refine_questionnaire_structure` capability returns the **full** updated
structure + a one-line summary; `replaceVersionStructure` clears and re-writes the
draft graph in one transaction (the same delete-then-write shape re-ingest uses).

**Guarded to draft versions with no respondent sessions** — a refine never rewrites
a launched/in-flight graph (`loadRefinableStructure` → 409 `REFINE_REQUIRES_DRAFT` /
`REFINE_HAS_SESSIONS`).

## Routes (all gated, admin-only, per-admin `composeLimiter` 20/min)

| Route                                                              | Purpose                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `POST /api/v1/app/questionnaires/compose`                          | Non-streaming JSON → single-shot capability → persist → 201 ids/counts. **API-first.**  |
| `POST /api/v1/app/questionnaires/compose/stream`                   | SSE — the watch-it-build surface; persists at the terminal, `done` carries the new ids. |
| `POST /api/v1/app/questionnaires/:id/versions/:vid/compose/refine` | One refine turn → rewrites the draft graph → updated structure + summary.               |

Gate: `withGenerativeAuthoringEnabled` (master `APP_QUESTIONNAIRES_ENABLED` **and**
sub-flag `APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_ENABLED`) — 404 when off, so a dark
sub-feature looks like a missing route.

## Feature flag

`APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_ENABLED` is a **DB `feature_flag` row**
(seed `035`, disabled by default), not an env var. Toggle it in the admin
feature-flags UI. With it off: the routes 404 and the "Describe your goal" entry
point is hidden — the page is otherwise unchanged.

## Admin UI

- **Entry point** — the list page's single upload button becomes `NewQuestionnaireMenu` (`components/admin/questionnaires/new-questionnaire-menu.tsx`): a "New questionnaire" dropdown with **Upload document** (the existing dialog, driven controlled) + **Describe your goal** (→ `/admin/questionnaires/compose`). The "Describe your goal" item only shows when the sub-flag is on.
- **Compose Studio** — `app/admin/questionnaires/compose/page.tsx` + `components/admin/questionnaires/compose/compose-studio.tsx`: left = brief + refine chat, right = live `StructurePreview`. SSE consumed via `fetch` → reader → `parseSseBlock` (same as `data-slots-review.tsx`). "Open in editor" → the Structure editor.

## Anti-patterns / gotchas

- **Don't dedup composed questionnaires by brief hash** — each generation is intentionally a fresh questionnaire (unlike the upload route's SHA-256 dedup). The brief is hashed only for the synthesized source-document row (`briefSource`).
- **`changes: []` is intentional** — composition has no before-state. The extraction-changes review tab tolerates an empty log.
- **The streamed `done` carries the new ids** — unlike the data-slot stream (which targets an existing version), composition creates the questionnaire at the terminal.
- **Refine returns the full structure, not a diff** — `replaceVersionStructure` rewrites the graph; the model is told to keep kept-question `key`s stable so answers stay aligned (only meaningful once a version has answers, which a draft does not — but it keeps re-keying churn down across refine turns).

## Key files

- Capabilities: `lib/app/questionnaire/capabilities/{compose-questionnaire,refine-questionnaire-structure}.ts`
- Orchestrator + prompts + schemas + events: `lib/app/questionnaire/ingestion/{stream-compose,compose-prompt,compose-schema,compose-events}.ts`
- Route helpers: `app/api/v1/app/questionnaires/_lib/{compose-pipeline,compose-input}.ts`; persist helpers `briefSource` / `replaceVersionStructure` in `_lib/persist.ts`
- Seeds: `prisma/seeds/app-questionnaire/035-generative-authoring-flag.ts`, `036-composer-agent.ts`, `037-compose-capability.ts`, `038-refine-structure-capability.ts`
- Constants/flag: `lib/app/questionnaire/constants.ts`, `feature-flag.ts` (`isGenerativeAuthoringEnabled` / `ensureGenerativeAuthoringEnabled` / `withGenerativeAuthoringEnabled`)
