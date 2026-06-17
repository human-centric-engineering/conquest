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
  - **`off`** — no detection.
  - **`flag`** — surface the conflict passively (a quiet informational notice) **and** refine the
    conflicting answer immediately, same turn.
  - **`probe`** — **confirm before overwrite**: nothing is changed on the detection turn. The
    interviewer asks a reconciliation question (stating that confirming will update the earlier
    answer + the linked data), the finding is parked on the session, and the change is applied only
    once the respondent confirms on the next turn. See [Probe-confirm flow](#probe-confirm-flow-probe-mode).
- **Cadence — when to run** (pure `shouldRunDetection`, **no config column**): the
  development-plan prose once listed `every_turn / every_n_turns / sweep_only`, but
  the committed schema has no cadence enum — it has `contradictionWindowN` (a
  _comparison window size_, not an interval). F4.3 models cadence as a pure
  scheduler the F4.6 engine calls:
  - `phase: 'turn'` → run every turn, comparing the last `windowN` answers
    (or all when `windowN <= 0`) — covers the prose's _every_turn_.
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
│                       ContradictionFinding, CONTRADICTION_SEVERITIES, DetectionPhase
├── detection-schema.ts contradictionDetectionSchema (+ z.toJSONSchema), validateContradictionDetection
├── detection-prompt.ts buildContradictionDetectionPrompt / …RetryMessage → LlmMessage[]
└── detection-logic.ts  normalizeContradictionFindings(...) + shouldRunDetection(...)
```

- **`ContradictionContext`** — `{ slots, answers, mode, windowN, currentStatement?,
sessionId }`, all in memory. `AnsweredSlotView` carries the actual `value` (detection
  reasons over values, not just "is answered") plus optional `provenance` (which side
  of a conflict to trust) and `turnIndex` (for windowing). **`currentStatement`** is the
  respondent's latest message — see [Same-slot reversal](#same-slot-reversal-via-the-latest-message).
- **`normalizeContradictionFindings`** — drop findings referencing unknown or
  _unanswered_ slots; require ≥2 distinct slots; **dedupe symmetric pairs** (`[a,b]`
  ≡ `[b,a]`, keep highest confidence); clamp severity; mode-shape (`flag` strips any
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
| `flag` mode finding carrying a probe       | **strip** the probe                                                                                                                |
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
- **Pre-merge answers.** Detection runs over the answers **as they were before this turn's extraction
  merged in** (`runContradictionPhase`'s `priorAnswers` = the orchestrator's `state.existingAnswers`,
  pre-`applyIntents`). This turn's contradicting statement is often extracted straight into the
  conflicting slot (`satisfaction` 1→5), which would erase the old value before the detector sees it;
  comparing the pre-merge answers against the latest message keeps it visible.

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

`flag` mode is unchanged: surface the explanation **and** refine immediately. `off` does nothing.

The seriousness gate runs BEFORE this phase, so a contradicting answer must survive it to be probed —
the judge prompt explicitly treats "contradicts an earlier answer" as genuine (see
[seriousness-gate.md](./seriousness-gate.md#a-contradiction-is-not-a-sincerity-failure)).

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
`withQuestionnairesEnabled(withAdminAuth(…))`.

- Body: `{ answers: { key, value, confidence?, provenance?, turnIndex? }[] (≥2),
mode?, windowN?, sessionId? }`.
- **Sub-flag gate** — `APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_ENABLED` (seed 011,
  off by default), on top of the master flag, because every call spends an LLM
  completion. Off → 404 (looks like a missing route). Same opt-in shape as answer
  extraction.
- **Per-admin LLM sub-cap** — `contradictionDetectionLimiter` (60/min), keyed on the
  admin who owns the spend.
- **DB seam** — `_lib/contradiction-context.ts` `buildContradictionContext` is the
  only Prisma in the feature: it loads the version's slots **and** its
  `contradictionMode` / `contradictionWindowN` config (so mode/window default from
  the saved config; the body may override them, so an admin can preview `flag` vs
  `probe` before committing). Fewer than two answers resolving to real slots is a
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
mode** (`runDataSlotTurn`, comparing the background question answers). Under `flag` mode each
surfaces an informational notice and refines immediately; under `probe` mode each runs the
[confirm-before-overwrite flow](#probe-confirm-flow-probe-mode). See
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
