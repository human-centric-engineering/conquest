---
name: Conversational Questionnaire
status: building
host_platform: sunrise
sunrise_version: 0.0.1
opened: 2026-05-30
supersedes: Conversational Questionnaire Phases.md
---

# Conversational Questionnaire — project plan

> The working plan for the Conversational Questionnaire app. Outlines the concept, key requirements, and the phased build broken into **features** and (when promoted) **tasks**. Mirrors the working model of the future [[v1-requirements|HCE Hub]] — until the Hub exists, this markdown is the system of record. Replaces the earlier prompt-per-phase document, which is preserved as reference detail.

## How to read this

- **Project → Phase → Feature → Task.** Aligned to the [[v1-requirements|HCE Hub]] data model. A **Phase** is a milestone container — release boundary, future-work parking — scaffolded into the Hub v1 schema and consumed by Hub UI/capabilities from v1.x (see [[v1-requirements#10. Initial data model sketch]] and [[futures#Coarse work grouping — Phases / Epics]]). This plan's informal `P0..P9` naming is the precursor; when v1.x phase UI lands, those phases become real `Phase` rows. A **Feature** is a coherent multi-PR capability with one owner, status arc, and dependencies. A **Task** is a PR-sized work unit, declared (promoted) under a feature when its owner is ready.
- **Intent over prescription.** Each phase and feature captures _what_ and _why_, not _how_. Implementation choices are made at the moment of work, with current context, by the owner + Claude.
- **Stable identifiers.** Phases are `P0..P9` (plus `P2.5`); features are `F<phase>.<n>` (e.g. `F4.1`); tasks are `T<feature>.<n>` (e.g. `T4.1.2`). Reference them when asking Claude to plan a piece of work: _"let's plan F4.1."_
- **Decisions and work-to-date are first-class.** See the running [[#Decisions log]] and [[#Work completed to date]] sections at the end. Append, don't rewrite.
- **The plan is allowed to be wrong.** Successful builds always deviate from the plan as insights, problems, and solutions arise. Edit it as you go; record material reframes in the decisions log.

## Project

| Field         | Value                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name          | Conversational Questionnaire                                                                                                                                                                                                                        |
| Repo          | `human-centric-engineering/conquest` (forked from `human-centric-engineering/sunrise` at v0.0.1)                                                                                                                                                    |
| Host platform | Sunrise v0.0.1                                                                                                                                                                                                                                      |
| Lead          | Simon Holmes                                                                                                                                                                                                                                        |
| Status        | `building` — P0 done (F0.1, PR #10); P1 done (F1.1 ingestion: PR #13/#14/#15); P2 in flight (F2.1 done — PR1 #18 + PR2 #19; F2.2 tagging merged #23; F2.3 change review built on `feat/f2.3-extraction-change-review`, gates pending; F2.4 remains) |
| Opened        | 2026-05-30                                                                                                                                                                                                                                          |

---

## Concept and intent

A conversational questionnaire platform built on Sunrise. An admin uploads a questionnaire document (PDF / DOCX / MD); an agent extracts questions and sections from it; end users complete the questionnaire through a streaming conversation rather than form-filling; the LLM extracts, infers, and synthesises answers with confidence scores and provenance; admins review the structure, evaluate it against goal and audience, manage versions, and export results.

The platform is **provider-agnostic** — it resolves models through Sunrise's `AiProviderModel` registry at runtime and runs against whatever provider the prospect uses (Anthropic, OpenAI, Google, OpenRouter, etc.). Nothing locks to a single vendor.

### Two audiences, one codebase

The platform serves two purposes simultaneously, and every decision should preserve both:

1. **A sales-demo vehicle.** It demonstrates Agentic Sunrise's capability to prospects — consultants, survey-using businesses, anyone curious what agentic LLM applications do beyond chat-bot demos. A prospect should see their own brand, their own questionnaire content, and their own users completing it within an hour of the discovery call.
2. **A project starter.** When a prospect signs an engagement to build a real product in this style, the platform forks into the starting point for that project. Fork-readiness is therefore non-negotiable: clean architectural seams, marked demo-only code, public-surface discipline, and a fork-procedure guide for the inheriting team.

Where a single decision serves only one purpose, mark it explicitly with `// DEMO-ONLY:` so a fork knows what to strip.

### Reuse beyond questionnaires

Some of what this platform builds is questionnaire-specific. Some is reusable across any agentic-application domain. Forks should understand the boundary.

**Questionnaire-specific** (rename or rebuild for a non-questionnaire fork):

- The Prisma schema's `AppQuestionnaire`, `AppQuestionSlot`, `AppAnswerSlot`, `AppQuestionnaireSession`, related models
- Extraction capabilities (parses questionnaire-shaped documents)
- Answer-into-slot extraction
- Selection strategies operating on questions
- The user-facing split-screen UI with the answer-slot panel

**Genuinely reusable** (carry forward to non-questionnaire forks):

- The **per-turn orchestrator** pattern (P6)
- The **design-time evaluation** pattern (P5) — admin reviews a structured artefact against a stated goal/audience via agents-as-judges
- The **demo tenancy + theming** module — a cross-cutting concern in marked `// DEMO-ONLY:` modules; foundation in P2.5, the rest distributed across P3/P6/P7/P9
- The **change-record review-and-revert** pattern (P1)
- The **suggestion review-and-accept** pattern (P5)
- The **tag-and-analytics-filter** pattern (P2, P8)
- Audit log, cost-tracking, feature-flag, versioning — Sunrise primitives consumed throughout

---

## Key requirements

### Functional

- **Ingest** a questionnaire document and produce a structured, editable representation of its sections and questions, with confidence and rationale per extraction decision (reviewable and revertible).
- **Author and configure** a questionnaire: edit structure, add/remove questions, tag, version, configure selection strategy, completion thresholds, anonymous mode, voice toggle, contradiction-detection cadence, per-session cost cap, profile-fields-to-collect.
- **Evaluate** a questionnaire's structure against its stated goal and audience using Sunrise's agents-as-judges; review and selectively apply suggestions.
- **Invite** users with a tokenised flow; track invitation state through to completion.
- **Converse** with a user through a streaming chat that selects, asks, and synthesises answers from natural language — with provenance, confidence, contradiction detection, and a clear completion offer.
- **Capture** answers as `AppAnswerSlot` rows with `ProvenanceItem` records (consumed from Sunrise's contract, not redefined).
- **Analyse + export** results: per-question distributions, completion funnel, cost actuals, CSV/JSON export, anonymous mode.
- **Brand** the user experience per demo-client tenant for the sales context.

### Non-functional

- **Provider-agnostic.** Every LLM call resolves through Sunrise's provider manager.
- **Cost-aware.** Per-agent budgets and per-session caps enforced via Sunrise's existing budget mechanism; admin sees actuals via `AiCostLog`.
- **Auditable.** Every admin mutation produces an `AiAdminAuditLog` row via `logAdminAction()`. Session-state transitions produce an `AppQuestionnaireSessionEvent`.
- **Provenance.** Every extracted answer carries non-empty `ProvenanceItem` records.
- **Versioned.** Edits to a launched version (any sent invitation or in-progress session) fork a new draft; in-flight sessions stay pinned to the version they started on.
- **Segregated.** All questionnaire logic lives under `lib/app/questionnaire/` (platform-agnostic, no Next imports); HTTP under `app/api/v1/app/`; admin pages under `app/admin/questionnaires/`; user pages under `app/(protected)/questionnaires/`. Sunrise primitives consumed through public entry points.
- **Feature-flagged.** `APP_QUESTIONNAIRES_ENABLED` (DB-backed) gates every surface.

---

## Architecture summary

### Sunrise primitives consumed (v0.0.1)

| Need                                       | Sunrise primitive                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Agents (extractor, judges, conversational) | `prisma.aiAgent.create()` + `AiAgentVersion` versioning                                                              |
| Workflows (intake, evaluation, completion) | `prisma.aiWorkflow.create()`                                                                                         |
| Capabilities                               | `capabilityDispatcher.register()` + `AiCapability` seeded row; registered via Sunrise's app-capability hook (seam 3) |
| App models                                 | Own `prisma/schema/app-questionnaire.prisma` (seam 1)                                                                |
| App seeds                                  | `prisma/seeds/app-questionnaire/NNN-*.ts` discovered by `db:seed` (seam 2)                                           |
| Admin nav                                  | Sunrise nav registry (seam 4) — no edit to the sidebar component                                                     |
| `lib/app/**` import boundary               | Shipped by Sunrise (seam 5)                                                                                          |
| User-relation pattern                      | Plain `String` FK to `User.id`, no `@relation`; documented FK/cascade recipe (seam 6)                                |
| App env vars                               | Sunrise app-env extension surface (seam 11)                                                                          |
| Document parsing                           | `parseDocument()` + `previewDocument()` / `confirmPreview()`                                                         |
| Embeddings                                 | `embedText()` / `embedBatch()`                                                                                       |
| Streaming chat                             | `streamChat()` + `sseResponse()` + `withAuth` / `withAdminAuth`                                                      |
| Voice / attachments                        | `getAudioProvider()`, `useVoiceRecording`, `<MicButton>`, `chatAttachmentSchema`, `assertModelSupportsAttachments()` |
| Evaluation                                 | `AiEvaluationRun`, `AiEvaluationCaseResult`, grader registry, admin eval UI                                          |
| Audit                                      | `logAdminAction()`                                                                                                   |
| Cost                                       | Per-agent budgets + `AiCostLog` query helpers                                                                        |
| Feature flag                               | `isFeatureEnabled('APP_QUESTIONNAIRES_ENABLED')`                                                                     |
| PDF rendering                              | App-owned dependency (vertical, not promoted upstream)                                                               |

### Relationship to Sunrise

The canonical model is [[building-on-sunrise]]: **public-surface-first, fix-in-place, promote-upstream**. The pre-fork seams the questionnaire planning surfaced are closed in Sunrise v0.0.1 (see [[fork-readiness-backlog]]). The app builds on top of those seams rather than working around them.

When a need arises that Sunrise's public surface doesn't cover, the rule is _not_ "flag and work around" — it is fix-in-place where possible, then **classify**: a generic primitive or seam goes upstream to Sunrise _promptly_; an app-specific behaviour stays in the app, plugged into an extension point. Carried changes (not yet upstream) are tracked in this doc's [[#Carried Sunrise patches]] section, retired when Sunrise releases include them.

---

## Phases overview

The build moves from scaffolding → ingestion → admin manage → demo branding → configuration → conversational core → evaluation → streaming → user UI → analytics → hardening. Phases are sequenced so each one's surface area is exercisable end-to-end before the next adds new abstraction.

| Phase    | Title                                           | Status      | Notes                                                                                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**   | Foundations                                     | done        | F0.1 shipped (PR #10) — substantially lighter than the original plan; Sunrise v0.0.1 provides the seams that used to need workarounds.                                                                                                                                                                               |
| **P1**   | Questionnaire ingestion                         | done        | Admin uploads a doc; LLM extracts structure; changes recorded for review. API-only. F1.1 (P1's sole feature) complete: PR1 (schema) + PR2 (pure core) in PR #13; PR3 (extractor capability) in PR #14; PR4 (ingestion route + persistence) in PR #15.                                                                |
| **P2**   | Admin CRUD over questionnaires                  | in flight   | Admin UI: list, edit, version, tag, review extraction changes. F2.1 done (PR1 read surface + PR2 structural authoring/version-fork/status); F2.2 tagging merged (#23); F2.3 change review built (full revert + sub-route, gates pending); F2.4 re-ingest remains.                                                    |
| **P2.5** | Demo-client foundation                          | done        | F2.5.1 shipped (PR #21) — demo-client identity + `AppQuestionnaire` FK + admin attribution, the slice that must **lead** so P3+ build tenant-aware. The rest of demo tenancy (theming, invitation branding, session reset, content seed) is **distributed** into P3/P6/P7/P9 as marked `// DEMO-ONLY:` sub-features. |
| **P3**   | Configuration, invitations, and cost estimation | not started | Per-version config; invitation flow; pre-launch cost estimate.                                                                                                                                                                                                                                                       |
| **P4**   | Conversational engine (non-streaming)           | not started | Selection · extraction · contradiction · completion logic, exercised without the streaming surface.                                                                                                                                                                                                                  |
| **P5**   | Design-time evaluation (agents-as-judges)       | not started | Judges score a questionnaire against goal/audience; suggestion review queue.                                                                                                                                                                                                                                         |
| **P6**   | Conversational session (streaming)              | not started | Per-turn orchestrator over streaming chat; voice + attachments.                                                                                                                                                                                                                                                      |
| **P7**   | User-facing conversational UI                   | not started | Split-screen chat + answer-slot panel; polish; PDF export.                                                                                                                                                                                                                                                           |
| **P8**   | Admin analytics, exports, anonymous mode        | not started | Dashboards, CSV/JSON export, anonymous-mode handling.                                                                                                                                                                                                                                                                |
| **P9**   | Hardening + forking docs                        | not started | Runbook, flag inventory, `forking.md`, concurrent-session sanity.                                                                                                                                                                                                                                                    |

---

## P0 — Foundations

**Intent.** Stand up the app's territory inside the Sunrise fork: module structure, schema, feature flag, doc namespace, capability registration, test scaffolding. Produces no user-visible feature; everything that follows depends on this being right. Significantly lighter than the original Phase 0 because Sunrise v0.0.1 closed the pre-fork seams (multi-file schema, recursive seeds, capability hook, nav registry, eslint boundary, FK pattern, app env vars).

### F0.1 — Foundation scaffolding

_Status:_ shipped ([PR #10](https://github.com/human-centric-engineering/conquest/pull/10)) · _Size:_ ~1 PR · _Owner:_ Simon Holmes · _Deps:_ none (first feature)

The platform's home in the fork. Module skeleton, app-owned Prisma schema, seed namespace, capability hook wired, env-var surface, feature flag, doc namespace, and the test/healthcheck scaffolding the rest of the build hangs off.

_Indicative tasks:_

- App module skeleton at `lib/app/questionnaire/**` — sub-module dirs with stub `index.ts` / `types.ts`. Inherits Sunrise's `lib/app/**` ESLint boundary.
- App Prisma schema file at `prisma/schema/app-questionnaire.prisma` — every model prefixed `App…`, User FKs as plain `String` per seam 6 recipe.
- Initial migration via `prisma migrate dev --name app-questionnaire-init`. Verify it applies cleanly against a Sunrise v0.0.1 DB.
- App seed namespace at `prisma/seeds/app-questionnaire/` — discovered by recursive `db:seed`. First seed populates the `APP_QUESTIONNAIRES_ENABLED` flag row.
- App capability-registration hook wired with an empty set (populated from P1).
- App env-var declaration surface plumbed through Sunrise's app-env extension (empty at P0).
- Feature-flag wrapper `isQuestionnairesEnabled()` over Sunrise's `isFeatureEnabled()`.
- Healthcheck route at `app/api/v1/app/_healthcheck/route.ts` — 404 when flag off, 200 when on. Sets the gating template every later route follows.
- Doc namespace under `.context/app/` — `questionnaire/` for domain/technical docs (`README.md`, `overview.md`, `schema.md`, `development.md`); `planning/` for the build plan, `features/` trackers, and an empty forward-looking `upstream-gaps.md` ledger; plus an app-docs `README.md` index at the `.context/app/` root.
- Test scaffolding — unit + integration test trees mirroring source; a schema-shape integration test asserting every model/column/index/FK from `information_schema`.

**Definition of phase complete.** Schema migrates cleanly; `npm run type-check` / `npm run lint` / `npm run test` pass; healthcheck flips with the feature flag; seeds run via `db:seed`; doc namespace populated.

---

## P1 — Questionnaire ingestion

**Intent.** Let an admin upload a questionnaire document (PDF / DOCX / MD / TXT) and have an LLM extract sections, questions, types, and supporting metadata into the app's schema. Every extraction decision is recorded as an `AppQuestionnaireExtractionChange` so the admin can review and revert in P2. API-only — no UI yet.

### F1.1 — Document → questionnaire ingestion

_Status:_ done — PR1 (schema) + PR2 (pure extraction core) in [PR #13](https://github.com/human-centric-engineering/conquest/pull/13); PR3 (extractor capability) in [PR #14](https://github.com/human-centric-engineering/conquest/pull/14); PR4 (HTTP + persistence) in [PR #15](https://github.com/human-centric-engineering/conquest/pull/15) — F1.1 feature-complete · _Size:_ multi-PR · _Owner:_ TBD · _Deps:_ F0.1

> Committable tracker: [`planning/features/f1.1.md`](features/f1.1.md) — the indicative-task list below predates the reconciliation in that doc (e.g. it cites `previewDocument`/`confirmPreview`, which F1.1 deliberately does **not** use — it parses directly via `parseDocument`). Defer to the feature tracker for current scope.

End-to-end pipeline from uploaded document to populated `AppQuestionnaire(Version|Section|Slot)` graph with confidence per slot, plus the change-record audit trail of every extraction decision. Audit + cost integration are cross-cutting tasks within this feature, not a separate one.

_Indicative tasks:_

- Seed the extraction agent (`app-questionnaire-extractor`) + its capability set via `prisma.aiAgent.create()`. Follow the `006-quiz-master.ts` shape.
- Wire the upload + parse pipeline against Sunrise's `previewDocument()` / `confirmPreview()` (SHA-256 dedup, scanned-page detection, opt-in table extraction). Do not parallel them.
- Structure extraction prompt + capability — produces sections, questions, types, confidence.
- Goal + audience inference, optional, recorded as `infer_goal` / `infer_audience` change records.
- Change-record write path covering every change type (`prune_*`, `correct_*`, `rewrite_prompt`, `infer_type`, `merge_questions`, `split_question`, `add_section`, `augment_question`, `infer_goal`, `infer_audience`) with before/after JSON.
- Ingestion API endpoint at `POST /api/v1/app/questionnaires` — multipart upload, `withAdminAuth`, Zod-validated, returns the new version id.
- Audit (`logAdminAction()`) on admin mutations + cost integration via Sunrise's existing cost tracker.

**Definition of phase complete.** Uploading a representative PDF produces a populated `AppQuestionnaire(Version|Section|Slot)` graph plus a complete change-record log. Integration tests cover happy path and the three big failure modes (scanned PDF, oversized doc, unparseable type). Audit + cost logs populated.

---

## P2 — Admin CRUD over questionnaires

**Intent.** The first admin UI. Lets an admin list questionnaires, edit structure, manage tags, review and revert extraction changes from P1, and trigger re-ingestion. Implements the version-fork-on-launch behaviour. Four ownerable features.

### F2.1 — Questionnaire authoring

_Status:_ done — PR1 (read surface + admin shell) merged (PR #18); PR2 (structural authoring + version-fork) on `feat/f2.1-pr2-authoring` — full section/question CRUD + reorder, goal/audience edit, live version-fork-on-launched, status transitions · _Size:_ multi-PR (2 PRs) · _Owner:_ TBD · _Deps:_ F1.1

> Committable tracker: [`planning/features/f2.1.md`](features/f2.1.md). Confirmed at planning: **full structural authoring** in PR2; **build the full version-fork mechanics now**, behind a `countLaunchBlockers()` seam that returns 0 until P3 (invitations) / P4 (sessions).

The main admin surface: nav entry, list view, detail/edit view, and the version-fork-on-launched lifecycle. The first place an admin "lives" in the platform. Packaged as two PRs per the gate-suite-tax calibration — the read surface (no high-stakes mutation) takes one clean review pass; the write surface (mutation + fork correctness) justifies its own `/security-review`.

_Indicative tasks:_

- Register admin nav entry via Sunrise's nav registry (seam 4). No edit to `admin-sidebar.tsx`.
- Questionnaire list view at `app/admin/questionnaires/` — status, owner, version, last activity.
- Detail/edit view — edit sections, questions, types, goal, audience.
- Version-fork-on-launched behaviour — edits to a version with zero sessions and zero sent invitations mutate in place; edits to a launched version fork a new `draft` version. In-flight sessions stay pinned to the version they started on.
- Audit-log all admin mutations through `logAdminAction()` with before/after.

### F2.2 — Tagging

_Status:_ in flight — built on `feat/f2.2-tagging` (schema + pure core + fork-copy + tag CRUD/assignment APIs + editor/read UI + tests; gates pending) · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F2.1

> Committable tracker: [`planning/features/f2.2.md`](features/f2.2.md). Build decisions: replace-set `PUT` assignment; tag = label + optional `color` (allowlist); same-version invariant is application-layer (checked pre-fork); the F2.1 `// F2.2:` fork seam now copies the vocabulary + re-links assignments.

Per-version tag vocabulary plus M:N assignment to questions. Used by P8 analytics filtering and by the adaptive selection strategy in F4.1.

_Indicative tasks:_

- `AppQuestionTag` CRUD (vocabulary editor in the version's edit view).
- `AppQuestionSlotTag` M:N assignment UI.
- Validation that tag/question both belong to the same version (application-layer per the schema decision).

### F2.3 — Extraction-change review

_Status:_ in flight — built on `feat/f2.3-extraction-change-review` (pure revert planner + list/revert APIs + sub-route review UI + tests; gates pending) · _Size:_ 2 PRs (read surface · revert engine) · _Owner:_ TBD · _Deps:_ F1.1, F2.1

> Committable tracker: [`planning/features/f2.3.md`](features/f2.3.md). Build decisions: **full revert across all change types** (not just the tractable ones); review surface on a **dedicated sub-route** (`…/[id]/extraction-changes?v=`), not a detail-page tab; **fail-cleanly** reconciliation (null-`targetEntityId` edits matched against the live graph, typed `RevertImpossible` → 422 rather than guess); fork-on-launched applies the inverse to the draft and marks the **source** change row reverted.

Lists every `AppQuestionnaireExtractionChange` with source quote, before/after, rationale. Admin can revert any change; revert restores the pre-change graph state. This is the consumer of P1's change-record log.

_Indicative tasks:_

- Review surface listing changes by version, grouped by change type.
- Revert action that restores `beforeJson` and updates change-record status to `reverted`.
- Filters (by status, type, target entity).

### F2.4 — Re-ingest

_Status:_ in flight — built on `feat/f2.4-reingest` (shared ingest pipeline refactor + `reingestVersion` replace-in-place writer + draft-only route with version-scoped dedup short-circuit + detail-page re-ingest dialog + tests; gates pending) · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F1.1, F2.1

> Committable tracker: [`planning/features/f2.4.md`](features/f2.4.md). Build decisions (confirmed): **replace the draft graph in place** (not a new version); **draft-only** — a launched/archived target is a typed `409 REINGEST_NOT_DRAFT`, not a fork; **version-scoped dedup** short-circuits an identical re-upload to a `200` no-op (vs. F1.1's global `409`); the F1.1 ingest "bytes → extraction" pipeline is factored into `_lib/extract-pipeline.ts` + `writeGraph`/`writeSourceDocument`, single-sourced by both routes (F1.1's tests are the regression net). No migration (every column, incl. the reserved `bytes`, exists from F1.1).

Admin uploads a replacement source doc against an existing draft version; SHA-256 dedup short-circuits an identical re-upload; non-identical re-upload produces a fresh extraction + change log.

_Indicative tasks:_

- `POST /api/v1/app/questionnaires/:id/versions/:vid/reingest` endpoint.
- SHA-256 dedup short-circuit returning the existing change log unchanged.
- UI surface to trigger re-ingest from the detail view.

**Definition of phase complete.** An admin can ingest, review, edit, tag, version, and re-ingest a questionnaire end-to-end through the UI.

---

## P2.5 — Demo-client foundation

**Intent.** Stand up the demo-client _identity_ — the table, the `AppQuestionnaire` foreign key, and the admin attribution surface — so a questionnaire can be labelled as a given prospect's demo. This is the one slice of demo tenancy that must **lead**: with the FK in place from here on, P3 (invitations), P4/P6 (sessions), and P7 (user UI) are all built tenant-aware in a single pass instead of retrofitted.

**This phase used to be all of demo tenancy; it isn't anymore.** Demo tenancy + branding is a _cross-cutting concern_, not a milestone — the decimal in "P2.5" was the tell that it was inserted between P2 and P3 without the dependency pass the round-numbered phases got. Most of it can only be built once the model each piece hangs off exists: invitation branding needs P3's invitation model, session reset needs P4/P6's session graph, the theming render points need P7's user pages, the content seed needs a complete vertical. (The original F2.5.1 even listed `AppQuestionnaireSession` scoping — a model P4/P6 hasn't built yet.) So those pieces now land **in the phase that builds their dependency**, each as a clearly-marked `// DEMO-ONLY:` sub-feature — see the distributed-work table below.

**Decompose the schedule, preserve the module boundary.** Fork-strippability — the property that justified bundling this as a phase — is a property of _code organisation_, not _build scheduling_. Every distributed piece still lives in the same marked territory (`lib/app/questionnaire/theming/`, the `demo-clients/` route + page dirs, `// DEMO-ONLY:` headers), so a fork still strips demo tenancy in one `grep` sweep even though the work is spread across phases. See the [[#Decisions log]] entry (2026-06-03).

### F2.5.1 — Demo-client foundation

_Status:_ done — shipped in [PR #21](https://github.com/human-centric-engineering/conquest/pull/21) · _Size:_ 1 PR · _Owner:_ Simon Holmes · _Deps:_ F0.1

> Committable tracker: [`planning/features/f2.5.1.md`](features/f2.5.1.md). Confirmed at build: identity-only (theme/logo deferred to F3.4/F7.1); FK `onDelete: SetNull` + app-layer 409 delete-guard; attribution via `PATCH /questionnaires/:id`. Packaged as **one PR** — no live destructive endpoint, no upload, no LLM, so one dominant risk type.

A **demo-client partition** — identity table, the `AppQuestionnaire` FK, and admin attribution — so each prospect's questionnaires are grouped and labelled under their name. Deliberately lightweight and app-owned: application-layer scoping on single-tenant Sunrise, **not** a security isolation boundary. Demo clients aren't adversarial, so hard isolation is out of scope here. Theme fields, session/invitation scoping, and the reset/seed utilities are **not** here — they ride into later phases (table below).

> **Not the bones of real multi-tenancy.** This table is a branding/content partition, not the foundation a real customer-isolation layer plugs into. If a fork becomes a multi-customer product, the right move is to activate Sunrise's RLS tenancy seam (`TENANCY_MODE=multi`, `Org`/`orgId` retrofit at the `lib/db/client.ts` chokepoint), **not** to harden this demo table into an isolation mechanism. Promoting app-layer demo scoping into a security boundary is exactly the trap Sunrise's multi-tenancy doc warns against. See the [[#Decisions log]] entry.

_Indicative tasks:_

- App-owned `AppDemoClient` **identity** table (`slug`, `name`, `description`, `isActive`), marked `// DEMO-ONLY:` — the abstraction a fork repurposes for branding/content scoping, not for isolation. Theme columns are deferred to the theming module (lands with its first consumer — see table).
- Nullable `demoClientId` FK on `AppQuestionnaire` (plain `String` FK per seam 6, indexed). `null` = generic Sunrise-default demo; pre-P2.5 questionnaires keep working, no backfill.
- Admin CRUD under `app/api/v1/app/demo-clients/` (list / create / detail / patch / delete; `DELETE` refuses `409` while any questionnaire still references the client).
- Attribution in the F2.1 admin surface — assign a questionnaire to a client and show the client in the list/detail. `PATCH …/questionnaires/:id` gains an optional `demoClientId` (nullable to detach).

**Definition of feature complete.** An admin can create demo clients and attribute questionnaires to them; the F2.1 list/detail surface shows attribution; the FK is in place for downstream phases to build tenant-aware.

### Distributed demo-tenancy work (tracked in host phases)

The rest of what was P2.5 lands where its dependency is built. Every piece stays in marked `// DEMO-ONLY:` modules so the fork-strip stays a single sweep.

| Piece                                                                       | Why it can't lead                                                  | Home                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| Theming module (theme columns + `resolveTheme()` + `themeToCssVariables()`) | Pure producer; its first renderer is an invitation email or a page | **F3.4** if themed invites adopted, else **F7.1** |
| Invitation `demoClientId` denormalisation + themed invitation email         | Needs `AppQuestionnaireInvitation`                                 | **F3.4** (P3)                                     |
| Tenant-scoped user routing (resolve tenant from URL / invite token)         | Needs user-facing routes + invite tokens                           | **F7.1** (P7)                                     |
| Theming application points (landing / completion pages)                     | Needs P7 user pages                                                | **F7.1 / F7.3** (P7)                              |
| Demo session reset (`reset-sessions`)                                       | Needs the full session graph                                       | **F6.4** (P6)                                     |
| Clone-for-client admin utility                                              | Needs tags (F2.2) + config (F3.1)                                  | **P3+**, promote once both exist                  |
| Demo content seed (`010-demo-content.ts`)                                   | Needs a complete themeable vertical                                | **F9.4** (P9)                                     |

---

## P3 — Configuration, invitations, and cost estimation

**Intent.** Make a questionnaire launchable. Per-version configuration; invitation flow with tokenised registration; pre-launch cost estimation so the admin sees expected spend before sending invites.

### F3.1 — Questionnaire configuration

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F2.1

The full `AppQuestionnaireConfig` editor — every setting that controls how a session runs — plus the launch gate that says "config is complete enough to invite users."

_Indicative tasks:_

- Config editor UI — selection strategy, completion thresholds, cost budget, per-session cap, voice toggle, contradiction-detection mode + N, anonymous mode.
- User-profile-fields configuration — admin defines which profile fields are collected at session start. Field-type enum `text | email | number | select`. Supports name, email, role, organisation, team, tenure, arbitrary custom fields.
- Launch gate — questionnaire can only be launched when goal + audience + at least one section + at least one question + config are all populated.
- Validation, audit-log, version-fork-on-launched compatibility.

### F3.2 — Invitation flow

_Status:_ in flight — built on `feat/f3.2-invitation-flow` (PR1: `AppQuestionnaireInvitation` + pure core + admin send/list/revoke/resend routes + launch-blocker wiring + admin sub-route UI; PR2: public token metadata/accept routes + respondent registration page reaching `registered`. `started`/`completed` left as P6/P7 seam states; demo-client branding is F3.4. Gates pending) · _Size:_ 2 PRs · _Owner:_ TBD · _Deps:_ F3.1

> Committable tracker: [`planning/features/f3.2.md`](features/f3.2.md). Build decisions (confirmed at planning): dedicated **version-scoped** `AppQuestionnaireInvitation` (not Sunrise's `Verification` store); **full better-auth registration** (reuses the `accept-invite` machinery, binds `userId`); **single + simple bulk** send; first non-zero `countLaunchBlockers` (moved route-local for the Prisma count, pure module keeps the type + `hasLaunchBlockers`); first app→User FKs (plain `String`, UG-1) with the erasure decision recorded in `invitations.md`.

End-to-end invitation lifecycle: tokenised invite, email send, registration, status tracking through to completion.

_Indicative tasks:_

- Invitation creation UI (single + bulk).
- Token generation + opaque URL.
- Email send via Sunrise's email recipes.
- Invitation lifecycle state machine: `pending → sent → opened → registered → started → completed | revoked`.
- Registration flow that links an invitation token to a user account.
- Admin view of invitation states.

### F3.3 — Pre-launch cost estimation

_Status:_ in flight — built on `feat/f3.3-cost-estimation` (pure history-aware heuristic estimator + Prisma-free `cost-estimation/` module + read-only `GET …/versions/:vid/cost-estimate` route + shared estimate card in the config editor & invitations page + tests; gates pending) · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F3.1

> Committable tracker: [`planning/features/f3.3.md`](features/f3.3.md). Build decisions (confirmed at planning): **heuristic-only** (no empirical mode — the session engine P4/P6 doesn't exist yet, so there are zero runs to calibrate against; an empirical mode keyed on `AppQuestionnaireTurn` actuals is a future PR); **history-aware token model** (quadratic conversation-history term `HISTORY × Q(Q−1)/2`, not flat-per-question); **`Q` honours the F3.1 caps**; **provider-agnostic pricing via `getModel`**, with **unknown-price ≠ free** (`pricingKnown:false`, USD withheld, never a misleading `$0.00`); **GET-only against persisted config** (no audit, no rate-limit sub-cap); surfaced in the **config editor + invitations page** (one fetch each, `perQuestionnaire = perSession × respondents` scaled client-side).

Pre-launch: estimated tokens × cost per provider × question count + extraction overhead, surfaced to the admin before sending invites.

_Indicative tasks:_

- Estimator that reads Sunrise's model registry for current pricing.
- Per-session and per-questionnaire estimates.
- UI surface in the config editor + launch flow.

### F3.4 — Demo-client invitation branding (DEMO-ONLY)

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F2.5.1, F3.2 · _Relocated from the old P2.5._

The first place a prospect sees their brand — the invitation. Snapshots the demo client onto the invitation and (if adopted) themes the invitation email. Can only be built once F3.2's invitation model exists, which is why it lives here and not in P2.5. All `// DEMO-ONLY:`.

> **Open decision at promotion — themed invites or plain?** Themed makes the prospect's first touch branded (strong for the sales intent) but pulls the **theming module** forward into P3; plain defers all theming to P7 (F7.1). This choice decides where the theming module (`lib/app/questionnaire/theming/` + the `AppDemoClient` theme columns) is built.

_Indicative tasks:_

- Denormalise `demoClientId` onto `AppQuestionnaireInvitation` at creation time (O(1) theme lookup; resilient to questionnaire reassignment; indexed).
- _(If themed invites)_ theme columns on `AppDemoClient` + the theming module — `resolveTheme()` (fills nulls with Sunrise defaults) and `themeToCssVariables()`, all `// DEMO-ONLY:`.
- _(If themed invites)_ client-aware invitation email — CTA colour, logo, welcome copy from the resolved theme; Sunrise defaults when null.

**Definition of phase complete.** Admin can configure → estimate cost → invite → see invitation states change as users open the link; demo-client invitations carry their attribution (and brand, if themed invites were adopted).

---

## P4 — Conversational engine (non-streaming)

**Intent.** All the per-turn intelligence — _which question to ask next, how to extract answers from a natural response, how to detect contradictions, when to offer completion_ — exercised as plain functions/capabilities first, without the streaming surface. P6 wraps the streaming layer around this. Six ownerable features; each is unit-testable in isolation.

### F4.1 — Selection strategies

_Status:_ not started · _Size:_ multi-PR · _Owner:_ TBD · _Deps:_ F0.1, F2.2 (tags), F3.1 (config)

Pluggable strategies for picking the next question. `Sequential`, `Random`, `Weighted`, `Adaptive`. Each a unit-tested function. Adaptive is the most complex — uses prior answers + tags + remaining coverage.

_Indicative tasks:_

- Strategy interface + registry.
- `Sequential`, `Random`, `Weighted` implementations.
- `Adaptive` implementation (largest task — multi-PR).
- Edge cases: no remaining questions, contradictions outstanding, low-confidence slots needing follow-up.

### F4.2 — Answer extraction into slots

_Status:_ not started · _Size:_ multi-PR · _Owner:_ TBD · _Deps:_ F1.1 (slots), F0.1

Capability that, given a user message + active question + session context, produces `(value, confidence, provenance, rationale, label)` for one or more slots. Side effects on other questions are allowed and recorded.

_Indicative tasks:_

- Extractor capability + system prompt.
- Slot-write path with provenance + confidence.
- Side-effect detection (one message answering multiple questions).
- Synthesised / inferred / direct / refined provenance labelling.

### F4.3 — Contradiction detection

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F4.2

Modes: `off`, `every_turn`, `every_n_turns`, `sweep_only`. Sweep runs at session completion. Surfaces contradictions to the agent for confirmation rather than auto-overwriting.

_Indicative tasks:_

- Detection capability comparing current answers across slots.
- Mode-aware scheduler (per-turn vs every-N vs sweep-at-completion).
- Surfacing-to-agent contract (how the agent is told to ask about a contradiction).

### F4.4 — Answer refinement

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F4.2

Allows the agent to update a previous slot's value based on new context, with `refinementHistory` preserved. Used both by contradiction resolution and by general "user clarified earlier" flows.

_Indicative tasks:_

- Refinement detection (when does the agent decide to refine vs overwrite vs leave alone).
- `refinementHistory` write path on `AppAnswerSlot`.
- Provenance label transition (`direct → refined`).

### F4.5 — Completion logic

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F4.1, F4.2

Decides when the agent offers submission (based on completion config) and accepts/holds when the user confirms. Drives the contradiction sweep in `sweep_only` mode at the moment of offer.

_Indicative tasks:_

- Completion criteria evaluation against `completionConfig`.
- Offer-to-submit logic + agent contract.
- Acceptance path (sweep → submit) and hold path (user wants to keep going).

### F4.6 — Session state machine

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F0.1

Lifecycle: `in_progress | paused | completed | abandoned`. Every transition writes an `AppQuestionnaireSessionEvent` row. Used as the audit trail of session-level state.

_Indicative tasks:_

- State transition table + guards.
- Event writes on every transition.
- Resume logic (paused session picks up where it left off).
- Cost-cap-reached event integration (set up here, fired in F6.3 / F6.5).

**Definition of phase complete.** Every per-turn behaviour exercisable by a Vitest integration test driving session state by hand (no chat surface yet). 100% coverage of the selection strategies' edge cases.

---

## P5 — Design-time evaluation (agents-as-judges)

**Intent.** Let an admin evaluate a questionnaire's structure against its stated `goal` and `audience` using Sunrise's existing agents-as-judges infrastructure. Seven judge agents cover distinct dimensions (clarity, coverage, duplicates, type fit, ordering, audience match, goal match). Suggestions land in a review queue; the admin accepts, declines, edits, or applies.

### F5.1 — Judge agents

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F2.1 (so there's a structure to judge)

Seed and tune the seven judges. Each is an `AiAgent.kind = 'judge'` with its own system prompt + grader binding consumed from Sunrise.

_Indicative tasks:_

- Seven judge seeds — one per dimension (clarity, coverage, duplicates, type fit, ordering, audience match, goal match).
- Grader bindings against Sunrise's grader registry.
- Cost-cap and timeout tuning per judge.

### F5.2 — Evaluation run

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F5.1

The trigger that fires the seven judges over a version's questions, persists the link to the resulting Sunrise `AiEvaluationRun`, and surfaces run history to the admin.

_Indicative tasks:_

- `POST /api/v1/app/questionnaires/:id/versions/:vid/evaluate` endpoint that kicks off the run.
- `AppQuestionnaireEvaluationLink` write per invocation.
- Admin UI listing prior runs for a version, newest-first.
- Run status polling / live updates.

### F5.3 — Suggestion review

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F5.2

The admin's surface for working through judge suggestions: review queue, accept/decline/edit, apply to the draft version, derive staleness at read time when a suggestion is rendered obsolete by intervening edits.

_Indicative tasks:_

- `AppQuestionnaireSuggestionReview` row per `AiEvaluationCaseResult`.
- Review queue UI grouped by judge + dimension.
- Accept / decline / edit actions; "edit proposal" stores override JSON.
- Apply action — applies the (possibly edited) suggestion to the draft version, forking if launched.
- Stale-suggestion derivation at read time (not stored): version diff since suggestion → stale.

**Definition of phase complete.** An admin can request an evaluation, see suggestions per judge, review/edit/apply them, and watch the version evolve.

---

## P6 — Conversational session (streaming)

**Intent.** Wrap the P4 engine in a streaming surface. The user sends a message → per-turn orchestrator runs (select → ask | extract → answer → detect | refine | offer completion) → response streams back via SSE. Voice and attachment inputs consume Sunrise's existing primitives verbatim.

### F6.1 — Per-turn orchestrator + streaming

_Status:_ not started · _Size:_ multi-PR · _Owner:_ TBD · _Deps:_ F4.1–F4.6

The streaming surface around P4. A pure function over session state + new user message produces a list of side effects + an agent response, wrapped in an SSE route. Includes attachment input (consumed from Sunrise's existing schema/validation).

_Indicative tasks:_

- Per-turn orchestrator — pure function taking session state + user message, returning side effects + agent response. Wraps the P4 capabilities.
- `POST /api/v1/app/questionnaire-sessions/:id/messages` SSE route using `streamChat` / `sseResponse` / `withAuth`. Mirrors `app/api/v1/chat/stream/route.ts`.
- Attachment input — consume `chatAttachmentSchema` + `assertModelSupportsAttachments()` without paralleling.
- Turn-record writes (`AppQuestionnaireTurn`) with `toolCalls`, `targetedQuestionId`, `sideEffectAnswerIds`, `costUsd`.

### F6.2 — Voice input

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F6.1

Voice transcription consumed from Sunrise primitives. The `/messages` route accepts multipart audio; transcription uses `getAudioProvider()` + `provider.transcribe()` with Sunrise's MIME/size validation and cost-log shape. UI integration of `useVoiceRecording` + `<MicButton>` happens in P7.

_Indicative tasks:_

- Multipart audio handling on the `/messages` route.
- `getAudioProvider()` integration + transcribe call.
- MIME allowlist + size cap matching Sunrise's admin transcription endpoint.
- Cost-log entry with `CostOperation = 'transcription'` using Sunrise's pricing.

### F6.3 — Cost cap enforcement at turn boundary

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F4.6, F6.1

The per-session cost cap that fires the wrap-up turn at 90% (soft) and halts with 402 + auto-pause at 100% (hard). Both write `AppQuestionnaireSessionEvent` rows.

_Indicative tasks:_

- Pre-turn cost check against the session's `perSessionCostCapUsd`.
- Soft-cap (90%) — agent receives a "wrap up" instruction in its system context for that turn.
- Hard-cap (100%) — turn refused with 402; session auto-paused; event written.
- Tests for both boundaries against scripted costs.

### F6.4 — Demo session reset (DEMO-ONLY)

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F4.6, F6.1, F3.1 · _Relocated from the old P2.5._

The between-demos "clean slate" — `POST /api/v1/app/demo-clients/:id/reset-sessions` hard-deletes the session graph for a client's questionnaires so the next prospect starts fresh. Can only exist once that graph does (this phase). Destructive; a production fork removes it — marked `// DEMO-ONLY:`.

_Indicative tasks:_

- Typed-confirmation guard (`confirmSlug` must equal the client slug → `400` on mismatch).
- Transactional delete of sessions + profiles + answer slots + turns + events for every version of every questionnaire with `demoClientId = :id`; optional invitation cleanup behind `?resetInvitations=true` (preserves `started | completed | revoked`).
- Refusals: `409` when any of the client's questionnaires has `anonymousMode` on (too destructive for research-sensitive data); `403` on ownership.
- Returns `deletedCounts`; audit-logged `app_demo_client.reset_sessions` (never deleted from the audit trail).

**Definition of phase complete.** End-to-end conversational session works via API. A scripted client can complete a small questionnaire over SSE; transcripts, costs, audit rows all land correctly.

---

## P7 — User-facing conversational UI

**Intent.** The thing a prospect actually sees. Split-screen layout: streaming chat on one side, answer-slot panel on the other showing live state as the conversation proceeds. Polish to demo-grade. Includes PDF export and the demo-flow E2E test that protects against regressions in the sales-critical happy path.

### F7.1 — Chat surface

_Status:_ not started · _Size:_ multi-PR · _Owner:_ TBD · _Deps:_ F6.1, F6.2, theming module (built in F3.4 if themed invites were adopted, else here)

Live SSE rendering with voice + attachment input wired. Consumes Sunrise's `useVoiceRecording` hook and `<MicButton>` verbatim. Branding hookup from P2.5 happens here. Includes the demo-flow E2E test (Playwright as an app dev-dep).

_Indicative tasks:_

- SSE message rendering with optimistic local turn append.
- Voice input integration (consume `useVoiceRecording` + `<MicButton>`).
- Attachment input (consume Sunrise's attachment-input affordance from `AgentTestChat` verbatim).
- Branding render — consume the theming module (built in F3.4, or build it here if invite-theming was deferred); add the tenant-scoped routing + landing/completion theming application points relocated from the old P2.5.
- Playwright setup as an app dev dependency (per [[building-on-sunrise]] — apps own their dev deps).
- Demo-flow happy-path E2E test in Playwright.

### F7.2 — Answer-slot panel

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F6.1

Live-updating list of slots with confidence indicators + click-to-jump-to-question. Marked `// DEMO-ONLY:` where it bleeds into questionnaire-specific assumptions so a non-questionnaire fork strips gracefully.

_Indicative tasks:_

- Slot list rendering with live updates from session state.
- Confidence-indicator visual language (quiet, semantic — per the human-centric principle).
- Click-to-jump-to-question interaction.
- Refinement-history disclosure.

### F7.3 — Session lifecycle UX

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F4.6, F6.3

Visible session state: pause/resume affordance, completion-offer prompt, submission flow, cost-cap-reached state, anonymous-mode indicator.

_Indicative tasks:_

- Pause/resume controls + resumption from a saved session.
- Completion-offer UI (agent offers; user accepts or holds).
- Submission flow + confirmation.
- Cost-cap-reached / paused-by-cap UI.
- Anonymous-mode indicator (when the questionnaire is configured that way).

### F7.4 — PDF export

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F8.1 (analytics data shape) or independent

`@react-pdf/renderer` as an app dependency (vertical — not promoted to Sunrise). Admin-facing export of a session's answers first; user-facing PDF download is a nice-to-have.

_Indicative tasks:_

- Add `@react-pdf/renderer` to app `dependencies` (per package.json convention from [[building-on-sunrise]]).
- PDF layout component for a completed session.
- Admin route to download a session's PDF.
- (Optional) user-facing download on session completion.

**Definition of phase complete.** A prospect can complete a branded questionnaire end-to-end on a clean machine; PDF export of results works; demo-flow E2E green in CI.

---

## P8 — Admin analytics, exports, anonymous mode

**Intent.** Make completed sessions readable for the admin. Per-question distributions, completion funnel, cost actuals, exports. Anonymous mode shipped throughout the build is verified and hardened here.

### F8.1 — Admin analytics dashboards

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F4.2 (slots), F4.6 (session events), F3.2 (invitations)

The admin's read-side view of completed-session data: per-question distributions, completion funnel, cost actuals. Tag-aware filtering throughout.

_Indicative tasks:_

- Per-question distribution view (by question type, with tag filtering).
- Completion funnel: invited → opened → started → completed, with drop-off points.
- Per-questionnaire cost dashboard reading `AiCostLog` via Sunrise's existing query helpers.
- Shared filter/scope component across the three views.

### F8.2 — Result exports

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F8.1

CSV + JSON export of session results. CSV is one row per session × question; JSON is the full session graph including provenance + turns. Both respect anonymous mode.

_Indicative tasks:_

- CSV export endpoint + admin UI button.
- JSON export endpoint + admin UI button.
- Anonymous-mode handling in the export pipeline (no PII in either format when configured).

### F8.3 — Anonymous-mode hardening

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ F8.1, F8.2 + any surface that touches session data

Verification pass across every surface that touches session data, ensuring no PII leak when `anonymousMode = true`. Flag-gating tightened where needed.

_Indicative tasks:_

- Audit every read path that touches `AppQuestionnaireUserProfile` for anonymous-mode gating.
- Audit exports + analytics + admin UI.
- Integration tests that flip the flag and assert PII absence on every surface.
- Documentation of the anonymous-mode contract.

**Definition of phase complete.** Every analytic surface populated against seeded session data; exports verified for both anonymous and identified modes; integration tests for the anonymous-mode invariants pass.

---

## P9 — Hardening + forking docs

**Intent.** Make the platform demo-grade _and_ fork-ready. Concurrent-session sanity, flag inventory, runbook, the `forking.md` that a real client engagement uses to inherit the platform, and the external-fork upgrade guide for OSS forkers.

### F9.1 — Production hardening

_Status:_ not started · _Size:_ ~1–2 PRs · _Owner:_ TBD · _Deps:_ everything (final pass)

The pre-ship technical hardening: concurrent-session sanity, master + sub-flag inventory, verification that every flag and sub-flag controls the right surfaces independently.

_Indicative tasks:_

- 20+ concurrent-session sanity test: no deadlocks, no orphan turns, no missed audit writes.
- Feature-flag inventory document — master flag + sub-flags (adaptive strategy, voice multipart, eval-auto-run).
- Per-sub-flag verification — with each off, the gated surface is correctly suppressed; rest of platform unaffected.
- Final integration-test pass against the full happy path.

### F9.2 — Operational runbook

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F9.1

`.context/app/questionnaire/runbook.md`: how to spin up a new demo client end-to-end. Road-tested by John or Simon before the phase ships, with friction corrected into the doc.

_Indicative tasks:_

- Draft the "spin up a new demo client" runbook covering tenant creation, branding, content seed, invitation, first session.
- Live road-test by a demo presenter on a clean machine.
- Correct the runbook against road-test friction.

### F9.3 — Forking documentation

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F9.1, F9.2

The fork-readiness deliverables: `forking.md` for an inheriting client-engagement team, the external-fork upgrade guide for OSS forkers, and the consolidated Sunrise-contributions record.

_Indicative tasks:_

- `.context/app/questionnaire/forking.md` — what to keep verbatim, what to rename, what to replace, the rename `sed` recipes, the demo-tenancy replacement procedure.
- External-fork upgrade guide section — git upstream remote, semantic-conflict discipline, contributing fixes via PR. Per [[building-on-sunrise]] / [[fork-readiness-backlog#External-fork upgrade guidance]].
- Sunrise contributions record — what this build contributed back (smaller than originally planned, since v0.0.1 closed the pre-fork backlog; still a real sales artefact).

### F9.4 — Demo content seed (DEMO-ONLY)

_Status:_ not started · _Size:_ ~1 PR · _Owner:_ TBD · _Deps:_ F2.5.1, F7.1 (a complete themeable vertical to seed) · _Relocated from the old P2.5._

The `LOAD_DEMO_CONTENT=1` mechanism that populates a sample demo client + branded questionnaire on a fresh DB. Idempotent; refuses to run without the env var. Strictly demo-only — a fork strips it entirely. Lands **before** F9.2's runbook road-test so the runbook can exercise it.

_Indicative tasks:_

- `prisma/seeds/app-questionnaire/010-demo-content.ts`, idempotent, env-gated.
- Sample demo client + theme + sample questionnaire with realistic content.

**Definition of phase complete.** Platform ships; runbook road-tested; a notional fork can be spun up using only `forking.md`; external-fork upgrade path documented.

---

## How features and tasks work

### Status vocabulary

- **Features:** `not started | in flight | blocked | shipped`. Each feature carries an owner and dependencies. `blocked` lists what's blocking.
- **Tasks (when promoted):** `backlog | available | claimed | in-pr | merged`.

### Indicative vs promoted tasks

Each feature lists **indicative tasks** — a planning aid that sketches the scope, named at the level of "a thing that becomes one small PR." Indicative tasks are _not commitments_. They're an at-a-glance read of how big a feature is and what the rough shape might be.

A task becomes **promoted** when the owner is ready to share that state with the team — they declare it with a stable ID (`T<feature>.<n>`), files-likely-to-touch, dependencies, status. Promotion mirrors the Hub's deliberate "this is real work now" gesture: nothing the rest of the team sees is implicit; everything is something the owner explicitly committed to.

Reality check expected: indicative tasks will reshape when promoted. That's the point of leaving them indicative.

Promoted-task format under a feature in flight:

```
| ID | Task | Files | Deps | Status | PR |
|---|---|---|---|---|---|
| T4.1.1 | Sequential strategy + tests | lib/app/questionnaire/selection/sequential.ts | — | available | — |
| T4.1.2 | Adaptive strategy | lib/app/questionnaire/selection/adaptive.ts | T4.1.1 | backlog | — |
```

### Two feature shapes (PR sizing)

The base model above — _a Feature is a coherent multi-PR capability; a Task is a PR-sized work unit_ — fits the **keystone** features but over-applies to the **contained** ones. F0.1 made this concrete: framed as a multi-PR feature, in practice it was **one PR** and each task was **commit-sized**. Each feature heading carries a `_Size:_` hint to set the right default at promotion:

- **`~1 PR`** — contained, additive, lower-risk (scaffolding, seeds, CRUD, config panels, docs, "consume a Sunrise primitive"). Promote the tasks as **commits in one PR** and batch the review gates once. This is the F0.1 shape, and the most common.
- **`multi-PR`** — keystone features spanning many files/concerns with real risk (ingestion, the per-turn orchestrator, selection strategies, authoring, the chat surface). Here task ≈ PR, as the base model intends; cluster the small tasks into PRs and split out the genuinely large one (e.g. F4.1's `Adaptive`).
- **`~1–2 PRs`** — in between; firms up at promotion.

The hint is a default, not a commitment — packaging is decided per-feature at promotion. The lever is **commits ≠ PRs**: don't reflexively make a keystone one PR (it becomes unreviewable), and don't split a contained feature into many tiny PRs (each re-runs the gates).

> **The hints aren't platform-aware audits.** They estimate net-new _app_ code but were sized from the task list, not a per-feature check of what Sunrise already provides — so wherever the platform pre-bakes the machinery (e.g. invitations: token generation, email, and registration all ship in Sunrise — `.context/admin/invitations.md`), the real size is smaller. The definitive sizing happens at **promotion**, when the feature is designed against Sunrise's actual capabilities the way F0.1 was — and some hints will shrink once a planned "build X" reduces to configuring a workflow or consuming a primitive.

**Sizing against the gate-suite tax — the dominant force (F1.1 calibration).**

The lever above ("commits ≠ PRs") is right but underspecified on _which way_ to lean. F1.1 settled it with real data: **the fixed cost you amortise per PR is the whole gate suite — `/pre-pr` + `/security-review` + `/test-review` + `/code-review` — plus CI minutes, not just CI.** Four heavyweight multi-agent passes per PR. That tax is large enough that the default should be **the fewest PRs that each still get one honest review pass**, not the finest cut the seams allow.

- **Floor test (operational):** if a capable session writes the code faster than the gate suite runs, the PR is below the floor — bundle it up. The work should clearly exceed the ceremony.
- **A risk-type seam is a split you must _justify_, not a default.** The reviews run over the whole diff and are thorough enough to cover mixed concerns in one PR, so "the LLM path and the HTTP path want different reviewers" is a _weak_ reason to split — set against paying the entire suite (and CI) a second time. Split only when the isolated slice is **substantial _and_ carries a genuinely distinct high-stakes concern** (a live endpoint's security surface is the canonical one).
- **Ceiling unchanged:** stop bundling when a PR can no longer get one coherent review pass, or a security-critical surface would be buried in a large unrelated diff.

F1.1 (keystone) was planned as four risk-typed PRs; in practice **PR1 (schema) was minutes of work — far below the floor — so it folded into PR2**, and PR3/PR4 (#14, #15: ~1.4k and ~2.3k diff) sat right at the floor and could defensibly have been one. The honest cut was **~2 PRs — "the engine" (schema + pure core + capability + seeds, all static / unit-tested) and "the live endpoint" (route + persistence + integration tests, where `/security-review` earns its run)** — not four. Treat the per-feature PR count as "fewest that stay reviewable," and let the executor merge seams at the moment of work.

### Asking Claude to plan a feature or task

When you're ready to work on something, point Claude at it by ID:

> "Let's plan **F4.1** — selection strategies. Read the project plan and the related sections of the original phases doc (kept as reference), then propose how we approach it."

Claude reads this doc for intent and the original [[Conversational Questionnaire Phases]] for detail if needed, then produces an implementation plan for review. The plan itself stays high-level; deep prescription only happens at the moment of work.

---

## Decisions log

Append-only. Newest at the top. Each entry: date, decision, context, link.

- **2026-06-03 — P2.5 decomposed: demo tenancy is a cross-cutting concern, not a phase.** The decimal was the tell — P2.5 was inserted between P2 and P3 without the dependency pass the round-numbered phases got. Most of it can only be built once the model each piece hangs off exists (invitation branding needs P3's invitation model; session reset needs P4/P6's session graph; the theming render points need P7's user pages; the content seed needs a complete vertical) — and the original F2.5.1 even listed `AppQuestionnaireSession` scoping that P4/P6 hasn't built yet. P2.5 now keeps only the **foundation** (F2.5.1 — demo-client identity table + `AppQuestionnaire` FK + admin attribution), the one slice that must lead so P3+ build tenant-aware in a single pass. The rest is distributed into its host phase as a marked sub-feature: invitation branding → **F3.4**, demo session reset → **F6.4**, theming render + tenant routing → **F7.1/F7.3**, clone-for-client → **P3+** (after F2.2 + F3.1), demo content seed → **F9.4**. **Fork-strippability is preserved by keeping every piece in the same marked modules** (`lib/app/questionnaire/theming/`, the `demo-clients/` dirs, `// DEMO-ONLY:` headers): _decompose the schedule, preserve the module boundary_ — a fork still strips demo tenancy in one grep sweep. One open decision deferred to F3.4 promotion: themed vs plain invitation emails determines whether the theming module is built in P3 or P7.
- **2026-06-02 — Version status transitions (launch/archive) pulled into F2.1 PR2.** The original phasing parked launching in P3 (alongside invitations + cost estimation), which would have left `forkVersionIfLaunched` dormant — nothing could set a version to `launched`, so the fork branch was untestable end-to-end. Bringing the lifecycle status flip forward into PR2 (a `PATCH …/versions/:vid/status` with a minimal launch guard — goal + ≥1 section + ≥1 question) makes the fork seam **live**: editing a launched version actually forks a new draft, exercised by tests and the editor. The _full_ config-completeness launch gate (audience, config, pre-launch cost estimate) and the invitation/registration machinery remain **F3.1/P3**; `countLaunchBlockers` stays a zero-returning P3/P4 seam. Two further PR2 decisions: manual structural edits are audited via `logAdminAction` only (the `AppQuestionnaireExtractionChange` log stays the _extractor's_ provenance, F2.3's consumer) and a fork starts a clean editorial lineage (structure copied, change records not); reorder uses `@dnd-kit` (app dependency). Reference: [[features/f2.1]].
- **2026-06-01 — App changes are tracked in the planning docs, not `CHANGELOG.md`.** `CHANGELOG.md` is the **Sunrise platform** changelog (the public-surface record forks consume); ConQuest's own app surface is not added there — it would be miscategorised noise that conflicts on every upstream sync. The app's record of _what's done / deferred / decided_ lives in these planning docs and is the reference for planning the next feature: **done** → [[#Work completed to date]] plus the per-feature trackers under `features/`; **deferred / platform gaps** → `planning/upstream-gaps.md`; **decided** → this log. A consumer-facing changelog for forks of ConQuest _itself_ is a separate, later decision.
- **2026-06-01 — App docs consolidated under `.context/app/`.** Replaced the `.context/application/` outlier with a single app-docs root, `.context/app/`, using namespace subfolders that mirror the substrate pattern and the code's app tier (`lib/app/`, `app/api/v1/app/`, `prisma/schema/app-*`). `planning/` holds this development plan, the `features/` trackers, and the forward-looking `upstream-gaps.md` ledger (sibling to this Decisions log and the Carried Sunrise patches section); `questionnaire/` holds the domain/technical docs (overview, schema, development). Purely an app-owned reorg — Sunrise's substrate never referenced `.context/application/`.
- **2026-05-31 — Demo-client tenancy is a branding partition, not real isolation.** Sunrise ships single-tenant by default with zero tenancy machinery (no `Org` table, no `orgId`, no RLS) — multi-tenancy is a fork-level RLS retrofit at the `lib/db/client.ts` chokepoint, gated behind `TENANCY_MODE=multi`, _not_ a switch. The plan does **not** require multi-tenant Sunrise; it runs on standard single-tenant Sunrise. P2.5's tenancy (F2.5.1) is a deliberately light, app-owned branding/content partition with application-layer scoping — adequate because demo clients aren't adversarial. A fork into a real multi-customer product activates Sunrise's RLS seam rather than promoting the demo table into a security boundary (which is the trap Sunrise's multi-tenancy doc explicitly warns against). Reference: Sunrise `.context/architecture/multi-tenancy.md`.
- **2026-05-30 — Replaced the phased prompt document with this plan.** The original `Conversational Questionnaire Phases.md` is preserved as reference detail (deep specifications per phase remain useful when planning a feature), but the working source-of-truth is this lighter, intent-shaped doc. Rationale: the prompt-per-phase format was overkill, premature, and didn't leave space for in-flight reframes.
- **2026-05-30 — Sunrise pre-fork backlog closed in v0.0.1.** Multi-file Prisma schema, recursive seed discovery, capability registration hook, admin nav registry, ESLint app-boundary, user-FK pattern, app env-var extension are all in. Phases that previously workaround these are simplified. Reference: [[fork-readiness-backlog]].
- **2026-05-30 — Apply the [[building-on-sunrise]] model.** Fix-in-place, classify, promote-upstream for generic seams; carry app-specific changes locally and track them. Supersedes the universal zero-touch framing in the original phases doc.

---

## Work completed to date

Append-only. Newest at the top.

- **2026-06-03 — F2.5.1 Demo-client foundation (shipped — [PR #21](https://github.com/human-centric-engineering/conquest/pull/21); P2.5 complete).** The whole of the decomposed P2.5: demo-client identity + attribution, behind `APP_QUESTIONNAIRES_ENABLED` (off). **Schema:** `AppDemoClient` (`app_demo_client` — `slug @unique`, `name`, `description?`, `isActive`; identity-only, theme columns deferred to F3.4/F7.1) + nullable `demoClientId` FK on `AppQuestionnaire` with `onDelete: SetNull` + reverse `questionnaires` relation + `@@index`. Migration `…_app_demo_client` created `--create-only`, schema-fold phantoms (3 pgvector DROP INDEX + `searchVector` ALTER) stripped by hand, applied via `db:migrate:deploy`; drift-check 9/9 green. **Domain** (`lib/app/questionnaire/demo-clients/**`, `// DEMO-ONLY:`, Prisma-free): client-safe view contracts, kebab-case `slugifyDemoClient` (+ pattern), create/update/assign Zod schemas. **API** (`app/api/v1/app/demo-clients/**`): `GET`/`POST` (root) + `GET`/`PATCH`/`DELETE` (`[id]`) — all flag-gate→`withAdminAuth`→404→Zod→audit; slug derive-with-override; `409 SLUG_CONFLICT` (P2002); **`409 DEMO_CLIENT_IN_USE` delete-guard** (refuse while `_count.questionnaires>0`); read model `_lib/read.ts`. **Attribution:** `PATCH /questionnaires/:id { demoClientId }` (the one shared-file touch with John — additive handler; `404 DEMO_CLIENT_NOT_FOUND` on attach to a missing client) + `demoClient` surfaced on the list/detail read models + `QuestionnaireListItem`/`QuestionnaireDetail`. Registry `API.APP.DEMO_CLIENTS`; nav entry appended to `initAppNav()` (seam 4). **UI:** `/admin/demo-clients` list + `/new` create + `[id]` edit/delete (`<DemoClientForm>`, `<DemoClientsTable>`, `<DemoClientActions>` with the in-use-disabled delete + alert-dialog confirm), and `<DemoClientAssign>` picker embedded in the questionnaire detail page. **Tests:** schema-shape (model + FK/onDelete/index + footgun guard), slug + schema units, read-model unit, demo-client route integration (gate order, 401/403, 404, slug 409, delete 409-guard, audit), attribution route integration (404s, attach/detach, audit). `npm run validate` green; full suite 20018 pass (the 8 "errors" are pre-existing vitest worker-pool startup timeouts — the named files pass in isolation). Docs: `questionnaire/demo-clients.md` + `schema.md`. No CHANGELOG entry (app surface, not Sunrise platform). Tracker: `planning/features/f2.5.1.md`. Gates all green: `/pre-pr` (one coverage gap found + fixed — `schemas.ts` 50%→100% branch), `/security-review` (clean), `/code-review` (2 cleanups applied — shared `toDemoClientView`/`DEMO_CLIENT_SELECT` + slimmed attribution response to `{ id, demoClient }`), `/test-review` (no findings ≥80).
- **2026-06-02 — F2.2 tagging — built on `feat/f2.2-tagging` (rebased on `main`; gates green).** The second P2 feature: a per-version **tag vocabulary** + **M:N assignment to questions**, behind `APP_QUESTIONNAIRES_ENABLED` (off), single PR. **Schema** (migration `…_app_question_tags`): `AppQuestionTag` (version-scoped; `label` + `normalizedLabel` case-insensitive dedup key + optional `color` from the `TAG_COLORS` allowlist; `@@unique([versionId, normalizedLabel])`) + `AppQuestionSlotTag` M:N join (`@@unique([questionSlotId, tagId])`); both all-cascade, no `User` FK (UG-1). Migration hand-trimmed of the schema-fold phantom DDL (3 pgvector `DROP INDEX` + `searchVector` ALTER) and applied via `migrate deploy` to dodge the mid-apply footgun; drift-check 9/9 green. **Pure core** (`lib/app/questionnaire/tagging/`, Prisma-free): `normalizeTagLabel` + create/update/set-assignment Zod schemas; `TAG_COLORS` single-source tuple in `types.ts`. **Fork seam:** the F2.1 `// F2.2:` placeholder in `_lib/fork.ts` now copies the vocabulary into the forked draft and re-links assignments through the question id-map; `ForkResult.tagIdMap` added so the post-fork assignment route remaps client-sent ids. **APIs** (`_lib/tagging-routes.ts`): `POST`/`PATCH`/`DELETE …/versions/:vid/tags[/:tagId]` (vocabulary) + `PUT …/versions/:vid/questions/:questionId/tags` (replace-set, idempotent). All on the F2.1 pipeline (flag-gate → `withAdminAuth` → scope-404 → `forkVersionIfLaunched` → validate → tx → P2002→400 → `logAdminAction` → `successResponse(data, {forked})`). The **same-version invariant is application-layer** — the assignment route validates every tag id against the question's version (`resolveAssignableTags`, which returns the validated rows so the response needs no readback) **before** forking, so a cross-version id is a 400 with no orphan draft; a validated tag that fails to remap after a fork (concurrent delete) surfaces as a 409, not a silent partial assignment. The **vocabulary create/rename routes pre-check the label too** (`assertTagLabelAvailable`, mirroring `assertKeyAvailable`) **before** forking, so a duplicate-label collision on a launched version is a 400 with no orphan draft (P2002→400 stays as the write-race backstop). Audited as `questionnaire_tag.{create,update,delete,assign}`. **Read:** `getVersionGraph` loads the version vocabulary + per-question tags in the same single nested query (no N+1); `TagView` + `tags` added to `QuestionSlotView`/`VersionGraphView`. **UI:** `tag-vocabulary-editor.tsx` (CRUD), `question-tags-editor.tsx` (popover checkbox multiselect → replace-set `PUT`), `tag-chip.tsx` (shared coloured pill, server + client), read-only chips on `version-graph.tsx`; all through the existing `authoringMutate`/`run` runner (fork notice + refetch). **Decisions:** replace-set `PUT` over per-link; label + optional colour (allowlist, semantic names not hex). **Tests:** schema-shape (2 new tables — DMMF + migration SQL: uniques/indexes/FK-cascade + phantom-strip guard), unit (`normalizeTagLabel`, schemas), fork (`fork.test.ts` extended — vocabulary copy + assignment re-link), route integration (`tagging-routes.test.ts` — gate order, scope-404, dedup 400 **pre-fork + write-race backstop**, **cross-version 400 pre-fork**, **409 on lost-after-fork tag**, replace/clear semantics, fork remap, audit). `npm run validate` + full questionnaire suite (364) green. Docs: `questionnaire/schema.md` + `admin-ui.md`. No CHANGELOG entry (app surface, not Sunrise platform). Tracker: `planning/features/f2.2.md`. **Gates all green** (all fixes amended into the single commit): `/pre-pr` (format nit + `[tagId]`-route branch-coverage gap 68→88% fixed), `/test-review` (6 findings ≥80 applied — auth-matrix gaps, missing status asserts, version-404, pre-fork assertion, non-P2002→500, `status:'applied'` filter pin), `/security-review` (clean — IDOR scoping, same-version invariant, fork remap, XSS, authz all verified), `/code-review high` (7 findings applied — the **orphan-draft class**: pre-fork label check on create/rename + colour-`Select` `disabled={busy}`; `normalizedLabel` dropped from the rename audit diff; `resolveAssignableTags` returns rows so the assignment response skips a readback and a lost-after-fork tag 409s; optimistic-ref fix for the rapid-toggle checkbox race).
- **2026-06-02 — F2.1 authoring PR1 (read surface + admin shell) — on `feat/f2.1-pr1-read-surface`, P2 begins.** The first admin UI for the platform, read-only, behind `APP_QUESTIONNAIRES_ENABLED` (off). Three admin GET endpoints (`app/api/v1/app/questionnaires/`): `GET /` (paginated enriched list — latest-version + section/question counts in a fixed 4-query budget, no per-row N+1; query `page/limit/q/status/sortBy/sortOrder`; read model `_lib/list.ts`), `GET /:id` (questionnaire + newest-first version summaries; `_lib/detail.ts`), `GET /:id/versions/:vid` (full section→question graph, scoped by both ids → mismatch 404s). All: flag-gate first (404 off) → `withAdminAuth` (401/403) → 404 unknown id. View contracts (client-safe, ISO dates) in `lib/app/questionnaire/views.ts`; endpoints under `API.APP.QUESTIONNAIRES`. **Provenance stored per field (not derived):** new `goalProvenance` + `audienceProvenance` columns on `app_questionnaire_version` (migration `…_app_questionnaire_version_provenance`, phantom DDL stripped, drift-check green) persist the ingest merge's admin-wins-per-field outcome; the version-graph endpoint reads them straight back and the UI marks each inferred field (per-audience-field, not a coarse flag). An initial read-time derivation from `infer_*` change records was replaced by these columns during PR1 review — the right data model. **Drift fix:** status vocabulary is now the single-source `APP_QUESTIONNAIRE_STATUSES` tuple in `types.ts` (type + Zod query enum + UI filter options all derive from it); `FieldProvenance` moved from route `_lib/merge.ts` into domain `types.ts` so the client-safe view layer doesn't import route internals. UI: nav entry via `registerNavSection()` (seam 4, no sidebar edit); list page (`QuestionnairesTable` — debounced search, status filter, pagination, row click-through) + read-only detail page (`VersionGraph` — SSR `?v=` version selector, goal/audience `inferred` badges, section/question tree); pages 404 via `isQuestionnairesEnabled()` when the flag is off. New tests (route integration: gate order, 401/403, 404, envelope, query parsing; unit: `listQuestionnaires` fixed-query-budget + mapping, `getQuestionnaireDetail`/`getVersionGraph` column-backed provenance + null/404 + version scoping; persist: provenance written; schema-shape: new columns + phantom-strip guard). `npm run validate` + full questionnaire suite (17 files / 178) green. Docs: `questionnaire/admin-ui.md` + `schema.md`. No CHANGELOG entry (app surface, not Sunrise platform). Tracker: `planning/features/f2.1.md`. Remaining in F2.1: PR2 (structural authoring + version-fork). Gates (`/pre-pr`, `/test-review`, `/security-review`, `/code-review`) run next.
- **2026-06-01 — F1.1 ingestion PR4 ([PR #15](https://github.com/human-centric-engineering/conquest/pull/15), open) — F1.1 feature-complete.** The ingestion HTTP endpoint + transactional persistence, behind `APP_QUESTIONNAIRES_ENABLED` (off). `POST /api/v1/app/questionnaires` (`app/api/v1/app/questionnaires/{route.ts,_lib/**}`): flag-gate → `withAdminAuth` → per-admin sub-cap (`ingestLimiter`, 10/min, in-handler — chosen over `registerAppRateLimits`) → `Content-Length`/size guards (25 MB) → `.pdf/.docx/.md/.txt` allowlist → admin goal/audience parse (Zod, empty-as-absent) → SHA-256 dedup (`409`, surfaces existing ids; re-ingest is F2.4) → `parseDocument` direct (no preview/embed) → scanned/empty detection → `capabilityDispatcher.dispatch` of the PR3 extractor (agent binding in `entityContext`, dispatch errors mapped 429/502/503) → coherence pre-check (`assertPersistable` → `422` before any write) → one `executeTransaction` writing the whole graph + change log + source doc → `logAdminAction('questionnaire.ingest')`. Persistence (`_lib/persist.ts`) applies the **admin-wins-per-field** goal/audience merge (`_lib/merge.ts`, pure) and returns per-field provenance; `targetEntityId` resolves to the version for `infer_*`, null for entity edits; raw `bytes` deliberately not stored in F1.1 (no consumer until F2.4 — open question #5). Capability stays Prisma-free; this `_lib/` is the only DB seam. 49 new tests (22 route integration covering 404/401/403/201 + 6 failure-mode envelopes + dedup + dispatch-error mapping + rate-limit + audit; 27 unit on merge/persist/upload-input); `npm run validate` + full questionnaire suite (118) green. Docs: `questionnaire/ingestion.md` + `extraction-changes.md`; synthetic `tests/fixtures/app/questionnaire/` (typo + boilerplate + compound + duplicate). No CHANGELOG entry (app surface, not Sunrise platform). Tracker: `planning/features/f1.1.md`.
- **2026-06-01 — F1.1 ingestion PR3 ([PR #14](https://github.com/human-centric-engineering/conquest/pull/14), open).** The extractor **capability** + its agent/capability seeds + registration, behind `APP_QUESTIONNAIRES_ENABLED` (off). `AppExtractQuestionnaireStructureCapability` (`lib/app/questionnaire/capabilities/**`) — a `BaseCapability` dispatched **programmatically** (not an LLM tool loop): resolves a provider-agnostic binding (read from dispatch `entityContext`, empty-binding → system default), runs `runStructuredCompletion` (parse → retry-once-at-temp-0 → cost-sum), validates against the PR2 Zod contract, normalises the change log, logs `CostOperation.CHAT` cost (fire-and-forget, isolated), and returns structure + changes. **No persistence** (PR4 owns the transactional write); stays Prisma-free per the `lib/app/**` ESLint boundary. `processesPii: true` + `redactProvenance()` (document text → sentinel, counts-only ≤200-char preview); **no silent fallback** on final parse failure — surfaces a typed error carrying the Zod issue paths. Seeds `002-extractor-agent` (empty model/provider, budget cap, `internal`, KB-restricted) + `003-extraction-capability` (`internal`, bound to the agent), idempotent; registered via the `initAppCapabilities()` seam. 23-case dispatch integration test through the real dispatcher + real `runStructuredCompletion`, provider mocked; capability coverage 100% stmts/funcs, 93% branches. Gates run on-branch: `/pre-pr`, `/test-review` (no findings ≥80; 2 app-tier near-misses fixed), `/security-review` (clean — real upload/auth surface lands in PR4), `/code-review high` (3 findings: `functionDefinition` dedup + Zod-issue surfacing fixed; agent sampling-param threading deferred until extraction is exercised on real docs). Two items routed upstream rather than forked: a `runStructuredCompletion` dynamic-retry-message enhancement and a `registry.test.ts` handler-reset. Only PR4 (route + persistence) remains. Tracker: `planning/features/f1.1.md`.
- **2026-06-01 — F1.1 ingestion PR1 + PR2 ([PR #13](https://github.com/human-centric-engineering/conquest/pull/13), open).** The data foundation + pure extraction core for questionnaire ingestion, behind `APP_QUESTIONNAIRES_ENABLED` (off). **PR1 (schema):** the ingestion graph on the F0.1 anchor — `AppQuestionnaireSection`, `AppQuestionSlot` (per-version unique `key`, `type`/`typeConfig`/`weight`, embedding deferred to F4.1), `AppQuestionnaireExtractionChange` (revertible audit trail), `AppQuestionnaireSourceDocument`, plus `goal`/`audience` on the version; no `User` FK (UG-1), all-cascade. Migration hand-trimmed of the schema-fold phantoms — and a Prisma-7 lesson banked: `migrate dev` is **not** transactional, so the phantom index DROPs partially committed mid-apply (recovered surgically, recipe in `questionnaire/schema.md`; drift-check 9/9). **PR2 (pure core):** `lib/app/questionnaire/ingestion/**` — the Zod extraction contract + `z.toJSONSchema` + `validateExtraction`, the provider-agnostic prompt builder, and the change-record normaliser (per-type coherence + admin-wins-per-field suppression); pure, DB-free, framework-free; 44 zero-mock unit tests, 100% coverage on changed files. PR3 (capability) + PR4 (route + persistence) remain. Gates run on-branch: `/pre-pr`, `/test-review` (3 fixed), `/security-review` (clean), `/code-review` (4 fixed). Tracker: `planning/features/f1.1.md`.

- **2026-06-01 — Upstream sync: UG-1 + UG-2 resolved.** Second `upstream/main` merge, pulling down the two F0.1-surfaced fixes Conquest raised: **#283** (UG-2 — pin `AiConversation` inbound unique DB name with `map:`, killing the phantom `ALTER INDEX … RENAME` on every `migrate dev`) and **#284 → #286** (UG-1 — app-extensible drift-probe seam: `lib/db/drift-probes.ts` + the `lib/app/db-drift.ts` `registerAppDriftProbes()` hook, so apps register unmodelled DB objects without forking `scripts/db/check-drift.ts`). Clean merge — no conflicts; Conquest had not modified any of the touched files. The #283 baseline edit is comment-only (DDL unchanged), so no new migration; existing dev DBs needed a one-row `_prisma_migrations.checksum` realignment (done locally — see UG-2 resolution note). Both gaps retired in `planning/upstream-gaps.md`.

- **2026-06-01 — F0.1 Foundation scaffolding (shipped — [PR #10](https://github.com/human-centric-engineering/conquest/pull/10), merged).** App docs consolidated under `.context/app/` (`planning/` + `questionnaire/` namespaces). Questionnaire module skeleton + DB-backed `APP_QUESTIONNAIRES_ENABLED` flag (seeded off) with the `ensureQuestionnairesEnabled()` route-gate template; app-owned Prisma schema (`AppQuestionnaire` + `AppQuestionnaireVersion`, app-internal cascade relation, User FK deferred — see `planning/upstream-gaps.md` UG-1) + init migration hand-trimmed of the platform schema-fold DROPs (drift-check green); recursive app seed for the flag; gated `GET /api/v1/app/healthcheck` (404 off / 200 on). Unit + integration tests; `validate` + full `test` green. Six PR-sized tasks (one commit each) batched into one PR — tracker: `planning/features/f0.1.md`.

---

## Carried Sunrise patches

Core changes the app currently carries that are not yet reflected in upstream Sunrise. Each tagged `pending-upstream | app-specific-override | abandoned`. Retired when a Sunrise release includes the change.

- **2026-05-31 — CI private-fork fixes + performance — RETIRED (landed upstream).** Was `pending-upstream`; now superseded by Sunrise #280 ("ci: adaptive pipeline for public + private forks, with perf overhaul") and pulled down in the first `upstream/main` merge on 2026-05-31. All Conquest carried CI overrides (heap bumps in `ci.yml`/`Dockerfile`, CodeQL + dependency-review private-gating, Tier-1 caching/concurrency/`--changed`, Tier-2 parallel+sharding) were resolved **in upstream's favour** during the merge — upstream's version is a superset (adaptive public/private, API-based visibility check that fixes the CodeQL `schedule` edge we'd flagged, `CI_TEST_SCOPE` knob). No Conquest-specific CI override remains; canonical behaviour now documented in `.context/architecture/ci.md`. The seed-credential issue (#278) also landed (first-user-is-admin + `system-owner` seed) — not a carried patch, but the README "first admin" section was updated to match during the merge.

---

## References

- [[building-on-sunrise]] — canonical model for how apps relate to Sunrise.
- [[fork-readiness-backlog]] — the pre-fork Sunrise work, now closed in v0.0.1.
- [[Conversational Questionnaire Phases]] — the original prompt-per-phase document. Superseded as the working plan, kept as deep-spec reference per phase.
- [[v1-requirements|HCE Hub v1 requirements]] — the working model this doc mirrors (Project → Feature → Task, ownership, promotion).
