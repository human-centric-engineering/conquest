# Reasoning stream — "watch it think" (demo feature)

The live reasoning stream surfaces the per-turn orchestrator's work — answers captured (with
provenance + confidence), contradictions spotted, earlier answers refined, and **why the next
question was chosen** — as a brand-themed feed beside the respondent chat. It is the clearest
"this is an agent, not a form" signal in the demo, and it costs **no extra LLM call**: the trace is
derived from work the turn already did.

`// DEMO-ONLY:` a sales-demo surface. A fork that drops the demo respondent experience drops this
with it (the pure builder and the config columns are harmless if left).

## How it works

1. **Build (pure).** After `runTurn` / `runDataSlotTurn` returns its `TurnResult`, the route calls
   `buildReasoningTrace(result, { questions, dataSlots?, isOpening })`
   (`lib/app/questionnaire/reasoning/`). It maps the result to a short, respondent-safe
   `ReasoningStep[]` in pipeline order: **extraction → contradiction → refinement → completion →
   selection**. Pure, DB-free, unit-tested.
2. **Selection rationale.** The "why this next" line is the selector's `rationale`, lifted onto
   `TurnResult.selectionRationale` (otherwise consumed and dropped) by the orchestrators. The
   builder phrases it per strategy — `adaptive` uses the LLM's real sentence verbatim; the
   deterministic strategies and data-slot mode get friendly canned copy.
3. **Stream.** The route emits a single `{ type: 'reasoning', steps: ReasoningStep[] }` SSE frame
   **before** the reply content. `parseSessionEvent` narrows it client-side (dropping malformed
   steps); the client reveals the steps staggered.
4. **Render.** `components/app/questionnaire/chat/reasoning-trace.tsx` — `live` variant (overlay
   placement) animates the steps in while the turn streams, then the steps collapse onto the
   settled turn; `collapsed` variant is a "Reasoning · N" chip beneath each turn (inline placement,
   and the history view for both).
5. **Persist (optional).** When the version opts in (`reasoningStreamPersist`), the trace is written
   to `AppQuestionnaireTurn.reasoning` (mirrors the `warnings` column) and replayed on resume /
   scroll-back via `loadTranscript`. Off → live-only (resumed turns show nothing).

## Respondent-safe by construction

The builder **never** surfaces the seriousness/abuse verdict or the sensitivity disclosure summary
(the abuse reason would be accusatory; the sensitivity summary is PII-guarded everywhere else). An
abuse-abandoned turn produces **no** trace at all. The sensitivity/seriousness signals continue to
flow through their existing side-band notices, unchanged.

## Gating

Two gates, ANDed (like cost-cap / seriousness):

- **Platform flag** `APP_QUESTIONNAIRES_REASONING_STREAM_ENABLED` (DB-backed feature_flag row, seed
  `039`, off by default) → `isReasoningStreamEnabled()` (requires the master app flag + live-sessions
  too). See [[feature-flags-are-db-rows]].
- **Per-version config** on the **Settings** tab (`config-editor.tsx`):
  - `reasoningStreamEnabled` (default **on**) — show the feed at all.
  - `reasoningStreamPlacement` — `overlay` (default; live drama then collapse) or `inline` (quiet
    disclosure only).
  - `reasoningStreamPersist` (default **on**) — replay on resume + admin trace later.

The pages (`app/(protected)/questionnaires/[sessionId]`, `app/(public)/q/[versionId]` via
`AnonymousSessionBoot`) resolve the effective placement server-side (platform flag AND version
toggle) and pass it through `SessionWorkspace` → `QuestionnaireChat`; absent ⇒ no trace.

## Files

| Concern                           | Path                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Pure builder + types              | `lib/app/questionnaire/reasoning/`                                                               |
| Selection rationale on the result | `lib/app/questionnaire/orchestrator/{orchestrator,data-slot-orchestrator}.ts`                    |
| SSE emit                          | `app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`                                   |
| Wire narrow                       | `lib/app/questionnaire/chat/parse-session-event.ts`                                              |
| Persist / replay                  | `_lib/turns.ts`, `_lib/turn-run.ts`, `_lib/transcript.ts`                                        |
| Client hook                       | `lib/hooks/use-questionnaire-session-stream.ts` (`streamingReasoning`)                           |
| UI                                | `components/app/questionnaire/chat/reasoning-trace.tsx`, `questionnaire-chat.tsx`                |
| Config / flag                     | `authoring/config-schema.ts`, `types.ts` (`REASONING_PLACEMENTS`), `feature-flag.ts`, seed `039` |

Migration: `20260615094314_reasoning_stream` — additive only (3 config columns + `reasoning` on the
turn). No new models.
