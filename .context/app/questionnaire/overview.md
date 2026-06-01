# Questionnaire — overview

## The concept

ConQuest is a **conversational questionnaire** platform. An admin uploads a
questionnaire document (PDF / DOCX / MD / TXT); an agent extracts its sections and
questions; end users complete it through a **streaming conversation** rather than
form-filling. The LLM extracts, infers, and synthesises answers with confidence
scores and provenance; admins review the structure, evaluate it against the stated
goal and audience, manage versions, and export results.

For the full intent — including the dual "sales-demo vehicle + project starter"
purpose and the questionnaire-specific vs reusable boundary — see
[`../planning/development-plan.md`](../planning/development-plan.md). This doc is
the technical orientation.

## Two tiers: app and platform

ConQuest is an **application fork of Sunrise**. Two tiers share one repo:

- **Platform (Sunrise)** — auth, `lib/` utilities, orchestration, security /
  rate-limit middleware, migration tooling. An upgradable dependency: extend
  through its seams, don't fork-and-edit. Documented at
  [`../../substrate.md`](../../substrate.md).
- **This app (ConQuest)** — questionnaire models, capabilities, and surfaces in
  _new_ files under the app-owned locations below.

### Where app code goes (and why it's segregated)

| Concern      | Location                                 | Rule                                                                                                                                                                                                              |
| ------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain logic | `lib/app/questionnaire/**`               | Platform-agnostic. The `lib/app/**` ESLint boundary forbids runtime `next/*`, `prisma`, `react-dom`, and node built-in imports (type-only OK). DB/HTTP glue lives in `app/` or a `lib/app/<name>/server/` module. |
| HTTP API     | `app/api/v1/app/**`                      | Inherits the 100/min `api` rate-limit cap automatically; gated by the feature flag.                                                                                                                               |
| Admin UI     | `app/admin/questionnaires/**`            | Registered into the sidebar via the nav seam (`lib/app/admin-nav.ts`), not by editing the sidebar component.                                                                                                      |
| End-user UI  | `app/(protected)/questionnaires/**`      | Session-gated route group.                                                                                                                                                                                        |
| Models       | `prisma/schema/app-questionnaire.prisma` | A **dedicated** file — `app.prisma` already holds platform models. Every model prefixed `App…`.                                                                                                                   |
| Seeds        | `prisma/seeds/app-questionnaire/**`      | Discovered by the recursive `db:seed` runner.                                                                                                                                                                     |

See [`development.md`](./development.md) for the boundary and gating mechanics in
detail.

## Sunrise primitives consumed

The app builds **on** Sunrise's public surface rather than reimplementing it. Key
primitives (full list in the plan's "Architecture summary"):

Primitives **already consumed** (F0.1 + F1.1):

| Need                       | Sunrise primitive                                                            |
| -------------------------- | ---------------------------------------------------------------------------- |
| Agents / versioning        | `prisma.aiAgent.upsert()` (seeded extractor agent) + `AiAgentVersion`        |
| Capabilities (agent tools) | `capabilityDispatcher` via the `lib/app/capabilities.ts` hook                |
| Structured LLM call        | `runStructuredCompletion()` + `resolveAgentProviderAndModel` + `getProvider` |
| Document parsing           | `parseDocument()` — called **directly** (see note)                           |
| Audit                      | `logAdminAction()`                                                           |
| Cost                       | Per-agent budgets + `logCost()` / `AiCostLog`                                |
| Feature flag               | `isFeatureEnabled('APP_QUESTIONNAIRES_ENABLED')`                             |

> **Parsing — `parseDocument()` directly, not `previewDocument()`/`confirmPreview()`.**
> Those preview helpers chunk + embed the document into the RAG knowledge base;
> ingestion (F1.1) only needs bytes → text and parses directly. See
> [`ingestion.md`](./ingestion.md).

Primitives **planned but not yet consumed** (later phases):

| Need                          | Sunrise primitive                                            | Phase |
| ----------------------------- | ------------------------------------------------------------ | ----- |
| Workflows                     | `prisma.aiWorkflow.create()`                                 | TBD   |
| Embeddings                    | `embedText()` / `embedBatch()` (deferred — no consumer yet)  | F4.1  |
| Streaming chat                | `streamChat()` + `sseResponse()` + `withAuth`                | P6    |
| Evaluation (agents-as-judges) | `AiEvaluationRun`, `AiEvaluationCaseResult`, grader registry | P5    |

## Non-functional principles

- **Provider-agnostic.** Every LLM call resolves through Sunrise's provider
  manager / `AiProviderModel` registry — nothing locks to a single vendor.
- **Feature-flagged.** `APP_QUESTIONNAIRES_ENABLED` (DB-backed) gates every
  surface. Routes flag-gate first via `ensureQuestionnairesEnabled()` before any
  auth/handler work.
- **Auditable & provenance-bearing.** Admin mutations log via `logAdminAction()`;
  extracted answers carry `ProvenanceItem` records.
- **Fork-ready.** Clean seams, `// DEMO-ONLY:` markers on sales-demo-only code, and
  public-surface discipline so a real client engagement can fork cleanly.

## Related

- [`schema.md`](./schema.md) · [`development.md`](./development.md)
- [`../planning/development-plan.md`](../planning/development-plan.md) — build plan & decisions
- [`../planning/upstream-gaps.md`](../planning/upstream-gaps.md) — tracked platform gaps
