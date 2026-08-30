# Turn progress — the honest wait

What a respondent watches between sending an answer and the reply beginning to arrive.

A single turn runs **four to six sequential model calls** before the first token appears (see
[`diagnostics.md`](./diagnostics.md#where-the-time-goes-stage-latency) for the measured split — the
first reading put an average turn at ~5s, model-bound end to end). The surface used to show one
static `Thinking…` for all of it, which made a normal turn and a stuck one identical.

Now the server says which stage it is on, and a clock appears once the wait is long enough to
warrant one.

## The stages

Four, declared in `lib/app/questionnaire/orchestrator/stage-progress.ts`:

| Stage       | Covers                                                | On screen                                  |
| ----------- | ----------------------------------------------------- | ------------------------------------------ |
| `reading`   | extraction, sensitivity detection, seriousness judge  | Reading your answer…                       |
| `checking`  | contradiction detect + refine                         | Checking that against what you've told me… |
| `choosing`  | the next-question / next-slot selection               | Choosing what to ask next…                 |
| `composing` | the phrasing (or offer) stream, until the first token | Writing the next question…                 |

Three deliberate choices in that table:

- **Coarser than the pipeline.** `reading` is three calls, not three labels. Announcing each would
  flicker three sentences through in under two seconds — and, more to the point, telling a
  respondent their answer is being judged for sincerity is true but is not a thing to say out loud.
- **Every label is a claim about work that has started.** Nothing here is scripted or timed. This is
  the same distinction the admin surfaces already draw between `ExtractionProgress` (real phases)
  and `StatusTicker` (a script for a wait with no signal) — see `components/admin/questionnaires/status-ticker.tsx`.
- **Plain English.** No "extracting", no capability slugs, no "orchestrating". A unit test asserts
  the labels against a forbidden-vocabulary pattern, so the rule survives the next edit.

Stages a turn never reaches are never announced. A kickoff has no respondent message, so it opens at
`checking` — never "Reading your answer…", which would be false. An offer turn selects nothing, so
it skips `choosing`. An abusive turn that abandons the session stops at `reading`.

## How it gets out, given a pure orchestrator

`runTurn` is pure: all I/O belongs to the route, and the core only decides. Two constraints follow,
and the design is entirely a consequence of them.

- The orchestrator is handed an **optional `StageEmitter`** — a synchronous, side-effect-only
  callback it calls at a stage boundary. It does no I/O, returns nothing, and cannot fail the turn.
  Purity relative to the result holds: a test asserts the `TurnResult` is identical with and without
  a reporter. Passing nothing is always valid, which is what left every pre-existing caller and test
  untouched.
- The route is an **async generator**, so a callback cannot `yield`. Hence the channel: `emit` fills
  a queue and `drain` lets the route pull from it concurrently with the pipeline promise.

```ts
async function* drive() {
  const stages = createStageChannel();
  const result = yield* streamStageStatus(stages, runTurn(state, invokers, stages.emit));
  // …the reply then streams as before
}
```

`streamStageStatus` re-throws the pipeline's own rejection unchanged, so the route's existing catch —
which persists the failure and emits `error` + `done` to unlock the surface for a retry — is
untouched. That path is covered by a route test, because a regression there would hang a respondent's
composer for the rest of the session.

`composing` is emitted by the route rather than the core, because composing is the route's own work.

Two properties of the channel worth knowing:

- **A repeated stage announces once.** Both orchestrators can re-enter a boundary; saying the same
  sentence twice reads as the surface having stalled and restarted. De-dup is against the _last_
  stage only, so a genuine return to an earlier stage is still news.
- **A channel is per-turn.** The de-dup memory is per-turn state; a shared channel would swallow the
  second turn's `reading` and leave the indicator static for the rest of the session.

## The client

The `status` frame already existed on the platform's `ChatEvent` — the respondent client had simply
been dropping it. `parseSessionEvent` now narrows it, rejecting a blank message: an empty label would
clear the indicator mid-wait, which reads as the reply having arrived.

`useQuestionnaireSessionStream` exposes `stageLabel`. It is **transient by construction**:

- Cleared the instant the first content delta lands — from then on the reply is its own progress, and
  a label under a visibly-arriving message is noise.
- Cleared in the stream teardown, which runs on every exit: clean settle, HTTP failure, abort,
  network drop. That single clear is also why the next turn necessarily starts with no label. The
  case it exists for is a stage arriving and _then_ the connection dropping with no content — without
  it, "Reading your answer…" sits beside the error banner, dots animating, claiming work that stopped.
- **Never committed onto a turn.** A wait cue is not part of the conversation and must not replay on
  resume or scroll-back.

### Where it renders

`TurnProgress` (`components/app/questionnaire/chat/turn-progress.tsx`), mounted by `CurrentExchange`
— the one place a respondent watches the whole multi-call wait.

It is **app-owned rather than a prop on the platform's `ThinkingIndicator`**. That component is
Sunrise's (verified against `upstream/main`), and ConQuest extends the platform through its seams
rather than editing it — a prop added there would have to be re-applied on every sync. The dots are
re-implemented here, deliberately, for a few lines. The platform component is still used for the
opening choreography's scripted beat in `transcript-turns.tsx`: that is a ~1s pause, not a server
wait, and a running clock on it would be nonsense.

### The clock

Held back for `ELAPSED_AFTER_MS` (4s), so an ordinary turn stays calm and a slow one gets the one
reassurance that cannot be faked. `formatElapsed` is shared with the admin tickers via
`lib/app/questionnaire/format-elapsed.ts` — it was private to the ticker until this needed the same
clock, and two copies of a format that must match across surfaces is a drift waiting to happen.

### One live region, not two

The composer keeps its own `sr-only` `role="status"` cue (a disabled field's placeholder is not
announced). That one deliberately announces the **stable** `composerHint`, not the stage label,
while the placeholder shows the live label silently.

Pointing both regions at a label that changes once per stage would have a screen reader read the
same wait out twice per stage — eight utterances across a five-second wait, drowning the reply that
follows. `TurnProgress` is the single live region on the stage, and its clock is `aria-hidden`: a new
number read out every second is a barrier, not reassurance.

## What this is not

- **Not the reasoning trace.** `buildReasoningTrace` ([`reasoning-stream.md`](./reasoning-stream.md))
  runs _after_ the pipeline and fills the **typing** wait; it is also off by default. This fills the
  **thinking** wait. Emitting reasoning steps progressively, now that stage hooks exist, is recorded
  as a follow-up in [`../planning/turn-latency-plan.md`](../planning/turn-latency-plan.md).
- **Not configurable.** The labels are fixed. Per-questionnaire tone applies to the interviewer's
  words, not to the machinery's account of itself.
- **Not a speed-up.** It makes the wait legible, not shorter. That is Phases 3 and 4 of the plan.
