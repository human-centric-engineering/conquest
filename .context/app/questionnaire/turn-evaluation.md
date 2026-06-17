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

**Inspector data is live-only and never persisted.** The server streams `inspector` SSE frames
(full `TurnInspectorData` dumps) only for an admin **preview** session with the inspector toggle on;
the client holds them in `inspectorTurns` state and the drawer renders them. So the evaluator's
input — "a complete Turn Inspector dump" — already exists client-side. The flow is therefore:

```
drawer "Evaluate" button → POST the turn dump → route → one structured LLM call → persist + verdict back to the drawer
```

No prompt reconstruction. **The verdict IS persisted** (`AppQuestionnaireTurnEvaluation`) — see
[Persistence](#persistence-the-stored-verdict). Because the inspector dump it judges is otherwise
live-only, the row snapshots **both** the verdict and the `evaluatedInput` (the exact call traces +
context that were judged): a stored score is uninterpretable without the input it judged, and the
snapshot is what later makes a flagged verdict usable as a learning case. Persistence is best-effort
— a write failure logs and returns a `null` `evaluationId` rather than losing the verdict the admin
is waiting on.

**The dump comes from the client; the objectives come from the server.** The client POSTs the call
traces (validated with Zod — external data, never `as`). The route separately loads the version's
**goal, audience, selection strategy, and tone/persona** by session id, so the questionnaire
objectives can't be spoofed and are present even though the dump doesn't carry them.

## Pieces

| Concern                                                                           | Location                                                                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Output contract (hybrid Zod + JSON-schema, `validateTurnEvaluation`, retry msg)   | `lib/app/questionnaire/turn-evaluation/schema.ts`                                                                   |
| Input types (`TurnEvaluationInput`, `TurnEvaluationContext`)                      | `lib/app/questionnaire/turn-evaluation/types.ts`                                                                    |
| Prompt builder (system rubric + serialized dump + context)                        | `lib/app/questionnaire/turn-evaluation/prompt.ts`                                                                   |
| Markdown serializer (shared by Copy + Download)                                   | `lib/app/questionnaire/turn-evaluation/serialize.ts`                                                                |
| Service (`evaluateTurn` — resolve binding → `runStructuredCompletion` → cost log) | `lib/app/questionnaire/turn-evaluation/evaluate-turn.ts`                                                            |
| Route (`POST …/questionnaire-sessions/:id/evaluate-turn`)                         | `app/api/v1/app/questionnaire-sessions/[id]/evaluate-turn/route.ts`                                                 |
| Prisma model (`AppQuestionnaireTurnEvaluation`)                                   | `prisma/schema/app-questionnaire.prisma`                                                                            |
| Persistence store (create / review-update / learning-action)                      | `app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store.ts`                                               |
| Search read model (list + detail, version enrichment)                             | `app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list.ts`                                                |
| Review route (`PATCH …/evaluations/:evalId` — comment + flag)                     | `app/api/v1/app/questionnaire-sessions/[id]/evaluations/[evalId]/route.ts`                                          |
| Learning-action route (`POST …/evaluations/:evalId/action-learning`)              | `app/api/v1/app/questionnaire-sessions/[id]/evaluations/[evalId]/action-learning/route.ts`                          |
| Search API (`GET …/turn-evaluations`, `GET …/turn-evaluations/:id`)               | `app/api/v1/app/turn-evaluations/`                                                                                  |
| Admin search surface (table + filters + detail drawer + review)                   | `app/admin/questionnaires/turn-evaluations/page.tsx` · `components/admin/questionnaires/turn-evaluations-table.tsx` |
| Shared verdict + review components (drawer + admin reuse)                         | `components/app/questionnaire/turn-evaluation/`                                                                     |
| Drawer UI (Evaluate button + verdict + inline review)                             | `components/app/questionnaire/chat/turn-inspector-drawer.tsx`                                                       |
| Evaluator agent seed (`turn-evaluator`, `kind: 'judge'`)                          | `prisma/seeds/app-questionnaire/043-turn-evaluator-agent.ts`                                                        |
| Sub-flag seed (disabled by default)                                               | `prisma/seeds/app-questionnaire/042-turn-evaluation-flag.ts`                                                        |

It deliberately reuses the F5.1 design-evaluation machinery: `runStructuredCompletion`
(call → parse → retry-once-at-temp-0 → cost-sum) from `lib/orchestration/evaluations/parse-structured.ts`,
`resolveAgentProviderAndModel` (empty binding → system default, `reasoning` tier), and the seeded-judge

- sub-flag pattern. It is a **plain service**, not a `BaseCapability` — a single call from one route
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
- **`actioned` is reached only via the learning-action route** (below), which must append a dataset
  case first — so an actioned row is always backed by a real learning case.

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

## Gating & limits

- **Flag:** `APP_QUESTIONNAIRES_TURN_EVALUATION_ENABLED` (a `feature_flag` row, **not** an env var),
  disabled by default. ANDed with the master `APP_QUESTIONNAIRES_ENABLED` by `isTurnEvaluationEnabled()`.
  Off → the route 404s (looks like a missing route), via `withTurnEvaluationEnabled` (gate before auth).
- **Preview-only:** the route additionally 404s unless the session is a preview — the same gate the
  inspector that produces the dump enforces, so it can only run where the inspector runs.
- **Auth:** `withAdminAuth` (admin session cookie; no `X-Session-Token` needed).
- **Rate limit:** `turnEvaluationLimiter` (20/min per admin) in `questionnaire-sessions/_lib/rate-limit.ts`
  — the expensive-sub-flow sub-cap on top of the section 100/min.
- **Cost:** logged fire-and-forget via `logCost` with `{ capability: 'turn-evaluation', sessionId, turnIndex }`.
- **Review / search / action routes** share the same flag + `withAdminAuth` (all 404 when the flag is
  off). They are reads / cheap writes, so they inherit the section 100/min cap with no extra sub-cap.

## Try it

1. `npm run db:seed`; enable the flag (`APP_QUESTIONNAIRES_TURN_EVALUATION_ENABLED`).
2. Start an admin **Preview as respondent** session with the inspector toggle on; complete a turn.
3. Open the Inspector drawer → expand a turn → **Evaluate turn** → read the scored verdict; **Copy**
   or **Download** the Markdown. Add a reviewer comment and **flag for learning** inline.
4. Open **Admin → Questionnaires → Turn evaluations** to search every stored verdict, filter by score
   / effectiveness / model / flag, open one for the full verdict, and action a flagged one into an
   eval dataset.
