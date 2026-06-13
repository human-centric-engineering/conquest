# Sensitivity awareness / safeguarding

When a respondent makes a **sensitive or contentious disclosure** mid-conversation — abuse,
distress, a safeguarding concern (e.g. "I was abused by the CEO") — the agent **notices** it,
**remembers** it at the session level, **treads carefully** in how it phrases every later
question, and **gently signposts support** once on a serious disclosure. It also gives admins a
lightweight flagged-session count. Mirrors the [seriousness gate](./seriousness-gate.md) end-to-end
(a per-turn signal → session-carried state → pure-orchestrator outcome → the route does the I/O).

> **Best-effort, not a guarantee.** Detection rides on the answer-extractor's structured output
> (the same place the seriousness gate's `suspectedNonGenuine` hint lives, which proved
> occasionally unreliable). A miss simply means that turn isn't softened — no hard safeguarding
> guarantee is claimed.

## Detection — folded into extraction (no extra LLM call)

When the feature is on (platform flag AND the per-questionnaire toggle), the answer-extractor
prompt gains a conditional "Sensitivity assessment" block (`extraction/extraction-prompt.ts`, gated
by `ExtractionContext.sensitivityAware`) and the output schema gains an optional `sensitivity`
object (`extraction/extraction-schema.ts`):

```
sensitivity?: { detected: true; severity: 'low'|'medium'|'high'; category: string; summary: string }
```

`severity` is from `SENSITIVITY_SEVERITIES` (top-level `lib/app/questionnaire/types.ts`); `summary` is a **careful, non-graphic**
one-line restatement — the only field that carries disclosure content. Off ⇒ the block is not
appended and the field is ignored, so the feature is **zero added prompt/cost when disabled**.

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
prose, so the safeguarding copy can't be paraphrased or hallucinated. Pushed **last** in
`result.events` (the chat keeps a single notice slot). Dedupe is implicit: the route persists
`'high'`, so `state.sensitivityLevel === 'high'` on every later turn ⇒ `signpost` is false.
Fail-open: if the persist write fails it may re-signpost, which is safer than missing it.

## Gating

- Platform flag `APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_ENABLED` (`isSensitivityAwarenessEnabled()`
  = app && live && sub-flag; seed `032-sensitivity-awareness-flag.ts`, default off).
- Per-questionnaire `config.sensitivityAwareness` (default false) + `supportMessage` /
  `supportResourceUrl`. The route runs detection only when **both** the flag and the toggle are on
  (`flags.sensitivityAwareness`). Kickoff turns force it off.

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

- Pure core: `lib/app/questionnaire/sensitivity/{types,logic,index}.ts`.
- Detection: `extraction/{extraction-schema,extraction-prompt,types}.ts`,
  `capabilities/extract-answer-slots.ts`, `_lib/turn-invokers.ts`.
- Orchestrator: `orchestrator/{orchestrator,data-slot-orchestrator,types}.ts` (step 1.6).
- Phraser: `_lib/question-stream.ts`.
- Persistence + route: `_lib/sessions.ts`, `_lib/turn-context.ts`, `_lib/detail.ts`,
  `[id]/messages/route.ts`.
- Gating + config: `constants.ts`, `feature-flag.ts`, `authoring/config-schema.ts`,
  `components/admin/questionnaires/config-editor.tsx`, seed `032-sensitivity-awareness-flag.ts`.
- UI: `components/app/questionnaire/chat/{support-notice,questionnaire-chat}.tsx`.
- Analytics: `analytics/{safeguarding,views,index}.ts` + the analytics page + route.
- Schema: `AppQuestionnaireConfig` (sensitivityAwareness/supportMessage/supportResourceUrl),
  `AppQuestionnaireSession` (sensitivityLevel/sensitivityNotes); migration
  `…_app_sensitivity_awareness` (create-only, phantom pgvector DDL stripped).
