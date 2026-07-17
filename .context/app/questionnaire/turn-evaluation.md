# Turn evaluation

An admin-only **interview-quality evaluator** the [Preview Turn Inspector](#) runs over **one
completed turn** of a live questionnaire conversation. Where the inspector _describes_ a turn (every
LLM/embedding call with its prompt, response, model, latency, tokens, cost), the evaluator _judges_
it — instruction compliance, interviewing quality, extraction quality, question-selection quality,
information gain, missed opportunities, prompt drift, and cost/efficiency — and returns a scored,
sectioned verdict for developers, researchers, and prompt engineers. It is never shown to
respondents.

A "turn" = all the LLM calls between one respondent answer and the next interviewer question.

## Why it's shaped this way

**Two ways to feed the evaluator — a live dump, or saved traces.** The Turn Inspector dump
(`TurnInspectorData` — every LLM/embedding call with its prompt, response, model, latency, tokens,
cost) reaches the evaluator from either boundary:

1. **Live (preview):** the server streams `inspector` SSE frames only for an admin **preview**
   session with the toggle on; the drawer holds them and POSTs the dump for the turn being judged.
2. **Saved (any session):** the per-turn dump is **persisted on every turn row**
   (`AppQuestionnaireTurn.inspectorCalls`, captured for all sessions), so a real chat found by its
   **support reference** (`publicRef`) can be re-evaluated against the exact calls it ran — see
   [Re-evaluate a chat by reference](#re-evaluate-a-chat-by-reference).

```
live:  drawer "Evaluate" → POST the dump        → route → structured LLM call → persist + verdict
saved: admin looks up ref → pick a turn         → route → load saved dump → same call → persist + verdict
```

Both validate the dump against the **same** Zod schema (`inspector/schema.ts`) — the live POST
because it's untrusted client data, the saved path because the persisted JSON is structurally
untrusted at the read seam. **The verdict IS persisted** (`AppQuestionnaireTurnEvaluation`) — see
[Persistence](#persistence-the-stored-verdict) — snapshotting **both** the verdict and the
`evaluatedInput` so a stored score stays interpretable and a flagged verdict is usable as a learning
case. Persistence is best-effort — a write failure logs and returns a `null` `evaluationId` rather
than losing the verdict.

> SSE **emission** of the live `inspector` frame is still preview-gated (a real respondent never
> receives it); only the **persistence** is universal. The drawer derives each turn's conversation
> context (respondent message + interviewer reply + recent history) and POSTs it with the dump.

**Drawer hydration on resume.** The drawer's `inspectorTurns` is client state fed by live frames, so
a reload (the preview boots client-side and resumes via `sessionStorage`) used to empty it until the
next turn. The transcript replay route now also returns the persisted traces (`loadInspectorTurns`
→ `inspectorTurns`), **gated to a preview session with the toggle on** — the same gate the live
frame uses — and `useQuestionnaireSessionStream` seeds them via `initialInspectorTurns`. Each
hydrated turn's `turnIndex` is the 1-based `ordinal` minus 1, reproducing the live `selectionRound`
so it maps to the same transcript message the drawer derives context from. A real respondent's
transcript read omits the field entirely.

**The dump's objectives come from the server.** Either route loads the version's **goal, audience,
selection strategy, and tone/persona** by session id (`buildObjectivesContext`), so the
questionnaire objectives can't be spoofed and are present even though the dump doesn't carry them.

## Pieces

| Concern                                                                               | Location                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Output contract (hybrid Zod + JSON-schema, `validateTurnEvaluation`, retry msg)       | `lib/app/questionnaire/turn-evaluation/schema.ts`                                                                   |
| Input types (`TurnEvaluationInput`, `TurnEvaluationContext`)                          | `lib/app/questionnaire/turn-evaluation/types.ts`                                                                    |
| Prompt builder (system rubric + serialized dump + context)                            | `lib/app/questionnaire/turn-evaluation/prompt.ts`                                                                   |
| Markdown serializer (shared by Copy + Download)                                       | `lib/app/questionnaire/turn-evaluation/serialize.ts`                                                                |
| Service (`evaluateTurn` — resolve binding → `runStructuredCompletion` → cost log)     | `lib/app/questionnaire/turn-evaluation/evaluate-turn.ts`                                                            |
| Inspector dump Zod schema (shared by live + saved paths)                              | `lib/app/questionnaire/inspector/schema.ts`                                                                         |
| Shared evaluator seam (agent load + objectives projection)                            | `app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-context.ts`                                             |
| Route — live (`POST …/questionnaire-sessions/:id/evaluate-turn`)                      | `app/api/v1/app/questionnaire-sessions/[id]/evaluate-turn/route.ts`                                                 |
| Route — saved (`POST …/questionnaire-sessions/:id/turns/:ordinal/evaluate-saved`)     | `app/api/v1/app/questionnaire-sessions/[id]/turns/[ordinal]/evaluate-saved/route.ts`                                |
| Saved-trace orchestration (`runSavedTurnEvaluation`)                                  | `app/api/v1/app/questionnaire-sessions/_lib/evaluate-saved-turn.ts`                                                 |
| Ref lookup (`GET …/turn-evaluations/by-ref/:ref`) + read model (`lookupSessionByRef`) | `app/api/v1/app/turn-evaluations/by-ref/[ref]/route.ts` · `_lib/turn-evaluation-list.ts`                            |
| Ref lookup + re-evaluate UI panel                                                     | `components/admin/questionnaires/ref-lookup-panel.tsx`                                                              |
| Prisma model (`AppQuestionnaireTurnEvaluation`)                                       | `prisma/schema/app-questionnaire.prisma`                                                                            |
| Persistence store (create / review-update / learning-action)                          | `app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store.ts`                                               |
| Search read model (list + detail, version enrichment)                                 | `app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list.ts`                                                |
| Review route (`PATCH …/evaluations/:evalId` — comment + flag)                         | `app/api/v1/app/questionnaire-sessions/[id]/evaluations/[evalId]/route.ts`                                          |
| Learning-action route (`POST …/evaluations/:evalId/action-learning`)                  | `app/api/v1/app/questionnaire-sessions/[id]/evaluations/[evalId]/action-learning/route.ts`                          |
| Search API (`GET …/turn-evaluations`, `GET …/turn-evaluations/:id`)                   | `app/api/v1/app/turn-evaluations/`                                                                                  |
| Admin search surface (table + filters + detail drawer + review)                       | `app/admin/questionnaires/turn-evaluations/page.tsx` · `components/admin/questionnaires/turn-evaluations-table.tsx` |
| Shared verdict + review components (drawer + admin reuse)                             | `components/app/questionnaire/turn-evaluation/`                                                                     |
| Drawer UI (Evaluate button + verdict + inline review)                                 | `components/app/questionnaire/chat/turn-inspector-drawer.tsx`                                                       |
| Evaluator agent seed (`turn-evaluator`, `kind: 'judge'`)                              | `prisma/seeds/app-questionnaire/043-turn-evaluator-agent.ts`                                                        |

It deliberately reuses the F5.1 design-evaluation machinery: `runStructuredCompletion`
(call → parse → retry-once-at-temp-0 → cost-sum) from `lib/orchestration/evaluations/parse-structured.ts`,
`resolveAgentProviderAndModel` (empty binding → system default, `reasoning` tier), and the
seeded-judge pattern. It is a **plain service**, not a `BaseCapability` — a single call from one route
has no fan-out or dispatcher reuse to justify the registry weight.

## Output shape (hybrid)

Headline scores/ratings are typed/enum'd (renderable as chips, trendable later); each prose section
is a bounded markdown string (robust to validate). Top level: `overallScore` (0–100),
`effectiveness`, per-`calls[]` evaluation, `interviewer` 1–10 sub-scores + `violations`,
`extraction`, `questionSelection`, `informationGain`, `missedOpportunities`, `promptDrift`,
`efficiency`, and `summary`. See `schema.ts` for the full contract.

The verdict renders in the drawer as a stat header + interviewer sub-score grid + the full markdown
body. **Copy** and **Download** (`turn-{n}-evaluation.md`) both emit the exact string from
`serializeTurnEvaluation` — one source of truth, identical to the on-screen body.

## Honesty rules (in the prompt)

The system rubric is load-bearing and lives in code (`prompt.ts`), not the agent's
`systemInstructions` (which exist only so the agent is self-describing in the admin UI). It instructs
the evaluator to:

- evaluate **only the calls present in the dump** — never invent a stage that didn't run (a
  deterministic selection strategy fires no selector LLM; sub-features may be off);
- treat embedding (VEC) calls as retrieval (cost/relevance only, no instruction-compliance scoring);
- **compare each output against the prompt that produced it**, never judge from outputs alone;
- evaluate on what context exists and note gaps, rather than fabricate objectives.

## Persistence (the stored verdict)

`AppQuestionnaireTurnEvaluation` is the durable record of one verdict. Written by
`persistTurnEvaluation` (the store) from the evaluate-turn route after a successful judge call.

- **Snapshot, not just score:** `verdict` (the full `TurnEvaluation`) **and** `evaluatedInput`
  (`{ turn, context }`) are both stored, because the inspector data is otherwise live-only.
- **Denormalised search facets:** `overallScore`, `effectiveness`, `evaluatorModel`, `flagStatus`,
  `questionnaireVersionId`, `createdAt` are real columns so the search surface filters/sorts without
  touching the verdict JSON.
- **Multi-dimensional version stamp:** `evaluatorModel`/`evaluatorProvider` (which model judged),
  `rubricVersion` (`prompt.ts` `TURN_RUBRIC_VERSION` — **bump it whenever the rubric changes**; a
  score is meaningless without the rubric that produced it), `questionnaireVersionId` (the authored
  structure the turn ran against), and `appVersion` (the fork build).
- **History is kept:** no unique on `turnId`, so re-runs and different evaluator models accumulate.
- **Turn back-link:** best-effort `turnId` to the persisted `AppQuestionnaireTurn` (inspector
  `turnIndex` is 0-based → turn `ordinal` is 1-based); `null` when no turn row exists.
- **FK posture (UG-1):** only `session` is a modelled relation (it owns the cascade — deleting a
  preview session removes its evaluations). Everything else (`turnId`, user ids, dataset ids) is a
  plain String validated at the seam.

## Human review & the learning flag

Each stored verdict carries a free-text reviewer `comment` and a learning-flag workflow:

```
none → flagged → reviewed → actioned | dismissed
```

- **Review PATCH** (`…/evaluations/:evalId`) sets the comment and/or moves the flag among
  `none | flagged | reviewed | dismissed`, stamping reviewer + timestamp on whichever facet changed.
  `actioned` is **not** settable here, and the store refuses to re-flag an already-actioned row (409).
- **`actioned` is reached only via the learning-action route** (below), which appends a dataset
  case first, then claims the flip with a conditional `updateMany` (`flagStatus != 'actioned'`) so a
  concurrent re-action is rejected (409) rather than double-stamping the row. The append and the
  flip are two writes, not a transaction — best-effort, not a hard guarantee: under genuinely
  simultaneous requests, or a crash between the two writes, a duplicate case can land. Acceptable
  for the admin, single-click surface.

## Learning datasets (wiring)

Actioning a flagged verdict appends it to an eval dataset as a learning case, via the platform
`appendCasesToDataset` seam (`POST …/evaluations/:evalId/action-learning` `{ datasetId }`):

- **Case framing:** `input` = the respondent message that opened the turn, `expectedOutput` = the
  judged interviewer reply (the exemplar — the verdict + comment say whether it's positive or
  negative), `metadata` = `{ source: 'flagged_turn', evaluationId, overallScore, effectiveness,
rubricVersion, questionnaireVersionId, flaggedByUserId, reviewerComment? }`.
- **No platform edit:** provenance rides in case **metadata** (the dataset `source` enum is
  platform-owned); the row records the resulting `datasetId` + `datasetCaseId`.
- **Context source:** the case needs a respondent message in the snapshot's `context`. The inspector
  drawer derives it from the live conversation — for a given turn it walks the message list to the
  matching respondent message + the interviewer reply that followed (a robust walk, so a leading
  agent greeting can't misalign it) and POSTs them alongside the dump, so the snapshot carries the
  context the action needs. A verdict with no respondent message still actions cleanly as a `422
no_content`.

## Search surface (admin)

`GET /api/v1/app/turn-evaluations` — paginated, filterable (flagStatus, effectiveness,
questionnaireVersionId, model substring, score range, date range), sortable (createdAt | overallScore).
Each page is enriched with the questionnaire title + version number in a **fixed query budget** (one
batched join — `questionnaireVersionId` is a plain String, not a relation). `GET …/:id` returns the
full verdict + snapshot + review state. The admin page (`/admin/questionnaires/turn-evaluations`)
renders the table with a slide-over detail that shows the verdict (shared `TurnEvaluationVerdict`) and
the review controls (shared `TurnEvaluationReview`) — the same controls the inspector drawer uses
inline once a verdict has persisted.

## Re-evaluate a chat by reference

Every session carries a short **support reference** (`AppQuestionnaireSession.publicRef`, e.g.
`7F3K-9M2P`) shown to the respondent (chat footer + completion screen — `lib/app/questionnaire/session-ref.ts`,
`components/app/questionnaire/lifecycle/session-ref-chip.tsx`). When a respondent reports a bad
experience and quotes it:

1. **Look it up** — `GET /api/v1/app/turn-evaluations/by-ref/:ref` (admin) resolves the
   forgivingly-normalised reference to the session and its turns, each carrying the **full**
   respondent/interviewer messages (not truncated previews), the complete saved **call trace**
   (`RefLookupTurn.calls: AgentCallTrace[]` — validated at the read seam against
   `inspector/schema.ts`), `hasTraces` (is a dump present?), and how many verdicts it already has.
   The admin surface (`/admin/questionnaires/turn-evaluations`) renders this as a lookup panel; each
   turn has a **Show raw calls** toggle that expands the shared `DiagnosticsInspectorCalls` renderer
   (`components/admin/questionnaires/diagnostics/inspector-calls.tsx`) to reveal every call's raw
   prompt + response — the same view the Diagnostics deep-dive and the preview drawer show.
2. **Re-evaluate a turn** — `POST …/questionnaire-sessions/:id/turns/:ordinal/evaluate-saved`
   (admin, **not** preview-gated) loads that turn's saved `inspectorCalls`, validates them, rebuilds
   the context from the saved respondent/interviewer messages + prior turns, runs the evaluator, and
   persists the verdict — which then appears in the search surface like any other. `no_traces` (422)
   when the turn predates the capture column or its dump is malformed.

This is the payoff of persisting traces for all sessions: a real conversation, not just a preview,
can be judged after the fact against the exact calls it made.

## Gating & limits

- **Always on:** turn evaluation is a permanent capability — there is no flag to check and no route
  that 404s when off.
- **Preview-only:** the route 404s unless the session is a preview — the same gate the
  inspector that produces the dump enforces, so it can only run where the inspector runs.
- **Auth:** `withAdminAuth` (admin session cookie; no `X-Session-Token` needed).
- **Rate limit:** `turnEvaluationLimiter` (20/min per admin) in `questionnaire-sessions/_lib/rate-limit.ts`
  — the expensive-sub-flow sub-cap on top of the section 100/min.
- **Cost:** logged fire-and-forget via `logCost` with `{ capability: 'turn-evaluation', sessionId, turnIndex }`.
- **Review / search / action / ref-lookup routes** share `withAdminAuth`. They are reads / cheap
  writes, so they inherit the section 100/min cap with
  no extra sub-cap. The **saved-turn evaluation** route is a paid reasoning call, so it takes the
  same per-admin `turnEvaluationLimiter` (20/min) as the live evaluator — but it is **not**
  preview-gated (re-evaluating a real chat by ref is the whole point).

## Try it

1. `npm run db:seed`.
2. Start an admin **Preview as respondent** session with the inspector toggle on; complete a turn.
3. Open the Inspector drawer → expand a turn → **Evaluate turn** → read the scored verdict; **Copy**
   or **Download** the Markdown. Add a reviewer comment and **flag for learning** inline.
4. Open **Admin → Questionnaires → Turn evaluations** to search every stored verdict, filter by score
   / effectiveness / model / flag, open one for the full verdict, and action a flagged one into an
   eval dataset.
