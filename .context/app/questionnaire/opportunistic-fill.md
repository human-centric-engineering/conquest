# Opportunistic form-fill + confidence loop

ConQuest's job is to take the hassle out of form-filling: the agent fills the underlying
questionnaire **on a good hunch** from what the respondent says, then circles back to confirm the
shaky ones — and the confidence score is the engine that decides what to auto-fill, what to
double-check, and when to stop.

This documents the end-to-end loop. It sits on top of the Data Slots feature (the conversational
capture layer) and the answer-slot persistence (`answer-slots.ts`, the structured deliverable).

## The loop

```
fill aggressively (a guess)  →  guess lands at a discounted confidence
        (a loose fill is Tentative + below the floor; a CLEARLY-mapped choice/likert
         keeps the resolver's clarity up to 0.75 "Fairly sure" and counts straight away)
        →  a below-floor guess doesn't count toward completion until confirmed (re-targeting pressure)
        →  a corroborating turn strengthens it (never lowers)
        →  once it crosses the floor it's "confirmed" and the agent moves on
        →  the respondent sees the confidence on each form field and can correct it
```

## Where each piece lives

| Concern                                                 | Code                                                                                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confidence accrual** (strengthen on confirmation)     | `lib/app/questionnaire/refinement/confidence-accrual.ts`                                                                                                                    | `accrueConfidence()` steps a same-value re-confirmation toward a 0.95 ceiling, **never lowers**. Wired into the per-turn upsert (`turn-run.ts`): a same-value re-statement strengthens; a changed value overwrites (refinement path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Down-propagation** (fill the form from a fill)        | `lib/app/questionnaire/capabilities/opportunistic-fill.ts` (`selectOpportunisticTargets`, `freeTextFitCandidates`, `capOpportunisticConfidence`, `dedupeIdenticalFreeText`) | A confident data-slot fill answers its **unanswered** mapped questions, provenance `inferred`, never overwriting an already-answered question. **Both types go through the answer-fit resolver**, which judges each mapped question on its own wording: choice/likert map onto their option/scale point; free text is answered in that question's own terms, or **omitted** when the theme was covered but that specific question wasn't. **Two ceilings, deliberately different:** free text keeps the flat `OPPORTUNISTIC_CONFIDENCE_CAP` (0.45 — Tentative; prose the respondent never gave for _this_ question is a guess however well it reads). Choice/likert **preserve** the resolver's mapping-clarity judgment up to `OPPORTUNISTIC_TYPED_CONFIDENCE_CAP` (0.75) — a clearly-pinned likert reads "Fairly sure", not "Tentative". The ceiling stays below "Confident" (0.85), which corroboration earns via accrual. Numeric/boolean/date are out of scope. |
| **Confirmation refresh** (strengthen the mapped answer) | `opportunistic-fill.ts` (`selectRefreshTargets`, `buildRefreshIntents`)                                                                                                     | When a data-slot fill's confidence **rose this turn** (genuine corroboration), re-emit its still-tentative (`inferred`, below-floor) mapped answers at the new confidence — same value, so the accrual guard only raises it. Strictly gated: only fills that strengthened, only inferred answers below the floor, never respondent/refined ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Wiring**                                              | `lib/app/questionnaire/capabilities/extract-answer-slots.ts` (step 5c)                                                                                                      | Runs SEED then REFRESH after the primary extraction + answer-fit pass; the intents flow through the normal `turn-run.ts` upsert. Free-text and typed targets ride **one** resolver call, so the added cost is one call only on turns whose fills map free text alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Configurable floor + completion gating**              | schema `answerConfidenceFloor` (default 0.5); `completion-logic.ts` `assessCompletion`                                                                                      | A below-floor answer doesn't count toward coverage, the min-answered gate, or a required question until corroborated. Unscored (authoritative) answers always count; a floor of 0 disables gating. 0.5 gates the 0.45 guesses without blocking genuine answers. Threaded to the extractor so the refresh uses the configured floor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Form-field surfacing**                                | `components/app/questionnaire/form/questionnaire-form.tsx` (`ConfidenceScore`)                                                                                              | Each agent-filled field shows its confidence band (Tentative → Confident) next to the "Inferred" marker, so the respondent knows which answers to glance at. Drops once they edit the field themselves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Provenance / confidence as the signal

There is **no separate "opportunistic" flag** — `provenance: 'inferred'` + a confidence below the
floor IS the signal. That keeps the contract small: completion gating, the refresh, and the form UI
all key off confidence + provenance, which already travel with every answer.

The shared confidence→label bands live in `lib/app/questionnaire/panel/confidence.ts`
(Confident ≥0.85 · Fairly sure ≥0.65 · Tentative ≥0.45 · Unsure <0.45) — reused everywhere so the
panel chip, the form chip, and the prompt anchors can't drift.

## One fill, many mapped questions (the `JP29` defect)

A data slot may map several questions, but a fill records **one** position. Free text used to be
seeded by copying the fill's paraphrase onto every mapped question — so an "Ego and Higher Self" slot
mapping three questions produced three **byte-identical** answers, none of which addressed the
question above it. No confidence cap makes a misfiled answer right, so free text now gets the same
per-question judgment the typed path always had, guarded three ways:

1. **Per-question resolution** — each mapped free-text question is judged on its own wording and
   answered in its own terms, or omitted. The prompt (`free_text_resolution_rules`) is the _inverse_
   of the typed framing: typed candidates should commit to the closest fit, free-text candidates
   should expect to omit most of the time.
2. **A deterministic backstop** — `dedupeIdenticalFreeText()` drops any free-text answer whose prose
   duplicates another in the same turn (normalised for case/spacing/punctuation, highest confidence
   wins). A prompt is a request; this is the guarantee.
3. **A safe failure path** — when the resolver can't run at all, `soleMappedFreeTextTargets()` seeds
   only fills mapping **exactly one** free-text question, where duplication is impossible. A
   multi-mapped fill is dropped rather than seeded into an arbitrary one of its questions.

**Upstream, this is a design smell worth catching at authoring time:** a slot mapping more than one
_free-text_ question is usually over-consolidated. Typed batteries consolidate well (ten satisfaction
items → one "Role satisfaction" slot, each mapped onto its own scale); distinct free-text questions
do not, because there is only one paraphrase to give them. See `data-slots.md`.

## Anti-patterns

- **Don't** down-propagate to an already-answered question — you'd overwrite a real answer with a
  guess. The selection deliberately excludes `answeredKeys` (this turn + prior).
- **Don't** reintroduce a blanket paraphrase copy for free text — `buildFreeTextOpportunisticIntents()`
  survives only as the resolver-failure fallback, and only behind `soleMappedFreeTextTargets()`.
  Calling it on the normal path pastes one summary under every mapped question again.
- **Don't** synthesise a typed value the conversation doesn't support — choice/likert go through the
  fit resolver, which omits when there's no honest fit; numeric/date/boolean are left for the
  extractor or a direct statement.
- **Don't** let confirmation lower a score — accrual is monotonic by construction (`max` + a step
  toward the ceiling). A genuine _change_ of stance is a refinement (new value), not corroboration.
- **Don't** count a tentative guess toward completion — the floor exists so a guess fills the form
  for convenience without letting the session finish before it's confirmed.
