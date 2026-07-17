# Reasoning stream — "watch it think" (demo feature)

The reasoning stream surfaces the per-turn orchestrator's work — answers captured (with
provenance + confidence), contradictions spotted, earlier answers refined, and **why the next
question was chosen** — as a brand-themed disclosure above each assistant turn in the respondent
chat. It is the clearest "this is an agent, not a form" signal in the demo, and it costs **no extra
LLM call**: the trace is derived from work the turn already did.

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
   steps); the hook attaches the steps onto the committed assistant turn (it does not surface them
   separately during streaming — the in-flight turn just shows the calm thinking dots).
4. **Render.** `components/app/questionnaire/chat/reasoning-trace.tsx` is a single "Reasoning · N"
   chip above each assistant turn that expands to the rows with an animated (CSS grid-rows) collapse.
   The placement setting drives only how it _starts_: **Animated** (`overlay`) passes `autoReveal`
   on the **newest** turn — it mounts open, holds for a **dwell that scales with the step count**,
   then animates closed over `AUTO_REVEAL_COLLAPSE_MS` (300 ms); **Inline** mounts every turn closed
   (opens on click). Older/historical turns and resumed transcripts always mount closed, so a reload
   never flashes every section open. The dwell is `computeReasoningDwellMs(steps, baseMs, perItemMs)`
   = `baseMs + max(0, steps − 2) * perItemMs` — `baseMs`/`perItemMs` are admin-tunable per version
   (`reasoningStreamDwellMs` default 2000, `reasoningStreamPerItemMs` default 750), so a longer
   summary stays open long enough to read. Under **Animated**, `questionnaire-chat.tsx` also **holds
   the reply back** (`reasoningHoldMs = dwell + collapse`) so the next question doesn't start typing
   until the reasoning summary has finished tucking away — the trace reads first, _then_ the question
   appears. The hold applies only when the newest turn actually has steps (no trace ⇒ no dead air).
   The two timing values are resolved server-side and threaded to the surface: the authenticated page
   reads them off the config row (`detail.ts` / `session-surface-config.ts`); the no-login page calls
   `resolveReasoningDwellForVersion`.
5. **Persist (optional).** When the version opts in (`reasoningStreamPersist`), the trace is written
   to `AppQuestionnaireTurn.reasoning` (mirrors the `warnings` column) and replayed on resume /
   scroll-back via `loadTranscript`. Off → current-turn-only (resumed turns show nothing).

## Respondent-safe by construction

The builder **never** surfaces the seriousness/abuse verdict or the sensitivity disclosure summary
(the abuse reason would be accusatory; the sensitivity summary is PII-guarded everywhere else). An
abuse-abandoned turn produces **no** trace at all. The sensitivity/seriousness signals continue to
flow through their existing side-band notices, unchanged.

## Gating

The reasoning stream is **always on** — there is no platform flag. Whether it shows, and how, is
governed entirely by the **per-version config** on the **Settings** tab (`config-editor.tsx`):

- `reasoningStreamEnabled` (default **on**) — show the trace at all.
  - `reasoningStreamPlacement` — `overlay` (default; UI label **"Animated"** — newest turn opens
    then animates closed) or `inline` (quiet disclosure, opens on click only). The enum value
    `overlay` is retained for config compatibility even though the UI now reads "Animated".
  - `reasoningStreamDwellMs` (default **2000**) — "Animated" base dwell (ms) for a trace of up to two
    steps; the inputs show only when placement is "Animated".
  - `reasoningStreamPerItemMs` (default **750**) — extra dwell (ms) per step beyond two.
  - `reasoningStreamPersist` (default **on**) — replay on resume + admin trace later.

The pages (`app/(protected)/questionnaires/[sessionId]`, `app/(public)/q/[versionId]` via
`AnonymousSessionBoot`) resolve the effective placement server-side from the version config and pass
it through `SessionWorkspace` → `QuestionnaireChat`; absent ⇒ no trace.

## Files

| Concern                           | Path                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Pure builder + types              | `lib/app/questionnaire/reasoning/`                                                             |
| Selection rationale on the result | `lib/app/questionnaire/orchestrator/{orchestrator,data-slot-orchestrator}.ts`                  |
| SSE emit                          | `app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`                                 |
| Wire narrow                       | `lib/app/questionnaire/chat/parse-session-event.ts`                                            |
| Persist / replay                  | `_lib/turns.ts`, `_lib/turn-run.ts`, `_lib/transcript.ts`                                      |
| Client hook                       | `lib/hooks/use-questionnaire-session-stream.ts` (attaches `reasoning` onto the committed turn) |
| UI                                | `components/app/questionnaire/chat/reasoning-trace.tsx`, `questionnaire-chat.tsx`              |
| Dwell resolve (no-login)          | `lib/app/questionnaire/chat/anonymity.ts` (`resolveReasoningDwellForVersion`)                  |
| Config                            | `authoring/config-schema.ts`, `types.ts` (`REASONING_PLACEMENTS`)                              |

Migrations: `20260615094314_reasoning_stream` (additive — 3 config columns + `reasoning` on the
turn) and `20260619080504_app_questionnaire_reasoning_dwell_config` (additive — the two
`reasoningStream{Dwell,PerItem}Ms` "Animated" timing columns, defaults 2000 / 750). No new models.
