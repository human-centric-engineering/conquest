# Seriousness / abuse gate

Per answered turn, the gate judges whether a respondent's answer is a **genuine attempt**.
Non-genuine answers (preposterous, abusive, off-topic — e.g. "**543 years**" of tenure) are
**disregarded** (never persisted), **strike** the session, escalate a polite warning, and at the
questionnaire's `abuseThreshold` **abandon** the session. Colloquial / lazy / brief answers
("very unlikely", "prefer not to say") are tolerated. Mirrors contradiction detection (F4.3)
end-to-end: a per-turn judge whose result becomes a `warning` SSE frame, gated by a platform
flag + a per-questionnaire config knob, rendered as a side-band notice.

## Two-stage design (cost-efficient)

1. **Suspicion (the "main agent")** — the **answer-extractor** capability
   (`lib/app/questionnaire/capabilities/extract-answer-slots.ts`), the pass that already reads the
   answer, also emits `suspectedNonGenuine` (+ `suspicionReason`) — **no extra LLM call**. Its
   prompt is tolerant: only abuse / absurd-or-impossible / gibberish / off-topic trip the flag.
2. **Judge (only on suspicion)** — when stage 1 flags suspicion AND the gate is on AND
   `abuseThreshold > 0`, the orchestrator calls `invokers.assessSeriousness` — a direct structured
   LLM call (`app/api/v1/app/questionnaire-sessions/_lib/turn-invokers.ts`) reusing the
   extractor's provider/model binding — returning a `{ serious, reason }` verdict
   (`lib/app/questionnaire/seriousness/`). Fail-soft: a null verdict skips the gate.

The judge runs **at most once per turn, only when suspected** → near-zero cost on normal turns.

## On a NOT-serious verdict (pure orchestrator, `orchestrator.ts`)

- **Disregard** — clear the turn's `answerUpserts`; the answer is never merged or persisted.
- **Strike** — `evaluateAbuseStrike(state.abuseStrikes, threshold)` (`seriousness/seriousness-logic.ts`).
- **Below threshold** — emit a `warning` (`code: 'seriousness'`) with escalating copy (gentle →
  firm); because the answer wasn't merged, selection **re-asks the same still-unanswered question**.
  Rendered by `SeriousnessNotice` above the re-asked question.
- **At/over threshold** — `result.abuse.abandon = true` + a deterministic polite final message;
  the pure core skips detect/refine/select.

`runTurn` stays pure: it reads `state.abuseStrikes`, returns
`result.abuse = { flagged, newStrikeCount, abandon, reason }`; the **route does the I/O**.

## Route (`…/questionnaire-sessions/[id]/messages/route.ts`)

After the reply streams + `persistTurn`: when `result.abuse?.flagged`, `persistAbuseStrikes()`;
when `abandon`, `abandonSession(sessionId, { reason: 'abuse_threshold_exceeded', metadata })`
(status → `abandoned`). The lifecycle status poll then locks the composer (`abandoned` →
`not_active`) and every later turn 409s. `seriousnessGate` is forced off on a kickoff turn.

## Config & gating

- **Platform flag** `APP_QUESTIONNAIRES_SERIOUSNESS_GATE_ENABLED` — dark-launch, default off
  (`isSeriousnessGateEnabled()`; requires master + live-sessions flags). Seeded by
  `prisma/seeds/app-questionnaire/029-seriousness-gate-flag.ts`.
- **Per-questionnaire** `AppQuestionnaireConfig.abuseThreshold` (Int, default **4**; **0 = off**) —
  non-genuine answers tolerated before abandon. Edited in the config editor ("Abuse threshold").
  Escalation at the default: strikes 1–3 warn (firming up), the 4th abandons.
- **Per-session** `AppQuestionnaireSession.abuseStrikes` (Int, default 0) — the strike counter.

## Analytics

Abandonment writes an `app_questionnaire_session_event` with `eventType: 'abandoned'`,
`reason: 'abuse_threshold_exceeded'`, and `metadata: { strikes, threshold, judgeReason }`. Filter
session-outcome analytics on that `reason` to count abuse-driven abandonments
(`ABUSE_ABANDON_REASON` in `lib/app/questionnaire/types.ts` is the single source of truth).

## Not in scope / limitations

- **Data-slot mode** (`runDataSlotTurn`) does not yet run the gate — it's inert there (question
  mode is the gated path).
- The judge piggybacks on extraction's suspicion flag; with **answer extraction off** the gate is
  inert (no suspicion signal). A real questionnaire runs extraction.
- Mid-stream the composer locks on the next status poll (a beat after the final message), backed
  by the 409 status gate — no separate terminal SSE frame.

## Files

Pure core: `lib/app/questionnaire/seriousness/**`, `orchestrator/{orchestrator,types}.ts`,
`types.ts` (`abuseThreshold`, `ABUSE_ABANDON_REASON`). Capability/suspicion:
`capabilities/extract-answer-slots.ts`, `extraction/extraction-{schema,prompt}.ts`. Route seam:
`turn-invokers.ts`, `turn-context.ts`, `messages/route.ts`, `feature-flag.ts`,
`authoring/config-schema.ts`, `_lib/{detail,sessions}.ts`. UI:
`components/admin/questionnaires/config-editor.tsx`,
`components/app/questionnaire/chat/{seriousness-notice,questionnaire-chat}.tsx`.
