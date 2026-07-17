# Sensitivity awareness / safeguarding

When a respondent makes a **sensitive or contentious disclosure** mid-conversation — abuse,
distress, a safeguarding concern (e.g. "I was abused by the CEO") — the agent **notices** it,
**remembers** it at the session level, **treads carefully** in how it phrases every later
question, and **gently signposts support** once on a serious disclosure. It also gives admins a
lightweight flagged-session count. Mirrors the [seriousness gate](./seriousness-gate.md) end-to-end
(a per-turn signal → session-carried state → pure-orchestrator outcome → the route does the I/O).

## Detection — defence-in-depth (three independent signals)

Detection is **not** a single best-effort field — that was the original design and it failed: the
answer-extractor's optional `sensitivity` object was silently dropped on busy turns (the same
unreliability the seriousness gate's `suspectedNonGenuine` hint showed), so a textbook disclosure
("i'm being abused by my manager") went unflagged and **no support was signposted**. Detection is
too safeguarding-critical to ride on one model remembering an optional field.

So when the feature is on, the orchestrator merges **three** per-turn signals (strongest severity
wins; on a tie the LLM signal beats the keyword net for its better summary) via the pure
`mergeSensitivitySignals`:

1. **Answer-extractor field** — the extractor prompt still gains a conditional "Sensitivity
   assessment" block (`extraction/extraction-prompt.ts`, gated by `ExtractionContext.sensitivityAware`)
   and an optional `sensitivity` object (`extraction/extraction-schema.ts`). Kept as one cheap signal.
2. **Dedicated detector** — a single-purpose structured LLM call run **every answered turn** the
   feature is on (`invokers.detectSensitivity`, `_lib/turn-invokers.ts`; prompt + schema in
   `sensitivity/{detect-prompt,detect-schema}.ts`). Because its only job is the disclosure ruling, it
   is far more reliable than the field. This is the same lesson the seriousness gate learned by moving
   its judge to a dedicated every-turn call. Synthetic tool slug `app_detect_sensitivity`.
3. **Deterministic keyword net** — a pure, non-LLM floor (`sensitivity/keyword-net.ts`) that forces a
   `high` assessment when the message plainly contains a first-person harm disclosure or an
   unambiguous self-harm phrase. It backs up the LLM calls when they fail/time out/miss. Tuned to
   avoid obvious false positives (a bare harm word with no first-person victim marker — "this survey
   is harassment" — does not trip it); it errs toward catching, since a false positive only adds an
   unneeded gentle tone + signpost while a false negative could drop a real disclosure.

The merged assessment shape (`SensitivityAssessment`):

```
{ detected: true; severity: 'low'|'medium'|'high'; category: string; summary: string }
```

`severity` is from `SENSITIVITY_SEVERITIES` (top-level `lib/app/questionnaire/types.ts`); `summary` is a **careful, non-graphic**
one-line restatement — the only field that carries disclosure content. Off ⇒ none of the three runs
(no extractor block, no detector call, no keyword check), so the feature is **zero added prompt/cost
when disabled**. Cost when on: one extra cheap structured call per answered turn (the detector); on a
disclosure turn the seriousness judge is skipped, so it is roughly cost-neutral there.

The merge runs at **step 1.4**, before the seriousness gate (step 1.5), so the gate's
`!extractedSensitivity` guard sees the combined result — a genuine disclosure is never judged for
sincerity or struck. Pure hostility/profanity with no harm disclosure ("go fuck yourself") is flagged
by none of the three, so it correctly falls through to the seriousness gate.

**The skip is per-turn, not sticky.** Each turn re-detects from scratch; a disclosure on an earlier
turn does not suppress the gate on later turns. Both LLM detectors (the dedicated detector and the
extractor's block) are explicitly **scoped to the current message** — they receive recent
conversation only to read an oblique disclosure, never to treat later pure abuse as a fresh
disclosure. Without that scoping, a respondent who disclosed harm then swore at the interviewer had
every later abusive turn read as "distress", so the gate was skipped — the bug this scoping fixes.
The deterministic keyword net is current-message-only by construction.

## Session memory (the load-bearing piece)

Two columns on `AppQuestionnaireSession`:

- `sensitivityLevel String?` — running-**max** severity (null until first detection).
- `sensitivityNotes Json @default("[]")` — append-only `SensitivityNote[]`
  (`{ severity, category, summary, turnOrdinal, createdAt }`).

The pure orchestrator stays pure: it returns `TurnResult.sensitivity`
(`{ detected, severity, category, summary, newLevel, signpost }`) computed via the pure
`lib/app/questionnaire/sensitivity/` module (`runningMaxLevel`, `shouldSignpost`,
`composeSupportMessage`). The **route** appends the note (stamping `turnOrdinal = selectionRound`
and `createdAt`) and persists `newLevel` via `persistSensitivity` (`_lib/sessions.ts`), plus writes
a `sensitivity_flagged` event via `recordSensitivityFlagged`.

The orchestrator computes the outcome on the **non-disregarded path only** — if the abuse gate
flags the turn non-genuine, sensitivity is skipped (a troll turn is not a genuine disclosure).

## Treading carefully (every later turn)

`buildTurnContext` loads `sensitivityLevel` + the note summaries into `TurnState`. The route threads
them into the question phraser (`question-stream.ts` → `QuestionComposeInput.sensitivityLevel` /
`sensitivityNotes`), **folding the just-detected note in** so the disclosure turn's own reply
already softens; later turns inherit it from the persisted memory. When a level is set, the phraser
system prompt gains a "tread carefully" block (acknowledge gently, never press for detail they
didn't offer, avoid blunt phrasing, don't re-raise specifics) — layered on top of the static
`audience.sensitivity` line.

## Support signpost (deterministic, once per session)

On the **first** turn the running level reaches `high` (`shouldSignpost`), and only when the version
configured a non-empty `supportMessage`, the orchestrator pushes a side-band `warning` with
`code: 'support'` (the verbatim author copy + optional `supportResourceUrl`), rendered by
`components/app/questionnaire/chat/support-notice.tsx`. It's a **deterministic frame**, not phraser
prose, so the safeguarding copy can't be paraphrased or hallucinated. The route collects every
`warning` frame in `result.events` and persists them on the turn (`AppQuestionnaireTurn.warnings`),
so the support notice is **attached to the turn that raised it** — it stays pinned beneath that
reply as the conversation scrolls on, and replays inline when the surface resumes (see
`per-turn-orchestrator.md` § resume replay). Dedupe is implicit: the route persists `'high'`, so
`state.sensitivityLevel === 'high'` on every later turn ⇒ `signpost` is false. Fail-open: if the
persist write fails it may re-signpost, which is safer than missing it.

## Gating

Safeguarding is **always on** — there is no platform flag. It is governed solely by the per-version
config opt-in: `config.sensitivityAwareness` (default false) + `supportMessage` /
`supportResourceUrl`. The route runs detection only when that toggle is on. Kickoff turns force it off.

## PII discipline

The `summary` lives only on `sensitivityNotes` and in the phraser prompt. It NEVER enters:

- the provenance audit row (`extract-answer-slots.ts` `redactProvenance` records severity + category
  only),
- the `sensitivity_flagged` event metadata (`{ severity, category }` only),
- analytics (counts only).

## Admin signal (counts only)

`analytics/safeguarding.ts` `getSafeguardingSummary` counts non-preview sessions in the window that
flagged a disclosure (and how many were serious), k-anonymity suppressed below the threshold (a count
on a tiny cohort is itself re-identifying). Surfaced as a small tile on the analytics tab via
`GET …/analytics/safeguarding`. No per-session detail viewer in this pass.

## Files

- Pure core: `lib/app/questionnaire/sensitivity/{types,logic,index}.ts` (`mergeSensitivitySignals` in
  `logic.ts`).
- Detection (three signals): the extractor field — `extraction/{extraction-schema,extraction-prompt,types}.ts`,
  `capabilities/extract-answer-slots.ts`; the dedicated detector — `sensitivity/{detect-prompt,detect-schema}.ts`
  - `invokers.detectSensitivity` in `_lib/turn-invokers.ts`; the keyword net — `sensitivity/keyword-net.ts`.
- Orchestrator: `orchestrator/{orchestrator,data-slot-orchestrator,types}.ts` (step 1.4 merge →
  outcome at step 1.6; `DETECT_SENSITIVITY_TOOL_SLUG`).
- Phraser: `_lib/question-stream.ts`.
- Persistence + route: `_lib/sessions.ts`, `_lib/turn-context.ts`, `_lib/detail.ts`,
  `[id]/messages/route.ts`.
- Gating + config: `constants.ts`, `authoring/config-schema.ts`,
  `components/admin/questionnaires/config-editor.tsx`.
- UI: `components/app/questionnaire/chat/{support-notice,questionnaire-chat}.tsx`.
- Analytics: `analytics/{safeguarding,views,index}.ts` + the analytics page + route.
- Schema: `AppQuestionnaireConfig` (sensitivityAwareness/supportMessage/supportResourceUrl),
  `AppQuestionnaireSession` (sensitivityLevel/sensitivityNotes); migration
  `…_app_sensitivity_awareness` (create-only, phantom pgvector DDL stripped).
