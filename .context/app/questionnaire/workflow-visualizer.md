# Behind the Scenes — Agentic Workflow Visualizer

A read-only, demo-oriented surface at **`/admin/questionnaires/behind-the-scenes`** that renders ConQuest's AI pipelines as React Flow node/edge diagrams. Click a step to reveal the agent that runs it (model, prompt, tools, knowledge). An optional **questionnaire lens** tints each workflow by whether it applies to a chosen version. Purely presentational — nothing here is editable and nothing is persisted.

## Why it exists

ConQuest's AI flows are hand-written TypeScript orchestrations, not rows in the platform's editable workflow-DAG engine. This surface documents them for demos: it reuses the platform's **presentational** canvas primitives read-only and layers a ConQuest-owned overlay for per-node metadata. It is a sibling to the [Prompt Library](../../admin/questionnaire/admin-ui.md) — nodes deep-link into it.

## Architecture (extend through these seams)

```
lib/app/questionnaire/workflows/
  types.ts          # client-safe: NodeMeta overlay, ApplicabilityContext, node()/diagram() helpers
  views.ts          # client-safe: API DTOs (AgentView, PromptView, NodeEnrichment, WorkflowDetail)
  categories.ts     # client-safe: WORKFLOW_CATEGORIES — lifecycle grouping + display order for the picker
  registry.ts       # pure: WORKFLOW_DIAGRAMS + getWorkflowDiagram / listWorkflowSummaries
  definitions/*.ts  # pure data: one hand-authored diagram per pipeline (+ its applicability predicate)
  enrich.ts         # SERVER-ONLY: resolve agent/prompt/tool/KB detail per node (prisma + prompt-catalog)
  applicability.ts  # SERVER-ONLY: build the per-version context, run every predicate

app/api/v1/app/questionnaires/workflows/route.ts        # GET list (+ ?versionId= lens)
app/api/v1/app/questionnaires/workflows/[slug]/route.ts # GET one diagram + enrichment (+ lens)

app/admin/questionnaires/behind-the-scenes/page.tsx     # server: prefetch summaries
components/app/questionnaire/behind-the-scenes/          # client: explorer, canvas, picker, lens, panel
```

**Reused platform code (read-only imports — never edited):** `nodeTypes`/`PatternNode`, the pure `workflowDefinitionToFlow` adapter, and `step-registry.ts` (icon/colour/handles) under `components/admin/orchestration/workflow-builder/` + `lib/orchestration/engine/`. The read-only canvas mirrors `workflow-canvas.tsx` (drops drag/drop, connect, change handlers, and the interactive retry edge) rather than reusing it.

**Data model:** each diagram is a platform `WorkflowDefinition` verbatim. The ConQuest per-node overlay (`agentSlug`, `promptCatalogSlug`, `promptSpecimenId`, `capabilitySlugs`, `kb`, `vector`, `hybrid`, `note`, `settings`) rides under `WorkflowStep.config._meta`, alongside the hand-placed `config._layout` (deterministic demo layout — no BFS). The platform mapper tolerates unknown config keys, so this is schema-safe. Deterministic (non-LLM) steps have no `agentSlug`.

**Node treatment (four categories).** `conquest-workflow-node.tsx` colours each step by what it is, and `miniMapNodeColor` + the explorer legend mirror it. The execution split (agent / hybrid / deterministic) is `nodeExecutionKind(config)` in `types.ts` — the single classifier, checked `hybrid` first (a hybrid gate also carries a `promptCatalogSlug`, so it would otherwise read as pure agent):

- **Retrieval** (violet, "KB"/"Vector" badge) — the step reads a knowledge base (`_meta.kb`) or runs an embedding/vector engine (`_meta.vector`). This wins over the execution split (an agentic retrieval step keeps its "AI" badge too), because "where does knowledge/vector plug in" is the question the highlight answers. `nodeRetrievalKind(config)` is a separate classifier — `kb` takes precedence when a step carries both. `kb` = a document corpus the step _reads_ (agent knowledge grant or per-demo-client tag); `vector` = the embedding/pgvector similarity engine the step _runs_ (adaptive question/slot selection is `active`; the at-scale extraction candidate pre-filter is `pluggable`). The info panel's **Knowledge** tab renders both.
- **Agentic** (blue, "AI" badge) — an LLM agent runs it (`_meta.agentSlug`/`promptCatalogSlug`), with no deterministic branch.
- **Hybrid** (blue with a _dashed_ border, "Hybrid" badge) — `_meta.hybrid`: the step runs a deterministic path AND an LLM path in the same turn. The **safety gates** are the canonical case, and both looked "deterministic" before this category existed: the **Sensitivity gate** merges a deterministic keyword floor + a dedicated LLM safeguarding detector + the extractor's structured field (defence-in-depth, `sensitivity/`), and the **Genuineness gate** runs a keyword floor OR an LLM judge (`seriousness/`). Both gates run in **both** live-turn diagrams — `conversation-turn` and `data-slot-turn` (the data-slot orchestrator runs them in parity, before merge). The **answer-fit `validate` gate** (`answer-extraction`) is hybrid too: deterministic per-type validation is the floor, and in `fallback`/`always` `answerFitMode` an LLM force-fit resolver maps free text that failed the floor onto the closest option (`resolveAnswerFit`, reusing the extractor's binding). Set `hybrid: true` alongside a `promptCatalogSlug`/`promptSpecimenId` so the info panel's **Prompt** tab shows the LLM path's real prompt. When the LLM path reuses the Answer Extractor's binding (no dedicated agent row), the **Agent** tab says so rather than showing "no AI agent". Not everything with a conditional model call is hybrid: the turn-evaluator's `validate` gate stays deterministic — its temp-0 retry is _error recovery_ (a schema-invalid re-ask of the same call), not a second substantive path.
- **Deterministic** (dashed slate) — plumbing: parse, merge, persist, pure-code guards.

**Node info panel** (on click) shows, top to bottom: the step's **Role** (its `WorkflowStep.description`), the **Settings that affect this step** (`_meta.settings` — each a `{ key, label, effect }` where `key` is a dotted path into `QuestionnaireConfigShape`, so an operator can find it on the Settings tab), then the **Agent / Prompt / Knowledge / Tools** tabs. The per-workflow **Purpose** (the diagram `description`) shows above the canvas.

**Step type → registry type** is a visual mapping only (icon/colour): agent call → `agent_call`, gate → `guard`, branch → `route`, tool → `tool_call`, KB read → `rag_retrieve`, fan-out → `parallel`, confirm → `human_approval`, persist/deliver → `report`, scoring → `evaluate`. **Never add ConQuest step types to the platform `step-registry.ts`** — it's platform-owned and merges from upstream.

## The workflows

| slug                     | pipeline                                                                                                          | source module                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `document-ingestion`     | upload → parse → guard → extract → coherence → persist                                                            | `_lib/extract-pipeline.ts`               |
| `generative-authoring`   | brief → outline → parallel sections → assemble → persist (+ refine)                                               | `ingestion/stream-compose.ts`            |
| `structure-edit`         | instruction → translate to edit-ops → preview → confirm → apply                                                   | `_lib/edit-agent-pipeline.ts`            |
| `data-slot-generation`   | authored questions → generate slots → review                                                                      | `data-slots/generation.ts`               |
| `conversation-turn`      | per-turn orchestrator: extract → gates → contradiction → assess → respond branch                                  | `orchestrator/orchestrator.ts`           |
| `answer-extraction`      | message → extract → normalise → validate → propagate                                                              | `extraction/extraction-prompt.ts`        |
| `data-slot-turn`         | combined extract → park → contradiction → respond (offer/question/next-slot)                                      | `orchestrator/data-slot-orchestrator.ts` |
| `respondent-report`      | load → transcript → (client KB) → (before-research) → generate → format → (after-research) → (appendix) → deliver | `report/generate.ts`                     |
| `cohort-report`          | dataset → material → (context KB) → synthesise → charts → publish                                                 | `cohort-report/generate.ts`              |
| `design-evaluation`      | structure snapshot → 7 judges (grouped, parallel) → aggregate → findings                                          | `evaluation/run-panel.ts`                |
| `config-advisor`         | snapshot → narrative (stream) → structured suggestions → admin applies                                            | `advisor/stream-advisor.ts`              |
| `agent-settings-advisor` | evaluate settings vs advisory table → structured explain (+ optional patch) → admin applies                       | `agent-advisory/explain.ts`              |
| `turn-inspector`         | gate → capture calls → capture vector calls → assemble → stream → (serialize/eval)                                | `inspector/index.ts`                     |
| `turn-evaluation`        | load turn+objectives → rubric prompt → judge → validate/repair → serialize → persist                              | `turn-evaluation/evaluate-turn.ts`       |

Leaf behaviours (intro/kickoff, voice transcription, interviewer personas/tone, adaptive selection) appear as nodes/notes within `conversation-turn` rather than separate diagrams.

**Picker — category-grouped dropdown.** `workflow-picker.tsx` is a `Select` (not a flat chip row): workflows are grouped by the **part of ConQuest that runs them**, defined once in `categories.ts` as `WORKFLOW_CATEGORIES` (lifecycle order: **Questionnaire Creation** → **Config / Settings** → **Live conversation** → **Reporting** → **Evaluation & QA**). Notable placements: **Design evaluation** sits under Questionnaire Creation (it grades a draft before launch), and both AI advisors — the **Config Advisor** and the **Agent Settings Advisor** — sit under Config / Settings. That module is the single source of truth for both the grouping and its display order; grouping happens client-side (the picker imports it directly — no API/summary change). Each option shows its **step count** (`WorkflowSummary.stepCount`) and the trigger echoes the selected workflow's title + step count, so the reader sees a pipeline's size before opening it. When a lens is active, each option keeps its applicability dot + dimming and the reason tooltip. "Category" here is a workflow **grouping** — distinct from the per-node treatment categories (retrieval / agentic / hybrid / deterministic) above. `integrity.test.ts` pins every diagram to exactly one category (and rejects dangling/duplicate membership), so a new diagram can't ship un-grouped.

**Agent coverage.** Every seeded questionnaire agent is represented in a diagram: the authoring/live/report agents in their pipelines; the seven **design-evaluation judges** each as their own node in `design-evaluation`, fanned out from the structure snapshot and wrapped in a single **"Judge panel"** container box (their slugs live in `evaluation/dimensions.ts`, so the integrity test unions them into the known-agent set); the **Report Research** agent (`app-report-researcher`) in the respondent-report diagram's optional before/after web-search nodes, driving a bounded `web_search` tool-loop (the appendix synthesis reuses the report writer, not a dedicated agent); the **Config Advisor** in `config-advisor`; the **Agent Settings Advisor** in `agent-settings-advisor`; the **Report Design Assistant** (`app-respondent-report-assistant`) in `report-config-assistant` (a multi-turn chat that drafts report-generation config, modelled as gather → draft → apply); and the **turn evaluator** in `turn-evaluation`. A step can carry `_meta.group = { id, label }`; the read-only canvas (`buildGroupNodes`) then synthesises a labelled container node **behind** every member of that group so related steps read as one unit (the seven judges as a "Judge panel"). It is pure presentation — the box is not a DAG node, is non-selectable, and is click-through. The support agents whose prompts are built in code (the Config Advisor, Agent Settings Advisor, Report Research, and Report Design Assistant) carry no Prompt tab and are allowlisted in the integrity test.

`turn-inspector` and `turn-evaluation` are the **admin diagnostic** pair (preview-only): the Inspector is pure observability (every node deterministic except the violet vector-capture step) that records a turn's agent + embedding calls and streams them to the drawer; from there the Evaluator runs a single structured reasoning judge (`turn-evaluator` agent, rubric in `turn-evaluation/prompt.ts`) over the serialized turn. Live sessions and turn evaluation are always on, so the Inspector's and Evaluator's applicability now gates only on the per-version `config.previewInspectorEnabled` toggle. The `turn-evaluator` agent slug is canonically defined in `constants.ts` (re-exported from `agent-advisory/recommendations.ts`) so the integrity test pins it.

## The questionnaire lens (applicability)

With a `?versionId=` lens, `buildApplicabilityContext(versionId)` combines the version's saved config (`CONFIG_SELECT`/`toConfigView`), its status + `goalProvenance`, and three relation counts (source documents, data slots, round items) — it no longer resolves any feature flags (the questionnaire flag layer was removed). Each diagram's pure `applicability(ctx)` predicate returns one of:

- **`applies`** — the per-version config/relation gate is satisfied (highlighted).
- **`inactive`** — the per-version config/relation gate is off, e.g. `config.cohortReport.enabled` false, or no data slots (dimmed, with a reason tooltip).
- **`unavailable`** — heavily dimmed. This state used to mean "the platform flag is off in this workspace"; with the flag layer removed there is no longer a platform-flag trigger for it, so in practice diagrams resolve to `applies` or `inactive`.

## Drift risk

Edge/ordering and the applicability predicates are the one thing **not** derivable from code — a diagram can misrepresent a changed pipeline. Mitigations:

- `tests/unit/app/questionnaire/workflows/integrity.test.ts` pins every `agentSlug` / `promptCatalogSlug` / `promptSpecimenId` / `capabilitySlug` to the live constants, prompt catalog, and capability registry, and every `_meta.settings` key to a real `QuestionnaireConfigShape` path — a renamed/removed reference fails CI. It also (a) asserts each referenced prompt specimen actually **renders** (a builder-signature drift shows as `error: true` / a ⚠️ in the Prompt tab, and fails CI), and (b) requires every **agent-backed** step to carry a `promptCatalogSlug` unless its agent is on an explicit allowlist. That allowlist is the set of agents the Prompt Library deliberately does not catalogue (see the `buildPromptCatalog` docstring): the **respondent report**, **cohort report**, **report formatter**, **report research**, **report design assistant**, and **structure editor** — post-completion / support agents whose prompts are built in code. Their nodes correctly show no Prompt tab. (The **turn evaluator** _is_ catalogued — its load-bearing rubric renders under `turn-eval.judge`.)
- `tests/unit/app/questionnaire/workflows/applicability.test.ts` pins the predicates to real flag/config field names.
- `tests/unit/app/questionnaire/workflows/definitions.test.ts` asserts each diagram is a valid, renderable DAG.
- Each diagram carries a `sourceModule` naming the code it documents — the anchor for review when that code changes.

The diagram _shape_ still needs manual upkeep; treat these as curated demo artefacts, not auto-generated documentation.

## Gating & access

Admin-only (`withAdminAuth`), and **always on** — the questionnaire feature-flag layer was removed (2026-07), so there is no flag gate and no 404/`notFound()`-when-off path. See [`feature-flags.md`](./feature-flags.md).
