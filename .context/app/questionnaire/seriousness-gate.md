# Seriousness / abuse gate

Per answered turn, the gate judges whether a respondent's answer is a **genuine attempt**.
Non-genuine answers (preposterous, abusive, off-topic — e.g. "**543 years**" of tenure) are
**disregarded** (never persisted), **strike** the session, escalate a polite warning, and at the
questionnaire's `abuseThreshold` **abandon** the session. Colloquial / lazy / brief answers
("very unlikely", "prefer not to say") are tolerated. Mirrors contradiction detection (F4.3)
end-to-end: a per-turn judge whose result becomes a `warning` SSE frame, gated by a platform
flag + a per-questionnaire config knob, rendered as a side-band notice.

## The judge

The **judge** (`invokers.assessSeriousness`, a direct structured LLM call in
`app/api/v1/app/questionnaire-sessions/_lib/turn-invokers.ts` reusing the answer-extractor's
provider/model binding) runs on **every answered turn** while the gate is on AND
`abuseThreshold > 0`, returning a `{ serious, reason }` verdict (`lib/app/questionnaire/seriousness/`).
It's a cheap (~$0.0001) gpt-4o-mini-tier call. Fail-soft: a null verdict skips the gate.

> **History / why not "only on suspicion".** The first design was two-stage to save cost: the
> answer-extractor also emitted a `suspectedNonGenuine` hint and the judge ran only when it was
> set. In practice that optional flag was unreliable — the model omitted it even for blatant abuse
> ("543 years", "you're shit"), so the judge never fired. The extractor still emits the hint (for
> trace) but it **no longer gates** the judge; running the (cheap) judge every answered turn is the
> reliable path.

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

Both orchestrators run the gate: question mode (`runTurn`) and **data-slot mode**
(`runDataSlotTurn`). In data-slot mode a non-serious verdict disregards both the background
question answers and the data-slot fills for that turn.

## Not in scope / limitations

- The gate needs answer extraction on only to merge real answers; the judge itself runs
  independently of the extractor's suspicion hint, so it fires even when extraction fails on an
  abusive message.
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
