# Experience routing

How an Agentic Switcher decides what a respondent should do next. Read
[`experiences.md`](./experiences.md) first for the model.

Code: `lib/app/questionnaire/experiences/{routing,carryover,run}/**`,
`app/api/v1/app/experiences/_lib/run-advance.ts`.

## The three tiers

Resolution order in `advanceExperienceRun`:

| #   | Tier             | Where                 | Cost     |
| --- | ---------------- | --------------------- | -------- |
| 1   | **Budget gate**  | `run/cost.ts`         | free     |
| 2   | **Rules**        | `routing/rules.ts`    | free     |
| 3   | **LLM selector** | `routing/select.ts`   | one call |
| —   | **Fallback**     | `routing/fallback.ts` | free     |

Rules exist for two reasons, not one. Authors want certain cases hard-pinned — **and the respondent
is standing at the fork waiting**. A rule resolves in microseconds where the selector takes seconds.
That is also why the selector runs with a 12s timeout: a deterministic fallback delivered quickly
beats a perfect answer delivered slowly.

## Never strand a respondent

> Every dead end resolves to `conclude`, never to an error — an exhausted budget, no candidates, a
> chosen step whose version was deleted, a closed round window.

Someone who has just spent ten minutes answering questions must always end up with a report. A run
left in `awaiting_handoff` means they sit on a spinner until it times out and receive nothing,
which is strictly worse than a journey that ended early.

`blocked` is reserved for an incoherent **call** — an unknown run, or a session that is not one of
its legs. It never means "the journey cannot continue".

## Idempotency

`after()`, a double-tapped submit and a cron retry can all race `advanceExperienceRun`.

**`@@unique([runId, ordinal])` on the leg table is the arbiter.** P2002 is treated as success and
the loser returns `noop`. Do **not** replace this with a pre-flight existence check — a
read-then-write check loses the race, and the failure mode is a duplicate session (and a duplicate
LLM bill) for the same respondent.

## Rules

A rule tests a **data-slot key** from the carry-over, not a question key: data slots are the
semantic answer layer and survive question rewording.

Operators: `equals` · `contains` · `gt` · `lt` · `exists`. Evaluated by ordinal, first match wins.

Behaviours that are deliberate, not incidental:

- **A non-numeric answer never satisfies `gt`/`lt`.** It is not "less than everything" — it is not
  comparable. Treating it as 0 would make `lt: 100` fire on every free-text response.
- **`gt`/`lt` extract a number from natural language** — respondents answer "about 500 people" and
  "£2.5m", not "500".
- **An empty `contains` operand never matches.** It would otherwise `includes()` into everything.
- **A rule about an unfilled slot never matches**, including `exists`.
- **A rule naming a deleted step is skipped, not an error** — the run falls through to the selector
  rather than failing a respondent's fork over an authoring slip. The admin editor flags it
  (`danglingRules`), because silence is what lets that mistake survive.

## The selector

Sees the carry-over digest and the candidates' `selectionCriteria` — **not the raw transcript**.
The digest is better signal per token, and inlining a conversation would blow the context budget on
the one call a respondent is actively waiting for.

Returns `{ decision, selectedStepKey, confidence, rationale, respondentMessage }`. `selectNextStep`
**never throws**: an unreachable provider, a hallucinated step key, or sub-threshold confidence all
resolve to the fallback.

Confidence is clamped, not rejected — a model reporting 1.2 means "very confident", and discarding
an otherwise-good decision over a malformed scalar would be perverse.

## Carry-over

Deterministic first, LLM second, then **frozen**.

1. **Deterministic (always):** data-slot fills + profile + scores + safeguarding state.
2. **LLM compression (config-gated):** a briefing plus the bridging line that opens the next leg.
3. **Frozen** onto `AppExperienceRun.carryOver`, never recomputed — an earlier leg may later be
   re-scored, and a finished report must not shift underneath it.

### Two invariants

**Anonymity is read from the SOURCE LEG's version config, never the experience's.** An anonymous
entry leg has no profile to carry regardless of what `carryProfile` says. Getting this backwards
leaks PII the respondent was promised would not be collected.

**Safeguarding state carries unconditionally.** No setting gates it, and
`createSessionForExperienceLeg` copies `sensitivityLevel`/`sensitivityNotes` onto the new session.
An experience that forgets a disclosure between legs makes the next interviewer re-open it — the
worst thing this feature can do to someone. Carried as **summaries only**; the raw disclosure text
stays in the originating transcript.

**Provisional fills are not carried.** They are inferences recorded after the pipeline gave up on a
re-ask, shown to the respondent as "may revisit". Carrying them forward as settled fact would
launder a guess into a premise.

### Rendering a fill as text

`carryover/text.ts` is the single place a slot value becomes text, because rules and prompts must
agree.

- `fillText` — **value first**. A rule author writing `equals: "yes"` means the answer.
- `fillPromptText` — **paraphrase first**. Prose gives a model far more to work with.

`valueToText` never produces `[object Object]`. In a prompt that would silently replace a real
answer with a meaningless token the model cannot know was a substitution.

## Budget

`AppQuestionnaireConfig.costBudgetUsd` is **per session**, so an n-leg run would silently get n×
the intended spend. `AppExperience.costBudgetUsd` is the run-level ceiling.

- `mustConcludeForBudget` at the **handoff gate** — the single highest-value control.
- `effectiveLegBudget` takes the **tighter** of the session cap and the run's remainder.
- `remainingRunBudget` **floors at 0**. A negative remainder would read as a non-positive cap —
  i.e. _uncapped_ — handing an overspent run unlimited budget.

## The poll endpoint

`GET /api/v1/app/experiences/runs/:runId/status` — the respondent's client asks "what next?".

**It must stay cheap** (two indexed reads, no LLM, no writes) and **must never trigger work**. A
poll that could cause an advance would let a page refresh double-fire the handoff. P15.5's
facilitator console reuses this primitive, so a room of forty polling every 1.5s is the real load
profile.

Ownership is proven against the run's **legs**, not the run row: the no-login surface holds a token
for a session and the authenticated surface owns sessions — neither knows a run id. An unproven
caller gets 404, not 403, so run ids are not enumerable.

## Provenance

Every decision writes an `AppAiRun` (`subjectKind: 'experience_run'`, `kind: 'experience_routing'`)
— **including rule and budget outcomes**, which record `provider: 'deterministic'`. A real
filterable value rather than a fake provider slug, so cost trends stay clean.

The dry-run endpoint (`POST /:id/preview-routing`) records one too, subject-scoped to the
experience: an author comparing two phrasings of a criterion wants both attempts on the record.

## Related

- [`experiences.md`](./experiences.md) — the model and the continuity modes
- `.context/app/planning/features/f15.2.md` — what shipped and why
- [`ai-run-provenance.md`](./ai-run-provenance.md) — the run-capture contract
