---
plan: P20
title: Turn latency and the honest wait
status: in progress
owner: TBD
opened: 2026-08-30
branch: feat/turn-progress-and-latency
docs: .context/app/questionnaire/turn-progress.md (written in Phase 2)
---

# P20 — Turn latency and the honest wait

> A respondent answers, and the surface shows `Thinking…` — one static label, no elapsed time, no
> account of what is happening — for as long as it takes **four to six sequential model calls** to
> finish. This plan attacks both halves of that: make the wait shorter, and make it honest.

Unlike the `fX.Y.md` trackers in [`features/`](./features/), which are written **after** the code,
this is a forward-looking plan. Each phase gets its own tracker when it ships. Phases land one at a
time, each on its own commit, with tests and docs in the same commit.

---

## 1. What the wait actually is

`app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts:814` awaits the **entire** pipeline
before a single token can stream. Inside `runTurn`
(`lib/app/questionnaire/orchestrator/orchestrator.ts:169`) that is a serial chain of LLM
round-trips, every one of them at the `chat` tier:

| #   | Stage                         | Where                    | Runs when                                                           |
| --- | ----------------------------- | ------------------------ | ------------------------------------------------------------------- |
| 1   | `extractAnswers`              | `orchestrator.ts:187`    | message is non-empty                                                |
| 2   | `detectSensitivity`           | `orchestrator.ts:210`    | `config.sensitivityAwareness`                                       |
| 3   | `assessSeriousness`           | `orchestrator.ts:253`    | not settled by the deterministic floor, and `!extractedSensitivity` |
| 4   | contradiction detect → refine | `orchestrator.ts:333`    | mode is not `off`                                                   |
| 5   | `selectNext`                  | `orchestrator.ts:434`    | not an offer/probe turn                                             |
| 6   | `streamQuestionMessage`       | `question-stream.ts:729` | always — **this is the first token the respondent sees**            |

Stages 1–5 are invisible. The respondent watches a static label for all of them.

### Two facts that shape every phase below

- **The `status` frame already exists.** `ChatEvent` carries a `status` variant
  (`lib/orchestration/chat/streaming-handler.ts:1248` emits one). The respondent client
  (`lib/hooks/use-questionnaire-session-stream.ts:396`) handles `content` / `warning` /
  `reasoning` / `question_card` / `inspector` / `error` and silently drops everything else;
  `parseSessionEvent` does not narrow `status` at all. The pipe is built and unused.
- **Per-call latency is already persisted for every real session.** `AppQuestionnaireTurn.inspectorCalls`
  holds `AgentCallTrace[]` — label, model, `latencyMs`, tokens, cost — and the schema comment is
  explicit that capture is universal; only _SSE emission_ to the admin drawer is preview-gated
  (`route.ts:512`). Turn wall-clock is denormalised onto `durationMs`. **No migration is needed to
  measure where the time goes.**

### Why the reasoning trace does not already solve this

`buildReasoningTrace` runs at `route.ts:882` — _after_ the pipeline. The "watch it think" feature
fills the **typing** wait, not the **thinking** wait. It is also off by default
(`config.reasoningStreamEnabled`).

---

## 2. Scope

Agreed 2026-08-30. Four phases, in order, reassessing after each.

| Phase | What                                                          | Risk to answer quality         |
| ----- | ------------------------------------------------------------- | ------------------------------ |
| **1** | Measure — per-stage latency breakdown in Diagnostics          | none (read-only)               |
| **2** | Honest stage status frames + delayed elapsed counter          | none (presentation)            |
| **3** | Parallelise extraction ∥ sensitivity; speculative seriousness | none (same calls, same inputs) |
| **4** | Prompt-cache prefix ordering audit on the phraser             | none (same prompt, reordered)  |

### Deliberately excluded from this round

These were considered and **cut on 2026-08-30** because each trades against answer quality or
carries structural risk, and none should be attempted before Phase 1 says the time is actually
there:

- **Trim the phraser's input** (drop prior-answer digest / transcript / glossary lines). Directly
  removes context the interviewer uses. Excluded.
- **Move classifiers to the `routing` tier.** The seriousness judge and sensitivity detector are
  safeguarding-adjacent; a cheaper model there is a real risk. Excluded.
- **Speculative pre-phrasing** (start phrasing the likely next question before the selector
  confirms it). The largest possible win and the largest complexity — abandoned streams, cost
  accounting, and a wrong guess costs a visible restart. Excluded.

### Candidates for a second round, not started

Recorded so they are not rediscovered from scratch:

- Emit reasoning steps **progressively** rather than as one post-hoc frame. Cheap once Phase 2's
  stage hooks exist — "Captured _your team's size_" the moment extraction returns.
- Type the status label out per character. `StatusTicker` already does this at 40ms.
- Stall escalation: "Still working on this…" at ~10s, offer retry at ~25s. Retry is already safe —
  `findTurnByIdempotencyKey` (`route.ts:786`) replays a persisted turn rather than re-running it.
- A greyed question-card skeleton during the wait, so the layout does not jump.

---

## 3. Phase 1 — Measure

**Goal.** Answer "which stage is the wait?" from data already on disk, before optimising anything.

`AppQuestionnaireTurn.inspectorCalls` carries a stable `label` per call — `Answer extraction`,
`Sensitivity detection`, `Seriousness judge`, `Contradiction detection`, `Answer refinement`,
`Interviewer phrasing`, `Completion offer`, `Data-slot selector`, and the two ranking calls. Group
by label, and report count / avg / p95 `latencyMs` per stage.

The **residual** matters as much as the stages: `durationMs` minus the summed call latencies is
everything that is _not_ a model call — DB reads, embedding, persistence. If the residual dominates,
none of Phases 3–4 will help, and that is exactly what this phase exists to find out before the
effort is spent.

- Extend `lib/app/questionnaire/analytics/diagnostics.ts` (which already computes version-level
  avg/p95 turn wall-clock via raw SQL) with a per-stage rollup.
- Surface it in `components/admin/questionnaires/diagnostics/diagnostics-view.tsx`.
- No schema change. No migration. Read-only.

**Done when** an admin can open a version's Diagnostics and read, per stage, how many calls ran, how
long they took at avg and p95, and how much of the turn was not a model call at all.

### Shipped 2026-08-30 — and the first reading

`getStageLatency` + the **Where the time goes** panel. Tracker: [`f20.1.md`](./features/f20.1.md).

Run against the dev database over every non-preview session (**10 turns — a small sample from one
data-slot-mode questionnaire; treat the shape as indicative, not the population**):

| Stage                      | Per turn     | Avg call | Calls |
| -------------------------- | ------------ | -------- | ----- |
| Interviewer phrasing       | **2,334 ms** | 2,334 ms | 10    |
| Answer extraction          | 879 ms       | 2,196 ms | 4     |
| Adaptive data-slot ranking | 598 ms       | 1,494 ms | 4     |
| Data-slot selector         | 500 ms       | 1,249 ms | 4     |
| Seriousness judge          | 371 ms       | 1,237 ms | 3     |
| Sensitivity detection      | 279 ms       | 696 ms   | 4     |
| **Not in a model call**    | **133 ms**   | —        | —     |

Average turn: **5.1 s end to end.**

Three findings, and they set up everything below:

1. **The residual is 2.6%.** The turn is model-bound almost end to end. Phases 3 and 4 are aimed at
   the right thing, and the "stop and re-plan" branch in §7 does not fire.
2. **Interviewer phrasing is the single largest stage — 46% of the turn.** It is also the _last_
   stage, and the one whose first token ends the wait. That makes Phase 4 (prompt-cache prefix
   ordering, which acts on time-to-first-token) the highest-value item on the list, not the
   afterthought it was ordered as.
3. **The three Phase 3 candidates cost ~1.53 s/turn between them** (extraction 879 + seriousness 371
   - sensitivity 279). Overlapping them leaves the slowest, ~879 ms — an expected saving of
     **~650 ms/turn**, about 13% of the turn, for a change that alters no prompt and no output.

One thing the sample raises that the plan did not anticipate: **the data-slot ranking and selector
together cost ~1.1 s/turn**, comparable to all three Phase 3 candidates. They are not in scope and
should not be pulled in without measuring a question-mode session for comparison — but they are
worth a look once the shipped phases are re-measured on real traffic.

---

## 4. Phase 2 — The honest wait (B1 + B3)

**Goal.** Replace one static `Thinking…` with a truthful account of the stage in flight, plus proof
the request is still alive.

### The plumbing problem

`runTurn` is documented as pure — "_All I/O … is the route's job; the core only decides_"
(`orchestrator.ts:1-18`). Emitting frames mid-run must not break that. And the route is an async
generator, so a plain callback cannot `yield`.

The shape: an **optional stage channel** passed into `runTurn`. The orchestrator only calls
`emit(stage)` — side-effect-only, no I/O, purity relative to the result preserved. The route drains
the channel concurrently with the pipeline promise and yields a `status` frame per stage. When no
channel is passed, nothing changes, so every existing caller and test is unaffected.

### The stages, in plain English

Per the house rule against implementation vocabulary on screen
(`.context/ui/plain-english-ui-copy` guidance — no "extracting", "orchestrating", "invoking"):

| Stage       | Covers                                             | Label                                      |
| ----------- | -------------------------------------------------- | ------------------------------------------ |
| `reading`   | extraction, sensitivity, seriousness               | Reading your answer…                       |
| `checking`  | contradiction detect + refine                      | Checking that against what you've told me… |
| `choosing`  | `selectNext`                                       | Choosing what to ask next…                 |
| `composing` | the phrasing / offer stream, until the first token | Writing the next question…                 |

A kickoff turn has no respondent message, so `reading` never fires — it opens at `choosing`. That is
correct, not a gap.

### Client

- `parseSessionEvent` narrows a `status` frame.
- The stream hook exposes the current stage label; it is transient and never committed onto a turn.
- **An app-owned indicator.** `ThinkingIndicator`
  (`components/admin/orchestration/chat/thinking-indicator.tsx`) is **Sunrise platform** — verified
  against `upstream/main`, commit `226998ea6`. Editing it is fork-and-edit and would fight every
  sync. The respondent surface gets its own component under
  `components/app/questionnaire/chat/` instead, and the platform file is left alone.
- **B3 — elapsed counter after a threshold.** Show `mm:ss` only after ~4s, so a fast turn stays
  clean and a slow one proves it is alive. `formatElapsed` already exists in
  `components/admin/questionnaires/status-ticker.tsx` (app-owned) and should be shared, not
  duplicated.

**Done when** a respondent sees the stage change as the turn progresses, and a turn slower than ~4s
shows a running clock.

### Shipped 2026-08-30

Tracker: [`f20.2.md`](./features/f20.2.md) · doc:
[`turn-progress.md`](../questionnaire/turn-progress.md).

Built as planned. Three things the plan did not anticipate, all worth carrying forward:

1. **Two live regions, not one.** The composer already had an `sr-only` `role="status"` cue. Pointing
   it at the live label as well made both it and the new indicator announce every stage — twice per
   stage, eight times across a five-second wait. Fixed by splitting _shown_ from _announced_: the
   composer's placeholder shows the live label silently, its status line keeps stable copy, and
   `TurnProgress` is the single live region.
2. **Two comments in the new code were false, and mutation testing caught both.** The `Promise.race`
   in `drain` is defensive rather than load-bearing (`wake` is assigned synchronously, so there is
   no window to lose), and the stage label was being cleared twice where the teardown clear alone
   already guaranteed it. The redundant clear was deleted; the comment was corrected. Neither was a
   bug — both were claims that would have misled the next reader.
3. **Testing mid-stream hook state took two attempts.** Recording renders shows nothing (one `act`
   batches the whole stream into a single render) and gating frames deadlocks if `act` scopes nest.
   The working shape is documented on the test helper.

---

## 5. Phase 3 — Remove two round-trips (A1 + A2)

Both are pure scheduling changes. **The same calls run, on the same inputs, and the same merge
decides the outcome** — only the order changes. Nothing about answer quality moves.

- **A1 — extraction ∥ sensitivity.** `detectSensitivity` reads only `state` and the user message; it
  has no dependency on the extractor's output, and `mergeSensitivitySignals` combines them
  afterwards regardless. They are serial today purely by code order. Saves one full round-trip on
  every turn of a sensitivity-aware questionnaire.
- **A2 — speculative seriousness.** The judge is gated on `!extractedSensitivity`, so today it
  cannot start until stage 2 returns. Launch it alongside 1 and 2 and discard the result when
  sensitivity fires. Costs a wasted cheap call on a minority of turns; removes a round-trip from
  every turn. The deterministic `keywordAbuseFloor` still short-circuits first, for free.

**The safeguarding invariant must not move.** A genuine disclosure is never judged for sincerity and
never struck. Today that is enforced by _ordering_ (the judge does not run). After A2 it must be
enforced by _the merge_ — the speculative verdict is discarded, not applied. This is the one place
in the phase where a mistake would matter, and it needs a test that fails if the discard is removed.

**Done when** the three stage-1 calls overlap, the merge is unchanged, and a test proves a
speculative non-serious verdict is discarded when sensitivity fires.

### Shipped 2026-08-30 — A1 only. **A2 is blocked on a decision, not on work.**

Tracker: [`f20.3.md`](./features/f20.3.md).

**A1 is done.** Extraction and sensitivity detection now overlap in both orchestrators. No input, no
prompt and no verdict changed; `toolCalls` are still recorded in their original order because that is
a read surface. Projected saving from the F20.1 sample: **~279 ms/turn**, the smaller of the two.

**A2 was not built, because it cannot be built without relaxing a guarantee this plan misread.**

The plan assumed the safeguarding invariant was about the OUTCOME — "a disclosure is never struck" —
and that speculation would therefore be fine as long as the verdict was discarded. Reading the tests
showed the guarantee is stronger and deliberate: three of them assert `calls.serious` is **zero** on a
disclosure turn, one named _"neither struck nor judged"_. The disclosure is never sent to the
sincerity judge **at all**.

That cannot be preserved under speculation. Whether a turn carries a disclosure is not knowable until
the extractor and the detector return, and either can be the one that flags it:

- the deterministic keyword floor — knowable up front, so speculation could skip those turns;
- the **dedicated detector** — knowable only after it returns;
- the **extractor's own `sensitivity` field** — knowable only after extraction returns.

There is no configuration in which speculation is provably safe, because the extractor's field gates
even when the sensitivity feature is off. Adding the judge to the batch fails **ten** tests across
both orchestrators, including all three safeguarding guarantees.

So A2 is a values question, not an engineering one:

| Option                    | Saving/turn | What changes                                                                                         |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| **Leave it** (current)    | 0 (A1 only) | Nothing. The guarantee stands as written.                                                            |
| **Relax to outcome-only** | ~371 ms     | A disclosure may be sent to the sincerity judge; its verdict is discarded. 3 tests + the doc change. |

Arguments for relaxing: no additional data leaves the system (the same message already goes to the
extractor, the detector and the phraser, same provider), and the respondent suffers no consequence
because the verdict is thrown away. Argument against: the guarantee was written down deliberately,
tested three ways, and "we send your abuse disclosure to a sincerity judge and ignore the answer" is
a sentence somebody may one day have to defend.

**Recommendation: leave it.** ~371 ms is ~7% of a turn, and Phase 4 targets a stage worth 46%.

---

## 6. Phase 4 — Prompt-cache prefix ordering (A3)

`buildStreamingQuestionPrompt` (`question-stream.ts`) assembles a large system prompt from many
conditional inserts — house rules, interviewer strategy, fidelity, glossary, briefing. Automatic
prompt caching keys on the **prefix**: anything volatile appearing early (turn count, the last user
message, the transcript) invalidates the cache on every single turn.

Audit the assembled order, then move stable-per-questionnaire content to the front and
volatile-per-turn content to the back. Same prompt content, same instructions, lower
time-to-first-token and lower cost.

**Verify before assuming there is a problem.** If the ordering is already correct, this phase closes
as a no-op with the finding written down — which is a real outcome, not a failure.

**Done when** the prompt's stable prefix is provably contiguous, or the audit records that it
already was.

---

## 7. Order and stopping rule

```
Phase 1 (measure) → Phase 2 (honest wait) → Phase 3 (round-trips) → Phase 4 (cache) → reassess
```

Phase 2 is worth doing whatever Phase 1 says — an honest wait is right even for a fast turn. Phases
3 and 4 are **contingent on Phase 1**: if the residual (non-model time) dominates, stop and re-plan
rather than shaving round-trips that were never the cost.
