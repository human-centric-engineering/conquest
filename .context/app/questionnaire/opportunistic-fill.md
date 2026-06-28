# Opportunistic form-fill + confidence loop

ConQuest's job is to take the hassle out of form-filling: the agent fills the underlying
questionnaire **on a good hunch** from what the respondent says, then circles back to confirm the
shaky ones — and the confidence score is the engine that decides what to auto-fill, what to
double-check, and when to stop.

This documents the end-to-end loop. It sits on top of the Data Slots feature (the conversational
capture layer) and the answer-slot persistence (`answer-slots.ts`, the structured deliverable).

## The loop

```
fill aggressively (a guess)  →  guess lands at a discounted, Tentative confidence
        →  it doesn't count toward completion until confirmed (re-targeting pressure)
        →  a corroborating turn strengthens it (never lowers)
        →  once it crosses the floor it's "confirmed" and the agent moves on
        →  the respondent sees the confidence on each form field and can correct it
```

## Where each piece lives

| Concern                                                 | Code                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confidence accrual** (strengthen on confirmation)     | `lib/app/questionnaire/refinement/confidence-accrual.ts`                                                                                                     | `accrueConfidence()` steps a same-value re-confirmation toward a 0.95 ceiling, **never lowers**. Wired into the per-turn upsert (`turn-run.ts`): a same-value re-statement strengthens; a changed value overwrites (refinement path).                                                                                                                                  |
| **Down-propagation** (fill the form from a fill)        | `lib/app/questionnaire/capabilities/opportunistic-fill.ts` (`selectOpportunisticTargets`, `buildFreeTextOpportunisticIntents`, `capOpportunisticConfidence`) | A confident data-slot fill seeds its **unanswered** mapped questions: free-text from the paraphrase; choice/likert through the answer-fit resolver. Capped at `OPPORTUNISTIC_CONFIDENCE_CAP` (0.45 — Tentative), provenance `inferred`. Never targets an already-answered question (no overwriting a real answer with a guess). Numeric/boolean/date are out of scope. |
| **Confirmation refresh** (strengthen the mapped answer) | `opportunistic-fill.ts` (`selectRefreshTargets`, `buildRefreshIntents`)                                                                                      | When a data-slot fill's confidence **rose this turn** (genuine corroboration), re-emit its still-tentative (`inferred`, below-floor) mapped answers at the new confidence — same value, so the accrual guard only raises it. Strictly gated: only fills that strengthened, only inferred answers below the floor, never respondent/refined ones.                       |
| **Wiring**                                              | `lib/app/questionnaire/capabilities/extract-answer-slots.ts` (step 5c)                                                                                       | Runs SEED then REFRESH after the primary extraction + answer-fit pass; the intents flow through the normal `turn-run.ts` upsert.                                                                                                                                                                                                                                       |
| **Configurable floor + completion gating**              | schema `answerConfidenceFloor` (default 0.5); `completion-logic.ts` `assessCompletion`                                                                       | A below-floor answer doesn't count toward coverage, the min-answered gate, or a required question until corroborated. Unscored (authoritative) answers always count; a floor of 0 disables gating. 0.5 gates the 0.45 guesses without blocking genuine answers. Threaded to the extractor so the refresh uses the configured floor.                                    |
| **Form-field surfacing**                                | `components/app/questionnaire/form/questionnaire-form.tsx` (`ConfidenceScore`)                                                                               | Each agent-filled field shows its confidence band (Tentative → Confident) next to the "Inferred" marker, so the respondent knows which answers to glance at. Drops once they edit the field themselves.                                                                                                                                                                |

## Provenance / confidence as the signal

There is **no separate "opportunistic" flag** — `provenance: 'inferred'` + a confidence below the
floor IS the signal. That keeps the contract small: completion gating, the refresh, and the form UI
all key off confidence + provenance, which already travel with every answer.

The shared confidence→label bands live in `lib/app/questionnaire/panel/confidence.ts`
(Confident ≥0.85 · Fairly sure ≥0.65 · Tentative ≥0.45 · Unsure <0.45) — reused everywhere so the
panel chip, the form chip, and the prompt anchors can't drift.

## Anti-patterns

- **Don't** down-propagate to an already-answered question — you'd overwrite a real answer with a
  guess. The selection deliberately excludes `answeredKeys` (this turn + prior).
- **Don't** synthesise a typed value the conversation doesn't support — choice/likert go through the
  fit resolver, which omits when there's no honest fit; numeric/date/boolean are left for the
  extractor or a direct statement.
- **Don't** let confirmation lower a score — accrual is monotonic by construction (`max` + a step
  toward the ceiling). A genuine _change_ of stance is a refinement (new value), not corroboration.
- **Don't** count a tentative guess toward completion — the floor exists so a guess fills the form
  for convenience without letting the session finish before it's confirmed.
