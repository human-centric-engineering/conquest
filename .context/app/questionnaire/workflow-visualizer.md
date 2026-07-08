# Behind the Scenes — Agentic Workflow Visualizer

A read-only, demo-oriented surface at **`/admin/questionnaires/behind-the-scenes`** that renders ConQuest's AI pipelines as React Flow node/edge diagrams. Click a step to reveal the agent that runs it (model, prompt, tools, knowledge). An optional **questionnaire lens** tints each workflow by whether it applies to a chosen version. Purely presentational — nothing here is editable and nothing is persisted.

## Why it exists

ConQuest's AI flows are hand-written TypeScript orchestrations, not rows in the platform's editable workflow-DAG engine. This surface documents them for demos: it reuses the platform's **presentational** canvas primitives read-only and layers a ConQuest-owned overlay for per-node metadata. It is a sibling to the [Prompt Library](../../admin/questionnaire/admin-ui.md) — nodes deep-link into it.

## Architecture (extend through these seams)

```
lib/app/questionnaire/workflows/
  types.ts          # client-safe: NodeMeta overlay, ApplicabilityContext, node()/diagram() helpers
  views.ts          # client-safe: API DTOs (AgentView, PromptView, NodeEnrichment, WorkflowDetail)
  registry.ts       # pure: WORKFLOW_DIAGRAMS + getWorkflowDiagram / listWorkflowSummaries
  definitions/*.ts  # pure data: one hand-authored diagram per pipeline (+ its applicability predicate)
  enrich.ts         # SERVER-ONLY: resolve agent/prompt/tool/KB detail per node (prisma + prompt-catalog)
  applicability.ts  # SERVER-ONLY: build the per-version context, run every predicate

app/api/v1/app/questionnaires/workflows/route.ts        # GET list (+ ?versionId= lens)
app/api/v1/app/questionnaires/workflows/[slug]/route.ts # GET one diagram + enrichment (+ lens)

app/admin/questionnaires/behind-the-scenes/page.tsx     # server: flag-gate + prefetch summaries
components/app/questionnaire/behind-the-scenes/          # client: explorer, canvas, picker, lens, panel
```

**Reused platform code (read-only imports — never edited):** `nodeTypes`/`PatternNode`, the pure `workflowDefinitionToFlow` adapter, and `step-registry.ts` (icon/colour/handles) under `components/admin/orchestration/workflow-builder/` + `lib/orchestration/engine/`. The read-only canvas mirrors `workflow-canvas.tsx` (drops drag/drop, connect, change handlers, and the interactive retry edge) rather than reusing it.

**Data model:** each diagram is a platform `WorkflowDefinition` verbatim. The ConQuest per-node overlay (`agentSlug`, `promptCatalogSlug`, `promptSpecimenId`, `capabilitySlugs`, `kb`, `note`) rides under `WorkflowStep.config._meta`, alongside the hand-placed `config._layout` (deterministic demo layout — no BFS). The platform mapper tolerates unknown config keys, so this is schema-safe. Deterministic (non-LLM) steps have no `agentSlug`.

**Step type → registry type** is a visual mapping only (icon/colour): agent call → `agent_call`, gate → `guard`, branch → `route`, tool → `tool_call`, KB read → `rag_retrieve`, fan-out → `parallel`, confirm → `human_approval`, persist/deliver → `report`, scoring → `evaluate`. **Never add ConQuest step types to the platform `step-registry.ts`** — it's platform-owned and merges from upstream.

## The workflows

| slug                   | pipeline                                                                         | source module                            |
| ---------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| `document-ingestion`   | upload → parse → guard → extract → coherence → persist                           | `_lib/extract-pipeline.ts`               |
| `generative-authoring` | brief → outline → parallel sections → assemble → persist (+ refine)              | `ingestion/stream-compose.ts`            |
| `structure-edit`       | instruction → translate to edit-ops → preview → confirm → apply                  | `_lib/edit-agent-pipeline.ts`            |
| `data-slot-generation` | authored questions → generate slots → review                                     | `data-slots/generation.ts`               |
| `conversation-turn`    | per-turn orchestrator: extract → gates → contradiction → assess → respond branch | `orchestrator/orchestrator.ts`           |
| `answer-extraction`    | message → extract → normalise → validate → propagate                             | `extraction/extraction-prompt.ts`        |
| `data-slot-turn`       | combined extract → park → contradiction → respond (offer/question/next-slot)     | `orchestrator/data-slot-orchestrator.ts` |
| `respondent-report`    | load → transcript → (client KB) → generate → format → deliver                    | `report/generate.ts`                     |
| `cohort-report`        | dataset → material → (context KB) → synthesise → charts → publish                | `cohort-report/generate.ts`              |

Leaf behaviours (intro/kickoff, voice transcription, interviewer personas/tone, adaptive selection) appear as nodes/notes within `conversation-turn` rather than separate diagrams.

## The questionnaire lens (applicability)

With a `?versionId=` lens, `buildApplicabilityContext(versionId)` combines the resolved feature flags (via `resolveQuestionnaireWorkspaceFlags` + a few extra `is*Enabled` helpers), the version's saved config (`CONFIG_SELECT`/`toConfigView`), its status + `goalProvenance`, and three relation counts (source documents, data slots, round items). Each diagram's pure `applicability(ctx)` predicate returns one of:

- **`applies`** — flag on and the per-version gate satisfied (highlighted).
- **`inactive`** — flag on but the config/relation gate is off, e.g. cohort reporting enabled workspace-wide but `config.cohortReport.enabled` false, or no data slots (dimmed, with a reason tooltip).
- **`unavailable`** — the platform flag is off in this workspace (heavily dimmed).

## Drift risk

Edge/ordering and the applicability predicates are the one thing **not** derivable from code — a diagram can misrepresent a changed pipeline. Mitigations:

- `tests/unit/app/questionnaire/workflows/integrity.test.ts` pins every `agentSlug` / `promptCatalogSlug` / `promptSpecimenId` / `capabilitySlug` to the live constants, prompt catalog, and capability registry — a renamed/removed reference fails CI.
- `tests/unit/app/questionnaire/workflows/applicability.test.ts` pins the predicates to real flag/config field names.
- `tests/unit/app/questionnaire/workflows/definitions.test.ts` asserts each diagram is a valid, renderable DAG.
- Each diagram carries a `sourceModule` naming the code it documents — the anchor for review when that code changes.

The diagram _shape_ still needs manual upkeep; treat these as curated demo artefacts, not auto-generated documentation.

## Gating & access

Admin-only (`withAdminAuth`), flag-gated by the master `APP_QUESTIONNAIRES_ENABLED` via `withQuestionnairesEnabled` (the page `notFound()`s and the routes 404 when off). No new flag was added.
