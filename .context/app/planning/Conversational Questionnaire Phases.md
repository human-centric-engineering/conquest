# Agentic Sunrise — Conversational Questionnaire Platform

## Phased Implementation Prompts

A set of prompts to feed to Claude Code in the CLI, one per phase. Each prompt asks Claude to **produce an implementation plan** for the phase — not to write code directly. Review and approve the plan before asking Claude to implement it.

## What this is

This document specifies a conversational questionnaire platform built **on top of Sunrise** — Anthropic's provider-agnostic agentic application platform. Admins upload questionnaire documents (PDF/DOCX/MD); an agent extracts questions and sections; end users complete the questionnaire through a streaming conversation rather than form-filling; the LLM extracts, infers, and synthesises answers with confidence scores and provenance; admins can view analytics, manage versions, and export results.

**Sunrise is provider-agnostic.** It runs against whatever LLM provider the prospect already uses or wants to use — Anthropic's Claude, OpenAI, Google, open-weights via OpenRouter, or any other provider Sunrise's `AiProviderModel` table knows how to address. Nothing in this platform locks to a single vendor; the conversational agent, the extractors, and the seven design-time evaluation judges all resolve their model through Sunrise's provider manager at runtime.

## Two audiences, one codebase

This platform serves two purposes simultaneously, and every implementation decision should preserve both:

**1. A sales-demo vehicle.** The platform is the artefact John & Simon use to demonstrate **Agentic Sunrise's capability** to prospects — consultants, survey-using businesses, anyone curious about what agentic LLM applications can do beyond chat-bot demos. A prospect should be able to see their own brand, their own questionnaire content, and their own users completing it within an hour of the discovery call. The demo also unlocks adjacent opportunities — questionnaires are the first vertical, but the patterns (per-turn orchestration, design-time evaluation, conversational extraction with provenance) generalise to intake forms, compliance reviews, structured interviews, customer onboarding, and any other domain where structured data is collected through unstructured conversation.

**2. A project starter.** When a prospect signs an engagement to build a real product in this style, the platform forks into the starting point for that project. The fork-readiness story is therefore non-negotiable: architectural seams are clean, demo-only code is marked, public-API discipline (the zero-touch rule below) ensures the fork inherits a clean upgrade path to future Sunrise versions, and the fork-procedure documentation (Phase 9's `forking.md`) tells the inheriting team exactly what to keep, what to replace, and what to evaluate.

These two purposes pull in slightly different directions — demo-readiness wants brand polish and predictable flows; fork-readiness wants extensibility and minimal demo-cruft. The phases below address both. Where a single decision serves only one purpose, this document marks it explicitly with the `// DEMO-ONLY:` convention (see ground rule 13) so a fork knows what to strip.

## Reuse beyond questionnaires

Some of what this platform builds is questionnaire-specific. Some of it is reusable across any agentic-application domain. Forks and follow-on demos should understand the boundary.

**Questionnaire-specific (rename or rebuild for a non-questionnaire fork):**

- The Prisma schema's `AppQuestionnaire`, `AppQuestionSlot`, `AppAnswerSlot`, `AppQuestionnaireSession` and related models
- The extraction capability (`app_extract_questionnaire_structure`) — designed to parse questionnaire-shaped source documents
- The answer extractor capability (`app_extract_answer_from_message`) — extracts answers into question slots
- The selection strategies — `Sequential | Random | Weighted | Adaptive` — operate on questions
- The user-facing split-screen UI with the answer-slot panel — designed for questionnaire completion

**Genuinely reusable (carry forward to non-questionnaire forks):**

- The per-turn orchestrator pattern (Phase 6) — applies to any conversational structured-data-collection domain
- The design-time evaluation pattern (Phase 5) — applies to any structured artefact the admin wants reviewed against a stated goal and audience; consumes Sunrise's agents-as-judges infrastructure with one judge per analysis dimension
- The demo tenancy + theming module (Phase 2.5) — applies to any demo platform
- The change-record review-and-revert pattern (Phase 1's extraction changes) — applies to any LLM-produced output the admin wants to audit
- The suggestion review-and-accept pattern (Phase 5's evaluation suggestions) — applies to any LLM-produced recommendation surface
- The tag-and-analytics-filter pattern (Phases 2 and 8) — applies to any taggable entity
- The audit log, cost-tracking, feature-flag, and versioning patterns — these are Sunrise primitives consumed throughout

When a real client engagement forks this platform, the inheriting team reads Phase 9's `forking.md` to understand which modules to keep verbatim, which to rename, and which to replace.

---

## The zero-touch rule — read this first, and every time

**The prototype must never modify any Sunrise core or Sunrise orchestration file. Ever.**

This is the single most important rule in this document. It is not a style preference and it is not negotiable.

### Why this rule exists

This prototype is a **child project**. Sunrise — both its core and its orchestration layer — is a base platform that evolves on its own track. Improvements to Sunrise are made **upstream, on the base platform**, and then pulled into child projects like this one as the platform releases new versions. If this prototype modifies Sunrise files, those modifications become merge-conflict liabilities every time Sunrise releases an update, the segregation collapses, and the entire fork-and-pull strategy breaks.

### What this means in practice

The rule has three consequences, each of which is a primary deliverable of this work:

1. **Additive only.** Every file the prototype creates lives in a path that Sunrise will never touch in its own development. The prototype never edits, deletes, renames, or refactors a Sunrise file — not even trivially, not even to "just add one line."

2. **Sunrise is consumed via its public surface only.** Capabilities, agents, workflows, audit log, cost log, embedding generation, email recipes, PDF rendering, document parsers, evaluation harness, voice routing, auth, response helpers, UI components — every Sunrise primitive is consumed through Sunrise's existing service/API/component entry points. Never by reaching into Sunrise's internal data structures, internal registries, internal files, or internal types not exported publicly.

3. **Every need for a Sunrise change is a finding that gets flagged for the base platform — it is not a problem and it is not an excuse to edit Sunrise.**

   This is the most important consequence. During this work, the prototype **will** discover places where Sunrise core or orchestration does not yet expose a clean public API for what the prototype needs. **This is expected. This is valuable. This is the work.**

   Every such discovery must be:
   - **Captured explicitly** in section (c) of the phase plan ("Sunrise changes this phase requires").
   - **Framed as an upstream feature request** — a clear, specific, actionable description of what Sunrise core or orchestration should expose, written so the Sunrise team (which may be the same person, on a different day, with a different hat on) can implement it on the base platform.
   - **Worked around in the prototype's own code** with a documented, acceptable, time-bounded workaround that holds until the upstream Sunrise change lands.
   - **Never silently resolved by editing Sunrise.**

   These flagged findings are the single most valuable artefact this prototype produces for the base platform. They are the shopping list of improvements that, once made upstream, let every future child project rely on a cleaner public API. Treat them as deliverables of equal importance to the prototype's own features.

### The escalation rule

If you find yourself reasoning "this is small / this is trivial / this is just one line / it would be easier to just edit the Sunrise file" — **stop**. That reasoning is the failure mode this entire rule exists to prevent. The size of the edit is irrelevant. A one-line edit to a Sunrise file breaks the fork-and-pull strategy exactly as completely as a hundred-line edit. There is no Sunrise edit too small to flag.

If at any point during planning or implementation you are about to touch a Sunrise file, stop, document the finding in section (c), propose the upstream request and the app-side workaround, and continue without making the edit.

### Sunrise-owned vs app-owned — the inventory

These mappings reflect the actual Sunrise layout (Next.js 16 App Router, Prisma 7, single `schema.prisma`, top-level `tests/`, route groups `(auth)` / `(protected)` / `(public)`):

| Sunrise owns (read-only from the prototype)                                                                                                                                                                                                                                                                                                       | App owns (the prototype's territory)                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/orchestration/**`, `lib/auth/**`, `lib/api/**`, `lib/audio/**`, `lib/email/**`, `lib/embed/**`, `lib/feature-flags/**`, `lib/db/**`, `lib/storage/**`, `lib/security/**`, `lib/validations/**`, all other existing `lib/*/` modules                                                                                                          | `lib/app/questionnaire/**` (and `lib/app/**` for any future app modules)                                                                                                                                                                                                                                                                                                             |
| `app/api/v1/admin/**`, `app/api/v1/chat/**`, `app/api/v1/embed/**`, `app/api/v1/inbound/**`, `app/api/v1/invitations/**`, `app/api/v1/mcp/**`, `app/api/v1/orchestration/**`, `app/api/v1/users/**`, `app/api/v1/user/**`, `app/api/v1/webhooks/**`, `app/api/v1/contact/**`, and `app/api/auth/**`, `app/api/health/**`, `app/api/csp-report/**` | `app/api/v1/app/**` (new top-level segment exclusively for app code)                                                                                                                                                                                                                                                                                                                 |
| `app/admin/overview/**`, `app/admin/users/**`, `app/admin/orchestration/**`, `app/admin/features/**`, `app/admin/logs/**`, `app/admin/layout.tsx`, `app/admin/page.tsx`, all other existing `app/admin/*` subdirectories                                                                                                                          | `app/admin/questionnaires/**` (new sibling under the existing `app/admin/` tree — the prototype does not create an `app/admin/app/` sub-namespace)                                                                                                                                                                                                                                   |
| `app/(auth)/**`, `app/(protected)/profile/**`, `app/(protected)/settings/**`, `app/(protected)/dashboard/**`, `app/(public)/**` — all existing route groups and their contents                                                                                                                                                                    | `app/(protected)/questionnaires/**` (new subdir under the existing `(protected)` route group, since end-user questionnaire pages require auth)                                                                                                                                                                                                                                       |
| `app/layout.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`, `app/error-handling-provider.tsx`, `app/globals.css`, `app/sitemap.ts`, `app/robots.ts`                                                                                                                                                                           | (no app changes; the prototype cannot modify root layouts)                                                                                                                                                                                                                                                                                                                           |
| `prisma/schema.prisma` (single-file schema — `prismaSchemaFolder` is NOT enabled), `prisma/migrations/**` (existing migrations), `prisma/seed.ts`, `prisma/runner.ts`, `prisma/seeds/*.ts` (top-level seed files), `prisma/seeds/data/**`, `prisma.config.ts`                                                                                     | The prototype's own schema content must land somewhere — see the "Prisma strategy" section below. Sunrise migrations are additive-only; the prototype adds new timestamped migration directories under `prisma/migrations/` for its own schema additions, since `prisma migrate dev` cannot place them elsewhere. The prototype adds new seed files — see the "Seeds" section below. |
| `.context/orchestration/**`, `.context/admin/**`, `.context/api/**`, `.context/architecture/**`, `.context/database/**`, `.context/auth/**`, `.context/email/**`, `.context/environment/**`, `.context/testing/**`, `.context/ui/**`, all other existing `.context/*` namespaces                                                                  | `.context/app/questionnaire/**` (new sibling namespace)                                                                                                                                                                                                                                                                                                                              |
| `components/admin/admin-sidebar.tsx` (the sidebar `navSections` array is hardcoded — see "Admin sidebar gap" below), `components/admin/admin-header.tsx`, `components/admin/**` overall                                                                                                                                                           | `components/app/questionnaires/**` (if the prototype needs shared components across its admin and user pages)                                                                                                                                                                                                                                                                        |
| `tests/unit/**` mirroring `lib/`, `tests/integration/api/v1/**` mirroring `app/api/v1/**`, `tests/setup.ts`, `tests/helpers/**`, `tests/mocks/**`                                                                                                                                                                                                 | `tests/unit/lib/app/questionnaire/**` (mirror of `lib/app/questionnaire/`), `tests/integration/api/v1/app/**` (mirror of `app/api/v1/app/`), `tests/integration/app/admin/questionnaires/**` and `tests/integration/app/(protected)/questionnaires/**` for page-level integration tests                                                                                              |
| `package.json`, `tsconfig.json`, `next.config.js`, `eslint.config.mjs`, `tailwind.config.ts`, `vitest.config.ts`, `postcss.config.js`, `proxy.ts`, `Dockerfile*`, `docker-compose*.yml`, `nginx.conf`, `.env`, `CLAUDE.md` at repo root, `README.md`, all other root config files                                                                 | (no app changes — every root config file is Sunrise-owned; new deps, new path aliases, new ESLint rules, new test config all become upstream findings)                                                                                                                                                                                                                               |
| `components/admin/**`, `components/ui/**`, `hooks/**`, `emails/**`, `scripts/**`, `proxy.ts`, `types/**`                                                                                                                                                                                                                                          | (no app changes to these directories — but the prototype can import from `components/ui/**` (shadcn primitives) and from `hooks/**` freely as a consumer)                                                                                                                                                                                                                            |

If a path you need to write to doesn't fit the right-hand column, you've hit an upstream finding — capture it in section (c) of the phase plan, do not edit the Sunrise file.

### Prisma strategy

**`prismaSchemaFolder` is NOT enabled in Sunrise** — `prisma.config.ts` points at a single `prisma/schema.prisma` and the generator block does not list it as a preview feature. The prototype cannot place its models in a separate `prisma/schema/*.prisma` file without first having Sunrise enable multi-file schema, which would require editing `prisma.config.ts` and `prisma/schema.prisma`'s generator block — both Sunrise-owned files.

**This is an unavoidable upstream finding.** Phase 0's section (c) must capture it as the first item. The proposed upstream change is: enable `prismaSchemaFolder` in `prisma/schema.prisma` and migrate the file to a folder layout, so child projects can drop their own `.prisma` files alongside.

**Until the upstream change lands**, the prototype's only option is an acknowledged-cost workaround: define the prototype's models in a discrete, well-commented section at the bottom of `prisma/schema.prisma`. This _does_ touch a Sunrise file. It is the smallest possible touch — additive only, contained in a single labelled region, easy to lift out into a separate file when Sunrise enables `prismaSchemaFolder`. It is a temporary breach of the zero-touch rule made deliberately and visibly, **not** silently. Section (c) of Phase 0's plan must document this breach with a clear migration path away from it.

If you prefer not to breach zero-touch even temporarily, the alternative is to halt the prototype until Sunrise enables `prismaSchemaFolder`. Surface the choice to the operator in Phase 0's plan — do not decide unilaterally.

### Prisma cross-model relations

Sunrise's `User` model in `prisma/schema.prisma` declares ~30 explicit reverse-relation fields (`aiAgents AiAgent[]`, `aiWorkflows AiWorkflow[]`, etc.). Adding a proper Prisma `@relation` from a new app model to `User` would require adding a reverse-relation field on `User` — another Sunrise edit.

**Workaround for cross-model references to Sunrise tables:** use a plain `String` foreign-key column without a Prisma `@relation` declaration (e.g. `userId String?` rather than `user User? @relation(...)`). The foreign-key integrity is enforced at the database level via a manual `@db.VarChar(...)` and an index, not by Prisma's relation machinery. Referential cascades are written by hand in the migration SQL. This is a known cost — the prototype accepts losing Prisma's typed `session.user` traversal in exchange for not editing Sunrise's schema. Section (c) must flag this.

### Seeds

Sunrise's seed runner in `prisma/runner.ts` reads the **non-recursive** `prisma/seeds/` directory and matches the strict filename pattern `^\d{3}-[a-z0-9-]+\.ts$`. Subdirectories are not discovered. The prototype's seeds therefore cannot live in `prisma/seeds/app/`.

**Workaround:** the prototype owns a separate seed script at `scripts/app/seed-questionnaire.ts` invoked manually via a new package.json script — but `package.json` is Sunrise-owned. So:

- **Preferred path (zero-touch):** the prototype's seed file lives at `lib/app/questionnaire/seeds/run.ts` (a plain TypeScript file, not a `prisma/seeds/` file) and is invoked by the operator via `tsx lib/app/questionnaire/seeds/run.ts` documented in `.context/app/questionnaire/README.md`. It uses the same `prisma` client and the same `SeedUnit` shape Sunrise uses internally so it could be lifted into `prisma/seeds/` once Sunrise enables recursive discovery. The `db:seed` script (Sunrise-owned `package.json`) will not run it; the operator runs it separately.

- **Upstream finding:** Sunrise should make the seed runner recursive — read `prisma/seeds/**/*.ts` rather than `prisma/seeds/*.ts` — and update the filename pattern to allow a per-app prefix (e.g. `app-questionnaire/001-extraction-agent.ts`). Once that lands, the prototype's seeds migrate into `prisma/seeds/app-questionnaire/` and run automatically with `db:seed`.

### Capability registration

`capabilityDispatcher.register(new MyCapability())` is a real, importable, public API at `lib/orchestration/capabilities/dispatcher.ts`. The prototype subclasses `BaseCapability` from `lib/orchestration/capabilities/base-capability.ts`, instantiates, and calls `register()` — no Sunrise file edits required for the registration mechanism itself.

**However**, Sunrise's `registerBuiltInCapabilities()` in `lib/orchestration/capabilities/registry.ts` is called once at module load by Sunrise's own startup (the chat handler imports it). There is no documented child-project hook that runs at app startup. The prototype's own capabilities must therefore be registered from somewhere that's guaranteed to run before any agent dispatch.

**Workaround:** the prototype creates `instrumentation.ts` at the repo root if Sunrise doesn't already have one, OR — if Sunrise does have one — the prototype must flag an upstream finding asking Sunrise to expose a plugin point. Confirm in Phase 0 whether `instrumentation.ts` already exists at the repo root. If it doesn't, the prototype creates it as an app-owned file containing the registration calls; if it does, Sunrise already owns it and the prototype either (a) accepts a smallest-possible breach to add app-registration calls, or (b) waits for an upstream plugin-point change.

### Agent and workflow registration

Despite earlier framing in this document, **Sunrise does not expose a public "agent-creation API" or "workflow-creation API" as separate services.** Sunrise's own seeds and admin route handlers create agents and workflows by writing to Prisma directly: `prisma.aiAgent.create(...)` and `prisma.aiWorkflow.create(...)`. The shape of these writes (columns, JSON payloads, version snapshots) is the public contract — Claude Code should grep `prisma/seeds/006-quiz-master.ts`, `prisma/seeds/004-builtin-templates.ts`, and `app/api/v1/admin/orchestration/agents/route.ts` to see the canonical creation pattern and follow it exactly.

The prototype's seeds therefore call `prisma.aiAgent.create()` and `prisma.aiWorkflow.create()` directly. This is correct and Sunrise-pattern-conformant — not a zero-touch violation, because writing rows to a Prisma table is a runtime operation, not a Sunrise source-file edit.

### Embedding

Embedding is a direct function call to `embedText()` or `embedBatch()`, exported from `lib/orchestration/knowledge/embedder.ts`. There is no capability indirection. The prototype imports the function and calls it.

### Document parsing

`parseDocument(buffer, fileName)` from `lib/orchestration/knowledge/parsers/index.ts` is the public entry point. Supports `.pdf`, `.docx`, `.md`, `.txt`, `.csv`, `.epub`. PDFs are flagged via `PREVIEW_REQUIRED_EXTENSIONS`. Returns a `ParsedDocument` with structured sections.

### Audit log

`logAdminAction(entry)` from `lib/orchestration/audit/admin-audit-logger.ts` is the public entry point. Fire-and-forget. Pass `{ userId, action, entityType, entityId?, entityName?, changes?, metadata? }`. The prototype calls this from app-owned route handlers — no Sunrise file edits.

### Streaming chat

`streamChat` from `lib/orchestration/chat`, `sseResponse` from `lib/api/sse`, `withAuth` from `lib/auth/guards` — all public, all importable. The prototype's `/api/v1/app/questionnaire-sessions/:id/messages` route uses the same pattern as `app/api/v1/chat/stream/route.ts` — read that file to see the canonical SSE shape.

### Voice / audio transcription

**Sunrise ships full voice-input infrastructure on both its admin and embed chat surfaces.** `lib/orchestration/llm/provider-manager.ts` exposes `getAudioProvider()` which picks the first audio-capable provider with an open circuit breaker. `POST /api/v1/admin/orchestration/chat/transcribe` and `POST /api/v1/embed/speech-to-text` are the existing transcription endpoints. The `useVoiceRecording` React hook owns the `MediaRecorder` lifecycle (runtime MIME selection, auto-stop, elapsed-time tracking, clean teardown) and `<MicButton>` wires it into a chat-input bar. `CostOperation = 'transcription'` is the existing cost-log shape with per-minute Whisper pricing. The platform consumes all of this directly — it does NOT build a parallel transcription endpoint or recording state machine. The platform's `/messages` route accepts multipart audio, calls `getAudioProvider()` and `provider.transcribe()` itself rather than going through Sunrise's admin endpoint (because the platform's auth context is different from the admin's), but the calling pattern, MIME allowlist, size cap, error envelope, and cost-log integration are all copied verbatim from Sunrise's implementation rather than reinvented.

Image and PDF attachments follow the same pattern: Sunrise already defines `chatAttachmentSchema`, the per-attachment and per-turn byte caps, `assertModelSupportsAttachments()`, and `CostOperation = 'vision'`. The platform's `/messages` route consumes these primitives directly.

### PDF rendering

**Sunrise has no PDF rendering library** — only PDF _parsing_ via `pdf-parse` for knowledge ingestion. User-facing and admin-facing PDF downloads require a new dependency in `package.json` (most likely `@react-pdf/renderer` to stay in the React idiom Sunrise already uses for email templates via `@react-email/render`). `package.json` is Sunrise-owned.

**Upstream finding:** Sunrise should add `@react-pdf/renderer` (or equivalent) as a dependency and document the canonical PDF-rendering pattern under `.context/orchestration/` so child projects can consume it. Until then, the prototype either (a) ships without PDF download (defer to a later phase via a feature toggle), (b) flags this as a smallest-possible breach and adds the dep to `package.json` with a clear comment marking the line as app-owned, or (c) ships PDF download as a separate static-site export that the user can print to PDF via browser — degraded but no Sunrise edit.

### Playwright

**Sunrise does not have Playwright installed.** `package.json` lists Vitest 4 but no Playwright. Adding it requires editing `package.json` (Sunrise-owned).

**Workaround:** all "E2E" tests in the phase prompts are actually **Vitest integration tests** that exercise the full HTTP request → handler → DB stack, not browser-driven tests. UI-level interaction tests use Vitest with React Testing Library (already in Sunrise's test stack). Real browser E2E becomes an upstream finding asking Sunrise to add Playwright. Throughout the rest of this document, where earlier text says "Playwright E2E," read it as "Vitest integration test using React Testing Library where UI is involved" until Sunrise adds Playwright.

### Admin sidebar gap

The admin sidebar in `components/admin/admin-sidebar.tsx` is a hardcoded `navSections` array. Adding a "Questionnaires" entry requires editing this Sunrise file. **There is no plugin point.**

**Upstream finding (Phase 0 critical-path):** Sunrise should refactor `navSections` to be discoverable from an extensible registry — e.g. `lib/admin-nav/registry.ts` with a `registerNavSection()` API child projects can call, and `admin-sidebar.tsx` reading from the registry. Until then, the prototype has three workaround options:

1. **Smallest-possible breach.** Add one entry to `navSections` with a clear comment. Easy to lift later. Breaches zero-touch.
2. **App-owned admin layout segment.** Place admin pages at `app/admin/questionnaires/` with their own `layout.tsx` that wraps them in an alternative sidebar. Loses the unified Sunrise admin shell visually. No zero-touch breach.
3. **Defer admin UI** until the upstream change lands. Phase 1 deliverables (API only) still ship. Phase 2's admin UI is paused.

Phase 0's plan must surface this choice to the operator.

### Feature flag

Sunrise has a real DB-backed feature flag system: `isFeatureEnabled(name)` from `lib/feature-flags/index.ts` reads from the `FeatureFlag` table. The flag name lookup is dynamic — the flag does not need to be in `DEFAULT_FLAGS` to be readable; it just needs to exist in the database.

**Approach:** the prototype's seed creates a `FeatureFlag` row named `APP_QUESTIONNAIRES_ENABLED` (default `enabled: false`). App-owned middleware and layouts call `isFeatureEnabled('APP_QUESTIONNAIRES_ENABLED')` — a Sunrise public function — to gate everything. No Sunrise file edits required. The `DEFAULT_FLAGS` constant in `lib/feature-flags/config.ts` stays unchanged; the prototype just doesn't appear in that constant, which is acceptable because `DEFAULT_FLAGS` is a "seed these if not already present" list, not an "enumeration of all known flags."

### ESLint segregation rule

Sunrise uses ESLint 9 flat config (`eslint.config.mjs`). Flat config does not auto-discover nested `.eslintrc.cjs` files — the rule restricting `next/*` imports inside `lib/app/questionnaire/` must be added to Sunrise's root `eslint.config.mjs` as a new override block. That's a Sunrise edit.

**Workaround:** the prototype uses TypeScript's path mapping in `tsconfig.json`... which is also Sunrise-owned. Or a custom runtime check at module load. Both are awkward.

**Recommended path for the prototype:** drop the ESLint rule from the goals. The platform-agnostic discipline of `lib/app/questionnaire/` is enforced by code review, by the directory's `CLAUDE.md`, and by Sunrise's existing typecheck (any `next/*` import in pure logic code is a smell the reviewer catches). Flag the absence as a Severity-C upstream finding ("Sunrise should expose a child-project ESLint extension point") but don't block on it.

---

## Shared context — read this before every phase

When pasting any phase prompt below into Claude Code, prepend the following context so Claude reasons within the right architectural envelope.

````
You are working in the Sunrise codebase as a child-project developer building the Conversational Questionnaire prototype.

Before doing anything, read these meta documents to ground your understanding of the platform:

- `.context/orchestration/meta/README.md`
- `.context/orchestration/meta/functional-specification.md` (skim — use as reference)
- `.context/orchestration/meta/architectural-decisions.md` (skim — sections 1.2, 1.3, 3.x, 5.x are most relevant)
- `CLAUDE.md` at the repo root

Then read the engineering docs for any orchestration modules you will consume in this phase (`.context/orchestration/<topic>.md`).

You are building a prototype called the **Conversational Questionnaire** as a strictly-segregated child project. The full multi-phase plan lives in this same document — read the whole thing first so you understand the zero-touch rule and where this phase sits in the larger arc, then focus on the phase you have been given.

## The zero-touch rule — non-negotiable

The prototype must never modify any Sunrise core or Sunrise orchestration file. Sunrise is a base platform that evolves on its own track; improvements to it are made **upstream, on the base platform**, and then pulled into child projects like this one. Your job in this phase is to build the prototype as a strict child project that consumes Sunrise but never edits it.

This means:

1. **Additive only.** Every file you create lives in app-owned territory. Never edit, delete, rename, or refactor a Sunrise file — not even trivially, not even one line.

2. **Sunrise is consumed via its public surface only.** Capabilities, agents, workflows, audit log, cost log, embedding generation, email recipes, PDF rendering, document parsers, evaluation harness, voice routing, auth, response helpers, UI components — all consumed through Sunrise's existing service/API/component entry points. Never reach into Sunrise's internal data structures, internal registries, internal files, or internal types not exported publicly.

3. **Every need for a Sunrise change is a finding that you flag for the base platform — it is not a problem, and it is not an excuse to edit Sunrise.** You **will** discover places where Sunrise does not yet expose a clean public API for what the prototype needs. This is expected and valuable. Each such finding is a deliverable: it gets captured in section (c) of your plan, framed as a specific upstream feature request the Sunrise team can implement on the base platform, and accompanied by a documented prototype-side workaround that holds until the upstream change lands. **Never silently resolve a gap by editing Sunrise.** If you find yourself reasoning "it would be easier to just edit the Sunrise file" — stop. That reasoning is the failure mode this rule exists to prevent.

### Sunrise-owned vs app-owned paths

These mappings reflect the actual Sunrise layout. Read the top-of-document inventory table for the full list; the summary below covers the paths most relevant to this phase. The prototype lives in app-owned territory; Sunrise's layout uses Next.js 16 route groups (`(auth)`, `(protected)`, `(public)`) for user-facing pages and a top-level `app/admin/` for admin pages.

| Sunrise owns (read-only) | App owns (your territory) |
|---|---|
| `lib/orchestration/**`, `lib/auth/**`, `lib/api/**`, `lib/email/**`, `lib/embed/**`, `lib/audio/**`, `lib/feature-flags/**`, `lib/db/**`, `lib/storage/**`, `lib/security/**`, `lib/validations/**` | `lib/app/questionnaire/**` |
| `app/api/v1/admin/**`, `app/api/v1/chat/**`, `app/api/v1/orchestration/**`, all other existing `app/api/v1/<sunrise>/**` | `app/api/v1/app/**` (new top-level segment) |
| `app/admin/orchestration/**`, `app/admin/users/**`, `app/admin/features/**`, `app/admin/logs/**`, `app/admin/overview/**`, `app/admin/layout.tsx`, `app/admin/page.tsx` | `app/admin/questionnaires/**` (new sibling, no extra `app/` sub-namespace) |
| `app/(auth)/**`, `app/(protected)/profile/**`, `app/(protected)/settings/**`, `app/(protected)/dashboard/**`, `app/(public)/**`, `app/layout.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`, `app/globals.css` | `app/(protected)/questionnaires/**` (new subdir under the existing `(protected)` route group) |
| `prisma/schema.prisma` (single file; `prismaSchemaFolder` not enabled), `prisma/migrations/**`, `prisma/seed.ts`, `prisma/runner.ts`, `prisma/seeds/*.ts` (top-level seed files, strict `^\d{3}-[a-z0-9-]+\.ts$` pattern, non-recursive), `prisma.config.ts` | See "Prisma strategy" and "Seeds" in the top-of-document section for the unavoidable upstream findings |
| `.context/orchestration/**`, `.context/admin/**`, `.context/api/**`, `.context/architecture/**`, `.context/database/**`, all other existing `.context/*` namespaces | `.context/app/questionnaire/**` (new sibling namespace) |
| `components/admin/admin-sidebar.tsx` (hardcoded `navSections` array — see "Admin sidebar gap"), `components/admin/**` overall, `hooks/**`, `emails/**`, `scripts/**` | `components/app/questionnaires/**` (if cross-cutting components are needed). The prototype freely **imports** from `components/ui/**` (shadcn primitives) and `hooks/**` as a consumer. |
| `tests/unit/**`, `tests/integration/api/v1/**`, `tests/setup.ts`, `tests/helpers/**`, `tests/mocks/**` (Sunrise's test convention is a top-level `tests/` mirror tree, NOT co-located `*.test.ts`) | `tests/unit/lib/app/questionnaire/**`, `tests/integration/api/v1/app/**`, `tests/integration/app/admin/questionnaires/**`, `tests/integration/app/(protected)/questionnaires/**` |
| `package.json`, `tsconfig.json`, `next.config.js`, `eslint.config.mjs`, `tailwind.config.ts`, `vitest.config.ts`, `prisma.config.ts`, all root config files, `CLAUDE.md` at repo root | (no app changes — any need for new deps, new test config, new ESLint rules, new path aliases is an upstream finding) |

If a path you need to write to doesn't fit the right-hand column, you've hit an upstream finding — capture it in section (c).

### Critical Sunrise integration facts you must verify before planning

Do not assume these from the document — confirm by reading the named Sunrise files. Most of these have already been flagged as findings to expect:

1. **Prisma is single-file** (`prisma.config.ts` points at `prisma/schema.prisma`; the generator's `previewFeatures` does NOT include `prismaSchemaFolder`). The prototype's models cannot live in a separate `.prisma` file without first having Sunrise enable multi-file schema. **Read `prisma.config.ts` and the top of `prisma/schema.prisma` to confirm.**

2. **Capability registration is a real public API.** `import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher'` and call `.register(new MyCapability())` where `MyCapability extends BaseCapability` from `@/lib/orchestration/capabilities/base-capability`. **Read `lib/orchestration/capabilities/registry.ts` to see the canonical built-in registration pattern.**

3. **Agents and workflows are created via direct Prisma writes** — `prisma.aiAgent.create(...)` and `prisma.aiWorkflow.create(...)`. There is no service API wrapping these. **Read `prisma/seeds/006-quiz-master.ts` and `prisma/seeds/004-builtin-templates.ts` to see the canonical creation shapes; read `app/api/v1/admin/orchestration/agents/route.ts` for the admin-route equivalent.**

4. **Embedding is direct function calls**: `embedText(text)` and `embedBatch(texts)` from `@/lib/orchestration/knowledge/embedder`. Not a capability dispatch. **Read `lib/orchestration/knowledge/embedder.ts` for the public exports.**

5. **Document parsing**: `parseDocument(buffer, fileName)` from `@/lib/orchestration/knowledge/parsers`. Supports PDF, DOCX, MD, TXT, CSV, EPUB. **Read `lib/orchestration/knowledge/parsers/index.ts` for the public surface.**

6. **Audit log**: `logAdminAction(entry)` from `@/lib/orchestration/audit/admin-audit-logger`. Fire-and-forget. **Read the file to confirm the entry shape.**

7. **Streaming chat**: `streamChat` from `@/lib/orchestration/chat`, `sseResponse` from `@/lib/api/sse`, `withAuth` from `@/lib/auth/guards`. **Read `app/api/v1/chat/stream/route.ts` for the canonical streaming-route pattern.**

8. **Voice and attachments are first-class Sunrise primitives**, not platform-specific additions. The platform's `/messages` route in Phase 6 consumes `getAudioProvider()` + `provider.transcribe()` + the existing MIME/size validation, and consumes `chatAttachmentSchema` + `assertModelSupportsAttachments()`. The platform's UI consumes Sunrise's `useVoiceRecording` hook and `<MicButton>` component verbatim, and Sunrise's attachment-input affordance from `AgentTestChat` verbatim. **Read `lib/orchestration/llm/provider-manager.ts`, `app/api/v1/admin/orchestration/chat/transcribe/route.ts`, and `lib/hooks/use-voice-recording.ts` (or wherever the hook lives — verify) before writing platform-side voice or attachment code.** The platform does NOT reinvent any of these primitives.

9. **Cross-model Prisma relations to Sunrise's `User`** require adding a reverse-relation field to `User` (Sunrise file edit). **Workaround:** use a plain `String` foreign-key column without a Prisma `@relation` declaration. Flag the loss of typed traversal as a finding.

10. **Sunrise has no PDF rendering library** and no Playwright. Phase 7/7 PDF download and any "E2E" tests will hit unavoidable findings (new deps required, `package.json` is Sunrise-owned).

11. **The admin sidebar `navSections` is a hardcoded array** in `components/admin/admin-sidebar.tsx`. There is no plugin point. This is a critical Phase 0 finding.

12. **Feature flags are DB-backed** via `lib/feature-flags`. The prototype creates a `FeatureFlag` row at seed time and consumes `isFeatureEnabled('APP_QUESTIONNAIRES_ENABLED')`. No Sunrise file edits required.

13. **Tests live at top-level `tests/`**, mirroring `lib/` and `app/api/v1/`. Not co-located. **Read `tests/integration/api/v1/admin/orchestration/agents.test.ts` for the canonical integration-test shape.**

## Architectural ground rules that apply to every phase

1. **API-first.** Every capability is exposed through `/api/v1/app/questionnaires/*` (or `/api/v1/app/questionnaire-sessions/*`) before any UI is built. The admin UI and the user UI both consume these routes the same way an external client would. No private query paths.

2. **Platform-agnostic core.** All questionnaire business logic lives in `lib/app/questionnaire/` and contains zero Next.js imports. Mirror the rule from `lib/orchestration/` (no `next/*` imports in pure logic). HTTP concerns live in `app/api/v1/app/`. Enforce by code review — the corresponding ESLint rule cannot be added without editing Sunrise's `eslint.config.mjs` (flagged as a Severity-C finding).

3. **Segregated app directories.** Admin pages under `app/admin/questionnaires/` and user pages under `app/(protected)/questionnaires/` are pure consumers — no business logic, no direct DB access, no LLM calls. Everything goes through `/api/v1/app/`.

4. **Consume Sunrise primitives — never reinvent.** Agents (via `prisma.aiAgent.create()`), workflows (via `prisma.aiWorkflow.create()`), capabilities (via `capabilityDispatcher.register()`), embeddings (`embedText`/`embedBatch`), document parsing (`parseDocument`), audit (`logAdminAction`), streaming chat (`streamChat` + `sseResponse`), auth (`withAuth`), feature flags (`isFeatureEnabled`) — all consumed via the specific named entry points above. Do not invent service-layer indirection that doesn't exist in Sunrise.

5. **Seed scripts are app-owned and operator-invoked.** The prototype's seeds live in `lib/app/questionnaire/seeds/` (a plain TypeScript directory, not `prisma/seeds/`), and are run by the operator via `tsx lib/app/questionnaire/seeds/run.ts`. Sunrise's `db:seed` script does not pick them up — this is a known limitation flagged as an upstream finding. Each seed uses the same `prisma` client Sunrise uses, and creates agents/workflows/capabilities via the direct-Prisma pattern documented in ground rule 4.

6. **App-prefixed schema, single Prisma file.** All new Prisma models are prefixed `App` (`AppQuestionnaire`, `AppQuestionSlot`, `AppAnswerSlot`, etc.). Until Sunrise enables `prismaSchemaFolder`, the prototype's models live in a clearly-labelled section at the bottom of `prisma/schema.prisma`. This is an acknowledged temporary breach of zero-touch, captured as a Phase 0 finding with a clear migration path. The operator chooses whether to accept this breach or halt the prototype until Sunrise enables multi-file schema.

7. **Versioned questionnaires.** Mirror the `AiAgentVersion` pattern. Edits to a version with zero sessions and zero invitations mutate in place; edits to a version that has been launched (locked by virtue of having any sent invitation or any in-progress session) fork a new draft version with the edit applied. In-flight sessions stay pinned to the version they started on.

8. **Provenance via Sunrise's existing contract.** Every extracted answer carries a `ProvenanceItem`-shaped record (source, confidence, reference, snippet). Consume the type from Sunrise; do not redefine it. **Read `lib/orchestration/provenance/` for the public exports.**

9. **Budget caps and cost transparency.** Every conversational turn runs under the agent's cost cap (enforced inside Sunrise's existing budget mechanism). The prototype reads pricing from Sunrise's model registry and per-session actuals from `AiCostLog` via the same query helpers Sunrise's own admin cost dashboard uses. **Read `lib/orchestration/cost-estimation/` and `lib/orchestration/llm/cost-tracker.ts` for the available query helpers.**

10. **Audit logging via `logAdminAction()`.** Every admin-side config change calls `logAdminAction({ userId, action, entityType, entityId, entityName, changes })` with the before/after state in `changes`.

11. **Feature flag.** The prototype's seed creates a `FeatureFlag` row named `APP_QUESTIONNAIRES_ENABLED`. App-owned middleware and layouts call `isFeatureEnabled('APP_QUESTIONNAIRES_ENABLED')`. When false, app routes return 404 and any app navigation hides. No Sunrise file edits required.

12. **Every phase ends with unit tests, integration tests, and documentation. No exceptions.** These are not deferred or final-phase activities; they are mandatory deliverables of every phase including Phase 0:

    - **Unit tests** live at `tests/unit/lib/app/questionnaire/**` mirroring the `lib/app/questionnaire/` source tree. Vitest 4 (Sunrise's existing version).

    - **Integration tests** live at `tests/integration/api/v1/app/**` mirroring `app/api/v1/app/**`, and at `tests/integration/app/admin/questionnaires/**` and `tests/integration/app/(protected)/questionnaires/**` for page-level integration. Same Vitest stack.

    - **End-to-end tests with a real browser require Playwright, which Sunrise does not have installed.** Until that's added upstream, "E2E" in the phase prompts means a Vitest integration test that exercises the full HTTP-handler-DB stack with React Testing Library for UI flows. Where a phase mentions Playwright, treat it as that Vitest integration variant.

    - **Documentation** lives at `.context/app/questionnaire/**` and follows the style of `.context/orchestration/*.md` (Sunrise's engineering docs). The specific docs required per phase are listed in that phase's goals.

    A phase is not done until its tests are green and its documentation is written.

    Tests and documentation are not optional gates. A phase is **not** done until its tests are green and its documentation is written. The "definition of done" of every phase explicitly references both.

13. **The `// DEMO-ONLY:` code convention.** Some of what this platform builds serves the sales-demo purpose but does not belong in a real client fork — for example, the Phase 2.5 demo-client tenancy (a branding overlay, not a security boundary), the demo-session reset endpoint (destructive and unsafe in production), demo-content fixtures, and any heuristic placeholder waiting for a more rigorous replacement.

    Every demo-only file or function carries a `// DEMO-ONLY:` comment header at the top of the file (or alongside the function declaration for in-file scoping). The header has three parts:

    ```
    // DEMO-ONLY: <one-line statement of demo intent>
    // FORK-GUIDANCE: <what a forking team should do instead>
    // SEE: <reference to the docs paragraph explaining the choice>
    ```

    Example, for the theming module:

    ```ts
    // DEMO-ONLY: client branding overlay for sales demos.
    // FORK-GUIDANCE: for a single-tenant production fork, delete this module and use
    // Sunrise's existing CSS variables in `app/globals.css` directly. For a multi-tenant
    // production fork, replace `AppDemoClient` with proper tenant scoping including RLS.
    // SEE: .context/app/questionnaire/forking.md § "Replacing demo tenancy"
    ```

    The convention has two effects: it tells anyone reading the code that this is intentional demo scaffolding (not under-baked code waiting to be finished), and it gives a forking team a grep-able marker (`grep -r "DEMO-ONLY:" lib/app/`) to find every place that needs review or removal. Phase 9's `forking.md` consolidates these markers into a checklist.

    Phases 2-9 each call out which of their deliverables carry this marker. The Phase 0 baseline carries none of them (Phase 0 is pure foundations).

## Your task for this turn: enter planning mode and produce a plan

**This is a planning task, not an implementation task.** For this turn:

- **Enter planning mode.** Do not write production code. Do not create files. Do not run migrations. Do not register seeds. Do not edit existing files. Read-only investigation of the repo is fine and expected; producing implementation is not.
- **End your turn with a plan, presented for my review.** I will read it, ask questions, request changes, and approve it. Only after I explicitly say "proceed with implementation" should you take any action that modifies the repo.
- **If the planning-mode tooling in your environment offers an explicit plan-and-approve flow, use it.** Otherwise treat this prompt as a soft equivalent: produce the plan as your full response, and stop.

When you produce the plan, structure it exactly as:

a) **Phase summary.** One paragraph: what this phase delivers and why it matters in the larger arc.

b) **File-by-file inventory of new files to create.** Every path with a one-line purpose statement. Every path must be in app-owned territory per the table above. If any file you propose to create is not in app-owned territory, that itself is a finding for section (c).

c) **Sunrise changes this phase requires (upstream findings).** This is the most important section of the plan after the inventory itself. List every Sunrise core or Sunrise orchestration change that would, in an unconstrained world, make this phase cleaner — every file you would have edited, every API that does not yet exist publicly, every component that is not exported, every internal type that is not exposed, every seed-registration path that is not pluggable, every sidebar or config slot that is not extensible from app code. For each:
   - **Finding** — one sentence stating what's missing or not publicly exposed.
   - **Affected Sunrise files** — the specific Sunrise paths involved.
   - **Proposed upstream change** — a specific, actionable feature request the Sunrise team can implement on the base platform.
   - **Prototype-side workaround** — what the prototype will do instead, in app-owned code, until the upstream change lands. This workaround must be acceptable on its own terms and must not involve any Sunrise file edit.
   - **Workaround durability** — how long this workaround is expected to hold and what would make it untenable.

   If this phase requires no Sunrise changes, say so explicitly: "No upstream Sunrise changes required for this phase." Do not skip the section.

d) **Prisma schema changes (if any).** New model definitions. Since `prismaSchemaFolder` is not enabled in Sunrise, the prototype's models live in a clearly-labelled section at the bottom of `prisma/schema.prisma` — acknowledge this as an upstream finding in section (c). New timestamped migration directories under `prisma/migrations/` are created by `prisma migrate dev`; do not hand-author them.

e) **API routes (if any).** Method, path, request shape, response shape, auth requirements. All paths under `/api/v1/app/`. No handler code.

f) **Agents / capabilities / workflows to seed (if any).** For each: which Sunrise primitive is consumed (e.g. `prisma.aiAgent.create()`, `prisma.aiWorkflow.create()`, `capabilityDispatcher.register(new MyCap())`) and which existing Sunrise seed file gives you the canonical example to follow (e.g. `prisma/seeds/006-quiz-master.ts` for agents). No seed code.

g) **UI surfaces (if any).** Component-level structure, page routes, accordion / panel / form layout. No component code. Admin paths under `app/admin/questionnaires/`; user paths under `app/(protected)/questionnaires/`.

h) **Unit test plan.** What pure functions and module-internal logic gets unit tests, organised by sub-module. Specify Vitest as the framework (matching Sunrise) and confirm the file-location convention you will follow.

i) **Integration test plan.** What API routes, database write paths, Sunrise public API integrations, workflow registrations, and seed scripts get integration tests. Specify the fixtures involved and the assertion shape (status code, response body, side-effect rows, audit log entries).

j) **End-to-end test plan (where applicable).** From Phase 2 onwards, at least one Playwright happy-path test. State which user-visible flow it covers. For phases without UI (0 and 1), say "Not applicable — API-only phase" explicitly.

k) **Documentation plan.** Which files under `.context/app/questionnaire/` this phase creates or updates, with a one-line description of the contents of each. Documentation follows the style of `.context/orchestration/*.md` (Sunrise's engineering docs) and is a mandatory deliverable, not optional.

l) **Risks and open decisions.** Anything you want me to confirm or push back on before implementation.

m) **Definition of done.** Concrete observable outcomes that prove the phase is complete. The definition of done must explicitly include: all unit tests green, all integration tests green, all E2E tests green where applicable, all documentation files written and committed, and zero Sunrise-owned files modified.

**Do not write implementation code in the plan.** Schema, route signatures, and component skeletons are fine; full code is not. When the plan is complete, stop and wait for my review.
````

---

## Phase 0 — Foundations

```
We are starting Phase 0 of the Conversational Questionnaire prototype: foundations and scaffolding.

[paste the shared context block from above]

This phase produces no user-visible feature. Its job is to put the scaffolding in place — module skeleton, schema, feature flag, test scaffolding, documentation namespace — so every subsequent phase has a stable home. It is also the phase where the most important upstream Sunrise findings are surfaced, because the rest of the prototype depends on resolutions to them.

## Verification step before planning

Before writing the plan, read these specific Sunrise files to ground the plan in reality. Do not infer from this document — confirm by reading. Each one is short:

1. **`prisma.config.ts`** — confirm the schema path is the single file `prisma/schema.prisma` and the `prismaSchemaFolder` preview feature is NOT enabled.
2. **`prisma/schema.prisma`** — read the top of the file (generator block, datasource, User model) and skim the rest. Note the pattern of `Ai`-prefixed models and the reverse-relation fields on `User`.
3. **`prisma/runner.ts`** — confirm the seed runner is non-recursive on `prisma/seeds/` with the `^\d{3}-[a-z0-9-]+\.ts$` filename pattern.
4. **`prisma/seeds/006-quiz-master.ts`** — the canonical example of seeding an agent + workflow + capability bindings together. Note that everything is `prisma.aiAgent.create()` / `prisma.aiWorkflow.create()`.
5. **`lib/orchestration/capabilities/registry.ts`** and **`lib/orchestration/capabilities/dispatcher.ts`** — confirm `capabilityDispatcher.register()` is the public registration entry, and confirm `registerBuiltInCapabilities()` is called once at module load with no documented child-project plugin point.
6. **`lib/feature-flags/index.ts`** and **`lib/feature-flags/config.ts`** — confirm `isFeatureEnabled(name)` reads dynamically from the `FeatureFlag` table, and that `DEFAULT_FLAGS` is a "seed if missing" list rather than an enumeration of known flags.
7. **`components/admin/admin-sidebar.tsx`** — confirm the `navSections` array is hardcoded with no plugin point.
8. **`eslint.config.mjs`** — confirm the flat-config format and the absence of any child-project extension point.
9. **`tests/integration/api/v1/admin/orchestration/agents.test.ts`** and **`tests/unit/lib/orchestration/capabilities/dispatcher.test.ts`** (or similar) — confirm the canonical test file layout, naming, and the Vitest mocking patterns used.
10. **`package.json`** — confirm there is no Playwright dep, no PDF rendering dep, and that the test stack is Vitest 4 + React Testing Library.
11. **Repo root for `instrumentation.ts`** — confirm whether one exists. If it does, it is Sunrise-owned; if it doesn't, the prototype is free to create one.

After this verification, you will know exactly which findings need to land in section (c) of the plan.

## Goals for this phase

1. **Create the `lib/app/questionnaire/` module skeleton** with the following sub-directories, each containing an `index.ts` and a stubbed `types.ts`: `types/`, `versioning/`, `extraction/`, `slots/`, `sessions/`, `selection/`, `provenance/`, `analytics/`, `export/`, `cost-estimation/`, `contradiction/`, `strengthening/`, `completion/`, `capabilities/`, `agents/`, `workflows/`, `seeds/`, `feature-flag/`. Pure TypeScript, zero Next.js imports — Sunrise's `lib/orchestration/` pattern.

2. **Add the prototype's models to `prisma/schema.prisma`** in a clearly labelled section at the bottom of the file. Use this exact comment fence so the section is mechanically liftable when Sunrise enables `prismaSchemaFolder`:

```

// ─────────────────────────────────────────────────────────────────────
// BEGIN APP MODELS — Conversational Questionnaire prototype
//
// This section is owned by the conversational-questionnaire child
// project. It exists at the bottom of schema.prisma as an acknowledged
// temporary breach of the zero-touch rule, pending Sunrise enabling
// `prismaSchemaFolder` (see .context/app/questionnaire/upstream-gaps.md).
// When that lands, lift this entire block (start/end fence inclusive)
// into prisma/schema/app-questionnaire.prisma without further edits.
// ─────────────────────────────────────────────────────────────────────

````

Models, all prefixed `App`:

- `AppQuestionnaire` — id (cuid), slug (unique per owner), name, description, **goal String?** (a paragraph describing what the questionnaire is intended to achieve — populated by the admin during creation/edit, optionally auto-suggested by the Phase 1 extractor from the source document; consumed by the Phase 5 evaluation judges), **audience Json?** (structured intended-audience metadata supplied by the admin during creation/edit and optionally auto-inferred by the Phase 1 extractor; consumed by the Phase 5 evaluation judges and by the Phase 6 conversational agent to calibrate tone and depth; shape documented below), ownerId String (no Prisma relation to `User` — explained below), status enum (`draft | active | archived`), currentVersionId String?, deletedAt DateTime?, createdAt, updatedAt

  **`audience` JSON shape** — formalised as the TypeScript type `AudienceShape`, exported from `lib/app/questionnaire/types/index.ts` (see goal 4 below) so every consumer (Phase 1 extractor, Phase 2 admin UI, Phase 5 evaluation judges, Phase 6 conversational agent) imports the same shape:
  ```ts
  export type AudienceShape = {
    description?: string;        // free-text paragraph
    role?: string;               // e.g. "Software engineers" / "First-time home buyers"
    expertiseLevel?: 'novice' | 'intermediate' | 'expert';
    estimatedDurationMinutes?: number;  // surfaced in the invitation email and the user-facing UI
    locale?: string;             // BCP-47, default 'en'; consumed by the Phase 6 agent for tone
    sensitivity?: 'low' | 'moderate' | 'high';  // hints anonymous-mode defaults and contradiction-detection cadence
    notes?: string;              // free-text — anything else the admin wants the evaluation judges to know
  };
  ```
  All fields optional; the agent and the UI degrade gracefully when fields are missing.
- `AppQuestionnaireVersion` — id, questionnaireId, versionNumber Int, schemaSnapshot Json, sourceDocumentBytes Bytes? (the original upload, for diff-against-source on re-upload), sourceDocumentFileName String?, isLocked Bool, lockedAt DateTime?, createdAt
- `AppQuestionnaireSection` — id, versionId, ordinal Int, name, description String?
- `AppQuestionSlot` — id, versionId, sectionId, ordinal Int, key String (unique per version), prompt String, guidelines String?, rationale String?, type enum (`free_text | single_choice | multi_choice | likert | numeric | date | boolean`), typeConfig Json, embedding `vector(1536)`? (matching `AiKnowledgeChunk.embedding`'s dimensionality and index strategy — confirm by reading that model), required Bool, weight Float (default 1.0, explained in §B5 of the open-decisions section below), extractionConfidence Float? (0–1, set by the extractor in Phase 1)
- `AppQuestionnaireConfig` — id, versionId (unique), selectionStrategy enum (`sequential | random | weighted | adaptive`), completionConfig Json, visibilityConfig Json, anonymousMode Bool, costBudgetUsd Decimal, perSessionCostCapUsd Decimal? (introduced now so Phase 9 doesn't need a migration), voiceEnabled Bool, contradictionDetectionMode enum (`off | every_turn | every_n_turns | sweep_only`), contradictionDetectionN Int?, userProfileFields Json (admin-configured list of profile fields to collect at session start; field-type enum is `text | email | number | select` — `number` added to support fields like tenure-in-years; supports name, email, job title, organisation, team / department, tenure, and arbitrary custom fields)
- `AppQuestionnaireInvitation` — id, versionId, email, name String?, token (unique), status enum (`pending | sent | opened | registered | started | completed | revoked`), sentAt DateTime?, registeredUserId String? (no Prisma relation to `User`)
- `AppQuestionnaireSession` — id, versionId, userId String? (no Prisma relation to `User`), anonId String?, status enum (`in_progress | paused | completed | abandoned`), startedAt, completedAt DateTime?, roundCount Int, totalCostUsd Decimal
- `AppQuestionnaireUserProfile` — id, sessionId (unique), capturedFields Json (the values for whatever fields the questionnaire config requested; replaces the earlier hardcoded `name/email/jobTitle/organisation` columns since the field set is admin-configurable)
- `AppAnswerSlot` — id, sessionId, questionSlotId, value Json, confidence Int (1–10), provenanceLabel enum (`direct | inferred | synthesised | admin_override | refined`), provenanceItems Json (array of `ProvenanceItem`-shaped records, consumed from Sunrise's contract), rationale String, lastUpdatedTurnId String?, refinementHistory Json (default `[]`)
- `AppQuestionnaireTurn` — id, sessionId, ordinal Int, userMessage String, agentMessage String, toolCalls Json, targetedQuestionId String?, sideEffectAnswerIds Json (default `[]`), costUsd Decimal, createdAt
- `AppQuestionnaireSessionEvent` — id, sessionId, eventType enum (`started | paused | resumed | refinement_requested | completion_offered | submitted | abandoned | cost_cap_reached`), payload Json, createdAt — used for the session-state audit trail Phase 9 finalises
- `AppQuestionTag` — id, versionId, key String (slug-style, unique per version), label String, description String?, colour String? (hex code for admin UI display; nullable since not every tag needs visual differentiation), ordinal Int (display order in the admin UI). Per-questionnaire-version tag set; the admin defines an arbitrary tag vocabulary per questionnaire. CRUD lands in Phase 2.
- `AppQuestionSlotTag` — pivot row: questionSlotId, tagId, createdAt. Composite primary key on `(questionSlotId, tagId)`. Many-to-many between questions and tags. Both sides scoped to the same `versionId` (enforced at the application layer in Phase 2; the schema cannot express the cross-table version constraint without additional triggers, which the prototype skips — section (c) notes this).
- `AppQuestionnaireExtractionChange` — id, versionId, changeType enum (`prune_section | prune_question | correct_spelling | correct_grammar | rewrite_prompt | infer_type | merge_questions | split_question | add_section | augment_question | infer_goal | infer_audience`), targetEntityType enum (`section | question | questionnaire`), targetEntityId String? (the affected entity in the extracted structure; nullable for changes against entities that were pruned and never persisted), sourceQuote String? (the relevant span in the original document), beforeJson Json (the pre-change state — for pruned items this is the only place the data exists), afterJson Json? (the post-change state — null for `prune_*` changes), rationale String, status enum (`applied | reverted`) default `applied`, revertedAt DateTime?, revertedByUserId String?, createdAt. Captures every decision the Phase 1 extractor made; visible in the Phase 1 review UI. The admin can revert any change; revert restores `beforeJson` to the questionnaire structure. `infer_audience` changes have `targetEntityType: 'questionnaire'` and `afterJson` containing the (partial) audience object the extractor inferred — reverting clears those specific fields back to their pre-extraction state.

**Design-time evaluation: consume Sunrise primitives, store only the review-state delta.**

Phase 5 evaluates a questionnaire's structure (clarity, duplicates, coverage, type fit, etc.) against its stated `goal` and `audience`. **Sunrise already provides the evaluation primitives**: judge agents (`AiAgent.kind = 'judge'`), datasets (`AiDataset` + `AiDatasetCase`), batch evaluation runs (`AiEvaluationRun`), per-case results (`AiEvaluationCaseResult`), the grader registry, and admin UI for all of it. The platform consumes these directly rather than parallelling them.

What the platform owns: a thin link table that ties a Sunrise `AiEvaluationRun` to a specific `AppQuestionnaireVersion` (so the admin UI can list "evaluation runs for this version"), and a small review-state table that records the admin's accept/decline/edit decisions on each case result (so the suggestion review queue is durable across sessions). Both are far smaller than the original spec.

- `AppQuestionnaireEvaluationLink` — id, versionId, aiEvaluationRunId String (FK to Sunrise's `AiEvaluationRun.id`, plain string column per the cross-table rule), triggeredByUserId String, createdAt. One row per `POST .../evaluate` invocation. Indexed on `(versionId, createdAt DESC)` so the admin UI lists runs newest-first.
- `AppQuestionnaireSuggestionReview` — id, versionId, aiEvaluationCaseResultId String (FK to Sunrise's `AiEvaluationCaseResult.id`, plain string), proposedChange Json (the structured "do this" description extracted from the case result's `output` field — see Phase 5 for the contract), proposedChangeOverride Json? (set when the admin uses "Edit proposal" to tweak the change before accepting; null otherwise), status enum (`pending | accepted | declined | applied`) default `pending`, declineReason String?, decidedByUserId String?, decidedAt DateTime?, createdAt. One row per case result the admin is reviewing. **No `stale` status** — staleness is derived at read time from version diffs, not persisted (see Phase 5).

`AppQuestionnaireEvaluationSuggestion` and `AppQuestionnaireEvaluationRun` from the earlier spec are **deleted from this phase** — replaced by the two link tables above plus Sunrise's evaluation tables.

**Foreign-key approach for references to Sunrise tables (User, etc.):** use plain `String` columns without `@relation` declarations. Add `@db.VarChar(30)` to match Sunrise's CUID column type. Manual referential cascade behaviour is written into the migration SQL by hand if needed. Acknowledge the loss of typed Prisma traversal in section (c).

**Indexes:** on every foreign key, on `AppQuestionnaire.ownerId`, on `AppQuestionnaireInvitation.token` (unique), on `AppQuestionnaireSession.userId`, unique constraint on `AppQuestionTag.(versionId, key)`, composite primary key on `AppQuestionSlotTag.(questionSlotId, tagId)` plus an index on `AppQuestionSlotTag.tagId` for reverse lookups, indexes on `AppQuestionnaireExtractionChange.(versionId, status)` and `AppQuestionnaireExtractionChange.changeType`, **indexes on `AppQuestionnaireEvaluationLink.(versionId, createdAt)` and `AppQuestionnaireSuggestionReview.(versionId, status)`**, and an HNSW index on `AppQuestionSlot.embedding` using the same operator class Sunrise uses for `AiKnowledgeChunk.embedding`. Read the Sunrise migration that created the `AiKnowledgeChunk.embedding` index and replicate it exactly.

3. **Generate the migration** by running `prisma migrate dev --name app-questionnaire-init`. The migration directory lands under `prisma/migrations/<timestamp>_app-questionnaire-init/`. This directory is technically Sunrise-owned but its existence is a runtime artefact of `prisma migrate dev` — it is not a hand-edited Sunrise file. Acknowledge in section (c) that subsequent Sunrise migrations land alongside the prototype's, with no conflict expected.

4. **Export shared TypeScript domain types** from `lib/app/questionnaire/types/index.ts` for use by the API layer, admin UI, and user UI. This includes `AudienceShape` (see above), the `SessionState` type that Phase 4 builds, the `UserProfileFieldSpec` type Phase 3 defines, and any other cross-phase types. The `ProvenanceItem` type is imported from Sunrise (`@/lib/orchestration/provenance`), not redefined.

5. **Feature-flag plumbing.** Create `lib/app/questionnaire/feature-flag/index.ts` exporting `isQuestionnairesEnabled()` — a thin wrapper around `isFeatureEnabled('APP_QUESTIONNAIRES_ENABLED')` from Sunrise's `lib/feature-flags`. Create `lib/app/questionnaire/seeds/001-feature-flag.ts` which inserts the `FeatureFlag` row (default `enabled: false`). The wrapper is a single function; route-level enforcement comes in Phases 1+.

6. **Capability-registration entry point.** Since Sunrise has no documented child-project hook for capability registration, check whether `instrumentation.ts` exists at the repo root.
- **If it doesn't exist:** create it as an app-owned file. It calls `registerBuiltInCapabilities()` from Sunrise (the existing call) and then calls the prototype's own `registerAppQuestionnaireCapabilities()` (which is a no-op in Phase 0; Phase 1 onwards populates it). This file is genuinely new — Sunrise did not have one before.
- **If it does exist** (Sunrise added one between when this document was written and when you read it): flag this as a finding. The prototype cannot edit it. Either Sunrise has already exposed a plugin point Claude Code should discover and use, or the workaround is to accept the smallest-possible breach (one line added to call the prototype's registration function) with the same comment-fenced labelling used in `prisma/schema.prisma`.

7. **App-owned seed runner.** Create `lib/app/questionnaire/seeds/run.ts` — invoked manually by the operator via `tsx lib/app/questionnaire/seeds/run.ts`. It uses Sunrise's `runSeeds()` helper from `prisma/runner.ts` (a public function) pointed at the `lib/app/questionnaire/seeds/` directory, which the prototype owns end-to-end. Document the manual invocation in `.context/app/questionnaire/README.md`. Section (c) flags that this should be unified with `db:seed` once Sunrise's runner is made recursive.

8. **Unit tests** (live at `tests/unit/lib/app/questionnaire/` mirroring the source tree):
- One test per sub-module that asserts the `index.ts` exports the expected named symbols (catches typo regressions).
- `feature-flag/index.test.ts` — mocks `isFeatureEnabled` and confirms the wrapper returns the right boolean.
- `types/index.test.ts` — type-level smoke test (one assignability check per type, using `expectTypeOf` from Vitest).

9. **Integration tests** (live at `tests/integration/api/v1/app/` and `tests/integration/prisma/`):
- `tests/integration/prisma/app-questionnaire-schema.test.ts` — runs the migration against a fresh database, then queries `information_schema` to assert every model, every column, every index, and every foreign key exists with the expected types.
- `tests/integration/lib/app/questionnaire/feature-flag.test.ts` — seeds the `APP_QUESTIONNAIRES_ENABLED` flag row, sets it to `false`, calls a tiny stub route under `app/api/v1/app/_healthcheck/route.ts` (created as part of this phase to give Phase 1 a flag-gating template), confirms a 404 response. Toggles the flag to `true`, confirms 200.

10. **Documentation** — create the entire app-owned documentation namespace:
 - `.context/app/README.md` — explains that this namespace is for child-project documentation, separate from `.context/orchestration/` (Sunrise's docs). One paragraph.
 - `.context/app/questionnaire/README.md` — the entry point for the prototype's docs. Includes how to run the prototype's seeds (`tsx lib/app/questionnaire/seeds/run.ts`), how to enable the feature flag, and an index of the docs files (most will be added in subsequent phases).
 - `.context/app/questionnaire/overview.md` — the module map: what lives under `lib/app/questionnaire/`, what lives under `app/api/v1/app/`, what lives under `app/admin/questionnaires/`, what lives under `app/(protected)/questionnaires/`. Updated as each phase ships.
 - `.context/app/questionnaire/schema.md` — the prototype's data model, every model and every column with rationale. References the comment-fenced section in `prisma/schema.prisma`. **Includes a "Renaming the App-prefix schema for a fork" sub-section** that explains the rename procedure for a real client engagement:
   - The platform ships every Prisma model prefixed `App` (`AppQuestionnaire`, `AppQuestionSlot`, `AppAnswerSlot`, etc.). A fork has three options: (1) keep the `App*` prefix as a stable schema-namespace marker that doesn't imply domain — perfectly valid, no work; (2) rename to a domain-meaningful prefix (`Intake*`, `Compliance*`, `Onboarding*`) for clarity; (3) drop the prefix entirely if the fork is single-purpose (`Questionnaire`, `QuestionSlot`, `AnswerSlot`).
   - The rename procedure is a `sed` recipe (full version in `forking.md` § "Renaming the App-prefix schema"). The schema.md mention is the pointer.
   - **What the rename touches**: schema models, every TypeScript file under `lib/app/` and `app/` that references the models, route paths (`/api/v1/app/...`), audit-log `entityType` strings, doc files under `.context/app/questionnaire/`, capability slugs (separate recipe — see `forking.md`), the default demo client slug.
   - **What the rename does NOT touch**: feature-flag names (those are operationally stable), Sunrise files (they don't reference the App prefix).
   - Recommend: most forks keep `App*`. The rename is opt-in and best handled in week 1 of the fork before any feature work begins.
 - `.context/app/questionnaire/upstream-gaps.md` — initially populated with the Phase 0 findings (see section (c) below). Each subsequent phase appends.
 - `.context/app/questionnaire/development.md` — how a developer works on the prototype: where to add code per layer, what tests to write, how seeds are run, how the feature flag is toggled in dev.

## Expected upstream findings (section (c) of your plan)

Before producing the plan, you must be able to articulate each of the following findings (or explain why one doesn't apply). At minimum, expect to flag:

1. **`prismaSchemaFolder` is not enabled.** Sunrise should enable it. Prototype workaround: comment-fenced section at the bottom of `prisma/schema.prisma`.
2. **Seed runner is non-recursive and uses a strict filename pattern.** Sunrise should make `runSeeds()` recursive. Prototype workaround: separate app-owned seed runner script, operator-invoked.
3. **Admin sidebar `navSections` is hardcoded.** Sunrise should expose a sidebar registry. Prototype workaround in Phase 2: admin pages with their own layout segment, or smallest-possible breach (one entry added to `navSections` with comment-fence).
4. **Capability-registration plugin point is undocumented.** Sunrise should expose a `registerExternalCapabilities()` hook called from its bootstrap. Prototype workaround: app-owned `instrumentation.ts` (Next.js convention), if Sunrise doesn't already own it.
5. **No public ESLint extension point.** Sunrise should expose an `eslint.config.mjs` slot child projects can plug into. Prototype workaround: code-review-enforced segregation (no automated enforcement).
6. **No PDF rendering dependency.** Sunrise should add `@react-pdf/renderer` (or equivalent) and document the canonical PDF-render pattern. Prototype workaround: PDF download is deferred until the dependency lands, or Phase 7/7 flags it again as a blocker. Phase 0 doesn't need this — Phase 7 does — but flagging it now lets the upstream change land in time.
7. **No Playwright dependency.** Same shape. All "E2E" tests are Vitest-integration-with-RTL until Playwright lands.
8. **Cross-model Prisma relations to `User` require editing the `User` model's reverse-relation list.** Sunrise should consider an `external_relations.prisma` partial or accept that child projects use string FKs. Prototype workaround: plain `String` foreign keys, manual referential integrity via migration SQL.

For each, produce the full five-part finding (Finding / Affected Sunrise files / Proposed upstream change / Prototype-side workaround / Workaround durability) per the shared context block.

## Open decisions to surface in section (l)

- **The Prisma-schema-breach decision.** Do you (the operator) accept the comment-fenced section at the bottom of `prisma/schema.prisma` as a temporary deliberate breach, or do you want to halt the prototype until Sunrise enables `prismaSchemaFolder`? Phase 0 cannot proceed without this answer.
- **The admin-sidebar decision** (deferable to Phase 2, but worth surfacing now): top-level "Questionnaires" entry as a smallest-possible-breach edit, OR app-owned admin layout with its own sidebar variant, OR defer admin UI entirely until Sunrise exposes a plugin point.
- **The `instrumentation.ts` decision** (only if Sunrise already has one): smallest-possible-breach, or defer all capability registration until Sunrise exposes a plugin point. If Sunrise doesn't have one, the prototype creates it freely.
- **The user-profile-fields schema.** I have re-modelled this in Phase 0 as `userProfileFields Json` on the config (admin defines the field set) plus `capturedFields Json` on the profile (user-submitted values). Confirm this is the right direction — the earlier-conversation idea of hardcoded `name/email/jobTitle/organisation` is too rigid and `customFields` JSON alongside hardcoded columns was confusing.

## Definition of done

- **`prisma migrate dev` runs cleanly** against a Sunrise database, producing a new migration directory and a working schema.
- **`pnpm type-check` clean** (Sunrise's existing script).
- **`pnpm lint` passes** (Sunrise's existing script).
- **`pnpm test` passes** — all unit tests green, all integration tests green.
- **The feature flag is functional**: with `APP_QUESTIONNAIRES_ENABLED` set to `false`, the `/api/v1/app/_healthcheck` stub returns 404; with `true`, it returns 200.
- **The app-owned seed runner works**: `tsx lib/app/questionnaire/seeds/run.ts` runs the Phase 0 seed (the `FeatureFlag` row) cleanly and idempotently.
- **Documentation files written and committed**: `.context/app/README.md`, `.context/app/questionnaire/README.md`, `.context/app/questionnaire/overview.md`, `.context/app/questionnaire/schema.md`, `.context/app/questionnaire/upstream-gaps.md`, `.context/app/questionnaire/development.md`.
- **Section (c) of the approved plan** lists every upstream Sunrise finding with the full five-part treatment.
- **The Prisma schema breach (if accepted by the operator) is contained** entirely within the comment-fenced section at the bottom of `prisma/schema.prisma` — no edits anywhere else in that file, no other Sunrise files touched apart from possibly `instrumentation.ts` if it didn't previously exist (in which case the prototype owns it).

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.
````

---

## Phase 1 — Questionnaire ingestion

```
We are starting Phase 1 of the Conversational Questionnaire prototype: questionnaire ingestion.

[paste the shared context block from above]

This phase lets an admin upload a questionnaire document and have an LLM extract questions and sections from it. No UI yet — everything is exercised through the API. All new code lives in app-owned territory.

## Verification step before planning

Before writing the plan, read these specific Sunrise files to ground decisions in reality:

1. **`lib/orchestration/knowledge/parsers/index.ts`** — confirm `parseDocument(buffer, fileName)` is the public entry, supports `.pdf` / `.docx` / `.md` / `.txt` / `.csv` / `.epub`, and that `.pdf` is flagged in `PREVIEW_REQUIRED_EXTENSIONS`. Read `parsers/types.ts` for the `ParsedDocument` shape.
2. **`lib/orchestration/knowledge/document-manager.ts`** in full — confirm `previewDocument(buffer, fileName, userId, options?)` and `confirmPreview(documentId, options?)` are the public lifecycle entries. **Read every option each takes** — the platform consumes these as-is, not a simplified facsimile. Pay particular attention to:
   - **SHA-256 dedup on PDF re-upload**: re-uploading the same PDF refreshes the existing `pending_review` row in place rather than creating a duplicate, scoped to the uploading user. This matters for demo prep where the presenter iterates on a prospect's document several times.
   - **Per-page text-density check**: groups consecutive scanned pages into a single warning per range. Catches scanned-image PDFs early — the most likely failure mode when a prospect's real compliance / HR / vendor document is a scanned PDF.
   - **`extractTables=true` opt-in**: vector-grid table extraction renders detected tables as fenced markdown pipe tables in the preview. Many real questionnaires have tabular sections; without this opt-in the platform misses content.
3. **`lib/orchestration/knowledge/embedder.ts`** — confirm `embedText(text)` and `embedBatch(texts)` are exported and synchronous to call (return a Promise).
4. **`lib/orchestration/capabilities/base-capability.ts`** — read `BaseCapability` in full. Pay attention to `processesPii` and the `redactProvenance()` override requirement.
5. **`lib/orchestration/capabilities/dispatcher.ts`** — read the `dispatch(slug, rawArgs, context)` method and the registry-load flow. Understand that dispatch requires both an in-memory handler (registered via `register()`) AND an `AiCapability` row with `isActive: true`.
6. **`prisma/seeds/011-call-external-api.ts`** — the canonical pattern for upserting an `AiCapability` row from a seed. Match this shape exactly for the prototype's own capability seeds.
7. **`prisma/seeds/006-quiz-master.ts`** — the canonical pattern for seeding an agent (`prisma.aiAgent.create()` with the right column set). Read in full; copy the column choices that make sense for an extraction agent.
8. **`lib/orchestration/chat/streaming-handler.ts`** — confirm the `streamChat({ message, agentSlug, userId, attachments?, ... })` signature in `types.ts` and skim `streamChat()` near the bottom. The prototype's upload route will invoke this to run the extraction agent against the uploaded document text.
9. **`lib/api/responses.ts`** and **`lib/api/validation.ts`** — Sunrise's public response and Zod-validation helpers. Confirm the function names (e.g. `withAdminAuth`, `validateRequestBody`, `errorResponse`) so the route handlers use them verbatim.
10. **`lib/auth/guards.ts`** — confirm `withAdminAuth` is the right guard for admin-only routes (versus `withAuth` for authenticated users).
11. **`app/api/v1/admin/orchestration/agents/route.ts`** — the canonical admin POST/GET route shape; copy the auth + validation + response patterns.

After verification, you'll know exactly which entry points to use and whether any of them have changed since this document was written.

## Goals for this phase

1. **Seed the extraction agent.** Create `lib/app/questionnaire/seeds/002-extraction-agent.ts` (a `SeedUnit` matching Sunrise's `prisma/runner.ts` contract). It calls `prisma.aiAgent.create()` directly — agents are created by writing Prisma rows, not by calling a service API. Follow the column choices in `prisma/seeds/006-quiz-master.ts`.

   - Agent slug: `app-questionnaire-extractor` (the `app-` prefix is the prototype's namespacing convention for agents it owns).
   - System instructions tuned for structured questionnaire extraction. The agent's response is a structured JSON document (sections + questions); rely on the LLM's tool-calling to invoke the extraction capability rather than parsing free-text agent output.
   - Model selection: pick a model that handles long documents well and has reliable structured output. Confirm from Sunrise's `AiProviderModel` table (or `prisma/seeds/009-provider-models.ts`) which models are seeded with `paramProfile` values that support structured output. **Do not prescribe a vendor in the seed** — pick the model whose `AiProviderModel.id` corresponds to the operator's preference, and document the chosen model in `.context/app/questionnaire/ingestion.md`. (`paramProfile` lives on the model row, not the agent — the agent points at the model.)
   - `costPerExecutionCapUsd`: `0.50` as a starting default (a few large extractions per dollar, easy to adjust). Document the rationale in the ingestion doc.
   - Visibility: `private` — only admin users invoke this agent, never end users.
   - Bound to the prototype's `extract_questionnaire_structure` capability (created next).

2. **Add the extraction capability.** Create `lib/app/questionnaire/capabilities/extract-questionnaire-structure.ts` — a class extending `BaseCapability` (imported from `@/lib/orchestration/capabilities/base-capability`).

   - Slug: `app_extract_questionnaire_structure`.
   - `processesPii: true` (questionnaire documents may contain PII like names or contact info). Override `redactProvenance()` to redact long text passages in the provenance preview (cap to ~200 chars). This is **required** — `BaseCapability` registration throws if a PII-handling capability doesn't override `redactProvenance()`.
   - Zod schema: `{ documentText: string, fileName: string, mediaType: string, adminProvidedGoal?: string, adminProvidedAudience?: AudienceShape }` — the agent gets these from the chat-handler attachments machinery, plus the admin-supplied metadata from the upload form so it knows which fields not to infer.
   - Output: `{ success: true, data: { sections: [{ name, description?, ordinal }], questions: [{ sectionOrdinal, prompt, guidelines?, rationale?, suggestedType, suggestedTypeConfig?, extractionConfidence: 0..1, sourceQuote: string }], inferredGoal?: string, inferredAudience?: Partial<AudienceShape>, changes: AppQuestionnaireExtractionChange[] } }` — `success: false` with an error on parse failure.
   - **The extractor is opinionated, not literal.** It does not produce a verbatim translation of the source document. Its job is to produce a high-quality, ready-to-use questionnaire structure. To do that, it makes editorial decisions:
     - **Prune** superfluous content: cover-page boilerplate, instructions-for-administrators-only, signature blocks, page numbers, "for office use only" boxes.
     - **Correct** obvious typos and grammatical errors in question prompts. The corrected prompt is what gets stored; the original wording lives in the change record's `beforeJson`.
     - **Rewrite** prompts that are ambiguous or telegraphically terse (e.g. "Years?" → "How many years have you been in this role?"). Only when the rewrite is high-confidence — when in doubt, leave the original and let the Phase 5 evaluation judges flag it.
     - **Augment** by inferring a sensible `type` and `typeConfig` from context (a question phrased "On a scale of 1-5..." becomes `likert` with the right scale).
     - **Merge** clearly-duplicate questions into one.
     - **Split** compound questions ("How long have you worked there and what's your role?") into two.
     - **Infer the questionnaire's overall goal** from the source document if one is discoverable (a stated purpose at the top of the document, or a clear theme across questions). Populated into `inferredGoal`. **Suppressed entirely if the admin supplied a goal on the upload form** — the admin's intent wins over inference.
     - **Infer audience characteristics** when discoverable from the document. The extractor may notice: "the document repeatedly addresses experienced engineers" → `role: 'Software engineers', expertiseLevel: 'expert'`; "the questionnaire mentions HIPAA in multiple places" → `sensitivity: 'high'`. Populated into `inferredAudience` as a partial object. **For each audience field individually, suppressed if the admin supplied that field** — partial overrides are honoured (the admin may have said "the role is engineers" but left expertise level for the agent to infer).
   - **Every editorial decision produces an `AppQuestionnaireExtractionChange` row** with the full five-field shape: `changeType`, `targetEntityType + targetEntityId`, `sourceQuote` (the relevant span from the document), `beforeJson` (the original or pre-correction state), `afterJson` (the post-decision state — null for `prune_*`), `rationale` (one short sentence). The change has `status: 'applied'` by default — the extracted structure already reflects it. The admin can revert any change later, which removes the change from the questionnaire (sees Phase 2's revert flow below).
   - **Conservative defaults.** When the extractor is uncertain whether a span is content or boilerplate, **keep it** rather than prune. Pruning is reversible (via the change log), but the admin reading the source document and not finding the questionnaire question they remember is a worse experience than the admin reading an extra unnecessary entry. Document the "lean toward keep" heuristic in `ingestion.md`.
   - The capability calls `parseDocument(buffer, fileName)` from `@/lib/orchestration/knowledge/parsers` if the input is a buffer rather than text; for the prototype's first cut, the route handler runs `parseDocument` and the capability gets `documentText`.
   - Provenance: each extracted question gets a `ProvenanceItem` (consumed from `@/lib/orchestration/provenance`) pointing at the `sourceQuote` from the document. Pruned content has provenance too — captured in the change record's `sourceQuote`.
   - Internally, the capability assembles a structured-extraction prompt and calls an LLM via Sunrise's provider manager. Use `runStructuredCompletion<T>` from `lib/orchestration/evaluations/parse-structured` to get the structured JSON back reliably. Look at how `lib/orchestration/capabilities/built-in/estimate-cost.ts` or `model-auditor` capability does LLM calls inside a capability — copy that pattern.

3. **Seed the capability row.** Create `lib/app/questionnaire/seeds/003-extraction-capability.ts` — upserts the `AiCapability` row for `app_extract_questionnaire_structure` following the `prisma/seeds/011-call-external-api.ts` pattern exactly. `executionType: 'internal'`, `executionHandler: 'AppExtractQuestionnaireStructureCapability'`, `category: 'app-questionnaire'`, `isSystem: false` (it's app-owned, not Sunrise built-in).

4. **Register the in-memory handler.** In `lib/app/questionnaire/capabilities/index.ts`, export a `registerAppQuestionnaireCapabilities()` function that calls `capabilityDispatcher.register(new AppExtractQuestionnaireStructureCapability())` (and will later register Phase 4's capabilities too). Phase 0 created an app-owned `instrumentation.ts` (or established the workaround); this phase wires the function into it.

5. **Implement the admin API routes** under `app/api/v1/app/questionnaires/`:

   - `POST /api/v1/app/questionnaires` — create a draft questionnaire. Body: `{ name, description?, goal?, audience?, slug? }` (slug auto-generated if missing; `goal` and `audience` are optional admin-supplied metadata that the Phase 5 evaluation judges and the Phase 6 conversational agent consume). Returns the questionnaire + an empty initial `AppQuestionnaireVersion`. Uses `withAdminAuth` and `validateRequestBody` from Sunrise's API helpers.
   - `POST /api/v1/app/questionnaires/:id/upload` — synchronous multipart upload (PDF, DOCX, MD; the document parser also handles TXT and CSV but they're not advertised in this phase).

     **The multipart payload accepts admin-supplied metadata alongside the document**: optional form fields `goal` (text), `audience.description`, `audience.role`, `audience.expertiseLevel`, `audience.estimatedDurationMinutes`, `audience.locale`, `audience.sensitivity`, `audience.notes`. Any supplied field is authoritative — the extractor will not overwrite an admin-supplied value with an inferred one. Any missing field is left for the extractor to infer (or remain null if the extractor can't infer it confidently). This means the admin has three patterns available: (a) "I know exactly what this questionnaire is for — here's the goal and audience, just extract the structure," (b) "I'm not sure, infer it for me," or (c) "I have a partial sense — here's the goal, infer the audience." All three work.

     **The upload flow consumes Sunrise's full document-ingestion lifecycle, not a simplified facsimile.** Specifically:

     - **PDFs go through `previewDocument()` then `confirmPreview()`** — the platform's upload route is a thin orchestrator that delegates the document-handling concerns to Sunrise.
     - **SHA-256 re-upload dedup** is inherited automatically by calling `previewDocument()` (Sunrise handles it). A demo presenter who re-uploads the prospect's tweaked document several times during demo prep gets the existing `pending_review` row refreshed in place, not a stack of duplicates clogging the admin UI.
     - **Per-page text-density check** runs as part of `previewDocument()`. If the document contains scanned pages, the preview response carries warnings flagging the page ranges. The platform's preview UI surfaces these prominently: "Pages 3-7 appear to be scanned images — no text extracted. Re-upload an OCR'd version if you need those pages." This prevents the worst live-demo failure mode (the extractor returns empty because the document was a scanned image, and the presenter doesn't realise until the empty structure surfaces).
     - **`extractTables=true` opt-in** is exposed as a form field on the upload route. The admin checkbox is "This document has tables I want extracted" — when checked, the route forwards `extractTables: true` to `previewDocument()` and tabular content lands in the preview as fenced markdown pipe tables. Default off because the table-extraction is slower; demo presenters know in advance whether the prospect's document has tabular sections.

     Flow:
     1. Receive multipart upload, read into a `Buffer`. Parse the metadata form fields against a Zod schema (the `audience` fields nest into a single object). Read the `extractTables` boolean form field (default false).
     2. **For PDFs**, call `previewDocument(buffer, fileName, userId, { extractTables })` from `@/lib/orchestration/knowledge/document-manager`. This handles SHA-256 dedup, per-page text-density analysis, optional table extraction. The route returns 200 with the document's preview response, including `pendingReviewDocumentId`, `extractedText`, `pages` (with `hasText` flags), `warnings` (scanned-page ranges, etc.), and `parsedSections`. The admin reviews the preview in the UI and re-POSTs with `?confirmed=true` and the `pendingReviewDocumentId` (plus the same metadata form fields) to proceed.
     3. **For DOCX / MD / TXT / CSV / EPUB**, call `parseDocument(buffer, fileName)` directly — these formats don't need a preview step because their text extraction is reliable. Proceed to step 5.
     4. **PDF confirmed path**: call `confirmPreview(pendingReviewDocumentId)` to finalise Sunrise's document ingestion (chunks and embeds the document if the platform also wants it queryable — see step 5 for whether the platform stores it as a knowledge document or only consumes the text). For the questionnaire extractor, the platform mainly needs `extractedText` — but persisting the document into Sunrise's knowledge base too means the conversational agent in Phase 6 can optionally search it later for domain context (an optional capability gated per-questionnaire).
     5. Call `capabilityDispatcher.dispatch('app_extract_questionnaire_structure', { documentText: parsed.fullText, fileName, mediaType, adminProvidedGoal, adminProvidedAudience }, { userId, agentId: <extraction agent ID> })`. The capability receives the admin-supplied values so it knows which fields to skip inferring. Persist sections, questions, per-question extraction confidence, the change records (as `AppQuestionnaireExtractionChange` rows on the version). Persist `goal` and `audience` to `AppQuestionnaire` using the **merge semantics**: for each field (goal, audience.description, audience.role, etc.), use the admin-supplied value if present in the request; otherwise use the extractor's inferred value if non-null; otherwise leave the existing DB value untouched. This means a second upload with new admin metadata doesn't blank out fields the extractor inferred on the first upload.
     6. Persist the raw upload bytes onto `AppQuestionnaireVersion.sourceDocumentBytes` for diff-against-source on re-upload (Phase 2 will use this).
     7. Return the populated version, including a `changes` array so the UI can immediately surface the review queue, plus the resolved `goal` and `audience` so the UI can confirm what landed (admin-supplied vs inferred — each field in the response is tagged with its provenance: `'admin-supplied' | 'inferred' | 'pre-existing'`).

     The 202 + polling fallback originally specified is dropped — Sunrise's preview-confirm lifecycle is the cleaner model. If a real async path is needed later (very large documents), it becomes a Phase 9 enhancement, not a Phase 1 requirement.
   - `GET /api/v1/app/questionnaires` — list, paginated, filterable by status. `withAdminAuth`.
   - `GET /api/v1/app/questionnaires/:id` — detail with current version, sections, questions, **plus a summary of extraction-change counts by status (`applied`, `reverted`) so the list page can show a "N changes pending review" badge, plus the current `goal` and `audience` JSON**. `withAdminAuth`.
   - `PATCH /api/v1/app/questionnaires/:id` — metadata updates (name, description, **goal**, **audience**). `withAdminAuth`. Calls `logAdminAction()` with before/after. `audience` updates are partial: passing `{ audience: { role: 'New role' } }` merges with the existing `audience` JSON rather than replacing it wholesale; passing `{ audience: null }` clears it entirely.
   - `DELETE /api/v1/app/questionnaires/:id` — soft delete by setting `deletedAt`. Refuse if any version is locked. Hard delete on drafts only if the operator passes `?force=true` (documented behaviour). Calls `logAdminAction()`.

   **Extraction-change review routes** (new in this phase):

   - `GET /api/v1/app/questionnaires/:id/versions/:versionId/extraction-changes` — list all extraction changes on this version. Returns `Array<AppQuestionnaireExtractionChange>` ordered by `changeType` then `createdAt`. Includes the pre/post state so the UI can render a comparison without further round-trips.
   - `POST /api/v1/app/questionnaires/:id/versions/:versionId/extraction-changes/:changeId/revert` — revert a change. Transactional: applies the inverse operation (re-inserts a pruned section/question from `beforeJson`, restores an un-corrected prompt, splits a merged question, etc.), updates the change's `status` to `reverted`, sets `revertedAt` and `revertedByUserId`, and goes through `applyEdit` from Phase 2's versioning module so locked-version reverts fork the version. Audit-logged with action `app_questionnaire.extraction_change.revert`.
   - `PATCH /api/v1/app/questionnaires/:id/versions/:versionId/extraction-changes/:changeId/restore` — re-apply a previously-reverted change. Symmetric to revert. Audit-logged.
   - **No "edit suggestion" route at the per-change level** — once an extraction change is applied, editing the *underlying entity* uses Phase 2's standard section/question PATCH routes. The change record is the audit trail of the original decision; the entity is the live truth. If the admin wants to revert and then re-edit, they revert (restoring the original) and then edit the original.

   All routes use Sunrise's existing `withAdminAuth` from `@/lib/auth/guards`, `validateRequestBody` from `@/lib/api/validation`, and `errorResponse` / similar from `@/lib/api/responses`. Ownership scoping uses 404-not-403. The prototype defines its own Zod schemas in `lib/app/questionnaire/types/` and imports them in route handlers.

6. **Generate embeddings on extracted questions.** After successful extraction, the route handler calls `embedBatch(questions.map(q => q.prompt + '\n' + (q.guidelines ?? '')))` from `@/lib/orchestration/knowledge/embedder`. This is a direct function call, not a capability dispatch. The returned vectors are persisted to `AppQuestionSlot.embedding`. Phase 4's adaptive strategy depends on this.

7. **Review-queue admin UI surface preparation.** Phase 1 doesn't ship the admin UI (that's Phase 2's job), but the upload-completion API response must include the change records so when Phase 2 builds the review queue tab, the data is already available. The Phase 1 plan must call out the cross-phase coordination: "Phase 2's questionnaire detail page gains an Extraction Review tab listing the change records produced here; this phase ensures the API returns them in a UI-ready shape."

8. **Test fixtures.** Three PDFs of increasing complexity (a simple 5-question flat questionnaire, a sectioned 20-question one, a 50-question one with mixed types), one DOCX, one Markdown file. **At least one of the fixtures must contain typos, grammar errors, a clearly-superfluous "for office use only" block, a compound question, and an obviously-redundant pair of questions** — so the extractor's editorial behaviour is exercised by the integration tests. Place under `tests/fixtures/app/questionnaire/`.

   **License note**: use synthetic content generated for this prototype (not real third-party surveys), and add a `README.md` to the fixtures directory explicitly stating "synthetic content for testing; no third-party content reproduced." This avoids any licensing entanglement when the repo is forked.

9. **Unit tests** at `tests/unit/lib/app/questionnaire/`:
   - `capabilities/extract-questionnaire-structure.test.ts` — capability behaviour with mocked LLM responses: well-structured document, document with no sections, document with sections but no questions, malformed document, document with deeply-nested numbering, document where the LLM returns inconsistent JSON. **Plus one fixture per change type: a document that triggers `prune_section`, one that triggers `correct_spelling`, one that triggers `merge_questions`, one that triggers `split_question`, one that triggers `infer_goal`, one that triggers `infer_audience` — each asserts the right change record is produced with the right `beforeJson` / `afterJson`.** **Plus three override-semantics tests: admin supplies `goal` only (extractor must not produce `infer_goal` change but may produce `infer_audience`); admin supplies `goal` AND full `audience` (extractor must produce neither inference change); admin supplies `audience.role` only (extractor may produce `infer_audience` for the unspecified fields but not for `role`).** Assert provenance shape, redaction behaviour (`processesPii` + `redactProvenance` round-trip), and confidence-score handling.
   - `extraction/revert.test.ts` — pure-function tests for the revert logic of each `changeType` against fixture state: revert of `prune_question` re-inserts the question at the right ordinal; revert of `correct_spelling` restores the original prompt; revert of `merge_questions` re-creates both questions; revert of `split_question` collapses back into one; revert of `infer_goal` clears the goal field (if and only if it currently matches the `afterJson`); revert of `infer_audience` clears only the fields recorded in `afterJson`, leaving other audience fields untouched.
   - `seeds/003-extraction-capability.test.ts` — seed unit runs cleanly against a mocked Prisma client, is idempotent, sets the right column values.
   - Type smoke tests for the API request/response Zod schemas.

10. **Integration tests** at `tests/integration/api/v1/app/questionnaires/`:
    - `create.test.ts` — `POST /api/v1/app/questionnaires` with valid body returns 201 + created row; with missing name returns 400; without admin auth returns 403; with non-admin user returns 403; with non-existent owner returns 404. Cover the optional `goal` and `audience` fields including partial `audience` payloads.
    - `upload.test.ts` — `POST /:id/upload` happy path for each format. PDF triggers the preview flow on first POST and the extraction flow on confirmed POST; DOCX and MD extract immediately. **Multipart payload variants tested: (a) document only — extractor infers everything; (b) document + admin-supplied goal only — extractor still infers audience; (c) document + full metadata — extractor produces no inference changes for goal or audience; (d) PDF preview flow with metadata — confirm step must re-submit the metadata.** Assert: extracted sections and questions are persisted to the current draft version; per-question `extractionConfidence` is populated; `AppQuestionSlot.embedding` is populated; `sourceDocumentBytes` is persisted; the audit log has the right entry; **the change records are persisted with status `applied`; `goal` and `audience` follow merge semantics; the response's per-field provenance tags (`'admin-supplied' | 'inferred' | 'pre-existing'`) are correct**.
    - `extraction-changes-list.test.ts` — `GET .../extraction-changes` returns the right shape and ordering; ownership scoping returns 404.
    - `extraction-changes-revert.test.ts` — revert each change type end-to-end against the corresponding fixture upload. Assert: the entity is correctly restored; `status: 'reverted'`; the audit log has the revert entry; locked-version revert forks (Phase 2's `applyEdit` flow).
    - `extraction-changes-restore.test.ts` — restore symmetric path.
    - `list.test.ts` — `GET /api/v1/app/questionnaires` pagination, filtering, ownership scoping.
    - `detail.test.ts` — `GET /api/v1/app/questionnaires/:id` returns full version detail and the extraction-change summary; 404 for non-existent; 404 for not-owner.
    - `patch.test.ts` — `PATCH` updates metadata (including `goal` and `audience`) and produces an audit-log row. Cover audience partial-merge (passing `{ audience: { role: 'X' } }` preserves other audience fields) and audience-clear (passing `{ audience: null }` empties it).
    - `delete.test.ts` — soft delete with `deletedAt`; refusal when version is locked; `?force=true` for hard delete on drafts.
    - `capability-registration.test.ts` at `tests/integration/lib/app/questionnaire/` — seeds the capability row, instantiates the dispatcher, asserts the capability is discoverable post-registration and `dispatch()` returns a well-shaped result with mocked LLM call inside.

11. **End-to-end test** — not applicable in the Playwright sense (no UI yet). Section (j) of the plan should state: "Not applicable — Phase 1 is API-only. Cross-route flow is exercised by `upload.test.ts` and `extraction-changes-revert.test.ts` in the integration suite." If Sunrise's Playwright dep has landed by the time this phase runs, add a single browser-driven curl-equivalent E2E that uploads a fixture via HTTPS and asserts the response shape; otherwise omit.

12. **Documentation** at `.context/app/questionnaire/`:
    - `ingestion.md` — describes the extraction agent's persona and the chosen model, the capability's input/output contract, the document parsers consumed from Sunrise, the PDF preview-then-confirm flow, the embedding step, the chosen `costPerExecutionCapUsd`, **the extractor's editorial decisions (pruning / correcting / rewriting / augmenting / merging / splitting / inferring goal / inferring audience), the admin-supplied-vs-inferred override semantics (admin wins per field, partial overrides honoured), the upload-time multipart-payload metadata fields, the merge-on-PATCH semantics for `audience`, the "lean toward keep" heuristic for boundary cases, the change-record model, and how the admin reverts a change**, and links to the canonical Sunrise files used as patterns.
    - **`extraction-changes.md`** — new file. Catalogue of every `changeType`, what triggers it, what the `beforeJson` / `afterJson` shape is, how revert works for each, what audit-log action is produced. Reference material for both the engineer building Phase 2's review UI and the admin reading the audit trail later.
    - Update `overview.md` to reflect the new module layout (capabilities, seeds, extraction-change endpoints).
    - Update `upstream-gaps.md` with any newly discovered findings.

## Expected upstream findings (section (c) of your plan)

Phase 1 is likely to discover fewer new findings than Phase 0 — most of the structural gaps were named there. But expect to surface at least:

1. **`processesPii` capabilities have no automated PII-redaction helper.** Sunrise's `BaseCapability` requires authors to override `redactProvenance()` by hand. Sunrise could expose a `defaultPiiRedaction()` utility. **Severity:** C.
2. **The capability seed pattern is repetitive across all built-ins.** A `seedCapabilityFromClass(CapabilityClass)` helper that reads slug + function definition from the class would reduce boilerplate. **Severity:** C.
3. **No public "run a capability standalone from a route handler" entry point** is documented — calling `capabilityDispatcher.dispatch(slug, args, context)` directly is the de-facto pattern but isn't documented as such. Sunrise could add a `.context/orchestration/capabilities.md` section ("invoking a capability outside the chat handler"). **Severity:** C.
4. **PDF upload preview behaviour is inconsistent across consumers.** Sunrise's knowledge ingestion uses one flow; the prototype implements a similar one independently. Sunrise could lift a shared `preparePdfUpload(buffer, fileName)` helper. **Severity:** C.

Plus anything Phase 0 deferred surfaced (sidebar, package.json deps, etc.) is **not re-raised in Phase 1** — `upstream-gaps.md` already carries them.

## Definition of done

- An admin user can `curl POST` a fixture PDF (with `?confirmed=true` after preview) and receive a populated questionnaire version with sections, questions, per-question extraction confidence, embeddings populated, **and a `changes` array reflecting every editorial decision the extractor made (prunings, corrections, merges, splits, type inferences, goal and audience inference)**.
- An admin user can `curl POST` a fixture DOCX or MD and receive a populated questionnaire version directly (no preview step), same shape.
- **An admin user can `curl GET` the extraction-changes endpoint to review what the extractor did, `curl POST` the revert endpoint to undo a specific change, and `curl PATCH` the restore endpoint to re-apply it.**
- **The admin can supply `goal` and structured `audience` metadata on the upload form (or at creation time). When supplied, the extractor honours them and does not produce inference changes for those fields. When not supplied (or partially supplied), the extractor infers what it can from the source document and records each inference as an `infer_goal` or `infer_audience` change record — admins can revert any individual inference.**
- **When the source document contains a discernable overall purpose, `AppQuestionnaire.goal` is auto-populated on first upload (only if not admin-supplied and previously null) so the Phase 5 evaluation judges have something to evaluate against.**
- All Phase 1 unit tests pass.
- All Phase 1 integration tests pass.
- `.context/app/questionnaire/ingestion.md` and `extraction-changes.md` are written and committed; `overview.md` updated; `upstream-gaps.md` updated with Phase 1 findings.
- The Phase 1 seeds run cleanly via `tsx lib/app/questionnaire/seeds/run.ts` and are idempotent.
- The extraction capability is registered at app startup (via the prototype's `registerAppQuestionnaireCapabilities()` call wired from `instrumentation.ts`) and is discoverable via `capabilityDispatcher.dispatch('app_extract_questionnaire_structure', ...)`.
- Zero Sunrise-owned files modified beyond the comment-fenced section established in Phase 0.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.
```

---

## Phase 2 — Admin CRUD over questionnaires

```
We are starting Phase 2 of the Conversational Questionnaire prototype: admin CRUD over extracted questionnaires.

[paste the shared context block from above]

This phase lets an admin manage everything extraction produced — edit sections and questions, reorder them, bump versions, and see version history. **Admin UI lands in this phase**, at `app/admin/questionnaires/` (a new sibling under Sunrise's existing `app/admin/` tree — there is no extra `app/` sub-namespace because Sunrise's admin pages don't use one).

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`app/admin/layout.tsx`** — confirm that every page under `app/admin/` automatically inherits `<AdminSidebar />` and `<AdminHeader />`. The prototype's pages at `app/admin/questionnaires/...` get the Sunrise admin shell for free.
2. **`components/admin/admin-sidebar.tsx`** — confirm that `navSections` is a hardcoded array. The prototype cannot add a "Questionnaires" entry without editing this file. This is the critical Phase 2 decision flagged in Phase 0.
3. **`app/admin/orchestration/agents/[id]/page.tsx`** (and any neighbouring `versions/` page or component) — read the canonical pattern for showing an entity with version history. The Before/After diff for `AiAgentVersion` uses `diffAgentSnapshots()` from `lib/orchestration/agent-version-diff.ts` — a pure helper, not a React component. The prototype writes its own diff *renderer* but reuses the diff *computation pattern* by writing an analogous `diffQuestionnaireSnapshots()` helper.
4. **`lib/orchestration/agent-version-diff.ts`** — read in full as the pattern for the prototype's `diffQuestionnaireSnapshots()`.
5. **`lib/orchestration/audit/admin-audit-logger.ts`** — confirm `logAdminAction({ userId, action, entityType, entityId, entityName, changes, metadata? })` and the `changes` shape (`Record<string, { from: unknown; to: unknown }>`). The `computeChanges()` helper exported from the same file is also useful.
6. **`app/api/v1/admin/orchestration/agents/[id]/route.ts`** — canonical PATCH-with-versioning pattern: how to compute changes, when to fork a version, how to write the audit log.
7. **`package.json`** — confirm no general drag-and-drop library is installed. `@dnd-kit/*` is not present; reordering will require either a new dep (Sunrise file edit, upstream finding) or an arrow-button-based reorder UI.
8. **`components/ui/`** — confirm shadcn primitives available (button, dialog, form, input, select, tabs, table, accordion, etc.). The prototype consumes these freely.
9. **`components/admin/orchestration/`** — skim a couple of detail pages and their `_components/` directories to see the conventions for sub-components (filename casing, import style, server/client split).

## Goals for this phase

1. **Implement the admin API routes**, all under `app/api/v1/app/questionnaires/`:

   - Sections:
     - `POST /:id/versions/:versionId/sections` — create
     - `PATCH /:id/versions/:versionId/sections/:sectionId` — edit name, description, ordinal
     - `DELETE /:id/versions/:versionId/sections/:sectionId` — refuse with 409 if questions still attached unless `?cascade=true`
     - `POST /:id/versions/:versionId/sections/reorder` — batch reorder; body `{ orderedIds: string[] }`; transactional
   - Questions:
     - `POST /:id/versions/:versionId/questions` — create
     - `PATCH /:id/versions/:versionId/questions/:questionId` — edit prompt, guidelines, rationale, type, typeConfig, required, weight, ordinal, sectionId
     - `DELETE /:id/versions/:versionId/questions/:questionId` — refuse with 409 if answers exist against this question on a locked version (in a launched version, questions cannot be deleted because answers exist — the admin must fork a new version, see below)
     - `POST /:id/versions/:versionId/questions/reorder` — batch reorder; transactional
   - **Tags** (per-questionnaire-version custom tag vocabulary that admins can apply to questions; the tag set and the applications are both version-scoped, so when a version is forked the tags and their applications fork with it):
     - `GET /:id/versions/:versionId/tags` — list all tags defined on this version, ordered by `ordinal`. Each row includes the count of questions currently tagged.
     - `POST /:id/versions/:versionId/tags` — create a tag. Body: `{ key: string, label: string, description?: string, colour?: string }`. `key` must be unique within the version (slug-style, validated against `^[a-z0-9-]+$`); 409 on duplicate. Ordinal auto-assigned as `max + 1`. Goes through `applyEdit` so locked-version creates fork.
     - `PATCH /:id/versions/:versionId/tags/:tagId` — edit any field: `key`, `label`, `description`, `colour`, `ordinal`. All fields are freely editable. Renaming `key` is safe because applications (`AppQuestionSlotTag`) reference `tagId`, not `key` — the rename is a cosmetic update with no cascade required. The unique-per-version constraint on `key` is still enforced (409 on a rename that collides with another tag in the same version). Goes through `applyEdit` so locked-version edits create a fork.
     - `DELETE /:id/versions/:versionId/tags/:tagId` — delete a tag and cascade-remove all `AppQuestionSlotTag` rows for it. Goes through `applyEdit`. Audit-logged with the cascade count in `metadata`.
     - `POST /:id/versions/:versionId/tags/reorder` — batch reorder using the same shape as section/question reorder.
   - **Tag applications** (the many-to-many between questions and tags within a version):
     - `PUT /:id/versions/:versionId/questions/:questionId/tags` — replace the entire tag set on a question. Body: `{ tagIds: string[] }`. Validates every tagId belongs to the same `versionId` as the question (the cross-table version-scope check that the schema cannot enforce — application-layer guard returning 400 on mismatch). Atomic: deletes all existing `AppQuestionSlotTag` rows for the question, then inserts the new set. Goes through `applyEdit`. Audit log captures the before/after tag-id set.
     - `POST /:id/versions/:versionId/questions/:questionId/tags/:tagId` — additive: attach a single tag to a question. Idempotent (re-attach is a no-op, returns 200 not 409).
     - `DELETE /:id/versions/:versionId/questions/:questionId/tags/:tagId` — remove a single tag from a question.
     - `GET /:id/versions/:versionId/tags/:tagId/questions` — list all questions currently tagged with this tag, ordered by section ordinal then question ordinal. Useful for the admin "what's in this tag" view.
   - Versions:
     - `POST /:id/versions` — explicit version bump: clones current version's sections/questions/config **and tags and tag applications** into a new draft version. Returns the new version.
     - `GET /:id/versions` — version list with diff summaries (count of added/removed/changed sections, questions, **and tags** vs the predecessor).
     - `GET /:id/versions/:versionId` — historical version detail.
     - `GET /:id/versions/:versionId/diff/:otherVersionId` — structured diff produced by `diffQuestionnaireSnapshots()` (Phase 2's new helper, modelled on `diffAgentSnapshots()` from `lib/orchestration/agent-version-diff.ts`). The diff covers sections, questions, config, **tag-set changes (added / removed / renamed tags)**, **and per-question tag-application changes (which questions gained or lost which tags)**.

   All routes use `withAdminAuth`, `validateRequestBody` with prototype-owned Zod schemas, and Sunrise's error response helpers. Ownership scoping returns 404 not 403.

2. **Implement `lib/app/questionnaire/versioning/`** as a pure, platform-agnostic module:

   - `isVersionLocked(version)` — returns true if the version has any sent invitation, any session in any state, or `isLocked: true` set explicitly. (Phase 3 sets the explicit lock flag at invitation-send time; Phase 6 onwards can also lock via session creation.)
   - `forkVersion(prisma, versionId, editorUserId)` — atomic transaction that clones a version forward: new `AppQuestionnaireVersion` row with `versionNumber + 1`, cloned `AppQuestionnaireSection` rows, cloned `AppQuestionSlot` rows (including embeddings — embeddings can be reused if the prompt didn't change; re-embed inside the same transaction if it did), cloned `AppQuestionnaireConfig` row, **cloned `AppQuestionTag` rows** (new tag IDs in the forked version, preserving `key` / `label` / `description` / `colour` / `ordinal`), **cloned `AppQuestionSlotTag` pivot rows** mapped from old-tag-id → new-tag-id and old-question-id → new-question-id so applications are preserved across the fork, and **cloned `AppQuestionnaireExtractionChange` rows** preserving their `status` so the review queue history travels with the version (the `targetEntityId` references inside the cloned changes are remapped from old-question-id → new-question-id and old-section-id → new-section-id; the `AppQuestionnaireEvaluationLink` and `AppQuestionnaireSuggestionReview` rows are NOT cloned — evaluation results are scoped to the run that produced them against a specific structure, and a forked version should be re-evaluated; Phase 5 explains the rationale). Returns the new version's ID.
   - `applyEdit(prisma, versionId, edit, editorUserId)` — the wrapper every edit route calls. If `isVersionLocked(version)` returns true, calls `forkVersion()`, applies the edit to the new version, returns `{ newVersionId, forked: true }`. Otherwise applies the edit in place, returns `{ versionId, forked: false }`. Either way, calls `logAdminAction()` with `entityType: 'app_questionnaire_version'`, the before/after, and metadata indicating whether a fork happened.

   The whole module is unit-testable with a mocked Prisma client; the route layer just calls into it.

3. **Audit log integration.** Every edit route calls `logAdminAction({ userId, action, entityType, entityId, entityName, changes, metadata })` where `changes` is a `Record<string, { from, to }>` map computed via `computeChanges()` from `@/lib/orchestration/audit/admin-audit-logger` (a public helper). `action` follows a stable pattern: `app_questionnaire.section.create`, `app_questionnaire.question.update`, `app_questionnaire.tag.create`, `app_questionnaire.tag.update`, `app_questionnaire.tag.delete`, `app_questionnaire.tag.apply`, `app_questionnaire.tag.unapply`, `app_questionnaire.question.tags.replace`, `app_questionnaire.version.fork`, etc.

4. **Re-generate embeddings on question prompt or guidelines change.** When a `PATCH` to a question changes `prompt` or `guidelines`, the route handler calls `embedText(newPromptPlusGuidelines)` from `@/lib/orchestration/knowledge/embedder` and updates `AppQuestionSlot.embedding`. Debouncing is unnecessary at the API layer — each PATCH is a discrete user action; if Phase 2's admin UI debounces field edits client-side (e.g. autosave after 2s of inactivity), the embed call follows the autosave naturally. Drop the "debounce" wording — it was over-engineered. Note this re-framing in section (l) for operator confirmation.

5. **Admin UI** at `app/admin/questionnaires/`:

   - `app/admin/questionnaires/page.tsx` — list page. Table of all questionnaires: name, current version number, status, session count placeholder (Phase 8), action menu (view, archive, delete). Uses shadcn's `<Table>` primitive from `components/ui/table.tsx`. Inherits the Sunrise admin shell from `app/admin/layout.tsx` automatically.

   - `app/admin/questionnaires/[id]/page.tsx` — detail page with shadcn `<Tabs>`:
     - **Sections** tab: list of sections under the current version, with Create/Edit/Delete actions per section and a Reorder mode. **Reordering uses up/down arrow buttons** rather than drag-and-drop, since Sunrise has no DnD library installed. This is a documented Severity-B finding — Sunrise should add `@dnd-kit/core` so reorder UIs across the platform can be unified; until then, arrow buttons are the workaround.
     - **Questions** tab: same arrow-button reorder, grouped by section, with type-specific edit forms for each question type (Likert scale config, multi-choice options editor, numeric bounds). Each question row in the list view shows its currently-applied tags as small coloured chips (using the tag's `colour` field when set, neutral grey when null) — so the admin can scan tag coverage at a glance. The question editor form has a "Tags" section: a multi-select (shadcn `<Command>`-based combobox) listing all tags on the version, with a "Create new tag" affordance that opens a small inline tag-creation dialog (saves via `POST .../tags`). Saving the question fires `PUT .../questions/:id/tags` with the full updated tag set. Uses shadcn `<Form>`, `<Input>`, `<Select>`, `<Textarea>`, `<Switch>`, `<Command>`, `<Popover>`, `<Badge>` from `components/ui/`.
     - **Tags** tab: dedicated management surface for the version's tag vocabulary. Shows a table of all tags with columns: label (with the colour chip), key, description, ordinal, "applied to" count. Per-row actions: edit (modal with the same form as the inline creator), delete (confirms with the cascade count: "This will remove the tag from N questions"), reorder (arrow buttons). "Create tag" button opens the same modal blank. A side panel can be toggled per row to show "Questions tagged with this tag" — calls `GET .../tags/:id/questions` and renders a clickable list that navigates to the Questions tab with that question selected.
     - **Extraction Review** tab — **new in this phase, consumes the change records from Phase 1's upload**. Lists every `AppQuestionnaireExtractionChange` row for the version, grouped by `changeType` with collapsible sections (Prunings, Corrections, Rewrites, Merges/Splits, Augmentations, Goal Inference). Each row shows: rationale, source quote (with a "show in original document" link if the source bytes are available), a side-by-side before/after view, status badge (`applied` / `reverted`), and a "Revert" or "Restore" action button. Includes a count badge on the tab header ("12 changes, 3 reverted") so the admin always knows there's editorial history. Empty-state copy when no changes exist ("This questionnaire was loaded without editorial changes"). The whole tab is read-only on locked versions except the revert/restore actions, which trigger `applyEdit` and may fork.
     - **Design Suggestions** tab: shows "Design suggestions appear in Phase 5" placeholder (the design-time evaluation surface lives there).
     - **Config** tab: shows "Configuration appears in Phase 3" placeholder.
     - **Sessions** tab: shows "Sessions appear in Phase 8" placeholder.
     - **Analytics** tab: shows "Analytics appear in Phase 8" placeholder.
     - **Versions** tab: version list with diff summary per row (added/removed/changed counts across sections, questions, **and tags**), click into a historical version to see its frozen state, "Compare with current" button that calls `GET /:id/versions/:versionId/diff/:otherVersionId` and renders the structured diff. The diff component is prototype-owned, built from `diffQuestionnaireSnapshots()` output — modelled on the Sunrise agent version diff pattern but rendered with the prototype's own component since the existing Sunrise component is internal to the agent admin page. The diff renderer surfaces tag-set deltas and per-question tag-application deltas as discrete sections so the admin can see "Tag X was added to 7 questions in this version" at a glance.

     **Goal and audience metadata**: the questionnaire's top-level metadata panel (above the tabs) shows the editable `goal` paragraph and a structured **audience editor** — a collapsible section exposing the seven `audience` fields (description, role, expertise level, estimated duration, locale, sensitivity, notes) as form inputs (text areas for `description` and `notes`; a text input for `role` and `locale`; `<Select>` for `expertiseLevel` and `sensitivity`; a number input for `estimatedDurationMinutes`). Each field shows a small badge indicating its provenance from the most recent upload (`'admin-supplied'`, `'inferred'`, `'pre-existing'`) so the admin can see which values came from where. Edits save via `PATCH /api/v1/app/questionnaires/:id` with partial-merge semantics on `audience`. Both `goal` and `audience` are populated by extraction if auto-inferred (and not admin-supplied at upload), edited freely thereafter, and consumed by the Phase 5 evaluation judges.

   - `app/admin/questionnaires/_components/` — prototype-owned sub-components (reorder list, question editor by type, section editor, **tag editor modal**, **tag chip component**, **tag multi-select combobox**, **extraction-change card**, **before/after diff renderer**, version diff renderer, etc.).

6. **Admin sidebar entry.** This is the Phase 0 decision arriving: the operator-chosen workaround applies here.

   - **If operator accepted smallest-possible-breach:** add one entry to `navSections` in `components/admin/admin-sidebar.tsx`, wrapped in the same comment fence used in Phase 0's `prisma/schema.prisma` breach. Section (c) documents the breach explicitly.
   - **If operator chose app-owned admin layout:** the prototype's admin pages live under `app/admin/questionnaires/(app-shell)/` (a route group) with a parallel `layout.tsx` that wraps them in a different shell, accessed via a top-level link the operator manually navigates to (e.g. a card on `/admin/overview/page.tsx` — but that's also Sunrise-owned, so this option is more awkward than it first looks).
   - **If operator chose to defer:** Phase 2 ships APIs only, no UI; UI is pulled into Phase 3 or held until Sunrise adds a sidebar registry.

   Phase 0's plan should have surfaced this decision. If the operator hasn't decided yet, Phase 2's plan must request the decision before any UI work begins.

7. **Cascade behaviour for question delete on launched versions.** Earlier text said "DELETE question — refuse if answers exist." But on a launched version, answers will always exist eventually. The corrected behaviour:
   - On a draft (unlocked) version: delete the question outright.
   - On a launched (locked) version: the route returns 409 with `{ error: 'version_locked_use_fork', message: '...' }`. The admin UI surfaces this as "This question can't be deleted in the current launched version. Fork a new version to make this change." Pressing Fork triggers `POST /:id/versions` to clone, then re-attempts the delete on the new draft.

   This makes the locked-version semantics explicit in the API rather than a UI workaround.

8. **Unit tests** at `tests/unit/lib/app/questionnaire/versioning/`:
   - `isVersionLocked.test.ts` — every lock-condition variant: no invitations + no sessions + no explicit lock (false); one sent invitation (true); one in-progress session (true); zero sessions but `isLocked: true` (true); etc.
   - `forkVersion.test.ts` — clone correctness: sections and questions are copied with new IDs, embeddings are preserved when prompt unchanged, config is copied, **tags are cloned with new IDs preserving key/label/description/colour/ordinal**, **tag applications are cloned with the correct old→new ID remapping (every old `AppQuestionSlotTag` row has a corresponding row in the new version pointing at the new question ID and the new tag ID)**, the new version number is `previous + 1`, the transaction rolls back on partial failure.
   - `applyEdit.test.ts` — in-place vs fork branching given the four lock-state permutations. Includes tag edits (create/update/delete) and tag-application edits in the matrix.
   - `diffQuestionnaireSnapshots.test.ts` — pure helper unit tests for added/removed/changed entries across sections, questions, config, **tag set (added/removed/renamed tags)**, **and tag applications (which questions gained/lost which tags)**.
   - `typeConfig.test.ts` — Zod schemas for each question type's `typeConfig` (free_text bounds, single_choice/multi_choice options, likert scale 1-N, numeric min/max with min≤max constraint, date min/max).
   - `tags/validate-tag-key.test.ts` — key validation regex (`^[a-z0-9-]+$`), uniqueness-within-version check on create and on rename (409 on collision), key rename succeeds even when the tag has applications (applications reference `tagId`, not `key`, so no cascade is needed — verify by asserting application rows are untouched after a rename).
   - `tags/cross-version-guard.test.ts` — application-layer guard that rejects a tag application where `tag.versionId !== question.versionId` (the cross-table check the schema cannot express).

9. **Integration tests** at `tests/integration/api/v1/app/questionnaires/`:
   - For every CRUD route, the standard matrix: success with valid input, 400 on invalid input, 401/403 on auth failures, 404 on missing entity, 404 on ownership scope.
   - `fork-on-locked-edit.test.ts` — edit to a locked version triggers a fork, returns the new version ID, and the audit log has both the fork entry and the edit entry. Cover a tag-edit and a tag-application-edit as fork triggers in addition to the section/question edits.
   - `section-delete-cascade.test.ts` — refuses without `?cascade=true` when questions exist; succeeds with it.
   - `question-delete-locked.test.ts` — returns 409 with the right error code on a locked version; the admin can fork and then delete on the new draft.
   - `reorder-atomicity.test.ts` — two concurrent reorder requests don't corrupt ordinals; transactional rollback on failure. Cover section reorder, question reorder, **and tag reorder**.
   - `audit-log.test.ts` — every mutation produces an `AiAdminAuditLog` row with the expected `action`, `entityType`, and `changes` shape. Cover all the new tag actions (`tag.create`, `tag.update`, `tag.delete`, `tag.apply`, `tag.unapply`, `question.tags.replace`).
   - `tags-crud.test.ts` — full CRUD over `AppQuestionTag`: create with valid/invalid key, duplicate-key 409 on create, rename `key` succeeds and applications remain intact, rename `key` to a colliding key returns 409, update label/colour/description/ordinal, delete with cascade application-count in audit metadata.
   - `tag-applications.test.ts` — `PUT .../questions/:id/tags` replaces atomically; partial-set update (additive POST, removal DELETE) correctness; cross-version tagId in body returns 400; idempotent re-attach; the `GET .../tags/:tagId/questions` endpoint returns the right ordered list.
   - `tags-clone-on-fork.test.ts` — end-to-end: create tags on a draft version, apply them to questions, send an invitation (locking the version), edit a question (triggering a fork), assert the forked version has its own copy of tags and applications correctly remapped to new IDs.

10. **Component tests** at `tests/integration/app/admin/questionnaires/`:
    - List page renders with mocked API responses, filter and search work, action menu opens.
    - Detail page tabs switch, question editor renders the right form for each type, arrow-button reorder produces the expected API call sequence.
    - **Tags tab** renders tag table, opens the create/edit modal, fires the right API calls on save, the cascade-count confirmation appears on delete.
    - **Question editor** shows currently-applied tags as chips, opens the multi-select combobox, inline tag creation works, saving fires the right `PUT .../tags` payload.
    - **Extraction Review tab** renders change cards grouped by type, opens the before/after diff view, "Revert" fires `POST .../extraction-changes/:id/revert` and updates the row status, "Restore" fires the symmetric `PATCH .../restore`, empty-state copy appears when no changes exist, the tab badge shows the right counts.
    - **Goal field** above the tabs is editable, saves via `PATCH /api/v1/app/questionnaires/:id`, surfaces validation errors.
    - **Audience editor** above the tabs renders the seven structured fields, shows the per-field provenance badge, partial-merge save sends only the changed fields, clear-audience action sends `{ audience: null }`.
    - Version diff renderer displays added/removed/changed entries with the right visual treatment, **including the tag-set delta section and per-question tag-application delta section**.

11. **End-to-end test** — without Playwright, this is a Vitest integration test wrapping the route handlers with `next-test-api-route-handler` or equivalent (whatever pattern Sunrise's existing integration tests use; confirm by reading `tests/integration/api/v1/admin/orchestration/agents.test.ts`). The test exercises: admin uploads a fixture questionnaire (calls Phase 1's `/upload` route) **that exercises every extraction-change type — the fixture deliberately contains typos, a redundant question pair, a compound question, and an "office use only" boilerplate block**, observes the Extraction Review tab listing each change, **reverts one specific change (e.g. the merge of duplicates), asserts both questions are back in the structure with the correct ordinals**, then edits a question's prompt via Phase 2's `PATCH`, creates two tags and applies them to a handful of questions, observes the audit log entries, edits another question after simulating an invitation send (which locks the version) and asserts the fork happened **with tags, applications, AND extraction-change records correctly cloned**, then fetches the version history and asserts the diff is correct (including tag deltas).

12. **Documentation** at `.context/app/questionnaire/`:
    - `admin-api.md` — every admin API route from Phases 1 and 2 with method, path, request shape, response shape, auth, error cases, audit-log action name. Living reference, updated each phase. Includes the full tag CRUD + tag application surface, and the extraction-change revert/restore routes.
    - `versioning.md` — the in-place vs fork rules, the lock conditions, the fork algorithm (now including tag, tag-application, and **extraction-change** cloning with the old→new ID remapping detail), the audit-log entries produced. References `lib/orchestration/agent-version-diff.ts` as the pattern source.
    - `admin-ui.md` — page structure under `app/admin/questionnaires/`, tab contents (including the new Tags tab, the **Extraction Review tab with its revert/restore UX**, and the tag affordances inside the Questions tab), the editable Goal metadata field, component breakdown, reorder UX (arrow buttons with the DnD-library finding documented).
    - `tags.md` — dedicated reference for the tags feature: data model (`AppQuestionTag`, `AppQuestionSlotTag`), the per-version scoping rule and why the cross-table version-scope check lives at the application layer rather than in the schema, the editability rules (all tag fields freely editable; `key` rename is safe because applications reference `tagId`; unique-per-version `key` constraint enforced), the cascade-on-delete behaviour, the fork-clone-with-ID-remap algorithm, the admin UX (Tags tab + chips on questions + multi-select in the question editor), and the analytics filter integration in Phase 8. Includes a future-enhancements section noting that Phase 4 selection strategies could also consume tags for prioritisation — explicitly out of scope for the current phased plan.
    - Update `overview.md`. Update `upstream-gaps.md`.

## Expected upstream findings (section (c) of your plan)

1. **No general drag-and-drop library** (`@dnd-kit/core` or similar) is installed. Sunrise should add one. Prototype workaround: arrow-button reorder. **Severity:** B.
2. **The agent version diff React component is page-internal**, not exported. Sunrise could lift it to a generic `components/ui/version-diff.tsx` consuming the pure `diffXxxSnapshots()` output. **Severity:** C.
3. **Sidebar entry registration** — already a Phase 0 finding; restate the operator's chosen workaround here without re-flagging.
4. **`computeChanges()` is exported but undocumented in `.context/orchestration/`.** Sunrise could add a section to the orchestration audit doc. **Severity:** C.

## Definition of done

- Admin can navigate to `/admin/questionnaires`, see the list, click into one, see all tabs, edit sections and questions in a draft (in-place), edit in a locked version (auto-fork), and view a version diff.
- **Admin can create a per-questionnaire-version custom tag vocabulary, edit and delete tags, apply tags to questions (singly and in bulk via the question editor), and see tag chips on questions in the Questions tab.**
- **Forking a version cleanly clones tags and tag applications with old→new ID remapping verified by an integration test.**
- **Version diffs surface tag deltas (set changes and per-question application changes).**
- All API routes return the right shapes and audit-log entries on every mutation, including the new tag actions.
- All Phase 2 unit, integration, and component tests pass.
- `.context/app/questionnaire/admin-api.md`, `versioning.md`, `admin-ui.md`, and `tags.md` are written and committed; `overview.md` and `upstream-gaps.md` updated.
- Zero new Sunrise-owned files modified beyond Phase 0's already-acknowledged breach (and the sidebar `navSections` entry, if the operator chose smallest-possible-breach for it).

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.
```

---

## Phase 2.5 — Demo clients and theming

````
We are starting Phase 2.5 of the Conversational Questionnaire prototype: demo-client tenancy and per-client theming.

[paste the shared context block from above]

This is an inserted phase between Phase 2 and Phase 3. The decimal numbering preserves the document's existing cross-references to Phases 3-9 without renumbering. It is a small, focused phase but it touches both the schema (additive) and the user-facing UI (themeable) in a way that all later phases need to know about.

**Scope clarification — what "demo tenancy" means here.** This phase serves the sales-demo intent: the platform is used to show a prospective client what a real Agentic Sunrise-built questionnaire feels like for *them*. When a prospect is shown a demo, the questionnaire should be attributable to that client (their name in the admin UI, their logo on the user-facing pages) and the user-facing UI should be branded in their colours and fonts. This is **not multi-tenancy as a security boundary** — the platform is not partitioning data physically, not enforcing cross-tenant access prevention, not implementing row-level security.

**For a fork into a real client engagement**, the entire `AppDemoClient` model and the theming module are demo-only (they carry the `// DEMO-ONLY:` marker per ground rule 13). The fork either deletes them entirely (single-tenant production: brand the app shell to the one client) or replaces them with proper multi-tenancy including row-level security and a real tenant identity model. Phase 9's `forking.md` walks through both replacement paths.

This phase is therefore an attribution and branding overlay, designed for the demo workflow, with clean removal in mind.

That framing matters because it scopes the work tightly. We don't need RLS policies, we don't need per-tenant database connections, we don't need provider-level isolation. We need: a `client` row, a foreign key on `AppQuestionnaire`, a small admin CRUD surface, and a theming mechanism that overrides CSS variables on the user-facing pages.

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`app/globals.css`** — confirm Sunrise's CSS-variable theming approach: the `@theme` block declares the variables (`--color-primary`, `--color-background`, etc.) that all shadcn components and Tailwind utilities consume. This means per-client theming is just **overriding these variables in a layered stylesheet on the user-facing pages** — no JavaScript theme provider, no custom component wrapper, no Sunrise file edits. Inline `<style>` injected at the top of the prototype's user-facing layout is sufficient.
2. **`hooks/use-theme.tsx`** — confirm Sunrise's `ThemeProvider` is a light/dark toggle, orthogonal to per-client branding. The two coexist: light/dark stays as Sunrise's mechanism; client branding overrides specific colour variables on top.
3. **`lib/storage/client.ts`** and **`lib/storage/upload.ts`** — confirm `getStorageClient()` and the surrounding upload helpers. `uploadAvatar()` is hardcoded for the avatars path and forces JPEG; the prototype writes its own small `uploadClientLogo()` helper using `getStorageClient().upload(buffer, options)` directly (a public method) so logos can be PNG or SVG.
4. **`lib/storage/image.ts`** — confirm `processImage()` and `validateImageMagicBytes()` are public. The prototype reuses them for logo validation + processing.
5. **`lib/storage/constants.ts`** — confirm `SUPPORTED_IMAGE_TYPES`. SVG may not be in the list (SVG validation is a security concern because of embedded scripts) — if so, the prototype either supports raster only (PNG / JPEG / WebP) or implements its own SVG-sanitisation step. Recommend raster-only for the prototype; flag SVG support as future enhancement.
6. **`emails/invitation.tsx`** — re-confirm the React-Email pattern. Phase 3's invitation email already exists; Phase 2.5 makes it client-aware.
7. **`prisma/schema.prisma`** — re-confirm the prototype's `AppQuestionnaire` model from Phase 0 so the new nullable foreign key to `AppDemoClient` slots in cleanly.

## Goals for this phase

1. **Add the `AppDemoClient` model** to the prototype's comment-fenced section in `prisma/schema.prisma`. **The model is annotated with the `// DEMO-ONLY:` schema comment from ground rule 13** so a forking team grepping the schema sees it immediately:

   ```prisma
   /// DEMO-ONLY: demo-tenancy attribution + branding overlay, not a security boundary.
   /// FORK-GUIDANCE: see .context/app/questionnaire/forking.md § "Replacing demo tenancy"
   /// for the three replacement paths (delete entirely, rename to AppTenant with RLS,
   /// or keep as AppBrand without demo-only marker).
   model AppDemoClient {
     // ...fields below
   }
````

Fields:

- `id` (cuid)
- `slug String @unique` — URL-safe, used in admin URLs and in invitation links (`/q/[clientSlug]/[token]` is one option Phase 3 may pick up; otherwise just admin-facing)
- `name String` — display name ("Acme Bank Demo")
- `description String?` — internal note for the admin ("Demo prepared for Q1 2026 pitch")
- `isActive Bool @default(true)` — soft-disable without delete
- **Theme fields, all nullable** (a client with no theme falls back to Sunrise defaults — useful for partial demos):
  - `primaryColour String?` — hex code, e.g. `#0066cc`
  - `secondaryColour String?`
  - `accentColour String?`
  - `backgroundColour String?`
  - `foregroundColour String?`
  - `mutedColour String?`
  - `borderColour String?`
  - `fontFamilyHeading String?` — Google Fonts family name (`"Inter"`, `"Lora"`) — the prototype loads dynamically via `next/font`
  - `fontFamilyBody String?` — same shape
  - `logoUrl String?` — full URL to the logo in Sunrise's storage; rendered on user-facing page headers
  - `faviconUrl String?` — full URL to favicon
  - `welcomeMessageMd String?` — markdown shown above the invitation landing page (above the user-profile form)
  - `completionMessageMd String?` — markdown shown on the completion page (in addition to the agent's farewell)
- `createdAt`, `updatedAt`

Indexes: unique on `slug`. No FK to `User` for any "owner" field — this is a global demo-fixture table; ownership is implicit (anyone with admin access can manage all demo clients).

2. **Extend `AppQuestionnaire`** with a single nullable foreign key:
   - `demoClientId String?` — FK to `AppDemoClient.id`. Plain string FK without Prisma `@relation` to avoid adding a reverse relation field on `AppDemoClient` (consistent with the Phase 0 cross-model approach).
   - Index on `demoClientId`.

   When `demoClientId` is null, the questionnaire is a "Generic Sunrise demo" — uses Sunrise defaults end-to-end. **This is important for backwards compatibility**: questionnaires created in Phase 1 (before Phase 2.5 runs) have `demoClientId: null` and continue to work. Phase 2.5 does not require any backfill.

3. **Extend `AppQuestionnaireInvitation`** with a denormalised `demoClientId String?` — copied from the questionnaire at invitation-creation time. **Why denormalised**: invitation-time → questionnaire-time → client-time is two hops; the invitation email needs the client's theme synchronously to render the branded template, and the invitation landing page needs the client's theme to render before the user is even authenticated. Snapshotting `demoClientId` onto the invitation row makes the lookup O(1) and resilient to questionnaire reassignment (an invitation sent under client A stays themed for client A even if the questionnaire is later reassigned to client B). Index on `demoClientId`.

4. **Admin API** under `app/api/v1/app/demo-clients/`:
   - `GET /api/v1/app/demo-clients` — list all clients (active and inactive). Returns `{ clients: AppDemoClientSummary[] }`.
   - `POST /api/v1/app/demo-clients` — create. Body: `{ slug, name, description?, themeFields? }`. Returns the created row.
   - `GET /api/v1/app/demo-clients/:id` — full detail.
   - `PATCH /api/v1/app/demo-clients/:id` — edit any field. Audit-logged.
   - `DELETE /api/v1/app/demo-clients/:id` — refuses with 409 if any `AppQuestionnaire` still references the client. The error message tells the admin to reassign or detach those questionnaires first.
   - `POST /api/v1/app/demo-clients/:id/logo` — multipart upload. Calls `processImage()` from `@/lib/storage/image` (validates magic bytes, constrains dimensions to e.g. 800×800), then `getStorageClient().upload(buffer, { key: 'app-demo-clients/${clientId}/logo.png', contentType: 'image/png', public: true })`. Returns the public URL, which the route also writes back to `AppDemoClient.logoUrl` in the same transaction.
   - `DELETE /api/v1/app/demo-clients/:id/logo` — clears the logo. Calls `deleteFile()` if needed.
   - `POST /api/v1/app/demo-clients/:id/favicon` and corresponding `DELETE` — same shape, smaller dimensions (e.g. 64×64).

   **Reset-sessions endpoint — demo-only, destructive.** Marked with the `// DEMO-ONLY:` header from ground rule 13.
   - `POST /api/v1/app/demo-clients/:id/reset-sessions` — hard-deletes all session data for every questionnaire belonging to this demo client. Used between demos so the next prospect sees a clean slate.

     Body: `{ confirmSlug: string }` — the request must include the client's slug as a typed-confirmation token. If `confirmSlug !== client.slug`, the route refuses with `400 { error: 'confirmation_mismatch' }`. Same pattern Phase 3 uses for launch confirmation; protects against accidental triggers.

     Refusal conditions:
     - `409 { error: 'anonymous_mode_active' }` if any of the client's questionnaires has `anonymousMode: true` set on its current version. Anonymous-mode questionnaires may carry research-sensitive data; this endpoint is too destructive to allow then. The admin must either switch anonymous mode off or use a different cleanup path.
     - `403` if the calling admin doesn't own the client (or the platform's ownership-scoping rules don't permit the action).

     On success, deletes inside a single transaction:
     - `AppQuestionnaireSession` rows where `versionId` belongs to any version of any questionnaire with `demoClientId = :id`
     - All `AppQuestionnaireUserProfile`, `AppAnswerSlot`, `AppQuestionnaireTurn`, `AppQuestionnaireSessionEvent` rows scoped to those sessions
     - Optionally (toggled by `?resetInvitations=true` query param) all `AppQuestionnaireInvitation` rows for those versions where `status IN ('pending', 'sent', 'opened')` — preserves `started | completed | revoked` invitations as audit history unless the operator explicitly chooses otherwise

     Returns `{ deletedCounts: { sessions: number, profiles: number, answers: number, turns: number, events: number, invitations: number } }` so the admin sees what was removed.

     Audit-logged with action `app_demo_client.reset_sessions`, the typed-confirmation slug in metadata, and the deletion counts. **Never deleted from audit trail** — the audit log remains the ground-truth record that a reset happened.

     The endpoint is annotated with the `// DEMO-ONLY:` header pointing to `forking.md`'s "Demo-only endpoints to remove" section.

   All routes use `withAdminAuth`, prototype-owned Zod schemas, Sunrise's error-response helpers. Audit log actions: `app_demo_client.create`, `app_demo_client.update`, `app_demo_client.delete`, `app_demo_client.logo.upload`, `app_demo_client.reset_sessions`, etc.

5. **Extend the questionnaire admin API** with two new routes:
   - `PATCH /api/v1/app/questionnaires/:id` already exists from Phase 1; it gains support for a `demoClientId` field in the request body (nullable to detach). Audit-logged.

   - **Clone-for-client endpoint** — the demo-reuse primitive. After a customer-success demo to one prospect lands well, the same content can be re-skinned for another prospect without rebuilding.

     `POST /api/v1/app/questionnaires/:id/clone-for-client` — clones an existing questionnaire into a new questionnaire bound to a different `AppDemoClient`.

     Body: `{ targetDemoClientId: string | null, slugSuffix?: string, nameSuffix?: string }`. `targetDemoClientId` is the demo client the clone will belong to (null means a generic Sunrise-default questionnaire — useful for moving a polished questionnaire out of demo-client scope). `slugSuffix` and `nameSuffix` are optional; if omitted, defaults are derived from the target client's slug/name (e.g. cloning `customer-nps` for client `acme-bank` produces `customer-nps-acme-bank` / `Customer NPS — Acme Bank`).

     Behaviour:
     - Creates a fresh `AppQuestionnaire` row with `demoClientId: targetDemoClientId`, the new slug, the new name, and a fresh `currentVersionId`.
     - Clones the source questionnaire's **current version only** (not history): a new `AppQuestionnaireVersion` with `versionNumber: 1`, cloned sections, cloned questions (including embeddings — re-used because prompts are identical), cloned config, cloned tags + tag applications. Goal and audience are cloned verbatim. **`sourceDocumentBytes` is also cloned** so the new questionnaire's lineage to the source is preserved.
     - **Does NOT clone**: sessions, invitations, analytics, evaluation runs/suggestions, extraction-change rows (those last are not relevant on a clone since no extraction happened). The clone starts fresh on every dynamic surface.
     - Returns `{ questionnaireId, versionId, slug }`. The admin UI redirects to the new questionnaire's detail page.

     Audit-logged with action `app_questionnaire.clone_for_client`, source ID, target client ID, target ID in metadata.

     **The endpoint is NOT marked demo-only** — the clone primitive is generally useful (any project starter that develops multiple questionnaire variants benefits). It's the _use case_ of "clone for sales demo" that's demo-specific; the endpoint itself is a project-starter feature.

     **Admin UI integration** (extends the Phase 2 admin work): the questionnaire list page gains a "Clone for another client" action in the per-row action menu. Selecting it opens a modal with a demo-client picker (or "no client") and the optional slug/name suffixes. Confirming fires the route and navigates to the new questionnaire.

6. **The theming resolver** — `lib/app/questionnaire/theming/`. **Every file in this module carries the `// DEMO-ONLY:` header from ground rule 13.** A real client fork replaces this module per `forking.md` § "Replacing demo tenancy":

   The header on each file should read approximately:

   ```ts
   // DEMO-ONLY: client branding overlay for sales demos.
   // FORK-GUIDANCE: for a single-tenant production fork, delete this module and brand
   // the app shell directly via Sunrise's CSS variables in app/globals.css. For a
   // multi-tenant production fork, rename AppDemoClient → AppTenant, add row-level
   // security, and keep this module as the per-tenant branding layer (with the marker
   // removed since it's no longer demo-only in that path).
   // SEE: .context/app/questionnaire/forking.md § "Replacing demo tenancy"
   ```

   `ResolvedTheme` is the fully-populated theme type, exported from `lib/app/questionnaire/theming/types.ts`. Every field is non-optional in the resolved form — `resolveTheme()` fills missing client values with Sunrise defaults so downstream consumers never have to null-check:

   ```ts
   export type ResolvedTheme = {
     colors: {
       primary: string; // hex
       primaryForeground: string;
       secondary: string;
       secondaryForeground: string;
       accent: string;
       accentForeground: string;
       background: string;
       foreground: string;
       muted: string;
       border: string;
     };
     fonts: {
       heading: string; // resolved CSS font-family value, e.g. '"Inter", system-ui, sans-serif'
       body: string;
     };
     logoUrl: string | null; // null when no client logo set
     faviconUrl: string | null;
     welcomeMessageMd: string | null;
     completionMessageMd: string | null;
   };
   ```

   - `resolveTheme(client: AppDemoClient | null): ResolvedTheme` — pure function returning a complete theme object with every CSS variable populated, either from the client's fields or from the prototype's documented Sunrise-default fallbacks. Returns the same shape regardless of input — null-safe.
   - `themeToCssVariables(theme: ResolvedTheme): string` — pure function rendering the theme as a CSS string suitable for inlining into a `<style>` tag. Example output:
     ```css
     :root {
       --color-primary: #0066cc;
       --color-primary-foreground: #ffffff;
       --color-background: #ffffff;
       --color-foreground: #0a0a0a;
       --font-family-heading: 'Inter', system-ui, sans-serif;
       --font-family-body: 'Inter', system-ui, sans-serif;
     }
     ```
   - `loadClientFonts(client: AppDemoClient | null): Array<{ family: string; preload: true }>` — returns a list of Google Fonts families to load via `next/font/google` dynamically. Returns empty when no client or no font set (Sunrise defaults are already loaded by the root layout). Includes a hardcoded whitelist of supported Google Fonts families (the admin's font picker constrains to this whitelist) to avoid arbitrary font URLs being injected.

   The whole module is platform-agnostic, fully unit-testable. No DB access — input is the client row, output is the theme.

7. **Theming application** — three insertion points in the user-facing UI added in Phase 7 (this phase ships them as preparation):
   - **The invitation landing page** at `app/(protected)/questionnaires/invitations/[token]/page.tsx` — server component. Resolves the invitation, resolves the invitation's `demoClientId` → fetches the client row → calls `resolveTheme()` and `themeToCssVariables()` → injects into a `<style>` tag at the top of the page. The logo renders in the page header. The `welcomeMessageMd` renders above the user-profile form. Phase 7's page already exists in concept; Phase 2.5 ships the theming hook.
   - **The session page** at `app/(protected)/questionnaires/[sessionId]/page.tsx` — same approach. The session row → questionnaire → client → theme. The logo renders in the header of the split-screen layout.
   - **The completion page** at `app/(protected)/questionnaires/[sessionId]/complete/page.tsx` — same. Includes the `completionMessageMd` on the page.

   **Phase 7 consumes this module.** Phase 7's `app/(protected)/questionnaires/` pages each resolve the theme and inject it; see Phase 7's goal 1 for the page-level wiring. Phase 2.5 just ships the resolver + CSS-variable serialiser; Phase 7 consumes them.

   **The admin UI is NOT themed.** Sunrise's existing admin shell stays Sunrise-branded. The admin is the demo presenter (John, Simon, or anyone running the platform); the themed surfaces are for the prospective client. For a fork into a real client engagement, the inheriting team chooses whether to theme the admin shell to the client's brand or keep the platform's neutral shell — Phase 9's `forking.md` discusses the trade-off.

8. **Theming of the invitation email**. The React-Email template `lib/app/questionnaire/email-templates/invitation.tsx` (already specified for Phase 3) gains a `theme?: ResolvedTheme` prop. When supplied, the template renders with the client's primary colour for the call-to-action button, the client's logo at the top, and the client's welcome message. When null, the template uses Sunrise defaults. Phase 3's invitation-send loop reads `invitation.demoClientId` → fetches the client → passes the resolved theme into the template.

9. **Admin UI** at `app/admin/demo-clients/`:
   - `app/admin/demo-clients/page.tsx` — list page. Table: name, slug, isActive, questionnaire count, created date. Row actions: edit, deactivate/reactivate, delete (with refusal-if-attached behaviour visible).
   - `app/admin/demo-clients/new/page.tsx` — create form. Slug + name required; rest optional.
   - `app/admin/demo-clients/[id]/page.tsx` — edit form with **four sections** in shadcn `<Tabs>`:
     - **Basics**: name, slug, description, isActive.
     - **Branding**: colour pickers (one per theme colour, using a small native-`<input type="color">` since shadcn doesn't have a colour primitive — flag as Severity-C finding), font selectors (constrained to the whitelist from `loadClientFonts()`).
     - **Assets**: logo upload (drag-and-drop fallback to file input — same MediaRecorder/file-input pattern used elsewhere in the prototype), favicon upload, current-asset preview, "Remove logo" / "Remove favicon" buttons.
     - **Messages**: `welcomeMessageMd` and `completionMessageMd` textareas with shadcn's existing markdown-preview pattern if any (if not, plain textarea with a "Preview" toggle that uses `react-markdown` — already a Sunrise dep).
   - **Live preview panel** on the edit page: a small `<iframe>`-style or div-based preview showing what the user-facing invitation landing page will look like with the current theme settings. Renders the theme variables into the preview and shows a stub invitation page. Updates as the admin edits.

   - **Questionnaire detail page gains a "Client" picker** at the top of `app/admin/questionnaires/[id]/page.tsx` — a shadcn `<Select>` populated from `GET /demo-clients`, defaulting to "Generic Sunrise demo" (the null case). Changing the selection fires `PATCH /api/v1/app/questionnaires/:id` with the new `demoClientId`. Saves with confirmation if the questionnaire has any invitations already sent — those invitations stay pinned to their original client (per the denormalisation rule).

10. **Admin sidebar entry** — same operator-chosen workaround from Phase 0. If smallest-possible-breach was chosen, add "Demo clients" as a sibling entry under the same comment-fenced block.

11. **Seed data** — `lib/app/questionnaire/seeds/004-default-demo-client.ts` creates one default `AppDemoClient` row with `slug: 'sunrise-default'`, `name: 'Sunrise default'`, no theme fields set (all null). Idempotent upsert. **The row serves three distinct purposes**, each worth keeping in mind:
    1. **A "no theme" baseline** for live demos. When the demo team wants to show a prospect what the platform looks like with Sunrise's stock branding before applying their theme, they assign questionnaires to `sunrise-default`. The visual comparison "this is the platform's neutral form / now here it is in your brand" lands well in pitches.
    2. **A test fixture**. Phase 2.5's integration tests and Phase 7's theming tests use this row as the canonical "null-theme" demo client without having to seed one per test.
    3. **A signal of intent for forks**. When a fork strips demo tenancy per `forking.md`, the seed file and this row are among the first things deleted. The presence of `sunrise-default` in a fork's database is a signal that demo-tenancy removal is incomplete.

    For single-tenant production forks, the seed file gets deleted; for multi-tenant forks where the `AppDemoClient` model is renamed to `AppTenant`, the seed gets repurposed (or deleted in favour of real tenant data).

11a. **Demo-fixtures directory** — `lib/app/questionnaire/fixtures/demo/`. This is **separate from `tests/fixtures/`** (which holds deliberately-flawed content for exercising the extractor). The demo fixtures are _polished_ sample questionnaires that John or Simon picks from when preparing a prospect demo, so they can show the platform with industry-relevant content without inventing it live in front of the prospect.

    Ship 5-8 fixtures as a starting set, each as a single markdown file with:
    - A stated `goal` paragraph at the top
    - A populated `audience` block (description, role, expertise level, estimated duration, locale, sensitivity, notes) in YAML front-matter
    - 15-30 questions with clean prompts (no deliberate typos, no compound questions, no ambiguous phrasing — the demo agent should produce *zero* extraction-change records on these)
    - Sensible question types (`free_text`, `likert`, `single_choice`, etc.) chosen to demo the type variety
    - Section structure that suits the domain

    Initial fixture set (the team can grow this over time):
    - `employee-satisfaction.md` — quarterly engagement survey for a 200-person SaaS company
    - `customer-nps.md` — post-purchase NPS + qualitative follow-up for a B2C product
    - `product-feedback.md` — feature-specific feedback after a release, for an engineering team
    - `compliance-attestation.md` — annual compliance review for a regulated industry (use a fictional regulation to avoid licensing issues)
    - `post-incident-review.md` — structured retro of a service incident, for an SRE team
    - `vendor-onboarding.md` — supplier intake form for procurement
    - `customer-research.md` — discovery interview script for a product team researching a new feature
    - `wellness-check-in.md` — gentle, sensitivity-tagged wellbeing pulse for HR

    Each fixture has a `README.md`-equivalent comment block at the top stating: this is synthetic content, no third-party content reproduced, fork-safe, generated specifically for Agentic Sunrise demo use. **Marked with the `// DEMO-ONLY:`-equivalent comment header** (markdown rather than TypeScript, but the same convention — see ground rule 13) since a real client fork should typically delete this directory rather than ship sample content the client didn't approve.

    **No seed loads these in Phase 2.5.** The seed that loads the fixtures into the database lives in Phase 9 (after every dependent feature exists) as `010-demo-content.ts` — see Phase 9's seed-extension item for details.

12. **Unit tests at `tests/unit/lib/app/questionnaire/theming/`**:
    - `resolveTheme.test.ts` — every field-null permutation falls back to the documented Sunrise default; a fully-populated client returns its own values; a partially-populated client mixes its values with Sunrise fallbacks correctly.
    - `themeToCssVariables.test.ts` — output matches expected CSS string exactly (snapshot-friendly); injection-safe (theme values containing CSS special characters or HTML are escaped — important since theme values eventually land in user-visible HTML).
    - `loadClientFonts.test.ts` — only whitelisted families are returned; non-whitelisted family in the client row is silently dropped; the function is type-safe with `next/font/google`'s expected family names.

13. **Integration tests at `tests/integration/api/v1/app/demo-clients/`**:
    - `crud.test.ts` — list, create, get, patch, delete (including the 409-when-attached refusal).
    - `logo-upload.test.ts` — multipart upload happy path; rejects oversized files; rejects unsupported MIME types; clears the URL on delete.
    - `favicon-upload.test.ts` — same shape, smaller dimensions.
    - `audit-log.test.ts` — every mutation produces an `AiAdminAuditLog` row with the expected `action` and `entityType`.
    - `assignment.test.ts` — `PATCH /api/v1/app/questionnaires/:id` with `demoClientId` writes the FK and audit-logs the change.
    - **`reset-sessions.test.ts`** — `POST /:id/reset-sessions` happy path (seed a client with 2 questionnaires × 3 sessions each = 6 sessions, fire the endpoint with the right `confirmSlug`, assert all 6 sessions plus profiles, answers, turns, events are deleted; assert the audit log has the deletion counts in metadata). Refusal: wrong `confirmSlug` returns 400. Refusal: when any questionnaire has `anonymousMode: true`, returns 409. `?resetInvitations=true` deletes pending invitations; without the flag, invitations are preserved.
    - **`clone-for-client.test.ts`** — `POST /api/v1/app/questionnaires/:id/clone-for-client` happy path (seed a questionnaire with sections, questions, tags, goal, audience; clone to a different demo client; assert the new questionnaire has the right `demoClientId`, the cloned sections/questions/tags match shape with new IDs, embeddings are reused, goal and audience are cloned, sessions/invitations/analytics are NOT cloned). Refusal: invalid `targetDemoClientId`. Default suffixes are derived from the target client's slug/name. Audit log carries source ID, target client ID, target ID.

14. **Integration tests at `tests/integration/lib/app/questionnaire/`**:
    - `theming-integration.test.ts` — given a seeded client and a seeded invitation pointing at a questionnaire owned by that client, rendering the invitation landing page produces HTML containing the client's CSS variables in the inline `<style>` tag and the client's logo in the markup.
    - `invitation-email-theming.test.ts` — render the invitation email template with a themed and unthemed client; assert the resulting HTML has the right colour values for the CTA button.

15. **Component tests at `tests/integration/app/admin/demo-clients/`**:
    - Edit page renders all four tabs; colour pickers fire the right `PATCH` payload; live preview updates as the admin types.
    - Logo upload component handles drag-and-drop and file-input; shows the existing logo if any; "Remove logo" clears it.
    - List page shows the questionnaire count per client (mocked aggregate query).
    - **Reset-sessions affordance** renders on the demo-client detail page, prompts for typed-confirmation matching the slug, disables when the client has any anonymous-mode questionnaire (with a tooltip explaining why), fires the right API call on confirm.
    - **Clone-for-client modal** (on the questionnaire list page) renders the demo-client picker, the optional suffix inputs with sensible defaults, fires `POST /clone-for-client` with the right payload, and navigates to the new questionnaire on success.

16. **Documentation at `.context/app/questionnaire/`**:
    - `demo-clients.md` — new file. Covers: the demo-tenancy model and what it explicitly is and is not (attribution + branding, not isolation); the `AppDemoClient` data model; the theming-fields-with-Sunrise-default-fallback contract; the per-questionnaire assignment; the invitation-time denormalisation rationale; the admin UI; the user-facing application points; the logo/favicon storage approach; the whitelisted-Google-Fonts list. **Includes the "Reset sessions" workflow** (when to use it, the typed-confirmation guard, the anonymous-mode refusal, the deletion counts response, the audit-log behaviour). **Includes the "Clone for another client" workflow** (the demo-reuse use case, what's cloned vs. not cloned, the default-suffix derivation, the use case for a non-demo project starter).
    - `theming.md` — new file. Focused reference for the theming module: the `ResolvedTheme` shape, the `themeToCssVariables()` CSS-injection contract, the security note (escape user-supplied theme values to prevent CSS injection), the `next/font` integration, the fallback chain.
    - Update `schema.md` — add `AppDemoClient`, the new `AppQuestionnaire.demoClientId` field, the new `AppQuestionnaireInvitation.demoClientId` field.
    - Update `admin-api.md` — add all the demo-client routes (including reset-sessions and clone-for-client).
    - Update `admin-ui.md` — add the demo-clients admin section, the questionnaire-detail Client picker, the questionnaire-list Clone-for-another-client action, and the reset-sessions affordance.
    - Update `invitations.md` (created in Phase 3 — note this phase makes its template themable; the Phase 3 doc reflects that).
    - Update `frontend.md` (created in Phase 7) — note the theming hook on each user-facing page.
    - Update `overview.md` and `upstream-gaps.md`.

## Expected upstream findings (section (c) of your plan)

1. **No shadcn colour-picker component.** Sunrise could add one to `components/ui/`. Prototype workaround: native `<input type="color">`. **Severity:** C.
2. **`uploadAvatar()` is hardcoded for user-avatar paths.** Sunrise could generalise to `uploadImage(file, { keyPrefix, format, dimensions })` so child projects can use the same processing pipeline for any image-upload need. **Severity:** B.
3. **SVG uploads are not supported by Sunrise's image validation** (SUPPORTED_IMAGE_TYPES likely excludes SVG due to script-injection concerns). Sunrise could add an SVG-sanitisation pass — useful for any logo upload anywhere. **Severity:** C.
4. **`next/font` dynamic family loading is awkward** because `next/font/google` typically expects compile-time family names. The prototype works around this by constraining to a whitelist; a true any-Google-Font solution would need a `@next/font/dynamic` capability. **Severity:** C.
5. **Sunrise's existing `ThemeProvider`** is dark/light only. A child-project theming hook that layers on top would centralise the pattern. **Severity:** C.
6. **No tenant-attribution concept anywhere in Sunrise.** This prototype's `AppDemoClient` is the first such construct. If demo tenancy becomes useful across multiple child projects, Sunrise should consider a base `Tenant` model. **Severity:** out-of-scope for the prototype but worth flagging.

## Open decisions to surface in section (l)

- **Whitelisted Google Fonts**. Recommend a starter list of ~12 families covering common brand aesthetics: Inter, Lora, Roboto, Open Sans, Montserrat, Playfair Display, Merriweather, Source Sans 3, Poppins, Raleway, Nunito, IBM Plex Sans. Confirm with operator.
- **Logo image format constraints**. Recommend PNG + JPEG + WebP (no SVG to avoid sanitisation concerns). Max dimensions 800×800, max file size 500KB. Confirm.
- **Whether the user-facing `<title>` should incorporate the client name** (e.g. "Acme Bank Questionnaire — Conversational Survey"). Recommend yes for demo polish; confirm.
- **Whether to expose `demoClientId` in analytics filters** in Phase 8. Recommend yes (filter sessions/exports by client) but call out as a downstream coordination point with Phase 8.
- **Whether anonymous mode preserves the client theme**. Recommend yes — anonymity is about admin→user privacy, not about hiding the brand from the user themselves. Confirm.

## Definition of done

- Admin can navigate to `/admin/demo-clients`, see the list, click into a client, edit branding fields in all four tabs, upload a logo and favicon, see a live preview, save.
- Admin can assign a questionnaire to a client via the Client picker on the questionnaire detail page.
- **Admin can clone an existing questionnaire to a different demo client via `POST .../clone-for-client`** and the admin-list Clone action — the new questionnaire has the right `demoClientId`, the cloned content, no sessions or invitations.
- **Admin can reset all session data for a demo client via `POST .../reset-sessions`** with typed-confirmation; the endpoint refuses when anonymous mode is on; the audit log records the deletion counts.
- A user invited under a themed client lands on a themed invitation page, completes a themed session, lands on a themed completion page. The invitation email is themed.
- A user invited under no client (Generic Sunrise demo) sees Sunrise defaults end-to-end.
- All Phase 2.5 unit, integration, and component tests pass.
- `.context/app/questionnaire/demo-clients.md` and `theming.md` are written and committed; `schema.md`, `admin-api.md`, `admin-ui.md`, `overview.md`, `upstream-gaps.md` updated.
- The Phase 2.5 seeds run cleanly via `tsx lib/app/questionnaire/seeds/run.ts` and are idempotent.
- Phase 7 has a clear coordination note in its open-decisions section about consuming the theming module — this is a forward-reference for Phase 7 implementation, not a Phase 2.5 deliverable.
- Zero new Sunrise-owned files modified beyond existing Phase 0/2 breaches.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Phase 3 — Configuration, invitations, and cost estimation

```

We are starting Phase 3 of the Conversational Questionnaire prototype: configuration, invitations, and cost estimation.

[paste the shared context block from above]

This phase covers everything between "the questionnaire is structurally complete" and "users start arriving." Three concerns: config knobs the admin sets, cost estimation the admin sees before launching, and the invitation pipeline that locks the version and emails users.

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`lib/orchestration/llm/cost-tracker.ts`** — confirm the public exports: `ComputedCost` type, `calculateEmbeddingCost(modelId, inputTokens)`, `LogCostParams`, and any helpers for reading aggregate costs back from `AiCostLog`. The prototype's cost estimator will use the same `ComputedCost` shape and the same pricing data.
2. **`lib/orchestration/llm/model-registry.ts`** — confirm `getModel(id)`, `getAvailableModels()`, and `ModelInfo` shape. The prototype reads per-model `inputTokenPriceUsdPerMillion` and `outputTokenPriceUsdPerMillion` (or whatever the actual field names are — confirm by reading `ModelInfo` in `lib/orchestration/llm/types.ts`).
3. **`lib/orchestration/cost-estimation/workflow-cost.ts`** — confirm `estimateWorkflowCost()` and read the breakdown shape. Useful as a structural model for the prototype's own estimator, even though the prototype's estimator works against a questionnaire (not a workflow).
4. **`lib/email/send.ts`** — confirm `sendEmail({ to, subject, react })` is the public entry. The `react` parameter accepts any `React.ReactElement` — the template doesn't have to live in `emails/`.
5. **`emails/invitation.tsx`** — the existing Sunrise invitation template as the structural reference for what an `@react-email/components`-based template looks like. The prototype writes its own template inside `lib/app/questionnaire/email-templates/`.
6. **`app/api/v1/users/invite/route.ts`** — the canonical pattern for an admin-only invite endpoint: token generation, `sendEmail` call, audit log. The prototype's invitation route follows the same shape.
7. **`lib/orchestration/engine/orchestration-engine.ts`** — confirm `OrchestrationEngine.execute()` is the public entry for running a workflow. **The prototype does NOT need a workflow for invitation sending** — a simple async loop in the route handler is sufficient. The previous version of this phase prescribed a workflow; that was over-engineered. Sunrise's orchestration engine is for multi-step LLM-involved processes, not for "fire 200 emails through a templated `sendEmail` call." Note the simplification in section (l).
8. **`lib/security/rate-limit.ts`** — confirm rate-limiter shape. Bulk invitation sends use it to space email dispatches.

## Goals for this phase

1. **Implement the configuration API:**
   - `PATCH /api/v1/app/questionnaires/:id/versions/:versionId/config` — update fields on `AppQuestionnaireConfig` (already in the schema from Phase 0): `selectionStrategy`, `completionConfig`, `visibilityConfig`, `anonymousMode`, `voiceEnabled`, `contradictionDetectionMode`, `contradictionDetectionN`, `costBudgetUsd`, `perSessionCostCapUsd`, `userProfileFields`. Goes through `applyEdit` from Phase 2's versioning module so locked-version edits fork. Audit-logged.

   - `GET /api/v1/app/questionnaires/:id/versions/:versionId/config` — read.

   The completion-config sub-shape: `{ minCompletionPct: number 0-100, targetCompletionPct: number 0-100, maxRounds: number, lowConfidenceThreshold: number 1-10 }`. The visibility-config sub-shape: `{ slotsVisible: boolean, rationaleVisible: boolean, provenanceLabelVisible: boolean, sectionGroupingVisible: boolean }`. The user-profile-fields sub-shape: `Array<{ key: string, label: string, type: 'text' | 'email' | 'number' | 'select', required: boolean, options?: string[], helperText?: string, minValue?: number, maxValue?: number }>` — admin defines which fields the session captures. The `number` type supports `minValue` and `maxValue` constraints (validated client- and server-side) so fields like tenure-in-years can sensibly bound input. The `select` type uses `options` (an array of string values); the `text` type has no extra config.

2. **Define defensible defaults** in `lib/app/questionnaire/config/defaults.ts`:
   - Selection strategy: `weighted` (more interesting than `sequential`, less risky than `adaptive` until Phase 4 proves it).
   - `minCompletionPct: 80`, `targetCompletionPct: 90`, `maxRounds: 50`, `lowConfidenceThreshold: 5`.
   - `slotsVisible: true, rationaleVisible: false, provenanceLabelVisible: false, sectionGroupingVisible: true`.
   - `anonymousMode: false`, `voiceEnabled: false` (opt-in per questionnaire).
   - `contradictionDetectionMode: 'every_n_turns'` with `contradictionDetectionN: 3` — middle-ground cost trade-off.
   - `costBudgetUsd: 100`, `perSessionCostCapUsd: 1.50` (a 50-question questionnaire with the chosen model and ~20 rounds should land near $0.50 per session, with headroom).
   - **`userProfileFields` default** — a richer set than just name and email, covering typical demo expectations: name, email, job title, organisation, team/department, and tenure. Admins remove fields they don't want via the Config tab.
     ```ts
     [
       { key: 'name', label: 'Your name', type: 'text', required: true },
       { key: 'email', label: 'Work email', type: 'email', required: true },
       {
         key: 'jobTitle',
         label: 'Your role / job title',
         type: 'text',
         required: false,
         helperText: 'e.g. Senior Product Manager',
       },
       { key: 'organisation', label: 'Organisation', type: 'text', required: false },
       {
         key: 'team',
         label: 'Team or department',
         type: 'text',
         required: false,
         helperText: 'e.g. Marketing, Engineering, Customer Success',
       },
       {
         key: 'tenure',
         label: 'Years in this role',
         type: 'number',
         required: false,
         minValue: 0,
         maxValue: 60,
         helperText: 'Approximate is fine',
       },
     ];
     ```
   - The admin Config UI lets the admin reorder, remove, edit labels/helper text, change required-ness, and add custom fields beyond this default set.

3. **Implement `lib/app/questionnaire/cost-estimation/`:**
   - `estimateQuestionnaireCost({ questionCount, avgQuestionTokens, expectedRoundsPerUser, invitedUserCount, modelId, contradictionDetectionMode, contradictionDetectionN, selectionStrategy })` returns `{ perUser, total, byPhase: { extraction, conversation, contradiction, completion } }`.

   - Pricing from `getModel(modelId)` in `lib/orchestration/llm/model-registry.ts` — read `inputTokenPriceUsdPerMillion` / `outputTokenPriceUsdPerMillion` (confirm the actual field names from `ModelInfo` in `lib/orchestration/llm/types.ts`).

   - **Default `expectedRoundsPerUser` heuristic**: `Math.max(questionCount * 0.3, 10)` for `sequential` strategy (each round answers ~3 questions on average given tangential matching), bumped to `* 0.4` for `weighted` and `adaptive` (more clarification rounds). Document this in `cost-estimation.md` and explicitly flag it as a starting heuristic to be tuned with real-session data in Phase 9.

   - `getActualCost(sessionId)` — direct Prisma query against `AiCostLog` filtered by an app-owned tag pattern. The prototype tags every LLM call it triggers with a `metadata.appQuestionnaireSessionId` field so cost-tracking-by-session is possible. Confirm `LogCostParams` accepts arbitrary metadata.

   - `getActualCostForQuestionnaire(versionId)` — aggregates across all sessions for the version. Same query pattern.

4. **Cost estimation API:**
   - `GET /api/v1/app/questionnaires/:id/versions/:versionId/cost-estimate?invitedUsers=N` — pre-launch estimate. Returns the full breakdown.
   - `GET /api/v1/app/questionnaires/:id/versions/:versionId/cost-actual` — in-flight totals from `AiCostLog`.

5. **Invitation system:**
   - `POST /api/v1/app/questionnaires/:id/versions/:versionId/invitations` — bulk CSV upload. Accepts a CSV file with `email` and optional `name` columns. Validates email format. Rejects duplicates within the upload and against existing invitations on the same version. Returns `{ created: number, skipped: number, errors: Array<{ row, reason }> }`. Each created row is a `pending` invitation with a generated token (use `randomBytes(32).toString('base64url')` — confirm the existing Sunrise token-gen pattern in `lib/utils/invitation-token.ts` if one exists). **Each created invitation also snapshots the questionnaire's current `demoClientId` onto `AppQuestionnaireInvitation.demoClientId`** (introduced in Phase 2.5) so the invitation email and landing page render the right client theme even if the questionnaire is later reassigned to a different client.

   - `POST /api/v1/app/questionnaires/:id/versions/:versionId/invitations/send` — the launch endpoint. Performs in this order, in a single Prisma transaction:
     1. Verify the version is currently `isLocked: false`.
     2. Set `isLocked: true` and `lockedAt: new Date()`.
     3. Read all `pending` invitations for this version.
     4. Emit a `logAdminAction({ action: 'app_questionnaire.launch', changes: { isLocked: { from: false, to: true } } })` entry.

     After the transaction commits, dispatch emails in a non-blocking background loop (no Sunrise workflow needed — a plain async iteration suffices):
     - For each invitation, mark status `sending`. Resolve the client theme: if `invitation.demoClientId` is set, fetch the `AppDemoClient` row and call `resolveTheme()` from `lib/app/questionnaire/theming/` (the Phase 2.5 module); otherwise pass `null` (the email template falls back to Sunrise defaults). Call `sendEmail({ to: invitation.email, subject, react: AppQuestionnaireInvitationEmail({ ..., theme }) })`. Then mark `sent` (with timestamp) on success or `failed` (with reason) on error.
     - Rate-limit using `lib/security/rate-limit.ts` to space sends — pick a sane default like 10 per second; document.
     - The route returns 202 with `{ jobId, invitationCount }` immediately after the transaction; the background loop continues. The admin polls `GET /invitations` to observe status transitions.

     **Atomicity contract:** the version-lock happens inside the DB transaction; if the operator triggers a concurrent edit during the lock, Phase 2's `applyEdit` will see `isVersionLocked === true` and auto-fork — clean semantics. The background send loop runs after commit; if the server crashes mid-send, surviving invitations stay `sending` and the admin can hit "Resume sending" (a new endpoint described below) to dispatch remaining ones. This is acceptable for a prototype; a production-grade replacement would use Sunrise's outbound webhook delivery infrastructure for retry and dead-letter handling.

   - `POST /api/v1/app/questionnaires/:id/versions/:versionId/invitations/resume-send` — re-dispatches any invitations stuck in `sending`. Idempotent. Same theming logic applies.
   - `GET /api/v1/app/questionnaires/:id/versions/:versionId/invitations` — list with status per invite (`pending`, `sending`, `sent`, `failed`, `opened`, `registered`, `started`, `completed`, `revoked`).
   - `POST /api/v1/app/questionnaires/:id/versions/:versionId/invitations/:inviteId/resend` — re-sends a single failed or sent invitation. Useful when an invitee asks to receive it again. Re-resolves the theme at send time (reads the snapshotted `demoClientId` on the invitation row).
   - `DELETE /api/v1/app/questionnaires/:id/versions/:versionId/invitations/:inviteId` — revokes before send only. Refuses with 409 if status has progressed past `sent`.

6. **Email template** at `lib/app/questionnaire/email-templates/invitation.tsx` — a React-Email template (using `@react-email/components`, already a Sunrise dep). Accepts a `theme?: ResolvedTheme` prop (introduced in Phase 2.5). When supplied, the CTA button uses the client's `primaryColour`, the header shows the client's `logoUrl`, and the welcome blurb prepends the client's `welcomeMessageMd` (rendered through `react-markdown` — already a Sunrise dep). When null, the template uses Sunrise defaults. Includes the questionnaire name, the inviter's name, the registration URL, the registration token expiry, and a polite explanation that this is a conversational questionnaire that should take ~15 minutes. Visually consistent with `emails/invitation.tsx` (read it as the styling reference) but explicitly app-owned content.

7. **Admin UI** additions at `app/admin/questionnaires/[id]/`:
   - **Config tab** (replaces the Phase 2 placeholder): structured form built from shadcn primitives. Every config knob exposed with inline help text explaining the cost trade-off (especially `contradictionDetectionMode`, where each option has measurable cost). Form uses the prototype's own Zod schemas with `react-hook-form` (already a Sunrise dep — confirm).
   - **Live cost-estimate preview**: as `invitedUsers` is typed in the launch panel and as config changes affect estimated rounds, fire `GET /cost-estimate?invitedUsers=N` (debounced 500ms client-side) and update a small breakdown card showing per-user / total / by-phase.
   - **Invitations tab** (replaces the Phase 2 placeholder): CSV upload component (shadcn `<Input type="file">` plus a preview table showing rows about to be uploaded). After upload, a status table with bulk filters, per-invite "resend" and "revoke" actions, and a clear lock indicator when `isLocked: true`. The lock indicator includes a "Resume sending" button if any invitations are stuck in `sending`.
   - **"Launch questionnaire" button** in the header of the questionnaire detail page: opens a shadcn `<Dialog>` confirming version contents (section count, question count, estimated cost), the invitation count, and the irreversible nature of the version lock. Confirms with a typed-confirmation pattern ("Type 'launch' to confirm") for the safety check Sunrise uses elsewhere.

8. **Unit tests** at `tests/unit/lib/app/questionnaire/`:
   - `cost-estimation/estimate.test.ts` — every byPhase calculation, every selection-strategy variant, every contradictionDetectionMode variant, boundary cases (zero invited users, very large invited counts, model not in registry).
   - `cost-estimation/actual.test.ts` — `AiCostLog` aggregation correctness with seeded fixtures.
   - `config/defaults.test.ts` — defaults are within valid ranges per the Zod schemas.
   - `config/schemas.test.ts` — Zod validation rejects bad shapes (negative percentages, `minCompletionPct > targetCompletionPct`, `contradictionDetectionMode: 'every_n_turns'` with no N).
   - `email-templates/invitation.test.tsx` — template renders without throwing for valid props; snapshot test against the rendered HTML.
   - `invitations/csv-parser.test.ts` — empty file, header-only, valid rows, duplicate emails within file, malformed rows, very large file (10k rows, performance assertion).

9. **Integration tests** at `tests/integration/api/v1/app/questionnaires/`:
   - `config-patch.test.ts` — config updates apply, audit-log entries created, locked-version edits fork.
   - `cost-estimate.test.ts` — pre-launch endpoint returns sensible numbers across config variations.
   - `cost-actual.test.ts` — after seeding `AiCostLog` rows with the prototype's metadata tags, the endpoint aggregates correctly.
   - `invitations-upload.test.ts` — CSV upload happy path and every error case.
   - `invitations-send.test.ts` — the transactional launch flow: version locks; pending invitations transition through `sending` → `sent` (with `sendEmail` mocked); the audit log has the launch entry; a concurrent edit during the launch transaction sees the lock and forks (per Phase 2's `applyEdit`).
   - `invitations-resend.test.ts` and `invitations-revoke.test.ts` — straightforward routes.
   - `invitations-resume-send.test.ts` — simulate a partial send by setting some invitations to `sending` and asserting resume dispatches them.

10. **Component tests** at `tests/integration/app/admin/questionnaires/`:
    - Config form renders with defaults, edits validate client-side, save calls the right API.
    - Live cost-estimate updates as the invitedUsers input changes (mock the API).
    - CSV upload preview renders correctly for valid and invalid rows.
    - Launch dialog requires typed confirmation before enabling the launch button.

11. **End-to-end test** — Vitest integration wrapping the routes (no Playwright yet). Test scenario: admin uploads a fixture questionnaire (Phase 1), edits config to set `costBudgetUsd: 50`, uploads a 5-row CSV, reads back the cost estimate, presses launch, asserts version locks, asserts five `sent` invitations, asserts the audit log carries the launch entry.

12. **Documentation** at `.context/app/questionnaire/`:
    - `configuration.md` — every config knob with rationale, default, range, cost-trade-off note (especially for contradictionDetectionMode), and the relationship to Phase 4 (selection strategy) and Phase 6 (per-session cap).
    - `cost-estimation.md` — the estimator's inputs, the byPhase breakdown, the per-strategy round-count heuristic (with the explicit "this will be tuned in Phase 9 with real data" note), how it reads from Sunrise's model registry.
    - `invitations.md` — the invitation lifecycle states, the version-lock transaction, the background-send loop semantics, the resume-send recovery flow, the email template.
    - Update `admin-api.md` to include the Phase 3 routes.
    - Update `admin-ui.md` to include the Config and Invitations tabs and the Launch dialog.
    - Update `overview.md` and `upstream-gaps.md`.

## Expected upstream findings (section (c) of your plan)

1. **No `bulkSendEmail` helper** — every consumer of `sendEmail` writes its own loop and rate-limit. Sunrise could add `bulkSendEmail(items, options)` with built-in pacing and a delivery-receipts table. **Severity:** B.
2. **No invitation-token utility shared across consumers** — `app/api/v1/users/invite/route.ts` generates tokens inline; the prototype either copies that pattern or, if a `lib/utils/invitation-token.ts` exists, consumes it. Confirm during verification. **Severity:** C (if missing) or already-resolved (if present).
3. **Cost-log metadata querying** — the prototype's approach of tagging `AiCostLog` rows with `metadata.appQuestionnaireSessionId` and aggregating works but is informal. Sunrise could add a `costByOwner(ownerType, ownerId)` helper. **Severity:** C.
4. **`react-hook-form` + Zod adapter** — the prototype's config form will use these; confirm Sunrise's existing form patterns and reuse them. If Sunrise's forms aren't built on react-hook-form, the prototype either matches Sunrise's pattern (preferred) or has a finding to flag the divergence.

## Open decisions to surface in section (l)

- **Background-send loop vs Sunrise's outbound webhook infrastructure.** For the prototype, a plain async loop is enough. If you want production-grade retry and delivery receipts, Sunrise has `lib/orchestration/outbound/` and `lib/orchestration/hooks/` — but adopting them adds complexity. Confirm the prototype-grade approach is acceptable for "between friendly pilot and paying client."
- **Rate-limit pacing.** 10/second is a default guess. If the operator's email provider has a stricter limit, the prototype's pacing should match.
- **Email template owner.** The prototype's `lib/app/questionnaire/email-templates/invitation.tsx` is app-owned. Confirm you don't want it under `emails/` (which would be a Sunrise file edit).

## Definition of done

- Admin can fully configure a questionnaire's launch behaviour via the Config tab.
- Admin sees a credible per-user / total / by-phase cost estimate that updates live as inputs change.
- Admin uploads a CSV of invitees, reviews the parsed preview, and launches.
- Launching locks the version and dispatches emails via `sendEmail` with the prototype's React-Email template.
- Stuck-send recovery via Resume Sending works.
- Audit log carries the launch entry, the config edits, and any invitation revocations.
- All Phase 3 unit, integration, and component tests pass.
- `.context/app/questionnaire/configuration.md`, `cost-estimation.md`, `invitations.md` are written and committed; `admin-api.md`, `admin-ui.md`, `overview.md`, `upstream-gaps.md` updated.
- Zero new Sunrise-owned files modified beyond the already-acknowledged Phase 0/2 breaches.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Phase 4 — Conversational engine: selection, extraction, contradiction, completion

```

We are starting Phase 4 of the Conversational Questionnaire prototype: the conversational engine.

[paste the shared context block from above]

This phase is **pure engine logic** — the brains behind the conversational flow Phase 6 will wire into a streaming chat. No HTTP, no UI, no SSE. The four selection strategies, the answer extractor, the contradiction detector, the strengthening sweep, the completion evaluator — all live under `lib/app/questionnaire/` as platform-agnostic TypeScript, all unit-testable in isolation.

## Verification step before planning

Before writing the plan, read these specific Sunrise files. They are load-bearing for this phase:

1. **`lib/orchestration/knowledge/embedder.ts`** — re-confirm `embedText(text)` is the entry. Phase 4 calls this from the adaptive strategy and from the tangential-question retrieval path inside the answer extractor.
2. **`lib/orchestration/evaluations/parse-structured.ts`** — read `runStructuredCompletion<T>(...)` in full. This is the canonical Sunrise pattern for "call an LLM, get JSON back, retry once on malformed output." The extractor and the contradiction detector should both use this rather than rolling their own structured-completion loop. **Note:** its `phase: 'summary' | 'scoring'` parameter is scoped to evaluations — the prototype either passes a fitting value or, if neither fits semantically, this is a Severity-C finding (Sunrise should widen the phase enum or accept arbitrary strings).
3. **`lib/orchestration/llm/provider-manager.ts`** — confirm `getProvider(slugOrName)` is public. Phase 4's capabilities resolve their provider via this.
4. **`lib/orchestration/llm/cost-tracker.ts`** — re-read for `LogCostParams` and the metadata-tagging pattern. Every LLM call Phase 4 triggers must tag `metadata.appQuestionnaireSessionId` (from Phase 3's tagging convention) so per-session cost aggregation works.
5. **`lib/orchestration/capabilities/base-capability.ts`** — re-read for `processesPii` and the redaction requirement. The answer extractor handles user-submitted free text (high PII risk) so `processesPii: true` + `redactProvenance()` override is mandatory.
6. **`lib/orchestration/provenance/`** — read the public exports (`ProvenanceItem` type, builders). Phase 4's extractor produces these.
7. **A canonical pgvector cosine-similarity query in Sunrise** — search `lib/orchestration/knowledge/` for the `<->` operator or `cosine_distance` to find the exact SQL pattern the knowledge search uses. The prototype's tangential-question lookup uses the same syntax against `AppQuestionSlot.embedding`.
8. **`prisma/seeds/006-quiz-master.ts`** and any other agent seed — re-read for the capability-binding pattern when an agent should have multiple capabilities attached (Phase 6 attaches the two Phase 4 capabilities — `app_extract_answer_from_message` and `app_detect_contradictions` — to the conversational agent).

## Goals for this phase

1. **Define the canonical `SessionState` type** in `lib/app/questionnaire/types/session-state.ts` — the read-only snapshot every engine module operates on. Includes: the locked questionnaire version (sections, questions, config), all current `AppAnswerSlot` rows for this session, all prior `AppQuestionnaireTurn` rows in oldest-first order, the user profile, the round counter, the running cost, and a `now()` timestamp. This is the engine's single source of truth — no module reaches into Prisma; Phase 6's per-turn orchestrator (the route handler) loads the snapshot once per turn and passes it in.

2. **Implement four selection strategies** under `lib/app/questionnaire/selection/`, each implementing a common interface:

   ```typescript
   interface SelectionStrategy {
     selectNext(state: SessionState): Promise<{
       questionId: string;
       rationale: string;
       costUsd: number; // 0 for non-LLM strategies; >0 for adaptive
     } | null>; // null when no eligible questions remain
   }
   ```

   - **`SequentialStrategy`** — next unanswered question by `(section.ordinal, question.ordinal)`. Pure function, no LLM call. `costUsd: 0`.

   - **`RandomStrategy`** — uniform random selection from unanswered required questions, then unanswered optional questions if no required remain. **Deterministic seeding**: use a hash of `sessionId + roundNumber` as the seed (so the same state always produces the same pick — necessary for testability and crash-recovery idempotency). `costUsd: 0`.

   - **`WeightedStrategy`** — pure function that scores each unanswered question by `(section_completion_inverse × question.weight × low_confidence_bonus)` where:
     - `section_completion_inverse = 1 - (answered_in_section / total_in_section)` — favours under-covered sections.
     - `question.weight` — admin-configurable, default 1.0.
     - `low_confidence_bonus = 1.0` unless any answer in the same section is below `lowConfidenceThreshold`, in which case `1.5` (the section needs reinforcement).
     - Top-scoring question wins; ties broken by ordinal. Deterministic, `costUsd: 0`.

   - **`AdaptiveStrategy`** — the riskiest. Algorithm:
     1. If there's no prior user turn (first round), fall back to `WeightedStrategy`.
     2. Otherwise: `embedText(lastUserMessage)` → vector.
     3. Pgvector lookup top-5 unanswered questions by cosine similarity to that vector, against `AppQuestionSlot.embedding`. (Direct Prisma `$queryRaw` with the `<->` operator since pgvector cosine isn't a first-class Prisma operator yet — read Sunrise's knowledge-search code for the exact syntax.)
     4. **Bounded LLM call** via `runStructuredCompletion<{ pickedId: string; rationale: string }>` from `lib/orchestration/evaluations/parse-structured`. The prompt contains: the questionnaire's name, the last 3 user/agent turns, the 5 candidate questions with their prompts, and instructs the model to pick the one that flows most naturally from the conversation. Cap input tokens at 2000 and output tokens at 200 — adaptive selection should not cost more than ~$0.005 per pick. Reject picks that aren't in the candidate set (defensive). Logs cost with `metadata.appQuestionnaireSessionId` so it's attributable.
     5. **If the LLM call fails or budget refuses**, fall back to `WeightedStrategy` deterministically.
     6. `costUsd` is the actual LLM cost from the structured completion.

     The defensive fallback to `WeightedStrategy` is critical — adaptive selection must never block a session.

     **Demo-mode gating** (Phase 9 sub-flag): when `APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED` is `false`, the adaptive strategy is removed from the admin config picker (the four strategies become three: sequential, random, weighted) and any session whose locked version has `selectionStrategy: 'adaptive'` runs the strategy through a defensive wrapper that immediately falls back to `WeightedStrategy` with a warning logged. Phase 4 just exposes the strategy; the gating logic and wrapper live in Phase 9's flag finalisation. Phase 4's tests assert both behaviours (adaptive when the flag is on, fallback when off) — see Phase 9's docs for the canonical wrapper.

3. **Implement the answer extractor capability** `app_extract_answer_from_message` under `lib/app/questionnaire/capabilities/extract-answer-from-message.ts`. Class extending `BaseCapability`. **`processesPii: true`**, with `redactProvenance()` overridden to redact long user-message excerpts. Registered alongside the Phase 1 capability in `registerAppQuestionnaireCapabilities()`. Seeded with an `AiCapability` row in `lib/app/questionnaire/seeds/005-extract-answer-capability.ts` following the Phase 1 canonical pattern.
   - Zod schema for input: `{ userMessage: string, recentTurns: Array<{ user: string; agent: string }>, targetedQuestion: { id, prompt, type, typeConfig }, tangentialCandidates: Array<{ id, prompt, type, typeConfig }> }`.
   - Inside `execute()`, the capability calls `runStructuredCompletion<ExtractionResult>` with a carefully-engineered prompt asking the LLM to:
     - Determine whether the targeted question is answered (and at what confidence, with rationale and source quote).
     - For each tangential candidate, determine whether the user's message _also_ answers it.
     - Tag every extracted answer with `provenanceLabel: direct | inferred | synthesised`.
   - Output: `{ success: true, data: { answers: Array<{ questionId, value, confidence: 1-10, provenanceLabel, rationale, sourceQuote, provenance: ProvenanceItem[] }> } }`.
   - **Tangential-question retrieval is done by the caller (Phase 6), not by this capability.** This keeps the capability's responsibilities narrow: caller passes pre-retrieved candidates; capability decides whether the message answers them. Justification documented in `engine.md`: it cleanly separates the pgvector lookup (a DB concern) from the LLM-judgement step (an extraction concern), and makes the capability fully unit-testable without a real database.

4. **Implement the contradiction detector capability** `app_detect_contradictions` under `lib/app/questionnaire/capabilities/detect-contradictions.ts`. Same `BaseCapability` pattern; `processesPii: true`; seeded with row `006-detect-contradictions-capability.ts`.

   **Conceptual relationship to Sunrise's guard system.** Sunrise's input/output/citation guards use a three-mode pattern (`log_only | warn_and_continue | block`) that decides _how_ the guard responds when it fires. The platform's `contradictionDetectionMode` (`off | every_turn | every_n_turns | sweep_only`) is structurally different — it decides _when_ the detector fires, not how it responds. The two axes are orthogonal: a future enhancement could combine them (e.g. "every_n_turns × warn_and_continue") but the current spec collapses the response axis to a single behaviour (gently surface the contradiction in the next agent turn). Document the relationship in `engine.md` so the eventual upstream finding ("Sunrise could generalise its guard infrastructure to support fire-cadence in addition to response-mode") is clear, and so a forking team understands the design choice.
   - Input: `{ newAnswers: Array<{ questionId, value, prompt }>, priorAnswers: Array<{ questionId, value, prompt }> }`.
   - Output: `{ contradictions: Array<{ questionIds: string[]; description: string; suggestedClarification: string }>, ambiguities: Array<{ questionId: string; description: string; suggestedClarification: string }> }`.
   - Uses `runStructuredCompletion` with a prompt asking the LLM to identify direct contradictions and softer ambiguities. **No firing decision inside the capability** — the capability is always-on when invoked; Phase 6's per-turn orchestrator decides whether to invoke it based on `contradictionDetectionMode`.

5. **Implement the strengthening sweep** under `lib/app/questionnaire/strengthening/`:
   - `findStrengtheningCandidates(state: SessionState): Array<{ questionId, currentConfidence, priorityScore }>` — pure function, no LLM call. Returns answers below `lowConfidenceThreshold` sorted by `priorityScore = (lowConfidenceThreshold - confidence) × question.weight`. Tie-break by ordinal.
   - `shouldRunStrengthening(state: SessionState, config: AppQuestionnaireConfig): boolean` — returns true once `percentComplete >= targetCompletionPct` and at least one candidate exists.

6. **Implement the completion evaluator** under `lib/app/questionnaire/completion/`:
   - `evaluateCompletion(state: SessionState): CompletionStatus` where `CompletionStatus = { percentComplete: number, weightedComplete: number, requiredComplete: boolean, canSubmit: boolean, agentShouldOfferCompletion: boolean, lowConfidenceCount: number, missingRequired: string[] }`.
   - `percentComplete` = answered count / total count × 100.
   - `weightedComplete` = sum(weight of answered) / sum(weight of all) × 100.
   - `requiredComplete` = every `required: true` question has an answer (any confidence).
   - `canSubmit` = `requiredComplete && percentComplete >= config.minCompletionPct`.
   - `agentShouldOfferCompletion` = `canSubmit && (percentComplete >= config.targetCompletionPct || roundCount >= config.maxRounds || lowConfidenceCount === 0)`.
   - Pure function. No LLM. Fast. Unit-testable with seeded `SessionState` fixtures.

7. **Implement the tangential-question retriever** under `lib/app/questionnaire/selection/tangential-retriever.ts`:
   - `findTangentialCandidates(prisma, sessionId, userMessage, options): Promise<Array<{ id, prompt, type, typeConfig, similarity }>>` — embeds the user message via `embedText()`, then runs a pgvector cosine-similarity query against `AppQuestionSlot.embedding` filtered to unanswered questions for this session's version, ordered by similarity descending, limited to `options.topN` (default 5), filtered by `options.minSimilarity` (default 0.3 to avoid noise picks).
   - Uses raw SQL via `prisma.$queryRaw` since pgvector's `<->` operator isn't first-class in Prisma's query API. Read Sunrise's knowledge-search code for the canonical pattern.

8. **Wire everything up.** Update `lib/app/questionnaire/capabilities/index.ts`'s `registerAppQuestionnaireCapabilities()` to register the two new capabilities. Update `instrumentation.ts` is not required — registration function is called once at startup; new entries flow through automatically.

9. **Unit tests at `tests/unit/lib/app/questionnaire/`** — this phase is mostly tests:
   - `selection/sequential.test.ts` — pick correctness across: empty answer set, partially answered, all required answered, all questions answered (returns null), questions across multiple sections in mixed ordinal order, deterministic re-pick for the same state.
   - `selection/random.test.ts` — pick correctness; deterministic seed verification (same state → same pick across runs); required-before-optional fall-through.
   - `selection/weighted.test.ts` — scoring correctness with a battery of fixtures: even weights / uneven weights, even completion / uneven completion across sections, low-confidence bonus triggering and not triggering, tie-breaking.
   - `selection/adaptive.test.ts` — full coverage with **mocked** `embedText` and `runStructuredCompletion`: first-round fallback to weighted; happy path picking from top-5 candidates; LLM picks a candidate not in the list (defensive reject + fallback); LLM call throws (fallback); LLM call exceeds budget (fallback); cost reporting correctness.
   - `selection/tangential-retriever.test.ts` — pure-function tests with a mocked `prisma.$queryRaw`; correctness of the SQL query string; correctness of similarity filtering.
   - `capabilities/extract-answer-from-message.test.ts` — capability behaviour with mocked `runStructuredCompletion`: direct answer to targeted question, inferred answer, synthesised answer, multi-answer (one user message answers target + 2 tangentials), no answer (low-quality user message), provenance shape, PII redaction round-trip.
   - `capabilities/detect-contradictions.test.ts` — fixture pairs covering: direct contradiction, soft ambiguity, clean answer (returns empty arrays), multiple contradictions in one batch.
   - `strengthening/find-candidates.test.ts` — priority ordering across confidence and weight combinations; `shouldRunStrengthening` boundary conditions.
   - `completion/evaluate.test.ts` — across 20+ fixture states covering: zero answers, all required answered with low optional completion, weighted vs unweighted, `agentShouldOfferCompletion` triggers (target reached / maxRounds reached / no low-confidence remaining), `canSubmit: false` until required are filled.

10. **Integration tests at `tests/integration/lib/app/questionnaire/`** — these touch the real database:
    - `tangential-retriever.test.ts` — seeds a questionnaire with 30 questions and embeddings (using `embedText` against a deterministic test provider, or fixed embedding fixtures), runs the retriever with a known user message, asserts the top-5 results are stable. Uses Sunrise's existing test-DB setup pattern from `tests/setup.ts`.
    - `capability-registration.test.ts` — instantiates the capabilities, registers them via `capabilityDispatcher.register()`, calls `dispatch()` end-to-end with mocked LLM responses, asserts the response envelope shape, the cost log, and the audit log (capabilities log their dispatches).
    - `engine-integration.test.ts` — seeds a full session state in the DB, runs each selection strategy against it via the real `SessionState` loader, asserts the picks match the pure-function tests.

11. **End-to-end test** — not applicable. State explicitly in section (j): "Phase 4 is engine-only; the full conversational loop is exercised by Phase 6's tests."

12. **Documentation at `.context/app/questionnaire/`**:
    - `engine.md` — the canonical reference for the engine: `SessionState` shape, the selection-strategy interface, the four implementations with cost characteristics, the answer extractor's prompt structure and output shape, the contradiction detector's prompt structure, the strengthening sweep's priority formula, the completion evaluator's six derived fields. Includes a worked example: "given this state, here's what each strategy returns, here's what the extractor produces, here's how completion evolves." **Includes a "Extending the question-type set" sub-section** explaining the type-extension pathway for forks:
      - The platform ships seven types: `free_text | single_choice | multi_choice | likert | numeric | date | boolean`. A real client engagement may need more (`currency`, `address`, `signature`, `file_upload`, `nps_score`, `matrix_question`, `slider_with_breakpoints`, etc.).
      - **First, reach for `typeConfig`.** The `typeConfig Json` column on `AppQuestionSlot` accommodates many type-variants without an enum change. Examples: `numeric` with `{ unit: 'years', min: 0, max: 60 }` covers "tenure in years"; `numeric` with `{ unit: 'currency', currency: 'USD', precision: 2 }` covers monetary input; `likert` with `{ scale: 7, labels: ['Strongly disagree', ..., 'Strongly agree'] }` covers any Likert variant. Most "new type" needs are actually "new typeConfig shape" needs.
      - **When a new enum entry is genuinely needed** (e.g. `signature` is structurally different from any existing type), the extension involves seven touch points, all in app-owned code: (1) add the value to the Prisma enum (migration); (2) update the Phase 1 extractor's prompt to recognise the type from source documents; (3) update the Phase 4 answer extractor's prompt to extract the type from user messages; (4) add a renderer for the type in the user-facing answer card under `app/(protected)/questionnaires/_components/`; (5) add an admin editor for the type's `typeConfig` shape in `app/admin/questionnaires/_components/`; (6) update the Phase 5 type-fit judge agent's system instructions so it knows about the new type; (7) add seed test fixtures and unit tests.
      - Cross-reference `forking.md` § "Adding industry-specific question types" for the full procedure with code-touching guidance.
    - `selection-strategies.md` — admin-facing deeper dive: when to choose each strategy, cost implications, a decision matrix.
    - Update `overview.md` with the new module layout.
    - Update `upstream-gaps.md`.

## Expected upstream findings (section (c) of your plan)

1. **`runStructuredCompletion`'s `phase` parameter is scoped to `'summary' | 'scoring'`.** Sunrise should widen this to accept arbitrary strings (or expose a sister helper for non-evaluation contexts). **Severity:** C.
2. **No public pgvector helper in `lib/orchestration/`.** The prototype writes its own `$queryRaw` cosine-similarity query against `AppQuestionSlot.embedding`. Sunrise's knowledge search has the same pattern internally; lifting it to a `lib/orchestration/pgvector/cosine-search.ts` helper would reduce duplication. **Severity:** C.
3. **`SessionState`-style snapshot pattern is reinvented.** Sunrise's chat handler builds its own context snapshot (`buildContext` from `lib/orchestration/chat/context-builder.ts`); the prototype builds an analogous one for questionnaire turns. A shared `SnapshotBuilder` abstraction could exist upstream. **Severity:** C.

## Open decisions to surface in section (l)

- **Adaptive strategy default**. Recommend keeping `weighted` as the documented default; `adaptive` only as an opt-in flagged "experimental" until real-session data confirms it improves UX without blowing cost. Confirm.
- **Tangential-candidate count** (`topN: 5`) and **min similarity** (`0.3`). Defensible starting values; flag for tuning in Phase 9.
- **Adaptive per-pick cost cap** (`~$0.005`). Confirm acceptable; if not, dial down `maxTokens`.

## Definition of done

- All four selection strategies are pure-function (sequential, random, weighted) or LLM-call (adaptive with fallback), implementing the common `SelectionStrategy` interface.
- The answer extractor and the contradiction detector are registered capabilities, dispatchable via `capabilityDispatcher.dispatch()`, returning the documented shapes.
- The strengthening sweep and the completion evaluator are pure functions returning the documented shapes.
- The tangential-question retriever runs a real pgvector cosine-similarity query against `AppQuestionSlot.embedding`.
- All Phase 4 unit tests pass.
- All Phase 4 integration tests pass.
- `.context/app/questionnaire/engine.md` and `selection-strategies.md` are written and committed; `overview.md` and `upstream-gaps.md` updated.
- The two new `AiCapability` rows are seeded via the prototype's seed runner.
- Zero new Sunrise-owned files modified.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Phase 5 — Design-time evaluation via Sunrise's agents-as-judges

```

We are starting Phase 5 of the Conversational Questionnaire prototype: the design-time evaluation surface.

[paste the shared context block from above]

This is Phase 5, sitting between Phase 4 (engine capabilities) and Phase 6 (conversational sessions). The phase delivers admin tooling to evaluate the _structure_ of an extracted questionnaire (not session data — that's a future enhancement) against the questionnaire's stated `goal` and `audience`, surfacing ambiguity / repetition / coverage gaps / type mismatches as actionable suggestions the admin reviews and accepts or declines.

**Architectural keystone: consume Sunrise's evaluation primitives, don't parallel them.** Sunrise already provides a complete batch-evaluation pipeline: judge agents (`AiAgent.kind = 'judge'`), datasets (`AiDataset` + `AiDatasetCase`), batch runs (`AiEvaluationRun`), per-case results (`AiEvaluationCaseResult`), the grader registry, and admin UI for all of it. (Read `.context/orchestration/evaluations.md` — the "agents-as-judges" architecture is the explicit recommended pattern for any LLM-driven structured assessment.) The platform consumes these primitives directly: the questionnaire becomes a dataset (one case per question, plus one per section, plus one for the questionnaire overall); each evaluation analysis (ambiguity, duplicates, coverage, etc.) is a `kind='judge'` agent the admin can edit in the existing agent form; running an evaluation kicks off an `AiEvaluationRun` against the dataset using the chosen judge agents; results land in `AiEvaluationCaseResult`. The platform adds two thin tables (`AppQuestionnaireEvaluationLink`, `AppQuestionnaireSuggestionReview`) to track which Sunrise runs belong to which questionnaire version and to record the admin's accept/decline/edit decisions on each case result.

**What this means for the demo:** the evaluation tooling looks like Sunrise's evaluation tooling, because it IS Sunrise's evaluation tooling. The judge agents are editable (a demo presenter can tune the ambiguity judge's rubric mid-session to show how the platform stays soft); judge cost rolls up to the existing cost pages; judge versioning happens through `AiAgentVersion` snapshots. None of these surfaces are platform-specific — they're production Sunrise behaviour, applied to questionnaire design.

**Why design-time, not runtime.** A future Phase 9 enhancement could feed actual session data back into the evaluation surface ("Question 12 has a 38% drop-off rate — consider rewording"). The user's request explicitly scopes this phase to design-time evaluation against the goal and structure. The data model is ready for the post-launch extension without changes — additional runs against an updated dataset are how it would work.

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`.context/orchestration/evaluations.md`** in full — this is the canonical reference for the agents-as-judges architecture. Read the data-model section, the grader-registry section, the worker section, the admin surfaces section. Every architectural decision in this phase derives from this doc.
2. **`prisma/schema.prisma`** — re-confirm `AiAgent` (including `kind` field and the `'judge'` enum value), `AiDataset`, `AiDatasetCase`, `AiEvaluationRun`, `AiEvaluationCaseResult` model shapes.
3. **`lib/orchestration/evaluations/`** in full — read the worker entry point, the grader registry, the judge-agent grader specifically (the `judge_agent` registry entry that takes `{ agentSlug }` in config), the queue/drain mechanism.
4. **`prisma/seeds/`** — find the seeds that create the six built-in judge agents (correctness, relevance, coherence, faithfulness, groundedness, brand-voice). Note their structure, system prompt patterns, and how they consume the user-message payload at evaluation time. The platform's judge agents follow the same shape.
5. **`app/admin/orchestration/evaluations/`** in full — read the admin pages for dataset CRUD, evaluation-run launch, results viewing. The platform's Design Suggestions tab reuses these patterns and where possible their components, NOT a parallel UI.
6. **`lib/orchestration/capabilities/base-capability.ts`** — `BaseCapability` and the `processesPii` requirement. The platform does NOT add a new capability for evaluation (the agents-as-judges architecture replaces it); this read is for the answer-extractor work that lives in Phase 4 and is referenced here only for `processesPii` discipline.

If any of the Sunrise files above don't exist or have shifted shape since this prompt was written, **stop and surface the discrepancy** before producing the plan. The whole phase pivots on these primitives being available.

## Goals for this phase

1. **Seed the platform's judge agents** as `kind='judge'` `AiAgent` rows. **One judge per analysis type.** Each is a thin platform-owned seed (`lib/app/questionnaire/seeds/007-evaluation-judges.ts`) that upserts agents through Sunrise's standard `AiAgent` table — `isSystem: false` so admins can edit rubrics; `kind: 'judge'` so the evaluation worker picks them up; `category: 'app-questionnaire-judge'` for filtering in the admin agent list.

   The judge agents:
   - `app-judge-question-ambiguity` — given a question's prompt, type, and the questionnaire's `goal` + `audience`, scores how clearly the question communicates what kind of answer is expected. Output schema: `{ score: 0..1, severity: 'info'|'warning'|'critical', rationale: string, proposedChange?: { kind: 'rewrite_prompt', questionId, newPrompt } }`.
   - `app-judge-question-duplication` — given the full question set, identifies pairs/groups that are semantically equivalent. Output schema: `{ score: 0..1 (1 = no duplication), severity, rationale, proposedChange?: { kind: 'merge_questions', questionIds: string[], newPrompt } }`.
   - `app-judge-goal-coverage` — given the questionnaire's `goal` and the question set, identifies aspects of the goal that no question addresses. Output schema: `{ score: 0..1 (1 = full coverage), severity, rationale, proposedChange?: { kind: 'add_question', sectionId, prompt, type, typeConfig } }`.
   - `app-judge-phrasing-consistency` — given the full question set, identifies inconsistent tone or voice. Output schema: `{ score: 0..1, severity, rationale, proposedChange?: { kind: 'rewrite_prompt', questionId, newPrompt } }`.
   - `app-judge-type-fit` — given each question's prompt and `type`, identifies type/prompt mismatches. Output schema: `{ score: 0..1, severity, rationale, proposedChange?: { kind: 'change_type', questionId, newType, newTypeConfig } }`.
   - `app-judge-rationale-quality` — given each question's `rationale` (or its absence) and the questionnaire's `goal` + `audience`, identifies weak or missing rationales. Output schema: `{ score: 0..1, severity, rationale, proposedChange?: { kind: 'rewrite_rationale', questionId, newRationale } }`.
   - `app-judge-section-balance` — given the section structure, identifies sections with hugely different question counts. Output schema: `{ score: 0..1, severity, rationale, proposedChange?: { kind: 'rebalance_section', sectionId, splitAfterOrdinal, newSectionName } }`.

   Each judge agent has:
   - **System instructions** describing its analysis target, the questionnaire `goal` + `audience` it will receive in the user-message payload, and the output schema. **Carefully calibrated for conservatism** — the demo audience tunes out after 20 noisy suggestions; the judges must emit a suggestion only when it would meaningfully improve the questionnaire. Documented in `evaluation.md`.
   - **Model selection** via `recommendModels('thinking', { limit: 1 })` from `lib/orchestration/llm` — a reasoning-capable model is the right choice for structured assessment; let Sunrise's existing recommender pick it. Document the chosen recommendation in the seed.
   - **`reasoningEffort: 'high'`** at the agent level. Design-time evaluation is exactly the use case where the model benefits from thinking time; the participant doesn't see the latency, the admin sees better suggestions.
   - **`monthlyBudgetUsd`**: a starting default of `5.00` per judge. Documented in `evaluation.md` so the operator can adjust.
   - **Visibility: `internal`** — admin-only.

   **Each judge is independently editable.** A demo presenter can open the ambiguity judge's agent detail page, refine the rubric in the system-instructions field, and the change takes effect on the next evaluation run. Version snapshots happen via Sunrise's standard `AiAgentVersion` mechanism — same audit trail as every other agent edit.

2. **Build the questionnaire-to-dataset mapper** at `lib/app/questionnaire/evaluation/dataset-builder.ts` (platform-agnostic). The mapper converts a version's structure into an `AiDataset` + `AiDatasetCase` set the evaluation worker consumes.
   - `buildEvaluationDataset(prisma, versionId): Promise<{ datasetId: string, caseCount: number }>` — loads the version's sections, questions, goal, audience; creates an `AiDataset` row with a descriptive name (`"Questionnaire structure: <questionnaire-name>, v<n>, <timestamp>"`) and a deterministic `contentHash` over the normalised case payload; creates one `AiDatasetCase` per evaluation target:
     - One case per question (input shape: `{ questionId, prompt, type, typeConfig, rationale, sectionId, goal, audience }` — used by the ambiguity, type-fit, and rationale-quality judges).
     - One case per section (input shape: `{ sectionId, name, description, questionCount, goal, audience }` — used by the section-balance judge).
     - One case for the full questionnaire (input shape: `{ versionId, goal, audience, sections, questions }` — used by the duplication, coverage, and phrasing-consistency judges that need a global view).
   - The case `position` field is stable across rebuilds (deterministic ordering by section ordinal then question ordinal then case-type) so re-evaluating the same version produces results that line up with the prior run.
   - **No case duplication on re-run**: if a dataset with the same `contentHash` already exists for this version, reuse it. The mapper is idempotent.

   Critically, this is the only platform-specific code in the evaluation pipeline. Everything downstream — the run, the scoring, the storage of results — is Sunrise's existing infrastructure.

3. **Implement the admin API routes** under `app/api/v1/app/questionnaires/`. Most routes are thin wrappers that delegate to Sunrise's existing evaluation endpoints; the platform-owned routes manage the link table and the review-state table.
   - `POST /:id/versions/:versionId/evaluate` — kick off an evaluation. Behaviour:
     1. Pre-flight: refuse with `400 { error: 'goal_missing' }` if the questionnaire's `goal` is null or empty. The UI displays "Set a goal for this questionnaire before running an evaluation." `audience` is optional but recommended — surface "audience not set" as an info banner (not a blocker) on the Design Suggestions tab.
     2. Call `buildEvaluationDataset(prisma, versionId)` (idempotent) to produce the `datasetId`.
     3. Create an `AiEvaluationRun` row via Sunrise's existing run-creation function (read the canonical implementation in `lib/orchestration/evaluations/`) with: `datasetId` from step 2; `subjectType: 'agent_set'` (or whatever the existing schema names the multi-judge case); `graders` populated with one entry per platform judge agent (`[{ graderId: 'judge_agent', config: { agentSlug: 'app-judge-question-ambiguity' } }, ...]` — seven entries total).
     4. Insert an `AppQuestionnaireEvaluationLink` row tying the new `aiEvaluationRunId` to `versionId` with `triggeredByUserId`.
     5. Sunrise's existing evaluation worker drains the run. The platform does not write its own worker.
     6. Return `202 { runId }`. The admin polls the run-detail route.

   - `GET /:id/versions/:versionId/evaluation-runs` — list `AppQuestionnaireEvaluationLink` rows for the version, joined to `AiEvaluationRun` for status / case counts / aggregate scores. Newest first.
   - `GET /:id/versions/:versionId/evaluation-runs/:runId` — single run detail (proxies Sunrise's run-detail endpoint after verifying the link belongs to this version, plus the platform-owned review-state for case results in this run).
   - `GET /:id/versions/:versionId/suggestions?status=pending|accepted|declined|applied&runId=...` — list suggestions. The route reads `AiEvaluationCaseResult` rows for the linked run(s), filters by the platform's `AppQuestionnaireSuggestionReview.status` (joining on `aiEvaluationCaseResultId`; missing review rows are treated as `pending`), and **filters out stale results** — a result is stale if the questionnaire version's most recent `AppQuestionnaireSection.updatedAt` or `AppQuestionSlot.updatedAt` on any entity referenced in the case's input payload is newer than the `AiEvaluationCaseResult.createdAt`. Returns `{ suggestions: SuggestionDto[], staleCount: number }` so the UI can show "5 suggestions, 3 stale (re-evaluate to refresh)."

     `SuggestionDto` carries: case-result id, suggestion type (derived from the judge agent's slug), severity (from the judge's output), rationale, proposedChange (override if set, else from the case result), affected entity ids, judge agent slug + version (so the admin can see _which judge_ and _which rubric version_ produced the suggestion), and `isStale: boolean`.

   - `POST /:id/versions/:versionId/suggestions/:caseResultId/accept` — accept and apply. Reads the proposed change (override or original), inspects `proposedChange.kind`, calls `applySuggestion()` (next item). Inserts or updates `AppQuestionnaireSuggestionReview` to `status: 'applied'`. Audit-logged.
   - `POST /:id/versions/:versionId/suggestions/:caseResultId/decline` — mark declined with optional reason. Insert-or-update `AppQuestionnaireSuggestionReview` to `status: 'declined'`. Audit-logged.
   - `PATCH /:id/versions/:versionId/suggestions/:caseResultId/edit-proposal` — set `proposedChangeOverride` on the review row, status stays `pending`. The accept route then applies the override.

   All routes use `withAdminAuth`, prototype-owned Zod schemas, Sunrise's response helpers. Audit log actions: `app_questionnaire.evaluation.run`, `app_questionnaire.suggestion.apply`, `app_questionnaire.suggestion.decline`, `app_questionnaire.suggestion.edit_proposal`.

4. **Suggestion-application logic** under `lib/app/questionnaire/evaluation/apply-suggestion.ts` (platform-agnostic). Unchanged in spirit from the earlier spec — the function dispatches on `proposedChange.kind`:
   - `applySuggestion(prisma, proposedChange, versionId, editorUserId): Promise<{ versionId: string; forked: boolean; result: ProposedChangeResult }>` — supports `rewrite_prompt`, `rewrite_rationale`, `change_type`, `add_question`, `remove_question`, `merge_questions`, `rebalance_section`. Each branch goes through Phase 2's `applyEdit` so locked-version application forks. Returns a structured description for the audit log.

   Pure unit-testable logic separate from the route layer.

5. **Admin UI** — replaces the Phase 2 "Design Suggestions appear in Phase 5" placeholder tab.

   **Design Suggestions tab** on `app/admin/questionnaires/[id]/page.tsx`:
   - **Run controls** at the top: an "Evaluate now" button. While a run is in progress, the button is disabled and a status indicator polls Sunrise's run-detail endpoint. If `goal` is null, the button is replaced by a "Set a goal first" prompt that opens the goal-editor inline.
   - **Judge configuration link**: a small "Configure judges" link in the Run controls area links to the standard Sunrise agent list filtered to `kind='judge'` and `category='app-questionnaire-judge'`. From there the admin opens any judge's detail page, tunes the rubric, and returns. No platform-specific judge-editing UI — the existing agent form does the job.
   - **Run history** dropdown showing prior runs (status, case counts, aggregate score, cost — all from Sunrise's run-detail endpoint). Selecting a run filters the suggestion list to that run.
   - **Suggestion list**, grouped by judge slug with collapsible sections (Ambiguity, Duplicates, Coverage Gaps, Phrasing, Type Fit, Rationale Quality, Section Balance). Each row shows: severity badge (info/warning/critical, colour-coded), the judge agent's name + a small chip linking to its detail page (so the admin can see "this suggestion came from the ambiguity judge — let me see what its rubric says"), rationale, the affected entity (with deep-links into the Sections/Questions tabs), the proposed change rendered as a before/after view, and three actions: **Accept**, **Decline**, **Edit proposal**.
   - **Stale suggestion treatment**: stale suggestions are shown with a `[stale]` badge and a muted background; the action buttons are disabled with a tooltip "This suggestion was produced against an older version of the question — re-evaluate to refresh." The admin can dismiss-without-action via a small × icon.
   - **Status filter** chip group: All / Pending / Accepted / Declined / Applied. Default: Pending.
   - **Empty states**: "Run an evaluation to see design suggestions" (no runs yet); "No pending suggestions — your questionnaire looks solid" (all addressed).
   - **Bulk-accept** for low-risk types (rationale-quality, phrasing-consistency).

6. **Cost transparency.** Sunrise's evaluation worker already writes `AiCostLog` rows tagged with the judge agent ID for every LLM call. Judge cost rolls up to the existing cost pages without any platform-specific code. The Design Suggestions tab surfaces the per-run cost from `AiEvaluationRun.totalCostUsd` (or whatever the field is named — verify during the read in step 3 of the verification phase). The questionnaire's actual-cost endpoint from Phase 3 picks up the judge costs automatically because the cost log query is per-conversation/per-tag and the judge calls land against the platform's own conversations.

   No new cost-tracking infrastructure. This is the largest single deletion versus the earlier Phase 5 spec.

7. **Unit tests at `tests/unit/lib/app/questionnaire/`**:
   - `evaluation/dataset-builder.test.ts` — given a fixture version, produces the expected `AiDataset` + `AiDatasetCase` rows: correct case counts (one per question, one per section, one for the questionnaire), stable `position` ordering across rebuilds, idempotent re-build (same `contentHash` returns the existing dataset), correct input-payload shape for each case-type. Plus three audience-aware tests confirming the audience is propagated into each case input where the relevant judge consumes it.
   - `evaluation/apply-suggestion.test.ts` — one unit test per `proposedChange.kind` against fixture state. Each test asserts: the underlying entity is correctly updated, the platform-owned review row's status becomes `applied`, the right audit entry is produced, locked-version application forks.
   - `evaluation/staleness.test.ts` — given a case result against a question and a subsequent edit to that question, the staleness derivation correctly flags the result as stale. Edits to unrelated questions don't flag it. Re-running the evaluation produces fresh non-stale results.
   - `seeds/007-evaluation-judges.test.ts` — seed idempotency for all seven judge agents. Each judge has the right `kind`, `category`, `reasoningEffort`, and system-instruction skeleton.

8. **Integration tests at `tests/integration/api/v1/app/questionnaires/`**:
   - `evaluation-run.test.ts` — `POST .../evaluate` happy path: refuses with 400 when goal is null; succeeds with goal set; calls `buildEvaluationDataset` and creates the `AiEvaluationRun` via Sunrise's existing run-creation path; creates the `AppQuestionnaireEvaluationLink` row; Sunrise's worker drains the run (verified via integration-test seam — read how Sunrise's existing evaluation integration tests handle the worker drain and mirror it); case results populate; on worker failure the run is marked `failed` with an error message.
   - `evaluation-suggestions-list.test.ts` — filtering by status, by runId, ownership scoping; stale-result filtering (results against a since-edited question carry `isStale: true`); the `staleCount` is correctly reported.
   - `evaluation-suggestion-accept.test.ts` — each `proposedChange.kind` end-to-end: the underlying entity is correctly mutated; the platform-owned review row's status updates; the audit log carries both the suggestion-accept and the underlying-entity-edit entries.
   - `evaluation-suggestion-decline.test.ts` — status updates; optional reason persisted.
   - `evaluation-suggestion-edit-proposal.test.ts` — `proposedChangeOverride` is set; subsequent accept applies the override.
   - `evaluation-locked-version.test.ts` — accepting a suggestion against a locked version forks. The forked version starts with a clean evaluation-link/review slate (per the `forkVersion` rule from Phase 0) because the structure has changed and should be re-evaluated. Document this in `evaluation.md`.
   - `evaluation-judges-editable.test.ts` — editing a judge agent's system instructions via Sunrise's standard agent PATCH route changes the next evaluation run's suggestions for that analysis. Demonstrates that the judges are genuinely Sunrise primitives, not a parallel surface. (Uses mocked LLM responses keyed on the system-instruction content to keep the test deterministic.)

9. **Component tests at `tests/integration/app/admin/questionnaires/`**:
   - **Design Suggestions tab** renders empty state when no runs exist.
   - "Evaluate now" button is disabled and replaced by "Set a goal first" when `goal` is null.
   - Run-in-progress state polls Sunrise's run-detail endpoint and shows progress.
   - Completed run shows suggestions grouped by judge with the right severity badges.
   - Each suggestion row's "judge agent" chip links to the standard agent detail page (verified by URL).
   - Stale suggestions render with the `[stale]` badge and disabled actions.
   - Accept fires the right API call; the row's status updates to `applied`.
   - Decline fires the right API call; optional-reason field works.
   - Edit-proposal modal renders the right form per `proposedChange.kind`.
   - Bulk-accept for low-risk types works; heavier types require individual confirmation.
   - The "Configure judges" link navigates to the standard Sunrise agent list filtered to the platform's judges.

10. **End-to-end test** at `tests/integration/lib/app/questionnaire/`:
    - `evaluation-flow.test.ts` — full flow: admin creates a questionnaire with a deliberately-flawed structure (seeded fixtures: two duplicate questions, one ambiguous prompt, one type-mismatched question, and a goal that mentions a topic no question covers); admin sets the goal; admin runs evaluation; assert the right suggestions are produced (with mocked judge-agent LLM responses keyed on the case-input shape to make this deterministic); admin accepts the duplicate-merge and the type-mismatch fix; admin declines the ambiguous-prompt suggestion; admin edits-then-accepts the coverage-gap "add this question" suggestion; final state matches expectations; audit log carries everything; cost log shows entries against each judge agent.

11. **Documentation at `.context/app/questionnaire/`**:
    - `evaluation.md` — the design-time evaluation surface as a thin layer over Sunrise's agents-as-judges architecture. Covers: the seven judge agents and their analysis targets, the rubric calibration approach (conservatism heuristic — admins reviewing 80 noisy suggestions tune out, admins reviewing 8 well-considered ones pay attention), the dataset-builder mapping from version structure to `AiDatasetCase` rows, the goal-required pre-flight check, the **audience-aware calibration where each judge consumes the audience from the case-input payload**, the link-table and review-state-table design, the staleness derivation (version-diff-based, not middleware), the apply-suggestion logic per `proposedChange.kind`, the admin UI, the link-not-cloned-on-fork rule and rationale, the cost-tracking inheritance from Sunrise (judge calls land in `AiCostLog` against the judge agent ID; roll-up is automatic). Cross-references Phase 1's `extraction-changes.md` for the related-but-distinct extraction-time cleanup feature.
    - `evaluation-judges.md` — operator-facing guide to the seven platform judge agents: each judge's analysis target, the user-message payload shape, the output schema, the starting system-instruction skeleton, the rubric-tuning workflow (edit the judge agent in the standard agent form, re-run evaluation, observe the difference). Demo-presenter relevance: this is the doc John or Simon reads before a domain-specific demo to understand what judges to tune for the prospect's vertical.
    - Update `admin-api.md` with the evaluation routes.
    - Update `admin-ui.md` with the Design Suggestions tab.
    - Update `overview.md` and `upstream-gaps.md`.

## Expected upstream findings (section (c) of your plan)

1. **Sunrise's grader registry could expose a "structured-output judge" template** that takes a judge agent's `agentSlug` plus an output Zod schema and validates the LLM response. Currently each judge defines its output schema in its system instructions and the platform parses the JSON. A first-class typed-judge would remove the parsing layer. **Severity:** C.
2. **Sunrise's `AiEvaluationRun.subjectType` enum** may not cover the platform's "multi-judge against a structural dataset" use case cleanly. Verify during the read step; if a new subject type is needed, propose it upstream. **Severity:** B if the enum needs widening, C if it's already general enough.
3. **No standard "suggestion review queue" UI pattern.** This pattern (a list of LLM-produced suggestions with accept/decline/edit affordances, derived from case results) is broadly useful for any LLM-driven admin tool that uses agents-as-judges. Sunrise could lift the platform's pattern into a reusable component once the platform proves it. **Severity:** C.

## Open decisions to surface in section (l)

- **Per-questionnaire judge model overrides.** Each judge agent has its own model selection that applies globally. A future enhancement could let the admin override the model per questionnaire (e.g. an expensive judge for high-stakes questionnaires, a cheap one for casual ones). Out of scope here but flag — Sunrise's `AiAgent.profileId` could plausibly carry per-tenant judge profiles in a multi-tenant fork.
- **Re-evaluation cadence.** Currently fully manual. Future: auto-trigger after N edits, or on a schedule via Sunrise's `AiWorkflowSchedule`. Recommend keeping manual for the platform; admins doing demo prep will explicitly evaluate when ready.
- **Suggestion expiry vs. version-diff staleness.** This phase uses **version-diff derivation** (a suggestion is stale iff the questionnaire's relevant entities have been edited since the case-result `createdAt`) rather than middleware that flips a stored status. The derived approach is simpler — no middleware, no race conditions, no orphaned stale rows — and Sunrise's audit log already gives us the underlying edit timestamps. Document the trade-off in `evaluation.md`: stale suggestions can't be filtered at the SQL layer (the join condition requires comparing `MAX(updatedAt)` across joined entities), but for review-queue scales (tens-of-suggestions per version) the cost is negligible.

## Definition of done

- Admin can set a `goal` on a questionnaire; the field is editable on the questionnaire metadata panel.
- Admin can click "Evaluate now" and trigger an evaluation run. The run uses Sunrise's existing evaluation worker — verified by inspecting the resulting `AiEvaluationRun` and `AiEvaluationCaseResult` rows.
- The seven platform judge agents exist as `kind='judge'` `AiAgent` rows, each editable through Sunrise's standard agent form. Editing a judge's system instructions changes subsequent evaluation runs' output for that analysis.
- The Design Suggestions tab shows results grouped by judge, with severity badges, rationale, proposed-change before/after, and per-row chips linking to each judge's agent detail page.
- Admin can review each suggestion: accept (applying the change via `applySuggestion`), decline (with optional reason), or edit-then-accept (via `proposedChangeOverride`).
- Accepting a suggestion against a locked version forks the version (Phase 2's `applyEdit` flow); the forked version starts with a clean evaluation-link slate.
- Stale suggestions are flagged via version-diff derivation; the UI shows the `[stale]` badge and disables actions on them.
- Evaluation costs roll up automatically into the questionnaire's actual-cost endpoint via the standard `AiCostLog` query (no platform-specific cost wiring).
- All Phase 5 unit, integration, component, and end-to-end tests pass.
- `.context/app/questionnaire/evaluation.md` and `evaluation-judges.md` are written and committed; `admin-api.md`, `admin-ui.md`, `overview.md`, `upstream-gaps.md` updated.
- The Phase 5 seeds run cleanly via `tsx lib/app/questionnaire/seeds/run.ts` and are idempotent.
- Zero new Sunrise-owned files modified beyond existing Phase 0/2 breaches. The two platform tables (`AppQuestionnaireEvaluationLink`, `AppQuestionnaireSuggestionReview`) are the platform's only contribution to the evaluation schema; everything else lives in Sunrise's existing tables.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Phase 6 — Conversational session: streaming chat

```

We are starting Phase 6 of the Conversational Questionnaire prototype: the conversational session.

[paste the shared context block from above]

This phase wires the Phase 4 engine into a streaming chat session. By the end of it a developer can drive a full conversational completion end-to-end via curl + SSE, no UI yet.

**Important architectural correction**: earlier drafts of this phase prescribed a custom `OrchestrationEngine` workflow with explicit yield-and-resume semantics for the conversational loop. **That was over-engineered.** Sunrise's `streamChat({ message, agentSlug, userId, conversationId })` already implements the per-turn loop: it loads agent context, invokes capabilities the agent has attached, streams content events, persists the assistant message, and returns. The prototype's job is _not_ to build a workflow that mimics this — it's to **configure the conversational agent and its bindings such that `streamChat` does the right thing**.

The orchestrating logic that _is_ prototype-owned — picking the next targeted question, retrieving tangential candidates, deciding whether contradiction detection fires, evaluating completion — runs **per turn around the `streamChat` call**, not inside a workflow. The route handler is the orchestrator. This matches how Sunrise's own chat surfaces work.

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`lib/orchestration/chat/streaming-handler.ts`** — read `streamChat` and the surrounding handler class. Understand the per-turn lifecycle: build context → invoke LLM with tool definitions → handle tool calls (which dispatch capabilities) → emit content events → persist messages → emit `done` event.
2. **`lib/orchestration/chat/types.ts`** — confirm `ChatRequest` fields, particularly `entityContext` (free-form context forwarded to capabilities). The prototype uses this to pass the current session ID and targeted question ID into the Phase 4 capabilities.
3. **`types/orchestration.ts`** — confirm the `ChatEvent` union shape.
4. **`app/api/v1/chat/stream/route.ts`** — the canonical SSE route. Copy the pattern (auth → request validation → `streamChat()` → `sseResponse()`).
5. **`lib/api/sse.ts`** — confirm `sseResponse()` is the public helper for converting an `AsyncIterable<ChatEvent>` into a Next.js `Response` with `text/event-stream` headers.
6. **`lib/orchestration/chat/context-builder.ts`** — confirm `buildContext()` is exported and how it loads conversation history. The prototype's per-turn orchestrator either calls this or relies on `streamChat` to call it internally.
7. **`lib/orchestration/chat/summarizer.ts`** — read for the rolling-summary mechanism. Confirm what's public.
8. **`lib/orchestration/llm/provider.ts`** — re-read for the `transcribe()` method signature.
9. **`app/api/v1/admin/orchestration/providers/[id]/test-model/route.ts`** — the canonical example of calling `provider.transcribe()` from a route handler.
10. **`prisma/seeds/006-quiz-master.ts`** — re-confirm the agent-with-capabilities seed pattern. Pay attention to `AiAgentCapability` rows (the binding between agent and capability with per-agent overrides like `requiresApproval`).

## Goals for this phase

1. **Seed the conversational agent** via `lib/app/questionnaire/seeds/009-conversational-agent.ts`:
   - Slug: `app-questionnaire-conversational`.
   - **System instructions are not baked into the agent row.** Because every questionnaire has its own persona, tone, and question set, the agent's stored `systemPrompt` is a generic template like:

     ```
     You are a warm, conversational interviewer helping a user complete a questionnaire. Refer to the {{questionnaireName}} context provided in entityContext, the questionnaire's stated goal ({{questionnaireGoal}}), and the intended audience ({{questionnaireAudience}}). Ask the current targeted question naturally — never as a numbered form field. Use the user's profile ({{userProfile}}) and recent conversation history to personalise.

     Calibrate tone and depth to the audience: if the audience's expertise level is `novice`, prefer plain language; if `expert`, you may use domain terms without explaining them. If the audience sensitivity is `high`, slow the conversation and acknowledge difficulty where appropriate. If the audience locale is not `en`, respond in the configured language throughout.

     Use the {{toolName}} tool after every user message to extract structured answers from what they said.
     ```

     The route handler interpolates `{{questionnaireName}}`, `{{userProfile}}`, etc. at runtime via Sunrise's existing prompt-resolution machinery (read `lib/orchestration/agents/resolve-effective-prompt.ts` for how Sunrise does this for agents).

   - Visibility: `private`.
   - `costPerExecutionCapUsd`: derived from the per-questionnaire `costBudgetUsd / expectedSessions` — the seed sets a conservative default; per-questionnaire overrides happen at session-start time via `AiAgentVersion` snapshots (read Sunrise's agent-versioning code in `lib/orchestration/agents/` for how Sunrise scopes per-conversation agent config).
   - Attached capabilities (via `AiAgentCapability` binding rows in the seed): `app_extract_answer_from_message`, `app_detect_contradictions` (both seeded in Phase 4), plus `search_knowledge` (Sunrise built-in, attached only if the questionnaire has an associated knowledge base — optional within this phase, omit if no use case yet).
   - Fallback providers configured per Sunrise's existing fallback-chain pattern (read `prisma/seeds/009-provider-models.ts` for the canonical column choices).

2. **Implement the per-turn orchestrator** under `lib/app/questionnaire/sessions/turn-orchestrator.ts` as a platform-agnostic module:

   ```typescript
   interface TurnInput {
     sessionId: string;
     userMessage: string;
     prisma: PrismaClient;
   }

   interface TurnOutput {
     events: AsyncIterable<ChatEvent>;
     turnId: string; // resolved after the turn completes
   }

   async function runTurn(input: TurnInput): Promise<TurnOutput>;
   ```

   `runTurn` performs:
   1. Load the full `SessionState` snapshot (Phase 4's loader).
   2. Pick the next targeted question via the configured `SelectionStrategy`.
   3. Retrieve top-N tangential candidates via the Phase 4 tangential retriever.
   4. Build the agent's `entityContext`: `{ sessionId, targetedQuestionId, tangentialCandidateIds, recentTurns, userProfile, questionnaireName, questionnaireGoal, questionnaireAudience, lowConfidenceCount }`. The Phase 4 capabilities consume these fields when invoked. The conversational agent uses `questionnaireGoal` and `questionnaireAudience` (when set) to calibrate tone and depth: a novice-expertise audience prompts more plain-language framing; a high-sensitivity audience prompts a more careful, slower-paced conversational style; a non-`en` locale prompts the agent to use the configured language throughout.
   5. Build the agent's `message` (the user's incoming text — for transcription via voice input, this has already been resolved by the route layer before `runTurn` is called).
   6. Call `streamChat({ message, agentSlug: 'app-questionnaire-conversational', userId, conversationId: session.conversationId, entityContext })`.
   7. Wrap the returned event stream: tee it so callers get the live SSE, and a background tap consumes it to persist a row to `AppQuestionnaireTurn` once `done` arrives (capturing `agentMessage`, `costUsd`, the capability results extracted by the agent, and the targeted/side-effect answer IDs derived from those results).
   8. After `done`, re-evaluate completion via Phase 4's `evaluateCompletion()`. If `agentShouldOfferCompletion` is true, mark on the session row so the next round's prompt includes a completion suggestion.

   Pure orchestration logic, fully unit-testable with mocked `streamChat`, mocked Prisma, mocked Phase 4 strategies.

3. **Implement the session API** at `app/api/v1/app/questionnaire-sessions/`:
   - `POST /api/v1/app/questionnaire-sessions` — start a new session.
     - Body: `{ versionId: string, invitationToken?: string, userProfile: Record<string, unknown> }` (the `userProfile` shape is validated against the version's `userProfileFields` config — admin defines what fields the questionnaire collects).
     - Auth: either `withAuth` (logged-in user) or by-token (if `invitationToken` matches a `pending` invitation, the user is logged in via the same auth flow Sunrise's `app/api/v1/users/invite/` route uses).
     - Creates `AppQuestionnaireSession` (status `in_progress`), `AppQuestionnaireUserProfile` (with `capturedFields` matching the config schema), and a corresponding `AiConversation` row (so `streamChat` has a conversation to anchor messages on). Returns `{ sessionId, conversationId }`.

   - `POST /api/v1/app/questionnaire-sessions/:id/messages` — send a user message and stream the agent's response.
     - Body: `{ message: string }` for text-only turns.
     - **For voice and attachments**, the route accepts `multipart/form-data` with optional `audio` (a recorded audio blob) and/or up to ten `attachments[]` (image or PDF binaries). The route's voice and attachment handling consumes Sunrise's existing primitives — no parallel transcription endpoint, no parallel attachment-validation logic. See goal 5 and 5a below for the full lifecycle. **The voice and attachment paths are gated by the Phase 9 sub-flag `APP_QUESTIONNAIRES_VOICE_ENABLED` and an equivalent attachment sub-flag respectively**: when off, the route rejects the corresponding multipart parts with a clear error. The two-flag model means a demo presenter can both (a) flip voice/attachments off across the platform for a demo where they aren't part of the pitch, and (b) opt-in per-questionnaire when the platform-level flag is on. **Both default off in demo presets** — voice and attachments are advanced affordances that only matter for specific verticals (drivers / accessibility users for voice; vendor onboarding / compliance evidence for attachments). Most questionnaire demos don't show them.
     - Calls `runTurn({ sessionId, userMessage, attachments?, prisma })` and returns `sseResponse(events)`.
     - Auth: must be the session's user OR an anonymous-session-token holder (Phase 8 anonymous mode).
     - Per-session cost-cap enforcement: before calling `runTurn`, check `getActualCost(sessionId)` against the questionnaire's `perSessionCostCapUsd`. If approaching 90%, the orchestrator injects a soft-cap hint into `entityContext` (`approachingBudget: true`); the agent's system prompt mentions to gently wrap up. If exceeded, the route returns 402 with `{ error: 'session_budget_exceeded' }` and the session auto-pauses.

   - `POST /api/v1/app/questionnaire-sessions/:id/refine/:answerSlotId` — trigger a refinement turn.
     - Sets a flag on the session indicating "next user message is a refinement of slot X".
     - The next `POST /messages` call's `runTurn` reads this flag, overrides the targeted question to be the refinement target (forcing `targetedQuestionId = answerSlot.questionSlotId`), and the agent's `entityContext` includes `refining: true` so its tone shifts to a direct follow-up.
     - The capability-extracted answer for that slot is written with `provenanceLabel: 'refined'` and the refinement history is appended to `AppAnswerSlot.refinementHistory`.

   - `GET /api/v1/app/questionnaire-sessions/:id` — full session state for resumption. Returns: session row, user profile, all `AppAnswerSlot` rows (subject to the version's `visibilityConfig`), all `AppQuestionnaireTurn` rows, the questionnaire version's sections and questions, the current completion status from `evaluateCompletion()`.

   - `POST /api/v1/app/questionnaire-sessions/:id/pause` — flips status to `paused`, writes an `AppQuestionnaireSessionEvent` row.

   - `POST /api/v1/app/questionnaire-sessions/:id/resume` — flips back to `in_progress`. Writes a session event.

   - `POST /api/v1/app/questionnaire-sessions/:id/complete` — finalises. Validates `evaluateCompletion(state).canSubmit === true`. Flips status to `completed`, writes the completion event, sends a completion-notification email (using `sendEmail` + an app-owned React-Email template under `lib/app/questionnaire/email-templates/completion.tsx`).

4. **Memory / rolling summary.** `streamChat` already handles conversation history loading. For very long sessions (>20 turns), Sunrise's `summarizer.ts` provides a rolling-summary regeneration mechanism — confirm it's invoked automatically by `streamChat` (read `streaming-handler.ts` for the trigger condition). If it isn't, the prototype invokes it explicitly inside `runTurn` once the conversation exceeds the configured threshold.

5. **Voice input via Sunrise's existing audio infrastructure.** No new transcription endpoint, no platform-owned `provider.transcribe()` call. The platform consumes Sunrise's existing voice plumbing as-is:
   - Sunrise already ships `getAudioProvider()` in `lib/orchestration/llm/provider-manager` — picks the first audio-capable provider with an open circuit breaker. The platform calls this directly from the `/messages` route when audio is present.
   - Sunrise already ships the `useVoiceRecording` hook with full `MediaRecorder` lifecycle (runtime MIME selection across Chrome/Firefox/Safari/iOS, 3-minute client-side cap, elapsed-time tracking, clean teardown). Phase 7's user-facing UI consumes this hook directly; no parallel recording state machine.
   - Sunrise already defines the `CostOperation = 'transcription'` cost-log shape with Whisper per-minute pricing. The platform's `/messages` route logs the transcription cost through Sunrise's `logCost()` with the session's metadata tag so it rolls up to `getActualCost(sessionId)` automatically.

   The `/messages` route flow when audio is present:
   1. Parse the multipart form, extract the audio blob. Validate MIME against Sunrise's allowlist (`audio/webm | audio/mp4 | audio/mpeg | audio/wav | audio/ogg`) and the 25MB size cap — both should match Sunrise's existing validation, copied verbatim or reused if Sunrise exposes a helper.
   2. Call `getAudioProvider()` to resolve an audio-capable provider. If none exists, return `400 { error: 'NO_AUDIO_PROVIDER' }`.
   3. Call `provider.transcribe(buffer, { language: 'en' })` to get `{ text, durationMs, language? }`.
   4. Log the transcription cost via Sunrise's existing `logCost()` with `operation: 'transcription'`, `durationMs`, and `metadata.appQuestionnaireSessionId`.
   5. Treat the resulting `text` as the user's message and proceed with `runTurn` as if it had been a text turn.

   **Per-questionnaire toggle** consumes Sunrise's `AiAgent.enableVoiceInput` on the conversational agent (goal 1 below sets this). **Org-wide kill switch** consumes Sunrise's `AiOrchestrationSettings.voiceInputGloballyEnabled`. The platform's `APP_QUESTIONNAIRES_VOICE_ENABLED` sub-flag is a third gate that applies only to the questionnaire surface — useful for live demos where the presenter wants voice off across questionnaires without flipping it off everywhere in Sunrise.

   **Effective state**: `agent.enableVoiceInput && settings.voiceInputGloballyEnabled && app_questionnaires_voice_enabled`. All three must be true for the affordance to appear in the UI and the `/messages` route to accept audio.

5a. **Image and document attachments via Sunrise's existing primitives.** Same architectural pattern as voice — the platform consumes Sunrise's existing attachment infrastructure rather than building a parallel surface.

- Sunrise already defines `chatAttachmentSchema` validating images (JPEG/PNG/WebP/GIF), PDFs, plain text, CSV, markdown, and DOCX. The platform's `/messages` route applies this schema to the multipart attachments without modification.
- Sunrise already defines per-attachment and per-turn byte caps (`MAX_CHAT_ATTACHMENT_BASE64_CHARS`, `MAX_CHAT_ATTACHMENT_COMBINED_BASE64_CHARS`) and the 10-per-turn limit. The platform inherits these.
- Sunrise already defines `assertModelSupportsAttachments(providerSlug, modelId, kinds)` which checks the resolved chat model's capabilities before attempting to send. The platform's route calls this before passing attachments through to `streamChat`. Capability mismatch surfaces as `400 { error: 'IMAGE_NOT_SUPPORTED' | 'PDF_NOT_SUPPORTED' }`.
- Sunrise already defines `CostOperation = 'vision'` with per-attachment pricing. The platform's `/messages` route inherits this — no platform-specific cost wiring.
- **Pass-through storage policy** is inherited too: image and PDF bytes never persist beyond the in-memory request body. The `AppAnswerSlot.value` field captures whatever the user said about the attachment, not the bytes themselves.

The `/messages` route flow when attachments are present:

1.  Parse the multipart form, extract `attachments[]` as base64 (matching Sunrise's `ChatAttachment` shape).
2.  Validate against `chatAttachmentSchema`.
3.  Call `assertModelSupportsAttachments(providerSlug, modelId, [imageCount > 0 ? 'vision' : null, pdfCount > 0 ? 'documents' : null].filter(Boolean))` to fail-fast on capability mismatch.
4.  Pass the attachments through to `runTurn`, which forwards them to `streamChat` via `ChatRequest.attachments`. Sunrise handles the rest (provider-specific PDF transport, base64 encoding, cost logging).

**Per-questionnaire toggles** consume Sunrise's `AiAgent.enableImageInput` and `AiAgent.enableDocumentInput` on the conversational agent. **Org-wide kill switches** consume `AiOrchestrationSettings.imageInputGloballyEnabled` and `.documentInputGloballyEnabled`. **Platform sub-flag** `APP_QUESTIONNAIRES_ATTACHMENTS_ENABLED` adds the third gate (defaults off in demo presets — most questionnaire demos don't show attachments).

**When attachments matter for a demo**: vendor-onboarding questionnaires (the user attaches a certificate the agent extracts from), compliance-attestation questionnaires (the user attaches evidence the agent reviews). For most questionnaires (employee satisfaction, NPS, product feedback), attachments are noise. The conditional inclusion in demos is documented in `runbook.md`.

6. **Crash recovery.** Because the per-turn orchestrator is stateless — every turn loads the full session state from the database — a server restart loses no state. An in-flight SSE stream that drops mid-turn results in:
   - The assistant message _may or may not_ have been persisted (depends on where in the stream the drop happened — `streamChat` persists on `done`).
   - On reconnect, the client calls `GET /:id` to refetch state; if the last turn wasn't persisted, the client sees the prior turn count and re-sends the user message. The route handler's idempotency check (the prototype owns an `AppQuestionnaireTurn` row count vs the user message; if a turn with the same `ordinal` and `userMessage` already exists, return the existing turn's response).
   - Document this in `sessions.md`. It's not perfect but it's adequate for the prototype.

7. **Unit tests at `tests/unit/lib/app/questionnaire/sessions/`**:
   - `turn-orchestrator.test.ts` — `runTurn` happy path with mocked `streamChat`, mocked strategies, mocked Prisma. Boundary cases: first turn (no prior conversation), refinement turn, approaching-budget turn, soft-cap-hint turn, completion-offer turn. Assert: `entityContext` shape is correct, `AppQuestionnaireTurn` row is persisted with the right fields after `done`, completion is re-evaluated.
   - `session-state-loader.test.ts` — the `SessionState` loader's correctness against fixture DB rows.
   - `voice/transcribe.test.ts` — route handler's audio-vs-text branching, `provider.transcribe` mocked.
   - Cost-cap-check logic in isolation.

8. **Integration tests at `tests/integration/api/v1/app/questionnaire-sessions/`**:
   - `start-session.test.ts` — POST session-start with valid invitation token, with valid logged-in user, with invalid profile shape, with locked-version, with already-completed-invitation.
   - `messages-text.test.ts` — POST a text message, assert the SSE stream emits `start` → `content` deltas → `capability_result` (extraction) → `done`. After completion, assert `AppQuestionnaireTurn` row exists, `AppAnswerSlot` rows are populated, `evaluateCompletion` runs.
   - `messages-voice.test.ts` — POST audio, mock `provider.transcribe`, assert transcript becomes the user message and proceeds normally.
   - `refine.test.ts` — refinement flow: set refine flag, send message, assert targeted question is the refinement target, assert `provenanceLabel: 'refined'`, assert refinement-history append.
   - `complete.test.ts` — refusal when not canSubmit, success when canSubmit, completion email sent (mocked).
   - `pause-resume.test.ts` — status transitions and session events.
   - `cost-cap.test.ts` — drive a session over its `perSessionCostCapUsd`, assert 402 and auto-pause.
   - `crash-recovery.test.ts` — simulate a turn that creates an AI conversation message but not the `AppQuestionnaireTurn` row; assert the next user message with the same content is idempotent.

9. **End-to-end test at `tests/integration/lib/app/questionnaire/`** — `full-session.test.ts`: programmatically drive a full session via the public API, 10+ turn cycles with deterministic mocked LLM responses (using a test provider that returns canned structured-output JSON), assert: final answer set is correct, all confidence scores are recorded, provenance labels are coherent, completion is offered at the right point, the session completes successfully, the PDF export (Phase 7 dependency — deferred or stubbed here).

10. **Documentation at `.context/app/questionnaire/`**:
    - `sessions.md` — the session lifecycle (in_progress / paused / completed / abandoned), the per-turn orchestrator's design (and the architectural correction that the orchestrator-not-workflow approach is deliberate), the cost-cap enforcement, the crash-recovery story, the voice-input path, the refinement flow.
    - `agent-config.md` — the conversational agent's stored prompt template, the runtime interpolation pattern, the entityContext shape contract between the route handler and the capabilities, the fallback-chain configuration.
    - Update `admin-api.md` if any admin-side routes are added (probably none in Phase 6).
    - Update `overview.md`. Update `upstream-gaps.md`.

## Expected upstream findings (section (c) of your plan)

1. **`streamChat`'s `entityContext` is not strictly typed by capability.** The prototype's capabilities expect specific keys (`sessionId`, `targetedQuestionId`, etc.) but `entityContext: Record<string, unknown>` is opaque. Sunrise could expose a typed-context-channel mechanism. **Severity:** C.
2. **No public idempotency-key handling for chat messages.** The prototype's crash-recovery relies on its own duplicate-turn detection. Sunrise's chat handler doesn't accept an idempotency key. **Severity:** B.
3. **Per-conversation agent config (per-instance overrides for `systemPrompt`, `costCap`)** is not directly supported by `streamChat`. The prototype interpolates the prompt at the route handler level before `streamChat` runs. Sunrise could expose a `systemPromptOverride` parameter on `ChatRequest`. **Severity:** B.
4. **Audio transcription has no public route handler example end-to-end.** The admin test-model route is the closest pattern. Sunrise could ship a `transcribeAudio(buffer, options)` higher-level helper that handles provider resolution and cost logging. **Severity:** C.
5. **Soft-cap nudging is not a first-class concept.** The prototype injects a soft-cap hint into `entityContext`; the agent's prompt mentions to wrap up. Sunrise could formalise this as a budget-status event channel. **Severity:** C.

## Open decisions to surface in section (l)

- **Soft-cap threshold default (90% of `perSessionCostCapUsd`).** Confirm.
- **Crash-recovery idempotency strategy** — duplicate-turn detection by `(ordinal, userMessage)` hash is approximate but cheap. A proper Idempotency-Key header (RFC 8941) would be cleaner; flag as upstream finding.
- **Whether voice transcription costs count toward the per-session cap.** Recommend yes (they're part of session cost) but the operator may want them tracked separately.

## Definition of done

- A developer can `curl` an SSE stream against `/api/v1/app/questionnaire-sessions/:id/messages` and observe the agent's conversational reply, with answers being extracted and persisted into `AppAnswerSlot`.
- Voice input via `multipart/form-data` works for at least one configured provider with `transcribe()` support.
- Refinement turns correctly target a specific answer slot and tag with `provenanceLabel: 'refined'`.
- Pause / resume / complete transitions work and produce `AppQuestionnaireSessionEvent` rows.
- The per-session cost cap halts the session gracefully when exceeded.
- All Phase 6 unit, integration, and end-to-end tests pass.
- `.context/app/questionnaire/sessions.md` and `agent-config.md` are written and committed; `overview.md` and `upstream-gaps.md` updated.
- Zero new Sunrise-owned files modified.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Phase 7 — User-facing conversational UI

```

We are starting Phase 7 of the Conversational Questionnaire prototype: the user-facing conversational UI.

[paste the shared context block from above]

This phase delivers the split-screen experience users actually see. Business logic is in place from Phase 6; this phase is pure UI consumption of `/api/v1/app/questionnaire-sessions/*`. New pages live under `app/(protected)/questionnaires/` — under Sunrise's existing `(protected)` route group, which gives them Sunrise's auth-required layout for free.

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`app/(protected)/`** — confirm what layout pages here inherit. Read `app/(protected)/dashboard/page.tsx` or similar as a reference for shape.
2. **`components/admin/orchestration/chat/chat-interface.tsx`** — read in full. This is the canonical Sunrise pattern for SSE-streaming chat in React: `fetch` + `ReadableStream.getReader()` (not `EventSource`), manual SSE frame parsing, `AbortController` for cleanup, exponential-backoff reconnect, all the production-grade details. The prototype's chat component copies this pattern. **The `ChatInterface` component is page-internal to the admin surface and is not directly reusable** — but the streaming logic in it (around the `fetch` + reader loop) is the template.
3. **`components/admin/orchestration/chat/message-with-citations.tsx`** — confirm this is exported and importable. The prototype reuses it directly for the agent-message rendering.
4. **`components/ui/`** — confirm the available shadcn primitives: `accordion`, `sheet` (for the mobile bottom sheet), `progress`, `dialog`, `button`, `card`, `badge`, etc.
5. **`package.json`** — confirm no Playwright dep is installed (re-flagged from earlier phases). Confirm whether Framer Motion is a dep (for the highlight-fade animation); if not, use Tailwind's `transition-*` utilities.
6. **`package.json`** — confirm no PDF rendering dep is installed. This is the unavoidable Phase 7 finding: user PDF download requires a new dep. Three operator-chosen options laid out below.
7. **`lib/auth/utils.ts`** — confirm `getServerSession()` or equivalent so server components and route handlers can check auth.

## Goals for this phase

1. **Route group under `app/(protected)/questionnaires/`** — Sunrise's `(protected)` group requires authentication, so all pages here automatically reject anonymous users via the existing redirect chain. New pages:
   - `app/(protected)/questionnaires/invitations/[token]/page.tsx` — invitation landing page. Server component that resolves the invitation token, validates it's `pending` or `sent`, and renders the user-profile form derived from the version's `userProfileFields` config. The form switches on each field's `type` to render the right HTML input: `text` → `<input type="text">`; `email` → `<input type="email">` with browser-level format validation; `number` → `<input type="number">` honouring the field's optional `minValue` / `maxValue` constraints (also enforced server-side at session-start); `select` → `<select>` populated from the field's `options` array. Each field shows its `label` and optional `helperText` and respects the `required` flag. On submit, calls `POST /api/v1/app/questionnaire-sessions`. On success, redirects to `[sessionId]`.

   - `app/(protected)/questionnaires/page.tsx` — the user's own list of in-progress and completed sessions across all questionnaires they've been invited to. Read-only.

   - `app/(protected)/questionnaires/[sessionId]/page.tsx` — the split-screen conversational experience.

   - `app/(protected)/questionnaires/[sessionId]/complete/page.tsx` — completion confirmation page with PDF download link (if PDF dep is installed; otherwise a print-this-page fallback).

   **All four pages apply the per-client theme** from Phase 2.5. Each page is a server component that resolves the invitation → `demoClientId` → `AppDemoClient` row → `resolveTheme()` → `themeToCssVariables()`, injecting the result into an inline `<style>` tag at the top of the rendered output. The client's `logoUrl` renders in each page's header (or a fallback to Sunrise's existing branding when null). The client's fonts are loaded via the Phase 2.5 `loadClientFonts()` helper, applied through `next/font/google`'s dynamic family loading. The `welcomeMessageMd` renders above the user-profile form on the invitation landing page; the `completionMessageMd` renders on the completion page. Read `.context/app/questionnaire/theming.md` (Phase 2.5) for the contract.

   **Theme resolution on the session page** uses `session.versionId → version.questionnaireId → questionnaire.demoClientId`, since `AppQuestionnaireSession` itself is not denormalised with `demoClientId` (only `AppQuestionnaireInvitation` is). This is fine because the session page is loaded post-authentication and the lookup is cheap.

   **When `demoClientId` is null** (the "Generic Sunrise demo" case from Phase 2.5), the theming module returns Sunrise defaults and no inline style override is needed — the pages render with the standard Sunrise look. This must work end-to-end as a smoke test.

2. **The split-screen `[sessionId]` page**:
   - **Layout**: CSS grid, left pane 60% / right pane 40% on desktop ≥ 1024px. On mobile (< 1024px), single-column with chat full-width and a "View progress" button in the header that opens the right pane as a shadcn `<Sheet>` bottom sheet.

   - **Left pane** — chat window:
     - SSE streaming via the prototype's own `useQuestionnaireSessionStream` hook at `lib/app/questionnaire/hooks/use-session-stream.ts`. Hook copies the fetch+reader pattern from Sunrise's `chat-interface.tsx`. Returns `{ messages, isStreaming, send, sendAudio, sendWithAttachments, reconnectAttempt }`.
     - Agent messages rendered via Sunrise's `MessageWithCitations` (imported directly from `@/components/admin/orchestration/chat/message-with-citations`).
     - User messages rendered with a simple right-aligned bubble in app-owned styling.
     - Input box at the bottom: text input + send button.
     - **Voice button consumes Sunrise's existing `<MicButton>` component + `useVoiceRecording` hook directly.** No platform-owned `MediaRecorder` lifecycle, no parallel runtime-MIME-selection logic, no parallel auto-stop timer — every cross-browser concern Sunrise has already solved is inherited verbatim by importing `MicButton` from Sunrise's chat components and wiring its `onComplete(audioBlob, durationMs)` callback to the session-stream hook's `sendAudio`. The button is rendered only when the effective state from Phase 6 goal 5 evaluates true (`agent.enableVoiceInput && settings.voiceInputGloballyEnabled && app_questionnaires_voice_enabled`).
     - **Attachment button consumes Sunrise's existing attachment UI primitives** (file-input affordance, attachment chips, the chat-attachment schema's client-side validation) — see Sunrise's `AgentTestChat` for the canonical pattern. Multipart POST to `/messages` carries both attachments and an optional text message. The button is rendered only when `agent.enableImageInput || agent.enableDocumentInput` and the corresponding org-wide + platform sub-flag gates evaluate true (per Phase 6 goal 5a).
     - Streaming indicator while `isStreaming`.
     - Reconnection indicator on `reconnectAttempt > 0`.
     - Disabled state during refinement turns with a clear "Refining: [question prompt]" banner.

   - **Right pane** — questionnaire progress:
     - Header: progress bar (`weightedComplete %` from the completion evaluator), low-confidence count badge, "Submit now" button (enabled when `canSubmit`).
     - Body: shadcn `<Accordion>` with one item per section (only rendered if `visibilityConfig.sectionGroupingVisible` else flat list). Section header shows section name + "X of Y answered" count.
     - Each section's body lists answered questions (only if `visibilityConfig.slotsVisible`) as cards:
       - Question prompt.
       - Current answer value (formatted per `type`: Likert as `4/5`, multi-choice as comma-separated labels, free-text as the verbatim string).
       - Confidence indicator: a 1–10 pill, colour-coded (red ≤ 3, amber 4–6, green ≥ 7).
       - Provenance label badge (only if `visibilityConfig.provenanceLabelVisible`): `direct` / `inferred` / `synthesised` / `refined`.
       - Rationale (only if `visibilityConfig.rationaleVisible`): one-sentence explanation from the extractor.
       - Refine button (always shown for visible answers).
     - **Visibility-config redaction happens server-side** in the `GET /:id` route (Phase 6). The right pane just renders what it receives; if a field isn't in the response, it's hidden.
     - **Highlight-fade animation** when an answer card updates from a streamed turn: Tailwind `transition-colors duration-1000` with a temporary `bg-amber-100` class added on update, removed after 1.5s. No Framer Motion needed.

3. **Refine button behaviour** — fires `POST /api/v1/app/questionnaire-sessions/:id/refine/:answerSlotId`, then `sendMessage` is disabled in the UI until the next user reply (which will be tagged as a refinement). The agent's next streamed message includes a refinement-specific tone; the UI shows the "Refining: [question prompt]" banner over the chat input.

4. **Completion flow**:
   - When `agentShouldOfferCompletion: true` in the latest session state (re-fetched after each turn's `done` event), the chat shows the agent's final message followed by an inline "Submit now" button.
   - Manual "Submit now" button in the right-pane header is enabled when `canSubmit: true`.
   - On submit, calls `POST /complete`, awaits success, redirects to `[sessionId]/complete`.

5. **PDF download decision** — `GET /api/v1/app/questionnaire-sessions/:id/export.pdf` is a new route under `app/api/v1/app/questionnaire-sessions/`. It needs a PDF library, but Sunrise has none installed. **Three operator-chosen paths**, surface in section (l):
   - **Path A — smallest-possible-breach**: add `@react-pdf/renderer` (~120kB) to `package.json` with a comment-fence labelling it as added by the questionnaire prototype. Implement the route using it. Easiest, fastest. Breaches zero-touch.
   - **Path B — defer PDF download**: the completion page shows a "Print this page" button using `window.print()` and a print-friendly CSS stylesheet under `app/(protected)/questionnaires/[sessionId]/complete/print.css`. Users print to PDF via their browser. No Sunrise edit. Acceptable for a prototype between friendly-pilot and paying-client.
   - **Path C — wait for upstream**: skip PDF download in Phase 7, implement once Sunrise adds the dep. Phase 9 picks it up if it lands.

   Phase 0's `upstream-gaps.md` already flagged this; Phase 7's plan must surface the choice. If Phase 0 hasn't gone live with a chosen path, Phase 7 blocks on the decision.

6. **Pause / resume** — auto-pause via `navigator.sendBeacon('/api/v1/app/questionnaire-sessions/:id/pause')` on `beforeunload`. Explicit resume on `[sessionId]` page mount if the session status is `paused`.

7. **Session-state hydration**. Every page mount calls `GET /:id` to load the full state, replaying turns into the chat and answers into the right pane. The streaming hook merges new events on top of the hydrated state. Pure React state — no localStorage, no service worker.

8. **Demo-grade polish bar.** This phase ships the user-facing experience that prospects actually see during a live demo. **Functional correctness is necessary but not sufficient.** A naive implementation could pass every test in this phase and still embarrass John or Simon in a live demo through visual roughness, jarring transitions, or generic-looking defaults. The following polish criteria are deliverables, not nice-to-haves:
   - **Typography and rhythm**. Real font choices via the Phase 2.5 font loader (defaults: Inter for body, a complementary heading font from the whitelist). Comfortable line height (1.5-1.6 for body, 1.2-1.3 for headings). Consistent vertical rhythm across the chat, the answer cards, and the page chrome — eyeball-check that nothing feels cramped or sparse.

   - **Conversational chat surface**. Smooth message-appearance animations (fade-in + subtle slide-up; ~150-200ms; use Tailwind's `transition-*` utilities or Framer Motion if available). Agent vs. user message differentiation: distinct background colours from the theme, distinct alignment (agent left, user right), distinct max-widths (~70% of the container) so the conversation reads at a glance. **Mid-message "thinking" indicator** while waiting for the first token: a subtle three-dot animation, never a spinner. **Token streaming feels fluid** — render incrementally as bytes arrive, no choppy buffering.

   - **Answer cards (right pane)**. Distinct hover states (subtle shadow lift, ~100ms transition). Accessible focus rings (visible keyboard focus, not just outline). **Smooth highlight-fade on update**: when an answer card gets a new value mid-conversation, a 1-2 second highlight animation draws the user's eye without being jarring. Empty-state copy when no answers yet ("Your answers will appear here as we go through this together" or similar — warm tone, not technical).

   - **Mobile bottom-sheet**. Smooth slide animation on open and close (~250ms ease). Proper safe-area handling for iOS notches and Android gesture bars. The sheet's drag handle is visible and reads as draggable. Tapping outside dismisses; tapping in doesn't. Don't ship the default shadcn bottom-sheet feel without tuning.

   - **Completion screen**. **Celebratory but restrained** — a small visual flourish (a green checkmark with a subtle scale-in animation, or a similar gentle treatment) signals success without feeling kitsch. A clean summary of what was discussed: the questionnaire name, the user's name, the duration, the count of answers captured, optional confidence summary if `provenanceLabelVisible` is on. The client's brand is prominent (logo, theme colours fully applied). The PDF download button (if Path A) reads as the primary action; secondary actions (start a new session, return to invitation page) are visually subordinate.

   - **Loading states**. Every async operation has a defined loading state. **Skeleton screens, not spinners on blank backgrounds.** The invitation landing page shows a skeleton of the profile form while the version's `userProfileFields` config is loading. The session page shows a skeleton of the split-screen layout while the session state is hydrating. The chat shows a skeleton of the conversation while turns are loading. The completion page shows a skeleton of the summary while the final state is being fetched.

   - **Error states**. Every error path has a defined empathetic message. **No "An error occurred" or "Something went wrong" copy.** Specific, actionable language: "We couldn't reach the server — try the button again, or refresh the page" / "This invitation has already been used. If you think that's a mistake, contact the person who invited you." / "Your session timed out — your answers are saved and you can pick up where you left off." Each error has a clear next-step affordance.

   - **Accessibility baseline.** WCAG AA contrast across the theme defaults (the theming module's CSS-variable defaults must pass contrast checks even before client themes are applied). Keyboard navigation works for every interactive element. Screen-reader labels on all icon-only buttons. Live-region announcements for streamed messages (the chat is an `aria-live="polite"` region).

   - **Polish-bar definition-of-done check.** Before this phase is declared done, John, Simon, or a designated reviewer **conducts a 5-minute live walkthrough** of the user-facing flow on both a laptop and a phone, and signs off that nothing about the visual experience would make them hesitate to demo it to a prospect. This isn't a unit test — it's a subjective sign-off that protects the sales-demo intent. Document the sign-off in the Phase 7 PR description.

   The polish bar applies specifically to the user-facing pages (the four pages under `app/(protected)/questionnaires/`). The admin surface keeps Sunrise's existing admin shell — admin polish is a Sunrise concern, not a Phase 7 deliverable.

9. **Unit tests at `tests/unit/app/(protected)/questionnaires/`** (server components) and **`tests/unit/lib/app/questionnaire/hooks/`** (the stream hook):
   - `use-session-stream.test.ts` — happy path with a mocked `fetch` returning a `ReadableStream`; reconnect on drop; abort on unmount; error handling.
   - `answer-card.test.tsx` — every visibility-config combination renders the right subset of fields. Each `type` formats its value correctly. Confidence pill colour matches the score band.
   - `progress-pane.test.tsx` — accordion renders the right section structure; "Submit now" enabled/disabled per `canSubmit`; highlight-fade triggers on prop change.
   - `chat-input.test.tsx` — text submission, voice toggle visibility per config, MediaRecorder mock.

10. **Integration tests at `tests/integration/app/(protected)/questionnaires/`**:

- `invitation-flow.test.ts` — token resolution, profile capture matching the version's `userProfileFields`, session creation, redirect.
- `session-page-hydration.test.ts` — page mount fetches state, renders chat history and answer pane correctly.
- `streaming.test.ts` — message send → stream receive → answer-pane update.
- `refinement.test.ts` — clicking Refine triggers the right API call and UI banner.
- `completion.test.ts` — Submit Now flow.
- `pause-resume.test.ts` — beforeunload triggers pause; mount triggers resume.
- `theming.test.ts` — given a themed `AppDemoClient`, the invitation landing page, session page, and completion page each render with the client's CSS variables in an inline `<style>` tag, the client's logo in the header, and the client's `welcomeMessageMd` / `completionMessageMd` in the right places. Given a null `demoClientId` (Generic Sunrise demo), the same pages render with no theme override and Sunrise's defaults visible — assert the absence of the prototype's inline `<style>` injection.

11. **End-to-end tests** — without Playwright, these are Vitest integration tests using a server-component testing approach. State explicitly: "Full browser E2E deferred until Sunrise adds Playwright (upstream finding from Phase 0). The full-flow tests in this phase use Vitest with React Testing Library and `next-test-api-route-handler`-equivalent route mocking." When Playwright lands, the test suite migrates without restructure.

12. **Documentation at `.context/app/questionnaire/`**:
    - `frontend.md` — page routes under `app/(protected)/questionnaires/`, the split-screen layout, the mobile bottom-sheet behaviour, the streaming hook, the visibility-config rendering rules, the refinement flow, the completion flow, the pause/resume mechanism, the highlight-fade animation, the PDF download decision (whichever path was chosen), how the print-fallback works if applicable, **the demo-grade polish bar criteria (cross-reference Phase 7 goal 8) so a fork that re-themes for a real client knows what visual treatments to preserve**, **and the per-client theming hook on each page (cross-referencing `theming.md` from Phase 2.5)**.
    - `user-flows.md` — walked-through user-facing experience with descriptions of each page state, including the visual difference between a themed-client demo and a Sunrise-default demo.
    - Update `overview.md`. Update `upstream-gaps.md`. Update `theming.md` (created in Phase 2.5) with the specific page-integration details now that the consumer pages exist.

## Expected upstream findings (section (c) of your plan)

1. **No PDF rendering library installed.** Already flagged in Phase 0. Phase 7's plan must restate the operator's chosen path (A/B/C) and remind the team this is still pending upstream.
2. **No reusable streaming-chat React hook.** Sunrise's `ChatInterface` component bakes its streaming logic in. Sunrise could lift a `useChatStream(url, options)` hook. The prototype's `useQuestionnaireSessionStream` is its own version of this. **Severity:** B.
3. **`MessageWithCitations` lives under `components/admin/orchestration/chat/`** — under an `admin` namespace, even though the component itself isn't admin-specific. Sunrise could promote it to `components/ui/chat/message-with-citations.tsx`. Until then the prototype imports from the admin path. **Severity:** C.
4. **No standard MediaRecorder-based audio capture component.** The prototype writes its own. Sunrise could lift one. **Severity:** C.

## Open decisions to surface in section (l)

- **PDF download path A/B/C.** Operator chooses.
- **Mobile breakpoint** (`< 1024px` for bottom-sheet). Defensible but worth confirming.
- **Print-fallback CSS scope** if Path B chosen — how much branding to keep.
- **Whether to support session-resumption from a different device** — the design above assumes the same user logs in on the same or different browser. Crash-recovery from Phase 6 covers it but the UX edge case (user starts on phone, finishes on laptop) is worth thinking through.

## Definition of done

- A real user receives an invitation email, clicks the link, lands on the invitation page, fills the profile form, lands on the session page, conducts a conversational session end-to-end (text and/or voice), submits, downloads or prints their answers.
- The right pane respects every visibility-config combination.
- The session resumes correctly on page refresh and on returning days later.
- Mobile layout works (manually verified across one phone-class device and one tablet-class device since Playwright isn't installed).
- **The demo-grade polish bar (goal 8) has been signed off by John, Simon, or a designated reviewer in a 5-minute live walkthrough on both a laptop and a phone. The sign-off is documented in the Phase 7 PR description.** This is a subjective gate that protects the sales-demo intent and complements (but does not replace) the automated test pass.
- All Phase 7 unit, integration, and (Vitest-equivalent) E2E tests pass.
- `.context/app/questionnaire/frontend.md` and `user-flows.md` are written and committed; `overview.md` and `upstream-gaps.md` updated.
- Zero new Sunrise-owned files modified beyond existing Phase 0/2 breaches (Phase 7 adds the `package.json` edit if PDF Path A was chosen).

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Phase 8 — Admin analytics, exports, and anonymous mode

```

We are starting Phase 8 of the Conversational Questionnaire prototype: admin analytics, exports, and anonymous mode.

[paste the shared context block from above]

This phase delivers the data-out side of the prototype. Three concerns: an admin analytics dashboard, downloadable exports in three formats, and end-to-end anonymous-mode enforcement.

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`package.json`** — confirm `recharts` is installed (it is, per Phase 0's verification). Confirm again that no PDF rendering dep is present — the PDF analytics report is subject to the same Path A/B/C decision as Phase 7's user PDF.
2. **`components/admin/orchestration/analytics/`** — read whichever existing admin analytics page lives here (e.g. a costs dashboard, an evaluations chart). Copy the patterns for: chart wrapper components, loading states, empty states, and how `recharts` is typically configured in Sunrise.
3. **`lib/orchestration/llm/cost-tracker.ts`** — re-confirm the aggregation helpers. The prototype reads from `AiCostLog` filtered by `metadata.appQuestionnaireSessionId` (the tagging convention from Phase 3).
4. **`lib/orchestration/knowledge/embedder.ts`** — re-confirm `embedBatch()` for the free-text clustering.
5. **A canonical CSV export pattern in Sunrise**, if one exists. Grep for `text/csv` in `app/` or `lib/` to find any. If none, the prototype builds its own from scratch using a simple template-string approach (no new dep — `csv-stringify` would require adding to `package.json`).
6. **`prisma/schema.prisma`** — re-confirm the prototype's models from Phase 0, especially `AppQuestionnaireConfig.anonymousMode`, `AppQuestionnaireSession.userId nullable`, `AppQuestionnaireSession.anonId`.

## Goals for this phase

1. **Anonymous-mode data layer**. Before any UI, lock down anonymous-mode enforcement at the data-access layer. The prototype owns a `lib/app/questionnaire/anonymous/` module exporting:
   - `getSessionsForAdmin(prisma, versionId, options)` — returns sessions list, with `userId` replaced by an anonymous identifier when `version.config.anonymousMode === true`. The identifier is **a freshly-generated opaque `anonId` from when the session was created** (Phase 6's session-creation route stamps every session with a random `anonId` regardless of mode; it just isn't surfaced unless mode is on). This is **better than a hash of the session ID** because a hash is reversible by anyone with `sessionId` access — `anonId` is genuinely unrelated and untraceable.
   - `getSessionDetailForAdmin(prisma, sessionId)` — single-session detail; in anonymous mode, the `AppQuestionnaireUserProfile` is omitted entirely, turn transcripts have user messages replaced with `[redacted user message]` for any turn where the user said something that could identify them (a heuristic redaction — names, emails, phone numbers via regex), and answer values for free-text questions get a similar pass.

     **The redaction regex is a heuristic placeholder and carries the `// DEMO-ONLY:` header from ground rule 13.** The regex catches obvious patterns (email addresses, North American + UK phone formats, common name salutations) but is not a rigorous PII detector. For demo use against synthetic data this is fine; for a real client engagement, the fork replaces it with a proper PII detection library (e.g. presidio, spaCy NER, or a vendor SDK depending on the client's privacy regime). The header in the redaction module reads:

     ```ts
     // DEMO-ONLY: heuristic PII redaction for demo use against synthetic data.
     // FORK-GUIDANCE: replace with a proper PII detection library (presidio, spaCy NER,
     // or a vendor SDK) before shipping to a real client whose privacy regime requires
     // rigorous detection. This module's regex misses many cases (international phone
     // formats, addresses, account numbers, etc.) and should not be relied on for
     // compliance-grade redaction.
     // SEE: .context/app/questionnaire/forking.md § "Replacing demo tenancy" (anonymous-mode notes)
     ```

   - `assertAdminCanAccessSession(prisma, sessionId, adminUserId)` — ownership scoping. 404 not 403.

   Every admin-side analytics route goes through these helpers — never queries `AppQuestionnaireSession` directly. This makes anonymous-mode enforcement a single-source-of-truth concern.

   **No admin override.** Under anonymous mode, admins cannot un-anonymise. If an admin needs to debug a session, they need to flip the questionnaire's `anonymousMode` config to `false` _before_ the session ran — going forward only. Flag this as an explicit policy decision in `anonymous-mode.md`.

2. **Analytics API** under `app/api/v1/app/questionnaires/`:

   **Tag-filter convention.** Every analytics endpoint below accepts an optional `tagIds` query parameter — a comma-separated list of `AppQuestionTag` IDs scoped to the version. When present, the query is restricted to **questions tagged with all of the supplied tag IDs (AND semantics)**. An empty / missing `tagIds` means no tag filter. The route validates that every supplied tag ID belongs to the same `versionId` (400 on mismatch — same cross-version guard pattern used in Phase 2).
   - `GET /:id/versions/:versionId/sessions?status=...&page=N&pageSize=N&tagIds=...` — paginated sessions list. Returns `{ sessions: SessionSummary[], total, page, pageSize }`. `SessionSummary` includes `completionPct`, `duration`, `costUsd`, `status`, `startedAt`, `completedAt`, and either `user: { name, email } | null` (non-anonymous) or `anonId` (anonymous). When `tagIds` is supplied, sessions are included if they have at least one answer to a question tagged with all the supplied tags. (Reasoning: an admin filtering by tag "sensitive" wants to find sessions that interacted with the sensitive subset, not exclude sessions that didn't.)

   - `GET /:id/versions/:versionId/sessions/:sessionId` — single-session detail with all answers + provenance + turn transcript (or anonymised equivalent per the data-layer rules above). Not filtered (single-row endpoint).

   - `GET /:id/versions/:versionId/analytics/summary?tagIds=...` — `{ completionRate, dropOffBySection: Array<{ sectionId, percentDroppedHere }>, avgConfidencePerQuestion: Array<{ questionId, avgConfidence, sampleSize }>, totalCostUsd, costPerCompletedSession, avgRoundsPerSession, avgSessionDurationSeconds }`. When `tagIds` is supplied: `avgConfidencePerQuestion` is restricted to tagged questions; `dropOffBySection` and the rate metrics are computed against the tagged subset; cost metrics remain whole-session (cost can't be attributed to a question subset cleanly). The response includes a `filter: { tagIds: string[], appliedQuestionCount: number }` envelope so the UI can clearly show "12 of 47 questions match this filter."

   - `GET /:id/versions/:versionId/analytics/distributions?tagIds=...` — per-question response distributions. When `tagIds` is supplied, only distributions for tagged questions are returned.

   - `GET /:id/versions/:versionId/analytics/free-text?clusterThemes=true|false&tagIds=...` — searchable table of free-text answers. When `tagIds` is supplied, restricted to free-text answers on tagged questions. With `clusterThemes=true`, runs an on-demand clustering pass: embeds all free-text answers via `embedBatch`, runs k-means with k = `min(8, ceil(answerCount / 10))`, returns per-cluster centroid sample + member-count. Without `clusterThemes`, returns a flat list. **Clustering is on-demand** (admin clicks "Cluster themes") rather than eager — eager clustering would re-fire embeddings on every session completion which is wasteful for analytics that admins look at occasionally. Document this rationale in `analytics.md`.

   - `GET /:id/versions/:versionId/analytics/confidence-heatmap?tagIds=...` — `{ questions: Array<{ questionId, prompt, confidenceBuckets: [count_1_to_3, count_4_to_6, count_7_to_10] }> }`. When `tagIds` is supplied, restricted to tagged questions.

   - `GET /:id/versions/:versionId/analytics/by-tag` — **new tag-pivoted aggregate view**: returns one row per tag in the version with `{ tagId, key, label, colour, taggedQuestionCount, avgConfidence, totalAnswers, lowConfidenceCount }`. This is the "tags as analytics axis" view rather than "tags as analytics filter" view — admins can scan tag-level metrics without picking a specific tag to filter by.

   All routes use `withAdminAuth` and go through the Phase 8 data-layer helpers. The tag-filtering query construction lives in a single helper `applyTagFilter(prismaQueryBuilder, tagIds)` under `lib/app/questionnaire/analytics/tag-filter.ts` so every endpoint uses identical semantics.

   **Cross-questionnaire per-client analytics** under `app/api/v1/app/demo-clients/`:
   - `GET /api/v1/app/demo-clients/:id/analytics/summary` — aggregate across all questionnaires attached to this client: total questionnaires, total sessions, total completed sessions, total cost, average completion rate. Useful for the demo-client overview dashboard so the admin can see at a glance "here's everything Acme Bank has been demoed."
   - `GET /api/v1/app/demo-clients/:id/sessions?page=N&pageSize=N` — paginated cross-questionnaire sessions list, useful for the demo-client detail page. Respects each questionnaire's `anonymousMode` setting on a per-row basis.

   These two endpoints honour every questionnaire's own anonymous-mode setting — they go through the same data-layer helpers (`getSessionsForAdmin` etc.) for each underlying questionnaire. No new redaction logic.

3. **Admin UI additions** to `app/admin/questionnaires/[id]/page.tsx`:
   - **Sessions tab** (replaces the Phase 2 placeholder): paginated table with filters (status, date range, completion %, cost band). Columns: anonymous-aware (no name/email columns when `anonymousMode: true`). Click a row → session detail page at `app/admin/questionnaires/[id]/sessions/[sessionId]/page.tsx`.

   - **Analytics tab** (replaces the Phase 2 placeholder): four-up grid of charts using `recharts`:
     - Completion-rate gauge (a `RadialBarChart`).
     - Drop-off bar chart per section (a `BarChart`).
     - Confidence heatmap — actually a stacked `BarChart` (recharts has no first-class heatmap; the stacked-bar approximation is documented and is consistent with how Sunrise visualises confidence buckets elsewhere).
     - Cost-over-time line chart (a `LineChart` with weekly buckets).

     **Tag filter control.** A shadcn `<Command>`-based multi-select tag picker sits in the Analytics tab header, populated from the version's `AppQuestionTag` set. Selecting one or more tags re-fires every chart's underlying API call with `?tagIds=...` and re-renders the four charts against the filtered question subset. The header also shows a "filter applied" indicator with the filtered question count vs total ("12 of 47 questions"). A clear-filter button resets. The tag picker uses the same component built in Phase 2 (`tag-multi-select` under `app/admin/questionnaires/_components/`) — confirm reuse rather than re-implement.

     A separate **"Distributions" sub-tab** lists one chart per multi-choice / Likert / numeric question. Also respects the tag filter.

     A separate **"Free text" sub-tab** for free-text answers. Respects the tag filter.

     A new **"By tag" sub-tab** is the tag-pivoted view: a table with one row per tag in the version showing tagged-question count, avg confidence across that tag's questions, total answers, and low-confidence count. Sortable by any column. Clicking a row applies that tag as the analytics filter and jumps back to the main Analytics view. Driven by `GET .../analytics/by-tag`.

   - **Session detail page** at `app/admin/questionnaires/[id]/sessions/[sessionId]/page.tsx` — shows the full session transcript on the left, the final answer set on the right with provenance details, cost breakdown at the top, rerun-evaluation button (Phase 9 wires this up). Each answered question in the right pane shows its applied tags as small coloured chips (reusing the chip component from Phase 2). If the underlying session's questionnaire is attached to a demo client, the page header shows the client name and logo as context.

   - **Sessions tab tag filter.** The sessions list tab from Phase 2's placeholder also gets the tag-filter picker — same component, fires `GET .../sessions?tagIds=...`. Lets an admin scope the sessions list to "sessions that touched the 'sensitive' tag subset."

   - **Demo-client analytics surface** (Phase 2.5 created the demo-client list/edit pages; Phase 8 adds the analytics view). `app/admin/demo-clients/[id]/page.tsx` (the edit page from Phase 2.5) gains an "Analytics" tab alongside the existing Basics / Branding / Assets / Messages tabs. This tab shows: a small summary card (questionnaires, sessions, completion rate, total cost from `GET .../demo-clients/:id/analytics/summary`), and a paginated cross-questionnaire sessions table (from `GET .../demo-clients/:id/sessions`) so the admin can browse activity across every questionnaire attached to this client. Click a row → navigate to the session detail page under the originating questionnaire.

   - **Questionnaire-list client filter.** The admin questionnaires list (`app/admin/questionnaires/page.tsx` from Phase 2) gains a small "Client" filter dropdown — defaulting to "All clients" and offering each `AppDemoClient` plus "Generic (no client)." Useful for the admin who is preparing several demos in parallel.

4. **Admin exports** — all respect anonymous-mode by going through the Phase 8 data-layer helpers, and all accept the same optional `tagIds` query parameter so the admin can export a filtered slice. New routes:
   - `GET /api/v1/app/questionnaires/:id/versions/:versionId/export.csv?tagIds=...` — answers across all sessions. One row per `(session × question)`. Columns: `sessionId | anonId | questionKey | questionPrompt | answerValue | confidence | provenanceLabel | turnOrdinal | timestamp | appliedTags` (the new `appliedTags` column is a semicolon-separated list of tag keys applied to the question on this version — makes filtered exports self-describing). Streams the response with `Content-Type: text/csv` and `Content-Disposition: attachment` — no `csv-stringify` dep needed; the prototype writes a small CSV-escape function under `lib/app/questionnaire/export/csv.ts`.

   - `GET /:id/versions/:versionId/export.json?tagIds=...` — full session bundle as JSON, including provenance items, turn transcripts, and per-question applied-tag lists. Same anonymous-mode rules. Pretty-printed for readability.

   - `GET /:id/versions/:versionId/export-report.pdf?tagIds=...` — analytics summary as a PDF. **PDF dep is the same blocker as Phase 7.** If the operator chose Path A (add `@react-pdf/renderer`), implement using it. If Path B (defer PDF in favour of print), this route returns 501 with a clear "PDF export not yet available — use export.json and render in your tool of choice" message. If Path C (waiting for upstream), same as Path B until the dep lands. Phase 8's plan must restate the operator's Phase 0 choice. When a tag filter is applied, the PDF's cover page shows the filter ("Filtered to N questions matching tags: X, Y") so the artefact is interpretable on its own.

   If PDFs are produced: charts are rendered to PNG server-side via a small wrapper that builds the chart's data shape and runs `@react-pdf/renderer`'s native SVG components. **No headless browser is needed** — `@react-pdf/renderer` works in plain Node. Document this in `exports.md`.

5. **Unit tests at `tests/unit/lib/app/questionnaire/`**:
   - `anonymous/redact.test.ts` — given a session with profile, returns the redacted shape. Given non-anonymous mode, returns full data. Edge cases: profile with extra fields, missing profile, free-text answer containing an email address.
   - `analytics/summary.test.ts` — completion-rate calculation across fixture session sets (zero sessions, one in-progress, multiple completed, multiple abandoned).
   - `analytics/drop-off.test.ts` — drop-off-per-section across fixtures.
   - `analytics/distributions.test.ts` — distribution computation per question type.
   - `analytics/clustering.test.ts` — k-means clustering of free-text embeddings; assert deterministic clustering given a fixed seed.
   - `analytics/confidence-heatmap.test.ts` — bucket-count correctness.
   - `export/csv.test.ts` — escape correctness (commas in values, quotes, newlines); anonymous-mode column presence; `appliedTags` column populated correctly.
   - `export/json.test.ts` — serialisation correctness; anonymous-mode field presence; per-question `appliedTags` field populated.
   - (If Path A) `export/pdf.test.ts` — basic structural assertion that the PDF renders without throwing.
   - `analytics/tag-filter.test.ts` — the `applyTagFilter(prismaQueryBuilder, tagIds)` helper: empty filter is a no-op; single-tag filter restricts to questions tagged with that tag; multi-tag filter applies AND semantics (questions must have all supplied tags); a tagId from a different version returns 400 not a wrong result.
   - `analytics/by-tag.test.ts` — the tag-pivoted aggregate's correctness across seeded session fixtures: tagged-question count, avg confidence, total answers, low-confidence count per tag.

6. **Integration tests at `tests/integration/api/v1/app/questionnaires/`**:
   - For every analytics route, two-way coverage: `anonymousMode: false` (full data) and `anonymousMode: true` (redacted). Explicit positive assertion that anonymous responses contain no PII (no email, no name, no `userId`).
   - `export.csv` over both modes; assert the redacted-mode CSV contains `anonId` but never `userId` or email fields; assert the `appliedTags` column matches the version's tag applications.
   - `export.json` over both modes.
   - (If Path A) `export-report.pdf` happy path.
   - Pagination correctness on the sessions list.
   - Ownership scoping returns 404 for sessions on questionnaires the admin doesn't own.
   - `analytics-tag-filter.test.ts` — every analytics endpoint (`summary`, `distributions`, `free-text`, `confidence-heatmap`, `sessions`) exercised with: no `tagIds`, single tag, multiple tags AND-semantics, cross-version tagId returns 400, non-existent tagId returns 400. Assert the `filter` envelope is correct on each.
   - `by-tag.test.ts` — the `analytics/by-tag` endpoint returns one row per tag with correct counts; tags with zero applied questions appear with `taggedQuestionCount: 0` (so admins can spot under-used tags).
   - `tag-filter-on-exports.test.ts` — `export.csv` and `export.json` with `tagIds=...` restrict the rows to the tagged subset; the PDF cover page (if Path A) shows the filter.
   - `demo-client-analytics.test.ts` (at `tests/integration/api/v1/app/demo-clients/`) — `GET .../demo-clients/:id/analytics/summary` aggregates correctly across multiple questionnaires attached to the same client; `GET .../demo-clients/:id/sessions` paginates across questionnaires; sessions from anonymous-mode questionnaires appear redacted while sessions from non-anonymous-mode questionnaires appear with full profile (per-questionnaire redaction respected); clients with zero attached questionnaires return empty results not 404.

7. **Component tests at `tests/integration/app/admin/questionnaires/`** and **`tests/integration/app/admin/demo-clients/`**:
   - Analytics tab renders four charts with seeded mock data.
   - **Tag filter picker** — selecting tags refires API calls with `tagIds=...`; the filter indicator shows the matched-question count; clear-filter resets all charts.
   - **By-tag sub-tab** — renders the tag-pivoted table; clicking a row applies that tag as the active filter and navigates to the main Analytics view.
   - Sessions tab respects anonymous mode (no name column when redacted) and respects the tag filter.
   - Session detail page renders transcript, answers correctly, **shows applied tags as chips on each answered question**, and shows the demo client header context when applicable.
   - Free-text tab clustering toggle fires the right API call.
   - **Demo-client edit page Analytics tab** — renders the summary card and the cross-questionnaire sessions table; row click navigates to the right session detail.
   - **Questionnaire-list client filter** — selecting a client filters the list; "Generic (no client)" returns questionnaires with `demoClientId: null`.

8. **End-to-end test** — Vitest integration. Drive two complete sessions through Phases 1-6 against a questionnaire with at least three tags applied across questions, **and attach that questionnaire to a themed demo client**. Then exercise the Phase 8 routes: list sessions (unfiltered and tag-filtered), view summary analytics (unfiltered and tag-filtered), view the by-tag aggregate, download CSV and JSON (unfiltered and tag-filtered), navigate to the demo-client's analytics tab and confirm the cross-questionnaire summary shows the same sessions. Plus an anonymous-mode variant of the same test asserting redaction.

9. **Documentation at `.context/app/questionnaire/`**:
   - `analytics.md` — every analytics endpoint, the aggregation logic, the chart types, the on-demand clustering rationale, the cost characteristics of each query (especially the clustering pass), **the tag-filter convention (AND semantics, where the filter applies, the `filter` envelope), the by-tag aggregate view, and the per-demo-client cross-questionnaire analytics endpoints**.
   - `exports.md` — CSV / JSON / PDF shapes with example artefacts (small fixture-based examples included in the doc). Notes which export formats are available given the operator's Path A/B/C choice. **Documents the `appliedTags` CSV column, the per-question `appliedTags` JSON field, and the PDF cover-page filter indicator.**
   - `anonymous-mode.md` — the threat model ("admin should not be able to link a session to a real user even with DB access to `AppQuestionnaireSession.anonId` alone"), the `anonId` scheme, the no-override policy, the free-text redaction heuristics, the limitations (the user's _answers_ may contain identifying information; the heuristic redactor catches obvious patterns but not all). **Confirms that anonymous mode coexists with per-client theming** — anonymity is admin→user, not user→brand.
   - **Update `tags.md`** (created in Phase 2) — add a section "Tags as analytics filters" describing the Phase 8 integration: how the tag filter applies across endpoints, the AND semantics, the by-tag pivoted view, the exports' tag-aware columns.
   - **Update `demo-clients.md`** (created in Phase 2.5) — add a section "Per-client analytics" covering the new `/demo-clients/:id/analytics/*` routes and the edit-page Analytics tab.
   - Update `admin-api.md`, `admin-ui.md`, `overview.md`, `upstream-gaps.md`.

## Expected upstream findings (section (c) of your plan)

1. **PDF rendering library still missing.** Re-flag from Phase 0. Phase 8's plan restates the operator's chosen path.
2. **No standard `text/csv` streaming-response helper.** Sunrise could add one to `lib/api/responses.ts`. **Severity:** C.
3. **No public free-text clustering helper.** Sunrise has `embedBatch` but no `clusterEmbeddings(embeddings, k)`. The prototype rolls its own k-means. **Severity:** C.
4. **No standard chart-to-PNG helper for PDF reports.** Even with `@react-pdf/renderer`, the recharts → PDF translation involves manual SVG drawing. Sunrise could lift a `renderChartToPdf(chartConfig)` helper. **Severity:** C.
5. **Anonymous-mode redaction heuristics are app-owned.** Sunrise has no general "redact PII from free text" helper. The prototype's regex-based redactor is rough. Sunrise could add a proper PII-redaction module. **Severity:** B.

## Open decisions to surface in section (l)

- **`anonId` generation strategy.** Plan recommends `randomBytes(16).toString('base64url')` — confirm.
- **Free-text redaction aggressiveness.** Conservative (catch obvious emails/phones/names) vs aggressive (also redact dates, addresses, place names). Recommend conservative for the prototype, flag the limitation.
- **PDF export availability** depends on Phase 0/7's Path A/B/C choice. Phase 8's plan restates the consequence: if Path A, PDF exports work; otherwise return 501.

## Definition of done

- Admin can navigate to the Analytics tab and see four primary charts plus distribution charts per question.
- Admin can navigate to the Sessions tab and see a paginated list, click into a session detail.
- **Admin can filter every analytics view (charts, distributions, free-text, sessions list) and every export by tag set via the tag-filter picker. Multi-tag selection applies AND semantics. The filter indicator shows the matched-question count.**
- **Admin can navigate to the By-tag sub-tab and see the tag-pivoted aggregate view.**
- **Session detail page shows applied tags as chips on each answered question; if attached to a demo client, the page header shows the client context.**
- **Admin can view per-demo-client cross-questionnaire analytics on the demo-client edit page's Analytics tab (summary + sessions list).**
- **Admin can filter the questionnaire list by demo client.**
- Admin can download CSV and JSON exports (and PDF if Path A). Exports respect the active tag filter and include per-question `appliedTags` data.
- Anonymous mode is verifiable end-to-end: a CSV export from a questionnaire with `anonymousMode: true` contains no PII; admin UI in anonymous mode shows no name or email; redaction heuristics applied to free-text answers. Anonymous mode coexists with demo-client theming on the user-facing pages (anonymity is admin→user, not user→brand).
- All Phase 8 unit, integration, component, and end-to-end tests pass.
- `.context/app/questionnaire/analytics.md`, `exports.md`, `anonymous-mode.md` are written and committed; **`tags.md` updated with the "Tags as analytics filters" section**; **`demo-clients.md` updated with the "Per-client analytics" section**; other docs updated.
- Zero new Sunrise-owned files modified beyond existing Phase 0/2/7 breaches.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Phase 9 — Hardening

```

We are starting Phase 9 of the Conversational Questionnaire prototype: hardening.

[paste the shared context block from above]

This is the bridge from "works for a friendly pilot" toward "works for a paying client." All hardening work stays in app-owned territory; Sunrise integrations remain consumption-only.

## Verification step before planning

Before writing the plan, read these specific Sunrise files:

1. **`lib/orchestration/evaluations/index.ts`** and **`lib/orchestration/evaluations/complete-session.ts`** — confirm `completeEvaluationSession(params)` and `rescoreEvaluationSession(params)` are the public entry points and read their parameter shapes.
2. **`lib/orchestration/evaluations/types.ts`** — confirm `CompleteEvaluationParams`, `EvaluationMetricSummary`, `RescoreEvaluationParams`.
3. **`lib/orchestration/evaluations/judge-model.ts`** — confirm how the judge model is selected (from `EVALUATION_JUDGE_MODEL` env / `EVALUATION_DEFAULT_MODEL` env). The prototype either inherits this or overrides per-questionnaire.
4. **`prisma/schema.prisma`** — confirm `AiEvaluationSession` model shape and how it links to conversations and metrics.
5. **`app/api/v1/admin/orchestration/evaluations/`** — read the canonical pattern for the evaluation admin routes. The prototype's eval rerun-on-completed-session route follows this shape.
6. **`lib/orchestration/llm/cost-tracker.ts`** — re-confirm the budget-status helpers (Phase 6 introduced soft-cap nudging; this phase makes it production-grade).
7. **`tests/integration/`** — confirm whether there's a concurrent-session test pattern Sunrise already uses (e.g. fan-out tests over a worker pool). If yes, the prototype copies the pattern; if no, the prototype writes the simplest defensible version.

## Goals for this phase

1. **Evaluations integration**:
   - Each completed `AppQuestionnaireSession` is wired to evaluation infrastructure. The model: when a session completes, create an `AiEvaluationSession` row referencing the session's `AiConversation` and the prototype's evaluation metric set (faithfulness / groundedness / relevance — these names come from Sunrise's existing metric library; confirm during verification). Call `completeEvaluationSession({ sessionId, ... })` from `lib/orchestration/evaluations/complete-session`.

   - **Scoring strategy**: **on-demand**, not auto-score-on-completion. Reasoning: auto-scoring every completion fires three additional LLM calls per session, materially inflating cost and adding latency to the user's submit experience. Admins click "Score this session" or "Score all unscored sessions" from the admin UI. Document this rationale in `hardening.md`.

   - **Re-score after prompt change**: when an admin edits the conversational agent's system-prompt template or any capability's prompt, they can navigate to a completed session and click "Re-score with current prompt" — calls `rescoreEvaluationSession()`. This is critical for tuning.

   - **Per-questionnaire quality trend chart**: a `LineChart` showing avg score per metric over time (one data point per scored session, ordered by `completedAt`). Rendered in the admin Analytics tab from Phase 8 as a new sub-tab "Quality."

   - **Judge model selection**: the prototype defaults to `EVALUATION_JUDGE_MODEL` from env (Sunrise's existing global). The per-questionnaire override is **not** in scope for Phase 9 — flag as a possible future enhancement.

   - New API routes:
     - `POST /api/v1/app/questionnaires/:id/versions/:versionId/sessions/:sessionId/evaluate` — score or re-score a session. Body: `{ rescore?: boolean }`. Returns the evaluation result.
     - `GET /api/v1/app/questionnaires/:id/versions/:versionId/evaluations` — list evaluation results for the version.
     - `GET /api/v1/app/questionnaires/:id/versions/:versionId/evaluations/trend` — time-series for the quality trend chart.

2. **Per-session cost-cap hardening** — extends Sunrise's existing budget-control pattern:

   Sunrise's existing budget infrastructure operates at agent-month granularity: `AiAgent.monthlyBudgetUsd` with 80% warning, 100% block, mid-execution check inside the tool loop. The platform's `perSessionCostCapUsd` adds a finer-grained per-session cap on top — same enforcement pattern (mid-loop check, soft warning, hard block), narrower scope. Phase 9's hardening pass treats the per-session cap as a _generalisation_ of Sunrise's existing pattern, not a parallel surface.
   - Phase 6's per-session cost cap already exists in soft and hard form. Phase 9 makes it production-grade:
     - The soft-cap threshold is admin-configurable (default 90% of `perSessionCostCapUsd`) — symmetric with Sunrise's 80% monthly threshold.
     - Soft-cap triggers a single agent turn that explicitly mentions wrap-up; the prompt template for this fallback turn lives at `lib/app/questionnaire/prompts/soft-cap-prompt.ts`.
     - The hard cap returns 402 + auto-pauses the session (already in Phase 6) — matches Sunrise's monthly hard-cap behaviour.
     - Phase 9 adds a "Session approaching budget" event to `AppQuestionnaireSessionEvent` so admins can see budget exhaustion in the session history.
   - Default soft-cap recommendation: 90% of `perSessionCostCapUsd`. Document.
   - **Upstream finding** (already in section c): "Sunrise's budget infrastructure could generalise to support arbitrary scope (agent-month, session, conversation, day, custom). The platform's per-session cap is a worked example." Severity B.

3. **Contradiction-detection rate-limiting** verification:
   - Phase 4's `contradictionDetectionMode` already gates when the capability fires. Phase 9 verifies end-to-end: every mode (`off`, `every_turn`, `every_n_turns`, `sweep_only`) is exercised in integration tests against a fixture session. The `sweep_only` mode fires at session-completion time (just before `evaluateCompletion` returns `canSubmit: true`); this is new behaviour added by Phase 9 — earlier phases treated `sweep_only` as a placeholder.

4. **Provenance and audit completeness pass**:
   - Audit every `AppAnswerSlot` write: a database-level constraint or application-level invariant that `provenanceItems` is non-empty. The prototype owns a Zod schema applied at every write site; Phase 9 adds an integration test that scans the test database after a full session and asserts every answer slot row has `length(provenanceItems) >= 1`.
   - Audit every admin mutation hits `AiAdminAuditLog` via `logAdminAction()`. Phase 9 adds an integration test that walks through every admin route, executes one mutation per route, and asserts the audit row.
   - Audit every session-state transition writes to `AppQuestionnaireSessionEvent` (the table introduced in Phase 0). Phase 9 adds: started, paused, resumed, refinement_requested, completion_offered, submitted, abandoned, cost_cap_reached. Integration test walks each transition.

5. **Feature-flag finalisation**:
   - The `APP_QUESTIONNAIRES_ENABLED` flag from Phase 0 gates **every** new route added across Phases 1-8. Phase 9 adds a single integration test that walks every route while the flag is off and asserts 404 on each. The test lives at `tests/integration/lib/app/questionnaire/feature-flag-coverage.test.ts`.

   - **Demo-mode sub-flags.** The platform serves both as a sales-demo vehicle and as a project starter (see "Two audiences, one codebase" at the top of this document). Some features are powerful but risky to demo live (the adaptive selection strategy may produce surprising question picks; voice input depends on the prospect's microphone setup; the evaluation surface's UI is verbose). Phase 9 adds three sub-flags that let a demo presenter scope which features are visible to a given prospect without redeploying:
     - `APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED` — when off, the Phase 4 adaptive selection strategy is hidden from the admin config picker (the four strategies become three: sequential, random, weighted) and any questionnaire whose config currently sets `adaptive` falls back to `weighted` with a warning logged. Default `true` in development, `false` for first-time demos to a new prospect until the team is comfortable demoing it.

     - `APP_QUESTIONNAIRES_VOICE_ENABLED` — when off, the voice-input affordance in Phase 7's session page is hidden, and the `POST /api/v1/app/questionnaire-sessions/:id/messages` route refuses `multipart/form-data` uploads with audio. Default `true` in development, `false` for demos where voice isn't part of the pitch (most demos).

     - `APP_QUESTIONNAIRES_EVAL_AUTO_RUN_ENABLED` — currently the Phase 5 evaluation judges only run on manual trigger ("Evaluate now" button); this flag is forward-compatible for a future enhancement that auto-triggers after N edits. When off, the auto-trigger logic is suppressed; manual evaluation still works. Default `false` (since auto-trigger doesn't exist yet); the flag exists so the future enhancement lands behind a flag rather than as a forced behaviour change.

     Each sub-flag has a `FeatureFlag` row seeded by an extension to `lib/app/questionnaire/seeds/001-feature-flag.ts` (or a new `001-feature-flags.ts` if the rename feels cleaner — operator choice). Each sub-flag has a thin wrapper function in `lib/app/questionnaire/feature-flag/index.ts` (`isAdaptiveStrategyEnabled()`, `isVoiceEnabled()`, `isEvalAutoRunEnabled()`). The wrappers are called by the relevant code paths (admin config picker, session page, future auto-trigger).

     `flag.md` documents all four flags (the root flag plus the three sub-flags), the default values for development vs. staging vs. demo-presentation environments, and the operator-facing toggle workflow (a tiny admin page at `app/admin/questionnaires/_settings/page.tsx` that shows all four with on/off switches and writes through `setFeatureFlag()` — or a documented `psql` snippet if the admin page is deferred).

   - **All four flags must remain `// DEMO-ONLY:`-aware**: a real client fork inherits `APP_QUESTIONNAIRES_ENABLED` (it's the main gate) but the sub-flags are demo-presentation concerns. The fork either deletes the sub-flags or repurposes them as proper feature toggles for the client's roll-out plan. Marked with the convention from ground rule 13.

   - Add a clear `flag.md` doc explaining how operators toggle the flag (DB row in `FeatureFlag` table) and what's visible when it's off.

6. **Demo-content seed.** Optional, off by default, opt-in by the operator. Loads the demo fixtures specified in Phase 2.5's directory `lib/app/questionnaire/fixtures/demo/` into the database so a fresh install has demonstrable content out of the box.
   - Seed file `lib/app/questionnaire/seeds/010-demo-content.ts` — **NOT auto-run by the app-owned runner**. The seed is opt-in: the operator invokes it explicitly via `tsx lib/app/questionnaire/seeds/010-demo-content.ts` after the other seeds have run. The seed checks for an environment variable `LOAD_DEMO_CONTENT=1` (or a CLI flag) and refuses to run without it — preventing accidental load in environments where demo content shouldn't appear (real-client forks; production).

   - Behaviour: for each fixture under `lib/app/questionnaire/fixtures/demo/`, the seed:
     1. Parses the YAML front-matter for `goal` and `audience`
     2. Creates an `AppQuestionnaire` row owned by a documented demo admin (configured via env var, defaults to the platform's first admin user)
     3. Creates the initial `AppQuestionnaireVersion`
     4. Extracts sections and questions from the markdown body using a deterministic parser (not the LLM extractor — the fixtures are clean and shouldn't depend on LLM availability for seeding)
     5. Generates embeddings via `embedBatch()`
     6. Idempotent upsert keyed on the questionnaire's `slug` so re-running doesn't duplicate

   - **`// DEMO-ONLY:` marker.** The seed file carries the header from ground rule 13. Real-client forks delete this seed and the entire `fixtures/demo/` directory.

   - **Audit-log**: the seed logs an `app_questionnaire.demo_seed.load` action per questionnaire created, with the fixture path in metadata. Useful for tracking what's in the database without grep-ing the schema.

   - **`runbook.md` references this seed** (see item 8 below) — the runbook tells the operator to run it on first install as part of "Spin up a new platform instance."

   - Tests: `tests/integration/lib/app/questionnaire/seeds/010-demo-content.test.ts` — confirms the seed runs cleanly, is idempotent, refuses without the env var, populates the expected row counts.

7. **Concurrent-session sanity check** (NOT a load test):
   - Drive 20 concurrent sessions through `runTurn` against a local PostgreSQL — use Vitest's `concurrent` mode or a simple `Promise.all` driver in the test. Assert: no deadlocks (test completes within a reasonable timeout), no orphan `AppQuestionnaireTurn` rows (every turn has a matching `AppAnswerSlot` or a documented reason it doesn't), no missed audit log writes, no race conditions in cost-log tagging. This is a confidence check, not a load benchmark — a real load test would need a dedicated tool which is out of scope.

   - **Define "orphan turn" explicitly**: a turn where `agentMessage` was streamed (i.e. `done` event arrived) but no `AppAnswerSlot` was created and no error event was emitted. Such turns indicate a silent capability-dispatch failure and would be a bug.

8. **Unit tests at `tests/unit/lib/app/questionnaire/`**:
   - `cost-cap/soft-cap-prompt.test.ts` — soft-cap prompt template renders sensibly across budget-progress values.
   - `contradiction/sweep-mode.test.ts` — `sweep_only` mode triggers at the right moment in the completion lifecycle.
   - `provenance/invariant.test.ts` — invariant validator: every answer-slot write rejects empty provenanceItems.
   - `evaluations/trigger.test.ts` — on-demand vs auto-score branching.

9. **Integration tests at `tests/integration/api/v1/app/questionnaires/`**:
   - `evaluate.test.ts` — happy path scoring; rescore; trend data.
   - `cost-cap-hard.test.ts` — drive a session over `perSessionCostCapUsd`, assert 402 and auto-pause.
   - `cost-cap-soft.test.ts` — drive to 90%, assert soft-cap turn fires and the `Session approaching budget` event lands.
   - `contradiction-modes.test.ts` — each mode exercised end-to-end.
   - `provenance-completeness.test.ts` — full session, scan all answer slots, every one has provenance.
   - `audit-coverage.test.ts` — every admin route produces the right audit entry.
   - `session-events-coverage.test.ts` — every state transition produces the right event row.
   - `feature-flag-coverage.test.ts` — flag off, every route returns 404. **Also exercises each sub-flag**: `APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED` off → admin config picker doesn't list `adaptive`, sessions with `adaptive` set fall back to `weighted` with a warning logged; `APP_QUESTIONNAIRES_VOICE_ENABLED` off → voice multipart upload returns 400; `APP_QUESTIONNAIRES_EVAL_AUTO_RUN_ENABLED` flag is exercised even though the auto-trigger doesn't exist yet (the test confirms the flag wrapper function returns the right value).
   - `concurrent-sessions.test.ts` — 20 concurrent sessions through the engine.

10. **End-to-end test at `tests/integration/lib/app/questionnaire/`**:
    - `full-happy-path.test.ts` — upload a fixture document (Phase 1), configure (Phase 3), invite (Phase 3), register as the invited user (Phase 6), complete a session (Phase 6), submit (Phase 6), admin views analytics (Phase 8), admin exports CSV+JSON+PDF (if Path A) (Phase 8), admin scores the session (Phase 9), admin views the quality trend (Phase 9). Single integration test driving every phase's deliverables in order.

11. **Documentation — final consolidation pass**:

    This phase doesn't just create new docs; it audits and consolidates every doc produced across Phases 0–8:
    - Re-read every `.context/app/questionnaire/*.md` produced so far. Fix any drift between docs and current code. Ensure cross-references are consistent.
    - Update `.context/app/questionnaire/overview.md` with the complete module map reflecting the final state.
    - Confirm all per-phase docs exist and are accurate. The full set:
      - `README.md`, `overview.md`, `schema.md`, `development.md` (Phase 0)
      - `ingestion.md`, `extraction-changes.md` (Phase 1)
      - `admin-api.md`, `versioning.md`, `admin-ui.md`, `tags.md` (Phase 2)
      - `demo-clients.md`, `theming.md` (Phase 2.5)
      - `configuration.md`, `cost-estimation.md`, `invitations.md` (Phase 3)
      - `engine.md`, `selection-strategies.md` (Phase 4)
      - `evaluation.md` (Phase 5)
      - `sessions.md`, `agent-config.md` (Phase 6)
      - `frontend.md`, `user-flows.md` (Phase 7)
      - `analytics.md`, `exports.md`, `anonymous-mode.md` (Phase 8)
      - `hardening.md`, `flag.md`, **`runbook.md`**, **`forking.md`**, `upstream-gaps.md` (Phase 9)
    - **`hardening.md`** — new file covering: evaluation integration (on-demand rationale, judge model), cost-cap (soft and hard), contradiction-mode verification, provenance/audit completeness invariants, concurrent-session sanity check, and the feature-flag coverage.
    - **`flag.md`** — operator-facing how-to for every feature flag, including the demo-mode sub-flags: what each one gates, the default per environment (dev / staging / demo-presentation), the admin-UI toggle path or the `psql` snippet for direct DB toggling.
    - **`runbook.md`** — new file covering operator workflows for running the platform as a sales-demo vehicle. **This is the primary deliverable that turns the platform from "a thing engineers built" into "a thing John & Simon can use to win deals."** Contents:
      - **Spin up a new platform instance** — first-time install: clone the Sunrise base, apply the prototype's migrations, run the seeds (`tsx lib/app/questionnaire/seeds/run.ts`), enable the feature flag, optionally run the demo-content seed (`LOAD_DEMO_CONTENT=1 tsx lib/app/questionnaire/seeds/010-demo-content.ts`) to populate sample questionnaires. ~30 minutes for a fresh install.
      - **Spin up a new client demo** — the end-to-end flow for preparing a demo for a specific prospect:
        1. Create an `AppDemoClient` row with the prospect's brand: primary/secondary/accent colour from their website, logo and favicon downloaded from their press kit, welcome message customised to the prospect's name (~15 min).
        2. Either pick an existing demo questionnaire from `fixtures/demo/` that matches the prospect's industry and clone it to the new client (`POST .../clone-for-client`), OR upload a representative document from the prospect (their existing intake form, their employee survey, their compliance checklist) and let the Phase 1 extractor parse it (~5 min, plus 10 min review).
        3. Set the goal and audience on the metadata panel — these are populated from the discovery call notes the team has on the prospect (3 min).
        4. Review extraction changes — accept any inferred goal/audience that's right, revert anything off-base (10 min if a real client document; 0 min if cloned from a demo fixture).
        5. Run the Phase 5 evaluation judges and review suggestions — accept high-value ones, decline noise (10 min).
        6. Apply Phase 2.5's theme; verify the user-facing flow by self-inviting and walking through the questionnaire (~5 min).
        7. Generate sample analytics by running 3-5 dummy completed sessions from yourself or teammates (10 min). This populates the analytics tabs so the prospect doesn't see empty charts.
        8. **Decide which sub-flags to enable** for this demo — most demos: voice off, adaptive off, evaluation-auto-run off. Live-demo-ready in roughly 1 hour total.
      - **Resetting between demos** — when the same demo client has been shown to multiple prospects (e.g. customer-success NPS shown to Acme then to Beta Corp using clone-for-client), each clone is independent and has its own session data. After a demo concludes, the operator MAY use `POST /api/v1/app/demo-clients/:id/reset-sessions` to clear session data, OR can simply use clone-for-client to spin up a fresh copy. The runbook explains when each approach is right.
      - **Re-running an old demo for a returning prospect** — if a prospect returns weeks later to revisit the demo, the platform's versioning means the questionnaire content is preserved; the team only needs to clear stale session data and (optionally) refresh the theme.
      - **Stripping the demo for a real engagement** — pointer to `forking.md` (the next doc in this list) for the full procedure.
      - **Troubleshooting common live-demo failures** — extractor returns no sections (cause: scanned-image PDF; fix: pre-OCR or pick a different fixture), session won't stream (cause: provider rate limit; fix: switch model in the agent's `AiAgentVersion` or wait), themed page shows default colours (cause: invitation pre-dates the theme assignment; fix: invitations snapshot the demo client at creation time, so re-send the invitation), evaluation run times out (cause: large questionnaire — many cases per judge; fix: run individual judges by deselecting the others in the launch dialog, or reduce the questionnaire's case count by splitting it; flagged as a future enhancement to add per-judge progress indicators).
    - **`forking.md`** — new file. The procedure for turning the demo platform into a real client engagement starter. Where `runbook.md` serves the sales-demo workflow, `forking.md` serves the moment a prospect signs and the team forks the codebase for them. The doc is structured around the question: "I'm starting a real client project from this platform — what do I keep, rename, or replace?"

      The doc has these sections, each treated as a distinct deliverable:

      **Section 1: Before you fork — decisions to make.** A short checklist the inheriting team works through before touching code: (a) Will the client want their own brand on the admin shell, or is the Sunrise-default admin shell fine? (b) Is this single-tenant (one client, one deploy) or multi-tenant (one deploy, many of the client's customers)? (c) Will the client use Sunrise's built-in auth or do they need SSO via Okta / Azure AD / OIDC / SAML? (d) Will the client want to rename the `App*` schema prefix to something domain-meaningful (`Intake*`, `Compliance*`, `Onboarding*`)? (e) Does the client need question types beyond the seven the platform ships with? Each answer routes to one or more sections below.

      **Section 2: Replacing demo tenancy.** The Phase 2.5 `AppDemoClient` model and the entire theming module are marked `// DEMO-ONLY:`. Three replacement paths depending on the answer to decision (b):
      - **Single-tenant**: delete `AppDemoClient`, delete `lib/app/questionnaire/theming/`, delete `app/admin/demo-clients/`, delete the cloning + reset-sessions endpoints, brand the app shell directly via Sunrise's CSS variables in `app/globals.css` (acknowledged as a Sunrise-owned file edit — this is the moment the fork accepts a Sunrise breach because the client's brand IS the platform's brand). Total removal: ~8 files + 1 schema migration.
      - **Multi-tenant**: rename `AppDemoClient` to something like `AppTenant`, add row-level security policies, scope every query by tenant ID, add tenant-aware auth middleware. The theming module survives as the per-tenant branding layer but loses its `// DEMO-ONLY:` marker. The reset-sessions endpoint is deleted (multi-tenant production is never destructive at the tenant level).
      - **Branded single-tenant with a future multi-tenant option**: keep `AppDemoClient` as `AppBrand`, drop the demo-only markers, keep the theming module, delete the cloning + reset-sessions endpoints. Document the path to add proper multi-tenancy later.

      For each path, the doc enumerates the specific files that change, the specific schema migrations needed, and the tests that need updating.

      **Section 3: Renaming the `App*` schema prefix.** The platform ships every Prisma model prefixed `App`. A real client engagement might prefer a domain-meaningful prefix. The doc gives a `sed` recipe:

      ```bash
      # Replace App<Model> with NewPrefix<Model> across schema, code, tests
      OLD_PREFIX=App
      NEW_PREFIX=Intake   # or whatever the client's domain calls for
      grep -rl "${OLD_PREFIX}Questionnaire\|${OLD_PREFIX}QuestionSlot\|${OLD_PREFIX}AnswerSlot" \
        prisma/schema.prisma lib/app/ app/ tests/ .context/ \
        | xargs sed -i "s/${OLD_PREFIX}\\([A-Z]\\)/${NEW_PREFIX}\\1/g"
      # Then run: prisma migrate dev --name rename-app-to-intake
      ```

      Includes warnings: (a) the rename touches `.context/` docs too — review them after the sed pass; (b) audit-log `entityType` strings need updating (they're `app_questionnaire`, `app_demo_client`, etc.); (c) capability slugs need a separate rename via the recipe in section 6 below; (d) the demo client default slug `sunrise-default` should be reviewed.

      Alternatively, the doc explains that **the fork is also welcome to keep `App*`** as a stable schema-namespace marker that doesn't imply domain. That's a valid choice; the rename is opt-in. Many forks may find the rename is more disruptive than helpful.

      **Section 4: Stripping demo-only code.** A `grep -r "DEMO-ONLY:" lib/app/ app/api/ app/admin/` produces the full list. The doc enumerates the expected matches at the time of writing so a fork can sanity-check: every file under `lib/app/questionnaire/theming/`; the `AppDemoClient` Prisma model; the demo-client API routes including reset-sessions; the demo-fixtures directory `lib/app/questionnaire/fixtures/demo/`; the demo-content seed `lib/app/questionnaire/seeds/010-demo-content.ts`; the demo-mode sub-flags (`APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED`, `APP_QUESTIONNAIRES_VOICE_ENABLED`, `APP_QUESTIONNAIRES_EVAL_AUTO_RUN_ENABLED`); the conservative free-text PII redaction regex in Phase 8's anonymous mode. For each, the doc gives the action: delete / re-purpose / keep (with notes).

      **Section 5: Adding industry-specific question types.** The platform ships seven question types: `free_text | single_choice | multi_choice | likert | numeric | date | boolean`. Real client engagements often need more: `currency`, `address`, `signature`, `file_upload`, `nps_score`, `matrix_question`, `slider_with_breakpoints`. The doc walks through the type-extension pattern:
      1. Add the new type to the Prisma enum on `AppQuestionSlot.type` (a migration).
      2. Update the extractor's prompt in `app_extract_questionnaire_structure` to recognise the type from source documents.
      3. Update the answer extractor's prompt in `app_extract_answer_from_message` to extract the type from user messages.
      4. Add a renderer for the type in the user-facing answer card (`app/(protected)/questionnaires/_components/`).
      5. Add an admin editor for the type's `typeConfig` shape (the JSON column accommodates per-type variant config without a migration).
      6. Update the Phase 5 type-fit judge's system instructions to recognise the new type.
      7. Add seed test fixtures and unit tests.

      Each step is touch-only in app-owned code. The doc also notes that **the `typeConfig Json` column accommodates many type variants without enum changes** — e.g. `numeric` with `{ unit: 'years', min: 0, max: 60 }` covers "tenure in years" without needing a separate `tenure` type. Forks should reach for `typeConfig` first; new enum entries only when no existing type can be configured to fit.

      **Section 6: Adding customer SSO / external auth.** This is the most likely Sunrise breach for a real client fork. The platform inherits Sunrise's auth (`withAuth`, `withAdminAuth` from `@/lib/auth/guards`). Real clients often need SSO via Okta, Azure AD, OIDC, SAML, or custom IDPs.

      Three paths depending on what Sunrise provides:
      - **(a) Sunrise has a documented provider interface**: confirm by reading `lib/auth/` in the forked Sunrise version. If a provider interface exists, write a new provider in app-owned code (`lib/app/questionnaire/auth/<provider>.ts`) implementing the interface. No Sunrise edits. This is the cleanest fork path.
      - **(b) Sunrise doesn't yet have a provider interface but the client urgently needs SSO**: acknowledge a Sunrise breach. Add the provider to Sunrise's auth tree directly. Document the breach as a `// FORK-BREACH:` comment marker (a sibling to `// DEMO-ONLY:`) and a corresponding entry in `forking.md` so the team tracks every Sunrise edit. Open an upstream Sunrise PR to land the provider-interface change so future client forks don't need to breach.
      - **(c) Sunrise's auth is being actively redesigned upstream**: wait for the new design if the client's timeline allows. If not, fall back to (b).

      The doc also covers the audit-log impact: SSO providers may produce a different `userId` shape; check that audit-log writes still scope correctly.

      **Section 7: Slug renaming for capabilities, agents, and feature flags.** Capability slugs (`app_extract_questionnaire_structure`, `app_extract_answer_from_message`, `app_detect_contradictions`), agent slugs (`app-questionnaire-conversational`, the seven `app-judge-*` evaluation judges from Phase 5, and any future platform agents), and feature-flag names (`APP_QUESTIONNAIRES_ENABLED` etc.) all start with `app_` / `app-` / `APP_`. A fork that renamed the schema prefix in section 3 will likely want to rename these too for consistency. The recipe:

      ```bash
      # Choose the new lowercase prefix (snake_case for capability slugs)
      OLD_LOWER=app_
      NEW_LOWER=intake_   # adjust to client's domain

      # Capability slugs (snake_case)
      grep -rl "${OLD_LOWER}extract_questionnaire_structure\|${OLD_LOWER}extract_answer_from_message\|${OLD_LOWER}detect_contradictions" \
        lib/app/ app/ tests/ prisma/ .context/ \
        | xargs sed -i "s/${OLD_LOWER}\\(extract_questionnaire_structure\\|extract_answer_from_message\\|detect_contradictions\\)/${NEW_LOWER}\\1/g"

      # Agent slugs (kebab-case) — covers both questionnaire agents and the judge agents
      OLD_KEBAB_QN=app-questionnaire-
      NEW_KEBAB_QN=intake-form-
      grep -rl "${OLD_KEBAB_QN}" lib/app/ app/ tests/ prisma/ .context/ \
        | xargs sed -i "s/${OLD_KEBAB_QN}/${NEW_KEBAB_QN}/g"

      OLD_KEBAB_J=app-judge-
      NEW_KEBAB_J=intake-judge-
      grep -rl "${OLD_KEBAB_J}" lib/app/ app/ tests/ prisma/ .context/ \
        | xargs sed -i "s/${OLD_KEBAB_J}/${NEW_KEBAB_J}/g"

      # Feature flag names (SCREAMING_SNAKE_CASE)
      OLD_UPPER=APP_QUESTIONNAIRES_
      NEW_UPPER=INTAKE_FORMS_
      grep -rl "${OLD_UPPER}" lib/app/ app/ tests/ prisma/ .context/ \
        | xargs sed -i "s/${OLD_UPPER}/${NEW_UPPER}/g"

      # Audit-log entityType strings (snake_case)
      grep -rl "'app_questionnaire" lib/app/ app/ tests/ \
        | xargs sed -i "s/'app_questionnaire/'intake_form/g"

      # Re-run the seed runner so the renamed capability and feature-flag rows land in the DB.
      # The old rows persist until a manual cleanup migration deletes them — see the
      # "Post-rename DB cleanup" sub-section.
      ```

      Covers the impact on seed files, capability registration, agent system prompts that reference each other by slug (including the cross-references the conversational agent makes to its capability slugs), audit-log `action` strings, feature-flag DB rows, and tests. Includes a "Post-rename DB cleanup" sub-section that walks through deleting the orphaned `AiCapability`, `AiAgent`, and `FeatureFlag` rows from before the rename.

      **Section 8: What to keep verbatim.** A counter-checklist of things forks should NOT rename or restructure: the per-turn orchestrator pattern (Phase 6), the agents-as-judges consumption pattern (Phase 5 — seven judge agents over Sunrise's evaluation infrastructure), the change-record review pattern (Phase 1), the suggestion review pattern (Phase 5), the version-fork-on-edit pattern (Phase 2), the public-API discipline (the zero-touch rule), the audit-log / cost-tracking / feature-flag consumption pattern. These are the platform's load-bearing patterns and a fork that rewrites them will spend more time than the rename saves.

      **Section 9: What to evaluate (keep, refresh, or replace).** Areas where a fork should make a conscious call rather than blindly inherit: the conversational UI's polish bar from Phase 7 (probably keep, refresh for the client's brand); the analytics surface from Phase 8 (probably keep but customise the metrics to what the client cares about); the tag system from Phase 2 (probably keep); the upload-and-extract flow from Phase 1 (definitely keep — this is one of the platform's strongest features); the cost-cap and contradiction-detection cadence defaults from Phase 3 (review against the client's expected volume).

      **Section 10: A reference fork timeline.** What a realistic fork might look like, with rough effort estimates: week 1 = "Before you fork" decisions + section 4 (strip demo-only) + section 3 (rename if chosen). Week 2 = section 2 (tenancy replacement) + section 6 (auth integration). Week 3+ = section 5 (new question types as needed) + bespoke client features. Not a contract, just a sanity-check anchor for project planning.

      **Section 11: Maintaining the upstream link.** The fork inherits the zero-touch rule. The fork's relationship to Sunrise stays: pull Sunrise updates regularly, never edit Sunrise files except in documented breach cases. The `upstream-gaps.md` from Phase 9 transfers with the fork; the fork team continues to file findings and propose upstream Sunrise improvements. This keeps the fork sustainable beyond the first delivery.

    - **`upstream-gaps.md` final consolidation** — the single most valuable artefact of this platform, serving two distinct audiences:

      **For the Sunrise base platform team**: a prioritised improvement queue. Each finding is a concrete proposal that, once landed upstream, lets every future child project rely on a cleaner public API. The Sunrise team reads from the top of the doc, treats severity-A findings as platform priorities for the next release, severity-B as the release after, severity-C as polish items for any spare-cycle work.

      **For prospects in a sales context**: evidence of platform-improvement contribution. John & Simon walk a prospect through the doc during the engagement scoping conversation, showing concrete examples of "every engagement we deliver also makes the platform better — here are the upstream improvements that came out of the questionnaire platform build, each one benefitting every subsequent project on Sunrise."

      To serve both, the doc has this structure:
      1. **Executive summary at the top** — one-paragraph statement of the platform-improvement contribution. Something like: "Building the Conversational Questionnaire Platform on Agentic Sunrise surfaced N specific gaps in Sunrise's public API surface. Each gap is documented here as an upstream improvement proposal. Landing the severity-A items unblocks the next class of child projects entirely; landing the severity-B items removes recurring friction; landing the severity-C items polishes the developer experience."
      2. **Summary table** — every finding as a row with severity, one-line summary, affected Sunrise files, current workaround status. Lets a reader scan the full list in 30 seconds.
      3. **Per-finding details** — each finding with the five-part shape: finding statement, affected Sunrise files, proposed upstream change, current platform-side workaround, workaround durability. Walk every Phase 0-9 plan's section (c) and consolidate.
      4. **Deduplication** — the PDF-render finding appears in Phase 0, 7, and 8 — collapse to one entry that lists all consumers. The capability-registration plugin point appears in Phases 0 and 1 — same treatment.
      5. **Severity sort** — A blocking, B significant, C polish.

      Provide the executive summary and summary table at the head of the doc as the sales-narrative entry points. The per-finding details serve the Sunrise team. The same doc serves both audiences because both want concrete, actionable proposals — the dual audience just frames how they each enter the document.

## Expected upstream findings (section (c) of your plan)

Phase 9 introduces few new findings — most of the work is verification, integration, and consolidation. Likely findings:

1. **No per-questionnaire judge-model override.** Sunrise's eval judge is selected at env level; per-evaluation overrides would let admins pick a cheaper or more rigorous judge per questionnaire. **Severity:** C.
2. **No concurrent-session benchmark tooling.** The prototype's 20-session sanity check is hand-rolled; Sunrise could provide a generic `runConcurrentSessions(count, sessionFactory)` test helper. **Severity:** C.
3. **`AppQuestionnaireSessionEvent` could be unified with `AiAdminAuditLog`.** The prototype maintains a separate event log because audit-log is for admin actions, not user session transitions. Sunrise could broaden its audit log to accept non-admin events, or expose a generic event-log helper. **Severity:** C.

## Definition of done

- Evaluation scoring works on-demand against completed sessions; re-scoring works; trend chart renders.
- Soft cost cap fires the wrap-up turn at 90%; hard cap halts at 100% with 402 + auto-pause; session events record both.
- All contradiction-detection modes exercised end-to-end including `sweep_only` at session completion.
- Provenance invariant verified: every `AppAnswerSlot` write has non-empty `provenanceItems`.
- Audit-log coverage verified: every admin mutation produces an `AiAdminAuditLog` row.
- Session-event coverage verified: every session-state transition produces an `AppQuestionnaireSessionEvent` row.
- **Feature-flag coverage verified, including the three sub-flags**: with `APP_QUESTIONNAIRES_ENABLED: false`, every platform route returns 404. With each sub-flag off independently, the gated surfaces are correctly suppressed (adaptive strategy unavailable in admin config, voice multipart returns 400, eval-auto-run wrapper returns false).
- **Demo-content seed runs cleanly when invoked with `LOAD_DEMO_CONTENT=1`**: idempotent, populates the right row counts, refuses without the env var.
- 20-concurrent-session sanity check passes: no deadlocks, no orphan turns, no missed audit writes.
- All Phase 9 unit, integration, and end-to-end tests pass.
- All prior phases' tests still pass (Phase 9 doesn't regress earlier work).
- **`.context/app/questionnaire/hardening.md`, `flag.md`, `runbook.md`, `forking.md`, and the finalised `upstream-gaps.md`** are written and committed.
- **The runbook's "Spin up a new client demo" flow has been walked through end-to-end at least once** by John, Simon, or a designated demo presenter, and any friction or unclear steps in the runbook have been corrected. This is the runbook's first real road-test; it should result in concrete improvements to the docs before Phase 9 ships.
- Every per-phase doc reviewed for accuracy and cross-reference consistency.
- The full documentation set is complete and ready to be the entry point for any future developer joining the platform AND the entry point for any demo presenter or forking team.
- Zero new Sunrise-owned files modified beyond existing Phase 0/2/7 breaches.

Now: enter planning mode and produce a plan for this phase, following the output format in the shared context block above. Do not write implementation code. Do not modify the repo. End your turn with the plan and wait for my review.

```

---

## Cross-phase notes for Claude Code

When picking up any phase, keep these in mind:

- **Every phase prompt is a planning task, not an implementation task.** Each phase prompt explicitly asks you to enter planning mode, produce a plan structured per the shared context block, and stop. Do not write production code, create files, run migrations, or modify the repo until the plan has been reviewed and you have been explicitly told to proceed with implementation. If your environment offers an explicit plan-and-approve flow, use it; otherwise treat the prompt as a soft equivalent.

- **The zero-touch rule is non-negotiable.** If at any point you find yourself about to edit a file under `lib/orchestration/`, `app/api/v1/orchestration/`, `app/admin/orchestration/`, `prisma/schema.prisma`, any other Sunrise-owned path from the inventory table, or any root config file — stop. That file edit is an upstream Sunrise change, not a prototype change. Capture the finding in section (c) of the phase plan, propose the upstream feature request, propose the app-side workaround, and continue without editing Sunrise. There is no Sunrise edit too small to flag.

- **Upstream findings are deliverables, not problems — and they're a sales asset.** Section (c) of every phase plan — the list of Sunrise changes that would make this phase cleaner — is one of the most valuable artefacts this platform produces. Each finding is the seed of an improvement that, once made on the base Sunrise platform, lets every future child project rely on a cleaner public API.

  This serves two audiences. For the **Sunrise base platform**, the findings are a prioritised improvement queue: each upstream change unblocks every future child project. For **prospects in a sales context**, the findings are evidence that the engagement isn't just about building one product — it's about contributing to a platform that makes every subsequent project faster, cleaner, and more capable. John & Simon can show a prospect the `upstream-gaps.md` and say: "Engaging with us doesn't just deliver your project. It improves Agentic Sunrise itself, which means the next thing you build on it benefits from everything we learned building yours." Treat the rigour of section (c) as equal in importance to the rigour of the file inventory.

- **`upstream-gaps.md` is the consolidated form of every section (c) across the phases.** Phase 9 collects them into `.context/app/questionnaire/upstream-gaps.md`. The completeness of that document is itself a definition-of-done criterion.

- **Tests and documentation are mandatory deliverables of every phase. No exceptions.** Every phase ends with: unit tests covering new pure functions and module logic, integration tests covering new routes and Sunrise public-API integrations, end-to-end tests where UI is involved (Phase 2 onwards), and documentation files under `.context/app/questionnaire/`. The definition-of-done line for every phase explicitly enumerates the test categories and doc files required. A phase that ships code without matching tests and documentation is incomplete, regardless of how complete the feature itself looks.

- **Never widen the surface area beyond the phase scope.** If a Phase 2 task hints at analytics work, defer to Phase 8.

- **Optional Sunrise conventions to check for during Phase 0 verification.** The items in this group may or may not exist in your Sunrise environment — verify by listing the repo / running the relevant commands before relying on them. If something here doesn't exist, treat it as a Severity-C upstream finding and proceed without it:
  - `.context/improvement-priorities.md` or similar meta document tracking shipped features that may change what the prototype needs to consume or flag.
  - Sunrise-provided Claude Code skills with names like `orchestration-capability-builder`, `orchestration-workflow-builder`, `orchestration-agent-architect` (for understanding Sunrise's capability/workflow/agent patterns) and `api-builder`, `form-builder`, `component-builder`, `page-builder` (for adding routes and UI). If these skills are present, use them — but always consume the patterns through Sunrise's public registration APIs, never by editing Sunrise files.
  - Sunrise-provided gates `pre-pr` and `test-coverage` (or equivalent npm scripts in `package.json`) to run at the end of each phase before declaring it done.

  Where this document references any of the above, treat it as "if this exists in your Sunrise environment" rather than a hard requirement.

- **Code review checklist item:** every PR for this prototype must be visually grep-checked against the Sunrise-owned path list. A diff that touches any Sunrise-owned path is automatically rejected and refactored into (a) app-owned code, or (b) a separate upstream Sunrise PR.
```
