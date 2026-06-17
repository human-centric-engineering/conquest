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
drawer "Evaluate" button → POST the turn dump → route → one structured LLM call → verdict back to the drawer
```

No persistence, no prompt reconstruction. The verdict is **ephemeral** (rendered in the drawer,
copied or downloaded by the admin) — mirroring the live-only nature of the data it judges.

**The dump comes from the client; the objectives come from the server.** The client POSTs the call
traces (validated with Zod — external data, never `as`). The route separately loads the version's
**goal, audience, selection strategy, and tone/persona** by session id, so the questionnaire
objectives can't be spoofed and are present even though the dump doesn't carry them.

## Pieces

| Concern                                                                           | Location                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Output contract (hybrid Zod + JSON-schema, `validateTurnEvaluation`, retry msg)   | `lib/app/questionnaire/turn-evaluation/schema.ts`                   |
| Input types (`TurnEvaluationInput`, `TurnEvaluationContext`)                      | `lib/app/questionnaire/turn-evaluation/types.ts`                    |
| Prompt builder (system rubric + serialized dump + context)                        | `lib/app/questionnaire/turn-evaluation/prompt.ts`                   |
| Markdown serializer (shared by Copy + Download)                                   | `lib/app/questionnaire/turn-evaluation/serialize.ts`                |
| Service (`evaluateTurn` — resolve binding → `runStructuredCompletion` → cost log) | `lib/app/questionnaire/turn-evaluation/evaluate-turn.ts`            |
| Route (`POST …/questionnaire-sessions/:id/evaluate-turn`)                         | `app/api/v1/app/questionnaire-sessions/[id]/evaluate-turn/route.ts` |
| Drawer UI (Evaluate button + verdict panel + Copy/Download)                       | `components/app/questionnaire/chat/turn-inspector-drawer.tsx`       |
| Evaluator agent seed (`turn-evaluator`, `kind: 'judge'`)                          | `prisma/seeds/app-questionnaire/043-turn-evaluator-agent.ts`        |
| Sub-flag seed (disabled by default)                                               | `prisma/seeds/app-questionnaire/042-turn-evaluation-flag.ts`        |

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

## Try it

1. `npm run db:seed`; enable the flag (`APP_QUESTIONNAIRES_TURN_EVALUATION_ENABLED`).
2. Start an admin **Preview as respondent** session with the inspector toggle on; complete a turn.
3. Open the Inspector drawer → expand a turn → **Evaluate turn** → read the scored verdict; **Copy**
   or **Download** the Markdown.
