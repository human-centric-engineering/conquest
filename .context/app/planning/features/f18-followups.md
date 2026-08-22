---
feature: F18-followups
title: P18 interviewer policy — everything deferred, open, or deliberately not built
phase: P18 — Per-questionnaire interviewer policy
status: open
owner: TBD
opened: 2026-08-22
docs: .context/app/questionnaire/interviewer-house-rules.md
---

# P18 follow-ups

The phase-level record of what is still open across the three interviewer-policy features — house
rules (`f18.1`), question fidelity (`f18.2`), and the funnel arc (`f18.3`) — plus the ring of
follow-ups that closed around them (`f18.4`–`f18.7`). Same shape as
[`f15-followups.md`](./f15-followups.md) and [`f17-followups.md`](./f17-followups.md).

**Nothing below is blocking.** All three features work end to end without any of it.

---

## 1. Nothing judges whether a policy is any good · **DONE** — see [`f18.8.md`](./f18.8.md)

> Shipped 2026-08-22 in two PRs. Four judges (`rule_coherence`, `arc_fit`, `fidelity_calibration`,
> `cross_layer_conflict`), twelve single-field ops, a review queue with one-click apply, and a
> top-level Questionnaire Pack section. Both things flagged below as worth carrying held up: the
> "no reconciler" argument really is different here, and there really is no provenance column — the
> audit log carries `previousValue` instead.
>
> Still open, and deliberately: the judges are **structural**. They read authored config, never live
> session data or the F18.7 behavioural findings. Layering that signal in is a later phase.

<details>
<summary>The original entry</summary>

Question design has a judge panel (F5.1–F5.3). Routing design has one (F17.21). The interviewer
policy — house rules × the arc × per-question fidelity, three layers resolved by later-section-wins
— has only mechanical lints (`detectConfigConflicts`, 20 checks) and no judgement.

The mechanical checks answer "is this well-formed". Nobody answers "is a rule too vague to change
any turn", "does this pace suit a reflective 60-question instrument", "is the fidelity dial set
coherently across the battery", or "does this rule fight the humour dial it sits above".

A design exists for it, worked through against the F17.21 template: a fourth sibling module
`lib/app/questionnaire/policy-evaluation/`, four dimensions (`rule_coherence`, `arc_fit`,
`fidelity_calibration`, `cross_layer_conflict`), eleven single-field edit ops, a new top-level
`PackInclude.interviewerPolicy` flag, and two PRs of roughly 4,600 prod lines. Two things in it are
worth carrying even if the panel is never built:

- **The "no reconciler" argument is NOT the scope panel's.** Three dimension pairs here genuinely can
  target the same field of the same object, so per-op staleness stops being incidental and becomes
  the only thing preventing a silent overwrite.
- **There is no provenance column to stamp on an applied edit.** Neither `AppQuestionSlot` nor
  `HouseRule` has the `source` field `AppQuestionnaireTopic` has, so the audit log is the only record
  that an AI suggestion — not a human — chose a value. Its metadata must carry `previousValue`.

## 2. Nothing measures whether a must-ask question was put _as written_ · **~1 day**

`f18.7` reports whether each `must_ask` question was **reached** and how often its answer control
was rendered. `cardShown` is the closest the schema comes to compliance and it is a proxy: the card
is emitted only for a **typed** must-ask, so a `free_text` one correctly reaches without one.

Judging the wording is a judgement, not a counter — the natural home is the turn evaluator, which
since `f18.4` is told the level and can now be asked to report on it.

## 3. The opening-probe allowance is not reported · **~half a day**

Derivable from the turn record the way Adaptive Scope already derives `spent` (opening turns minus
distinct opening slots), but it needs the opening-topic join. Cut from `f18.7` to keep that phase to
one migration.

## 4. Smaller things

- **House rules, from the feature doc's own Deferred list:** verbatim `if_asked` responses (a
  per-rule flag for compliance clients needing exact wording); per-topic rule scoping (binding a rule
  to an Adaptive Scope topic or section rather than the whole questionnaire); client-level rule
  libraries (a shared set inherited by every questionnaire for a client).
- **The two PDF `QuestionBlock` components are duplicated** — byte-identical in
  `instrument-pdf-document.tsx` and `pack-pdf-document.tsx`. Deduping is a real refactor of two
  document trees; noted in `f18.5` rather than half-done.
- **The live Turn Inspector only knows the question key when a card was rendered.** So the live
  evaluate path resolves per-question fidelity for `must_ask` turns and last-resort re-asks, and
  falls back to version-level context elsewhere. The saved-turn path has no such limit. Threading a
  key through the whole inspector dump to close a preview-only gap was judged not worth the coupling.
- **Nothing lints the reverse direction.** `f18.6` checks what the interviewer does to Adaptive
  Scope. Whether the topic criteria are written against the kind of answer the opening actually
  invites is a judgement — item 1.

---

## Related

- [`f18.1.md`](./f18.1.md) · [`f18.2.md`](./f18.2.md) · [`f18.3.md`](./f18.3.md) — the three features
- [`f18.4.md`](./f18.4.md) · [`f18.5.md`](./f18.5.md) · [`f18.6.md`](./f18.6.md) ·
  [`f18.7.md`](./f18.7.md) — the ring of follow-ups
- [`f17-followups.md`](./f17-followups.md) — the same shape, for Adaptive Scope
