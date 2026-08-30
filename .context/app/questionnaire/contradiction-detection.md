# Contradiction detection (F4.3)

How a respondent's captured **answers** are compared across slots to surface
**logical contradictions** — an earlier answer that can't be true alongside a later
one ("no children" then "my daughter's at college"). The third of P4's
conversational primitives after selection (F4.1, _which_ question) and extraction
(F4.2, _what_ was answered). F4.3 **surfaces** conflicts for the agent to confirm —
it never overwrites an answer. Built as a pure core + a capability + a
no-persistence preview route, exercisable by Vitest before any streaming surface
exists.

## Two axes: behaviour vs cadence

Contradiction handling has two independent levers. **Only the behaviour axis is a
config field today** (it was locked in F3.1); the cadence axis is pure logic F4.6
will drive.

- **Behaviour — what to do on a hit** (`AppQuestionnaireConfig.contradictionMode`,
  `CONTRADICTION_MODES` in `lib/app/questionnaire/types.ts`):
  - **`off`** — no detection. The shipped default.
  - **`probe`** — **confirm before overwrite**: nothing is changed on the detection turn. The
    interviewer asks a reconciliation question (stating that confirming will update the earlier
    answer + the linked data), the finding is parked on the session, and the change is applied only
    once the respondent confirms on the next turn. See [Probe-confirm flow](#probe-confirm-flow-probe-mode).
  - **`flag`** — **retired 2026-08-30**, no longer selectable. It surfaced the conflict passively
    _and_ let the refiner rewrite the conflicting answer in the same turn — an AI edit to a
    respondent's answer that they were never asked about and could easily miss. Turning checking on
    now means asking. The value stays in `CONTRADICTION_MODES` so stored rows and older API/import
    payloads still parse; **every read funnels through `resolveContradictionMode`, which returns
    `probe` for it**, so no row was migrated and nothing downstream of that resolver ever sees it.
    The engine has no passive-refine arm left to reach.

  Why a resolver rather than a backfill: mapping `flag` **before** the enum-membership check is what
  makes it safe. Dropping the value from the tuple instead would send every stored `flag` row down
  the unknown-value path to the default — silently turning checking **off** for exactly the
  questionnaires that had asked for it.

- **Cadence — when to run** (pure `shouldRunDetection`, **no config column**): the
  development-plan prose once listed `every_turn / every_n_turns / sweep_only`, but
  the committed schema has no cadence enum — it has `contradictionWindowN` (a
  _comparison window size_, not an interval). F4.3 models cadence as a pure
  scheduler the F4.6 engine calls:
  - `phase: 'turn'` → run every turn, comparing the last `windowN` answers
    (or all when `windowN <= 0`) — covers the prose's _every_turn_. **That window went
    unapplied until 2026-08-30**: `shouldRunDetection` returned a `compareWindow` from the
    first release and every caller ignored it, so a questionnaire set to "check against the
    last 3" checked against all of them — the admin field promised one thing and the detector
    did another, with a wider comparison surface (and so more false positives) than anyone
    asked for. `runContradictionPhase` now narrows `priorAnswers` through
    `applyCompareWindow` before the detector sees them, and applies it **before** the answer
    floor so the floor counts what the detector will actually get. The window is the tail:
    `existingAnswers` is loaded oldest → newest (`turn-context.ts` orders on `updatedAt`,
    which it previously did not, so "the last 3" would have been three arbitrary answers).
  - `phase: 'completion-sweep'` → run once before submit, comparing **all** answers
    — covers the prose's _sweep_only_.
  - The prose's _every_n_turns_ (a pure cost-tuning interval) **landed 2026-06-07**
    (deferred-gaps audit): the additive config column `contradictionEveryNTurns`
    (`Int @default(1)`, 1 = every turn) + an optional `cadence` arg on
    `shouldRunDetection(mode, windowN, phase, { everyNTurns, turnIndex })`. For
    `phase: 'turn'`, detection runs only when `turnIndex % everyNTurns === 0` (the
    orchestrator passes the zero-based `selectionRound`); the completion sweep ignores
    cadence (the final gate never skips).

The natural high-value default falls out for free: `probe` + a completion sweep
catches every conflict with one end-of-session LLM call; per-turn detection is the
opt-in for high-stakes surveys.

**The look-back window** (`contradictionWindowN`) has no stored default — the config's cross-field
rule pins it to `0` while the mode is `off` — so `DEFAULT_CONTRADICTION_WINDOW_N` (**10**) is what
the config editor fills in the moment an admin switches checking on. Before that constant existed the
field was left at the stored `0`, which the save path clamped to `1`: each answer checked against only
the one before it, which is close to no look-back at all. Ten is wide enough to catch a reversal
several questions later and tight enough to keep the comparison small — a wider net is a wider surface
for a false positive, which is the failure that actually costs the respondent's trust.

## The finding contract (surface, never overwrite)

Like extraction, detection splits the LLM contract from what callers consume:

1. **Raw LLM output** (`contradiction/detection-schema.ts`) — `{ contradictions:
[{ slotKeys, explanation, severity, confidence, suggestedProbe? }] }`. Structural/
   enum checks only (`slotKeys` non-empty, `severity` in `CONTRADICTION_SEVERITIES`,
   `confidence` 0–1). SEMANTIC checks (do the keys name _answered_ slots, is a pair
   a duplicate) live downstream in the normaliser — which drops one odd finding
   rather than failing the whole pass (the F4.2 doctrine).
2. **`ContradictionFinding`** (`contradiction/types.ts`) — the surfacing intent:
   `{ slotKeys: string[], explanation, severity, confidence, suggestedProbe? }`. It
   carries **no value to write** — F4.6 renders it to the agent/respondent; nothing
   is overwritten. Resolving a conflict (re-ask, overwrite, the `refined`
   provenance) is **F4.4's** job; the `suggestedProbe` string is the handoff.

`CONTRADICTION_SEVERITIES = ['low','medium','high']` is **detector-local** (it lives
in the core, not the shared `types.ts`), the same way `EXTRACTOR_EMITTED_PROVENANCES`
is a contract-local subset.

## Architecture — pure core + a capability

The core lives in `lib/app/questionnaire/contradiction/` and is **Prisma-free,
framework-free**. A caller assembles an in-memory `ContradictionContext`; the core
builds the prompt and (after the LLM call) normalises the findings.

```
contradiction/
├── types.ts            ContradictionContext, ContradictionSlotView, AnsweredSlotView,
│                       ContradictionFinding, RaisedContradiction, CONTRADICTION_SEVERITIES,
│                       CONTRADICTION_RESOLUTIONS, DetectionPhase
├── detection-schema.ts contradictionDetectionSchema (+ z.toJSONSchema), validateContradictionDetection
├── detection-prompt.ts buildContradictionDetectionPrompt / …RetryMessage → LlmMessage[]
└── detection-logic.ts  normalizeContradictionFindings(...) + shouldRunDetection(...) + contradictionKey(...)
```

- **`ContradictionContext`** — `{ slots, answers, mode, windowN, currentStatement?,
sessionId }`, all in memory. `AnsweredSlotView` carries the actual `value` (detection
  reasons over values, not just "is answered") plus optional `provenance` (which side
  of a conflict to trust) and `turnIndex` (for windowing). **`currentStatement`** is the
  respondent's latest message — see [Same-slot reversal](#same-slot-reversal-via-the-latest-message).
- **`normalizeContradictionFindings`** — drop findings referencing unknown or
  _unanswered_ slots; require ≥2 distinct slots; **dedupe symmetric pairs** (`[a,b]`
  ≡ `[b,a]`, keep highest confidence); clamp severity; mode-shape (the legacy `flag` strips any
  probe; a `probe` finding with a missing/blank probe is _downgrade-kept_ without one,
  not dropped — the conflict still stands).
- **`shouldRunDetection(mode, windowN, phase, cadence?)`** — the pure scheduler (see
  cadence above). The optional `cadence` (`{ everyNTurns, turnIndex }`) skips off-boundary
  turns. Lives in the core so it's zero-mock unit-testable; the live orchestrator consumes it.

### `normalizeContradictionFindings` outcomes

| Situation                                  | Outcome                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `slotKey` not a known slot                 | **drop** (`unknown slot key(s)`)                                                                                                   |
| `slotKey` known but unanswered             | **drop** (`unanswered slot key(s)`)                                                                                                |
| fewer than two distinct slots after dedupe | **drop** (`fewer than two distinct slots`) — but ≥1 is enough when `currentStatement` is set (`no slot referenced` only when zero) |
| same conflict reported twice (symmetric)   | **dedupe** — keep the highest-confidence finding                                                                                   |
| legacy `flag` finding carrying a probe     | **strip** the probe                                                                                                                |
| `probe` mode finding with a blank probe    | **keep** without a probe (conflict still stands)                                                                                   |

## Same-slot reversal via the latest message

The classic pass compares captured **answers against each other**, so it catches a
_cross-slot_ conflict ("no children" + "daughter at college") only once **both** values
are stored. It misses a _same-slot reversal_ — an earlier "I hate the job" (→ `satisfaction`
low) and a later "I love my job" — because the new statement either overwrites the stored
value (no conflict left to see) or, as often happens, isn't re-extracted into the already-
answered slot at all (extraction tends not to re-answer a filled slot). Either way the
reversal lives only in the message text, invisible to an answer-vs-answer pass.

`currentStatement` closes that gap. The live invoker passes the respondent's latest message
(`state.userMessage`); the prompt tells the detector to **also** weigh it against each
recorded answer and report any answer it reverses. Because the message is the implicit second
party, the normaliser **relaxes its ≥2-distinct-slots rule to ≥1** when `currentStatement` is
present — a finding may name the single conflicting slot (`satisfaction`), which then drives
the probe and F4.4 refinement of that answer. Absent/blank → the classic answer-vs-answer pass,
unchanged. `currentStatement` is respondent PII, so `redactProvenance()` redacts it from the
durable provenance row alongside the answers.

Two orchestration details make this actually fire (both were live bugs):

- **Floor.** The live phase requires only **≥1 stored answer** when a message is present (it can
  contradict the message); the detector capability's arg floor is `answers.min(1)` to match. The old
  `≥2` floor silently skipped the very case this targets (e.g. only `satisfaction` answered so far).
  With **no** message the floor is back to **≥2** — a lone answer with nothing to compare it against
  is not a pass worth dispatching. That arm is reachable as of 2026-08-30; see [Which turns are
  checked](#which-turns-are-checked) below. It is also why `applyCompareWindow` runs **before** the
  floor: a look-back of 1 on a message-less turn leaves the detector a single answer, and the floor
  is what stops it.
- **Pre-merge answers.** Detection runs over the answers **as they were before this turn's extraction
  merged in** (`runContradictionPhase`'s `priorAnswers` = the orchestrator's `state.existingAnswers`,
  pre-`applyIntents`). This turn's contradicting statement is often extracted straight into the
  conflicting slot (`satisfaction` 1→5), which would erase the old value before the detector sees it;
  comparing the pre-merge answers against the latest message keeps it visible.

### Which turns are checked

**Checking is about the answers, not the keyboard.** A turn is checked when something arrived to
check — the respondent **typed** (`hasMessage`), or they **answered a question through its in-chat
answer control** (`answerRecorded`, from `TurnState.answeredQuestionKey`). Those are the two ways an
answer reaches the session.

The card case is why this is not simply `hasMessage`. A P18 answer card persists the value itself
(`PUT …/answers`) and then fires a turn carrying no message, because passing the picked value as a
fake user message would leak form values into the transcript. Until 2026-08-30 the phase gated on the
message alone, so **a respondent working through a questionnaire on answer cards was never checked
mid-conversation** — their conflicts surfaced only at the submit-time sweep, stopping them at the
finish line instead of being cleared up in the flow. Nothing was missed, but the feedback came at the
worst moment.

Two things fall out of using a positive "something arrived" signal rather than "not a kickoff":

- **The opening turn is excluded by construction.** It has neither signal. This matters more than it
  looks: a form-first session can reach its first conversational turn with answers already stored, and
  opening the interview by challenging the respondent is not how it should start.
- **A card turn has nothing to suppress.** `suppressWrites` exists so this turn's _extraction_ can't
  overwrite the old value before the respondent confirms; on a card turn there is no extraction and
  the value is the respondent's own deliberate pick. The promise the probe makes — nothing is
  **changed** until you reply — still holds.

One further rule keeps the conversation civil: **while a probe is parked and this turn cannot answer
it** (a card tap, or a disregarded turn), no fresh detection runs. Stacking a second reconciliation
question on top of an unanswered one is the nagging the ledger exists to prevent, and parking a new
finding would overwrite the one still waiting. The parked conflict keeps its `unresolved` entry, so
the completion sweep still raises it if the session ends without an answer.

The remaining gap, accepted deliberately: a respondent who answers a probe by tapping another card
rather than typing does not resolve it that turn. A probe is a free-text question, so typing is the
natural reply; if they never do, the conflict is caught by the sweep.

### The question the message is answering (the 5GB3M8SS correction)

Feeding the latest message in without saying **what it answers** created a second, worse false
positive — worse because the respondent had done nothing ambiguous at all.

Session `5GB3M8SS`, verbatim from the transcript:

| Turn | Interviewer asked                                                         | Respondent |
| ---- | ------------------------------------------------------------------------- | ---------- |
| 3    | "roughly how many hours do you end up working across everything"          | `70 hrs`   |
| 4    | "a more **sustainable** weekly rhythm … what number would feel realistic" | `40 hrs`   |

Both answers were extracted correctly, into two different slots
(`current_weekly_work_hours = 70`, `sustainable_weekly_hours = 40`). The **detector** was the one
agent in the turn that never learned what was being asked. It received `current_weekly_work_hours`
with its question text, plus a bare `"40 hrs"`, and a rule inviting it to report any recorded answer
the message is incompatible with. Given only that, flagging it is the reasonable reading — the fact
that would have exonerated the respondent was simply not in the prompt. Note also that detection
runs **pre-merge**, so `sustainable_weekly_hours` did not yet exist to compare against.

None of the existing guards could catch it: the restatement rule is about _matching_ numbers, the
confidence floor does not apply (the model was rightly confident about what it could see), and the
glossary rule needs a contested term.

Three things fixed it, all of them context rather than wording:

- **`activeQuestion`** — the key and prompt of the question the message answers, rendered
  immediately BEFORE the message so the two read as a question and its answer rather than as a
  free-floating claim. Absent in data-slot mode (no single active question) and on a kickoff.
- **`recentMessages`** — a short tail of the conversation (capped at `MAX_DETECTION_TRANSCRIPT`),
  labelled in the prompt as context and _not_ answers to check, so the question reads as the
  interviewer actually put it. Deliberately **not** governed by the look-back window: the window
  says how much _evidence_ to compare, this is how to read _one message_. Handing the detector a
  whole transcript would give it pages of prose that were never answers to find tension in.
- **The new-answer rule** — "an answer to a DIFFERENT question is a NEW ANSWER, never a reversal",
  naming the shapes that keep tripping it: now vs preferred, actual vs target or ideal, one period
  or role or scenario vs another. The latest-message rule was tightened to match: report it only
  where it genuinely revisits **the same** question.

The model's verdict cannot be unit-tested, so the tests pin the things that would have prevented it
reaching the model: the schema keeps the keys (`contradiction/question-context-wiring.test.ts` —
`BaseCapability.validate` safe-parses against a non-strict object, which is exactly how the glossary
seam once shipped inert), the invoker assembles them (`turn-invokers.test.ts`), and the prompt
renders them in the right order (`contradiction/detection-prompt.test.ts`).

## Probe-confirm flow (`probe` mode)

Under `probe` mode a detected contradiction is **never silently overwritten**. The shared
`runContradictionPhase` (`orchestrator/contradiction-phase.ts`, used by BOTH `runTurn` and
`runDataSlotTurn`) runs a small two-turn state machine:

1. **Detection turn.** A fresh contradiction → the orchestrator:
   - emits the blue notice carrying the **explanation only** (informational — never the question);
   - asks a **reconciliation question** as the interviewer's message — a `contradiction_probe`
     response whose text is the detector's `suggestedProbe` (or a default) **plus an explicit
     consequence line**: confirming will update the earlier answer(s) — named from the slot/data-slot
     labels — and the linked saved data (`buildContradictionProbe`). The route streams this text
     **verbatim** (not through the question phraser) so the consequence wording is exact;
   - **suppresses this turn's writes** (`suppressWrites`): no answer upsert, and in data-slot mode no
     data-slot fill either — nothing is recorded before the respondent confirms;
   - **parks** the finding as a `PendingContradiction` on `AppQuestionnaireSession.pendingContradiction`.
2. **Resolution turn.** With a pending contradiction loaded, THIS turn's message is the answer to the
   probe: the refiner runs against the parked finding (apply the change on confirm / keep otherwise),
   the pending state is **cleared**, and **no fresh detection runs** (so the same conflict can't
   re-probe in a loop). The turn then proceeds to normal selection.

### Surfacing floor (weak findings never reach the respondent)

The detector is asked how sure it is (`confidence` 0–1). Below **`SURFACE_CONTRADICTION_CONFIDENCE`
(0.7)** a finding is **not surfaced at all** — no probe, no notice, no submit-time hold — in either the
per-turn phase (`isSurfaceableContradiction` filters `fresh`) or the completion sweep
(`filterSweepFindings`). This is a **surfacing** gate, not a detection one: `normalizeContradictionFindings`
still returns weak findings (the admin preview shows them); only the live respondent paths drop them.
It exists because a weaker detector model will occasionally emit a hedged "could imply a different
understanding" guess at ~0.6 confidence, and interrupting a respondent over a non-conflict does more
harm than good. The prompt reinforces this: a **restatement of the same value/number** in different
words is explicitly _not_ a contradiction, and the model is told not to report "could imply / might be"
differences — only answers that **cannot both be true**.

### Graded, humble phrasing (how directly the conflict is raised)

Once a finding clears the floor, the reconciliation question is **calibrated to the detector's own
certainty**, so the interviewer matches how a careful person would raise a suspicion. The finding
carries `confidence` (0–1) and `severity`; both the LLM-authored `suggestedProbe` and the deterministic
fallback use them:

- **Clear and obvious** (`≥ 0.8` confidence — answers that plainly can't both be true) → put the tension
  **directly and plainly** ("Earlier you said X, but just now it sounds like Y — which is right?").
- **Genuine but subtle** (`[0.7, 0.8)` confidence — a real conflict, but the wording is ambiguous or
  it's a matter of degree) → raise it with **genuine humility**: a softener such as _"Forgive me if
  I've misunderstood…"_, _"It seems that…"_, or _"I may be wrong, but…"_, framed as the interviewer's
  possible misreading, and easy to correct. Humility governs **delivery** of a conflict the detector
  does believe is real — it is never a licence to raise a doubt (that's what the floor is for).

Either way the probe **always names the specific thing that seems to conflict** (the suspicion is
never hidden), and never accuses or presumes which answer is correct. The **switch is confidence**
(how sure the detector is it's a real conflict — the axis the user's "clear vs subtle" maps to); a low
`severity` only nudges the model gentler still, it is not itself the direct/humble toggle. The detector
prompt (`detection-prompt.ts`) instructs the model to apply this to `suggestedProbe`; when the model
returns no probe, `buildContradictionProbe` picks a **direct** vs **humble** default by
`CLEAR_CONTRADICTION_CONFIDENCE` (0.8) — the same confidence threshold (so code and prompt agree on the
switch). The deterministic consequence line is unaffected — it stays exact regardless of tone.

`off` does nothing. There is no other mode: checking that is on always asks.

The seriousness gate runs BEFORE this phase, so a contradicting answer must survive it to be probed —
the judge prompt explicitly treats "contradicts an earlier answer" as genuine (see
[seriousness-gate.md](./seriousness-gate.md#a-contradiction-is-not-a-sincerity-failure)).

### Never re-raise the same conflict (the "don't nag" ledger)

Detection is stateless — it re-reports a conflict every time it still sees one. Left alone, the same
contradiction would be probed / alerted on turn after turn, which reads as the interviewer nagging.
`AppQuestionnaireSession.raisedContradictions` fixes that: an **append-only ledger of contradictions
already surfaced this session**, keyed by the canonical slot-key set (`contradictionKey` — so
`[a,b] ≡ [b,a]`).

- **Suppress.** In `runContradictionPhase`, every freshly-detected finding whose key is already in the
  ledger is dropped **before** any notice or probe — no re-alert, no re-probe — **whether or not it was
  ever reconciled**. Detection still runs (it's cheap and the tool-call is recorded); it just produces
  no user-facing output for a stale conflict. A wholly-stale pass surfaces nothing.
- **Record.** The phase **acts on every fresh conflict the turn surfaces** and records each one, so a
  conflict is only ledgered once it has genuinely been raised (never noticed-then-silently-suppressed):
  each is recorded as `unresolved` until the respondent answers the probe. (`flagged` is a legacy
  ledger value from the retired `flag` mode — still **read** so an older session's dealt-with conflicts
  stay suppressed, never written.) When a single turn
  turns up **more than one** fresh conflict they are handled **together** — see [Combining several
  conflicts](#combining-several-conflicts-in-one-turn).
- **Resolve.** On the resolution turn (a parked probe is confirmed/declined), each parked conflict's
  ledger entry is stamped `resolved` (that conflict's slot was actually refined), `kept` (the sole
  conflict, replied to without a change — a deliberate decline), or `unresolved`. A conflict stays
  `unresolved` when refinement was disabled (never attempted) **or** when it was one of SEVERAL bundled
  in a combined probe and this reply didn't refine its slot — a single message can't have addressed
  every point, so an un-refined bundle member is left open for the final sweep to catch rather than
  silently marked `kept`. If no entry matches — a probe parked before the column existed — the entry is
  appended defensively, so the conflict is still suppressed from then on.

The ledger is **PII-free by design** — `RaisedContradiction = { key, slotKeys, resolution,
raisedAtTurnIndex }`, never the explanation / statement / values (those live transiently on
`pendingContradiction` and are cleared on resolution). The route loads it (parsed defensively per
entry) into `TurnState.raisedContradictions` and persists the full updated list alongside
`pendingContradiction` in one session update, so raise/resolve state moves atomically.

### Combining several conflicts in one turn

Usually a turn surfaces at most one new conflict. When detection returns **several fresh conflicts at
once**, they are handled **together**, not dribbled out over turns:

- **One notice box.** The blue "I noticed something" callout combines them — a short lead-in plus a
  numbered line per conflict (`buildContradictionNoticeMessage`). The notice renders with
  `whitespace-pre-line` so the breaks show.
- **One combined probe** (probe mode). The interviewer asks a single reconciliation message that raises
  each conflict as its own numbered point to clarify, closed by one consequence sentence naming every
  affected topic. All conflicts are parked together in `PendingContradiction.findings`, and the next
  turn reconciles them in one refiner pass (a **merged trigger** over the union of their slots). Each
  conflict's ledger entry is stamped by its own outcome (the one whose slot was refined → `resolved`,
  the rest → `kept`).
  Every fresh conflict is recorded in the ledger (so none re-alerts), **and** every one is genuinely
  acted on this turn (so none is silently dropped) — the two guarantees the "don't nag, but do deal with
  new ones" requirement needs. A brand-new conflict on later turns (different slots) is still detected
  and handled normally; only a conflict already in the ledger is suppressed.

The same ledger is also consulted by the **submit-time completion sweep** (below), so a conflict dealt
with mid-conversation never re-nags at the finish line.

## Final completion sweep (submit-time)

Both a normal submit and an early finish (`POST …/questionnaire-sessions/:id/submit`, `{ early }`) run
one last contradiction pass **before the session completes and its respondent report is generated** — a
report built on contradictory answers would mislead. This is distinct from the admin **preview** sweep
(`…/versions/:vid/complete`, over body-supplied answers): the live sweep sources the session's stored
answers.

- **Gate.** Runs only when `contradictionMode ≠ off`, and never when
  the respondent chose to finish anyway (`skipSweep`). Needs ≥2 answered slots (no `currentStatement`
  at submit). The paid dispatch takes a per-flow sub-cap (`turnLimiter.check(access.rateKey)`, 60/min —
  the same guard the per-turn messages route uses), so a held session can't be re-POSTed to hammer
  detection. Fail-soft: a missing detector, oversized input, or dispatch error → treated as clean, so
  a wrap-up is never blocked by infra (`runCompletionSweep`).
- **Idempotent re-submit.** If a probe is already parked (a prior hold the respondent hasn't answered),
  a plain re-submit **short-circuits**: it re-surfaces the SAME parked probe — no second sweep (no LLM),
  no duplicate probe turn — so a resume-then-resubmit never spams the transcript or re-bills.
- **Ledger-aware.** `filterSweepFindings` drops any conflict already `resolved` / `kept` / `flagged`
  this session; it surfaces only **genuinely-new** conflicts (the sweep's real value — cross-slot ones
  the per-turn pass never caught) **and still-`unresolved`** ones (raised, never reconciled — the final
  check).
- **Held, not blocked.** On a surviving conflict the session does **not** complete: a combined probe is
  parked (reusing the multi-conflict builder), recorded as a turn (so it shows in the chat + replays),
  each conflict recorded `unresolved`, and the route returns `{ held: true, probe }`. The respondent's
  next chat message resolves it through the ordinary [resolution turn](#probe-confirm-flow-probe-mode)
  — refining answers + data slots in the background — after which finishing again completes cleanly.
- **Escape hatch.** `{ skipSweep: true }` ("finish / get my report anyway") bypasses the sweep and
  completes, recording the conflict `unresolved` (auditable) and leaving the data as-is. Completing
  clears any parked `pendingContradiction` so a completed session never carries a stale probe. The
  respondent is never trapped.
- **Surfaces.** Normal submit continues **in the chat** (the probe is the next message); an early
  finish additionally opens a **final-check modal** over the exit action (`FinalCheckModal`), with
  "Clarify in chat" and "Get my report anyway". Both are driven by the same `held` backend response
  (`useSessionLifecycle` `onHeld` → `SessionWorkspace`).

## The capability

`AppDetectContradictionsCapability`
(`lib/app/questionnaire/capabilities/detect-contradictions.ts`) extends
`BaseCapability`, mirroring the F4.2 extractor: resolve the provider/model binding →
`getProvider` → `runStructuredCompletion` (call → parse → retry-once → cost-sum) →
fire-and-forget `logCost` → `normalizeContradictionFindings` →
`this.success({ findings, droppedCount })`. Error codes: `no_provider_configured`,
`provider_unavailable`, `detection_failed`.

- **Tier `chat`**, not `reasoning` — detection runs per-turn-ish and must be snappy
  (`maxTokens` 4 000, timeout 30 s).
- **`processesPii = true`** — the answers (and any probe echoing them) are respondent
  PII. `redactProvenance()` redacts them and emits a **counts-only** preview
  (`findingCount`, `probeCount`, `droppedCount`, `severityCounts`), never the
  explanations / probes / values.
- A **distinct agent** (`app-questionnaire-contradiction-detector`, seed 009) from the
  answer extractor — different job, own monthly budget. Capability + binding in seed 010.

## The preview route

`POST /api/v1/app/questionnaires/:id/versions/:vid/detect-contradictions` —
`withAdminAuth(…)`.

- Body: `{ answers: { key, value, confidence?, provenance?, turnIndex? }[] (≥2),
mode?, windowN?, sessionId? }`.
- **Always on** — detection is a permanent capability; there is no flag to check and no route
  that 404s when off. Whether it actually runs on a given version is governed by the per-version
  `contradictionMode` config (`off` disables it). Each call spends an LLM completion, which is why
  the per-admin sub-cap below exists.
- **Per-admin LLM sub-cap** — `contradictionDetectionLimiter` (60/min), keyed on the
  admin who owns the spend.
- **DB seam** — `_lib/contradiction-context.ts` `buildContradictionContext` is the
  only Prisma in the feature: it loads the version's slots **and** its
  `contradictionMode` / `contradictionWindowN` config (so mode/window default from
  the saved config; the body may override them, so an admin can preview a different window before
  committing). Both stored value and body override go through `resolveContradictionMode`, so a
  preview of the legacy `flag` previews what the questionnaire will actually do — probe. Fewer than two answers resolving to real slots is a
  **400** (`insufficient_answers`); a missing version is a **404**.
- **Fail-soft** — a capability error returns `200` with `{ findings: [], diagnostic }`,
  never a 5xx: the engine (F4.6) must keep the conversation going rather than crash a
  pass.
- Persists nothing — a true preview, the proven seam F4.6 calls.

## Who consumes it

F4.6 (session state machine) wires persistence + the live loop: it calls
`shouldRunDetection` per turn / at the completion sweep, then this detection seam,
and renders findings to the agent. The live per-turn loop runs detection in **both**
orchestrators via the shared `runContradictionPhase` — question mode (`runTurn`) and **data-slot
mode** (`runDataSlotTurn`, comparing the background question answers). Each surfaces an informational
notice and runs the [confirm-before-overwrite flow](#probe-confirm-flow-probe-mode). See
[`per-turn-orchestrator.md`](./per-turn-orchestrator.md) and [`data-slots.md`](./data-slots.md). **F4.4** (refinement, now shipped — see
[`answer-refinement.md`](./answer-refinement.md)) acts on a confirmed contradiction:
its capability takes the finding as a `triggeringContradiction` and writes a `refine`
(transitioning provenance to `refined`); the `suggestedProbe` is F4.3's handoff to it.
**F4.5** (offer-to-submit, now shipped — see [`completion-logic.md`](./completion-logic.md))
owns the trigger point for the completion sweep: its `complete` route, on an eligible
`accept`, calls `shouldRunDetection(mode, windowN, 'completion-sweep')` and dispatches
this capability, holding the submit for review when conflicts are found.

## Not in F4.3

Resolution / overwrite / the `refined` provenance (F4.4); the completion-sweep
trigger point (F4.5); persistence, the session/turn tables, turn indexing, and an
`every_n_turns` cadence config column (F4.6/P6); the streaming chat surface (P6).
Detection is LLM-only — cross-slot semantic conflicts need a model; single-slot
validity (an off-list choice, an out-of-range number) is already caught at
extraction time by F4.2's `answer-value` check, not here.
