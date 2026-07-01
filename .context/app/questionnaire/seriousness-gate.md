# Seriousness / abuse gate

Per answered turn, the gate judges whether a respondent's answer is a **genuine attempt**.
Non-genuine answers (preposterous, abusive, off-topic — e.g. "**543 years**" of tenure) are
**disregarded** (never persisted), **strike** the session, escalate a polite warning, and at the
questionnaire's `abuseThreshold` **abort** the session (terminal status `aborted`). Colloquial / lazy / brief answers
("very unlikely", "prefer not to say") are tolerated. Mirrors contradiction detection (F4.3)
end-to-end: a per-turn judge whose result becomes a `warning` SSE frame, gated by a platform
flag + a per-questionnaire config knob, rendered as a side-band notice.

## Two layers: a deterministic floor + the LLM judge

The gate decides "non-genuine?" in two layers, in order:

1. **Deterministic abuse floor** (`keywordAbuseFloor`, `lib/app/questionnaire/seriousness/abuse-net.ts`)
   — a SHORT message dominated by directed hostility ("oh just fuck off", "screw you", "go fuck
   yourself", "piss off") is struck **without any LLM call**. This exists because the judge is
   probabilistic: with a prior disclosure in its recent-conversation context it intermittently reads
   plain dismissals as the _distress_ of an upset respondent and returns `serious: true`, so clear
   abuse went unstruck across turns. The floor makes the obvious cases reliable. It is deliberately
   tight — only directed-dismissal phrases (never bare insults that can sit inside a genuine
   complaint like "my boss is an asshole"), and only on short messages (a hostile phrase inside a
   longer sentence — "my manager told me to fuck off" — is a _report_, left to the judge). It fires
   **even when an LLM flagged the turn sensitive** (an over-eager detector must not shield plain
   abuse) and is suppressed **only by the deterministic HARM floor** (`keywordSensitivityFloor`), so
   abuse paired with a real disclosure stays protected. A floor strike records an
   `app_assess_seriousness` tool call with no `latencyMs` (no LLM call).

2. **The judge** (`invokers.assessSeriousness`, a direct structured LLM call in
   `app/api/v1/app/questionnaire-sessions/_lib/turn-invokers.ts` reusing the answer-extractor's
   provider/model binding) runs for the nuanced cases — when the turn was **not** deterministically
   abusive **and** not flagged a genuine disclosure (`!extractedSensitivity`). It returns a
   `{ serious, reason }` verdict (`lib/app/questionnaire/seriousness/`); a cheap (~$0.0001)
   gpt-4o-mini-tier call. Fail-soft: a null verdict skips the gate.

> **History / why not "only on suspicion".** The first design was two-stage to save cost: the
> answer-extractor also emitted a `suspectedNonGenuine` hint and the judge ran only when it was
> set. In practice that optional flag was unreliable — the model omitted it even for blatant abuse
> ("543 years", "you're shit"), so the judge never fired. The extractor still emits the hint (for
> trace) but it **no longer gates** the judge; running the (cheap) judge every answered turn is the
> reliable path.

### Safeguarding precedence vs. later abuse

Two safeguards interact here. (1) When **sensitivity detection** flags a genuine disclosure _this
turn_ (`extractedSensitivity` — the merge of the extractor field, the dedicated detector, and the
keyword net; see [sensitivity awareness](./sensitivity-awareness.md)), the orchestrator **skips the
judge entirely** — a harm disclosure is by definition a real answer and must never be struck
(`orchestrator.ts`, the `!extractedSensitivity` guard, evaluated at step 1.5 after the step-1.4
merge). (2) The judge prompt has its own OVERRIDING SAFEGUARDING RULE as defense-in-depth for when
sensitivity awareness is off.

But the judge **scopes that rule to the message it is ruling on**. A disclosure on an _earlier_
turn does **not** grant blanket immunity to _later_ messages: pure hostility / profanity aimed at
the interviewer with no new disclosure or substantive content (e.g. "go fuck yourself" two turns
after "I am being abused by my manager") is still **ABUSIVE** and is struck. The recent
conversation is context for reading the message, not a reason to keep it. Venting that carries
content or a fresh disclosure ("I'm still being bullied and I'm furious") stays genuine. Note that
the persisted `sensitivityLevel` still keeps the **phraser** in a warm/careful tone for the rest of
the session — tone-softening and the strike decision are independent.

### A contradiction is not a sincerity failure

The judge rules on whether **this** answer is genuine on its own — **never** on whether it is
consistent with earlier answers. A later answer that contradicts or reverses an earlier one ("I
hate my job" on one turn, "I love my job" on the next) is genuine and must be **kept**; reconciling
the conflict is the [contradiction detector's](./contradiction-detection.md) job (it surfaces a
`contradiction` warning and, under `probe` mode, a reconciliation question). This is an explicit
rule in the judge prompt because the recent conversation it receives (for reading oblique messages)
otherwise tempts the model to mark a reversal as a "joke/troll" and disregard it — which both drops
a real answer **and** pre-empts the contradiction probe (the disregard sets `disregarded`, and the
per-turn detect step is guarded by `!disregarded`). The `PREPOSTEROUS / IMPOSSIBLE` category is
scoped to an answer that is impossible **on its own**, not one that is merely inconsistent with a
prior turn.

## On a NOT-serious verdict (pure orchestrator, `orchestrator.ts`)

- **Disregard** — clear the turn's `answerUpserts`; the answer is never merged or persisted.
- **Strike** — `evaluateAbuseStrike(state.abuseStrikes, threshold)` (`seriousness/seriousness-logic.ts`).
- **Below threshold** — emit a `warning` with escalating copy (gentle → firm); because the answer
  wasn't merged, selection **re-asks the same still-unanswered question**.
  The **penultimate** warning (the last one before abort, `remaining === 1`) is flagged
  `final` by `evaluateAbuseStrike` and emitted under the **distinct code `seriousness_final`**
  (earlier strikes use `seriousness`). It ends with a **bold** last-chance sentence — a blunt
  "Final warning: one more inappropriate answer and this conversation will be aborted." — that
  `warningCopy` wraps in `**…**`. `SeriousnessNotice` renders the markers as `<strong>` and, on the
  `final` variant, escalates the whole notice from the amber nudge to a **red** palette with a
  **"Final warning"** header (earlier warnings keep the amber "Let's keep it genuine" nudge).
  Rendered inline beneath the re-asked turn. The route persists the frame on the turn
  (`AppQuestionnaireTurn.warnings`), so the notice survives the next input and replays on resume
  (see `per-turn-orchestrator.md` § resume replay).
- **At/over threshold** — `result.abuse.abandon = true` + the deterministic `abuseAbortMessage(count)`
  final message ("There have now been {count} occasions … record this session as aborted.",
  singular-aware); the pure core skips detect/refine/select.

`runTurn` stays pure: it reads `state.abuseStrikes`, returns
`result.abuse = { flagged, newStrikeCount, abandon, reason }`; the **route does the I/O**.

## Route (`…/questionnaire-sessions/[id]/messages/route.ts`)

After the reply streams + `persistTurn`: when `result.abuse?.flagged`, `persistAbuseStrikes()`;
when `abandon`, `abortSession(sessionId, { reason: 'abuse_threshold_exceeded', metadata })` (status
→ **`aborted`**). `aborted` is a distinct terminal status set ONLY by the abuse gate — separate from
the admin/manual `abandoned` — so the outcome reads as "Aborted" and analytics can tell them apart.
The lifecycle status poll then locks the composer (any non-active terminal status → `not_active`)
and every later turn 409s. `seriousnessGate` is forced off on a kickoff turn.

## Config & gating

- **Platform flag** `APP_QUESTIONNAIRES_SERIOUSNESS_GATE_ENABLED` — dark-launch, default off
  (`isSeriousnessGateEnabled()`; requires master + live-sessions flags). Seeded by
  `prisma/seeds/app-questionnaire/029-seriousness-gate-flag.ts`.
- **Per-questionnaire** `AppQuestionnaireConfig.abuseThreshold` (Int, default **4**; **0 = off**) —
  non-genuine answers tolerated before abort. Edited in the config editor ("Abuse threshold").
  Escalation at the default: strikes 1–2 warn gently (amber), strike 3 is the firm bold last-chance
  warning (red `seriousness_final` notice), the 4th aborts.
- **Per-session** `AppQuestionnaireSession.abuseStrikes` (Int, default 0) — the strike counter.

## Analytics

Abort writes an `app_questionnaire_session_event` with `eventType: 'aborted'`,
`reason: 'abuse_threshold_exceeded'`, and `metadata: { strikes, threshold, judgeReason }`. The
session's terminal status is `aborted` (distinct from admin `abandoned`). The completion funnel
(`analytics/funnel.ts`) counts only `completed` as completed, so an `aborted` session is a
started-but-not-completed run — it lowers the completion rate exactly like any non-completion, and is
distinguishable from admin abandonment by status (`ABUSE_ABANDON_REASON` in
`lib/app/questionnaire/types.ts` remains the reason constant).

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

Pure core: `lib/app/questionnaire/seriousness/**` (incl. `abuse-net.ts` — the deterministic floor),
`orchestrator/{orchestrator,data-slot-orchestrator,types}.ts`,
`types.ts` (`abuseThreshold`, `ABUSE_ABANDON_REASON`). Capability/suspicion:
`capabilities/extract-answer-slots.ts`, `extraction/extraction-{schema,prompt}.ts`. Route seam:
`turn-invokers.ts`, `turn-context.ts`, `messages/route.ts`, `feature-flag.ts`,
`authoring/config-schema.ts`, `_lib/{detail,sessions}.ts`. UI:
`components/admin/questionnaires/config-editor.tsx`,
`components/app/questionnaire/chat/{seriousness-notice,questionnaire-chat}.tsx`.
