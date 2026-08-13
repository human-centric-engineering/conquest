---
feature: F17-followups
title: P17 Adaptive Scope — everything deferred, open, or deliberately not built
phase: P17 — Adaptive Scope
status: open
owner: TBD
opened: 2026-08-12
docs: .context/app/questionnaire/adaptive-scope.md
---

# P17 follow-ups

Everything left open when F17.1–F17.7 shipped. Consolidated here so a follow-up does not have to
reconstruct it by reading seven trackers, the Merlin5 research doc's capability table, and the
authoring script's stdout.

**Nothing below is blocking.** Adaptive Scope works end to end without any of it, and the Merlin5
Growth Assessor runs. What the first four items blocked was a **faithful** Merlin5 — three of them
(§1, §3, §4) have since shipped, leaving §2 and the guardrail in §5 as the workbook behaviour we
cannot yet express.

Ordered by value. Each heading carries a rough size, so a follow-up can tell a half-hour job from a
phase without reading the whole entry.

> **Where these came from.** §1–§4 are capabilities C7, C6, C8 and C9 of
> [`../../research/merlin5-growth-assessor.md`](../../research/merlin5-growth-assessor.md) §2, plus
> guardrails G03 and G05 from that workbook's Guardrails tab. `scripts/author/merlin5-growth-assessor.ts`
> prints §1, §3, §4 and G03 on **every run**, so an operator authoring the instrument is told rather
> than left to find out.

---

## 1. Time as a budget (C7) · **DONE** — see [`f17.8.md`](./f17.8.md) and [`f17.9.md`](./f17.9.md)

> Shipped 2026-08-13, in two halves. `f17.8` prices the instrument in seconds and shows an author the
> arithmetic (`sessionBudgetSeconds`, per-type costs, the floor and the allowance, two coherence
> checks); `f17.9` makes the planner obey it — a fit stage in `guardrails.ts` that drops the
> lowest-ranked topic that does not fit, seated after the rules and the fallback and **before** the
> blind-spot check, whose seconds it reserves rather than treating as free. The count survives
> alongside it: `maxConditionalTopics` bounds breadth, the budget bounds duration, and neither
> implies the other.
>
> Two things named below are still open, and deliberately: nothing prices the interviewer's own
> turns (see §5, G03), and a running interview is never re-planned — the budget bounds what is
> asked, not what is spent.

**What the client specified:** a 600-second session, item-level time estimates (8s per likert, 45s
per free-text, 40s per opening question), and a planner that fits the plan to the seconds remaining.
The famous "maximum three routed sections" (G01) is **derived**, not chosen:

```
Mandatory floor:  S0 (160) + S1 (8) + S4 (8) + S15 (90)   = 266s
Remaining for routed sections                              = 334s
The three most expensive routed sections (S14+S11+S2)      = 332s ← exactly fits
A fourth, even the cheapest (S6/S8/S9 at 61s)              = 393s ✗
```

**What we built:** `adaptiveScope.maxConditionalTopics`, a topic **count**, defaulting 3.

**Why it matters:** a client who says "make it fifteen minutes" needs a code change today. Modelled
in seconds, they need a settings field. The count also cannot see that S14 (10 items) and S6 (3
items) cost wildly different amounts of a respondent's attention — three topics is not a length.

**Shape of the work:** per-type second estimates as version config; an `estimatedSeconds` on each
topic derived from its members; a `sessionBudgetSeconds` setting; and a fit stage in
`guardrails.ts` that drops the lowest-ranked topic that does not fit, seated **after** rule-includes
and **before** the blind-spot check.

**One finding to carry in:** the workbook's own arithmetic does not account for G04's two blind-spot
items (16s). The worst-case plan comes to 348s against a 334s allowance — trivial in practice, but
the budget must count the check topic rather than treating it as free. _(It does: the reserve is
re-asked on every pass of the fit, because the check is chosen from what the fit drops.)_

---

## 2. Item injection at arbitrary granularity (C6) · **~1–2 days**

**What exists:** `light` depth takes a topic's two highest-weight members —
`LIGHT_DEPTH_MEMBER_COUNT`, a module constant. That covers G04 (the blind-spot check) exactly,
which is why Merlin5 works.

**What does not:** carrying an arbitrary subset of items from a non-selected topic — three items
from one, one from another, or a named item rather than a weight-ranked one. `PlannedTopic` carries
a `depth`, not a member list.

**Whether to build it:** only when a second instrument actually needs it. A one-question topic
already expresses a fine-grained dependency (that is the "size is not significant" design), so the
honest question is whether anyone needs _partial_ selection of a topic they did not select — as
opposed to authoring the two items as their own topic, which works today.

---

## 3. Cross-scale normalisation (G06 / C8) · **DONE** — see [`f17.10.md`](./f17.10.md)

> Shipped 2026-08-13, and wider than recorded below: the trap is not confined to Merlin5's 1–6
> section. Nothing constrains a scoring item's type, so a `numeric` ranged 0–50 could already sit in
> a scale beside 1–5 likerts and decide it outright. `ScoringSchemaContent.normalise` (off by
> default) puts every item on a 0–1 ruler; the save is refused when band cutoffs no longer match it.

**The trap:** Merlin5's Section 14 runs a **1–6** agreement scale; Sections 1–13 run **1–5** extent.
`scoreSession` combines raw item values by weighted sum or mean with no normalisation, so a
composite spanning Section 14 and anything else is arithmetic over two different rulers. It will
produce a number. The number will be wrong, and nothing will say so.

**Mitigation today:** the Merlin5 instrument ships with **no scoring schema**, and
`scripts/author/merlin5-growth-assessor.ts` prints "do not build a composite across Section 14 and
the rest until this lands" on every run.

**Shape of the work:** `ItemBounds` is already loaded per item for reverse-scoring, so the pieces
are there — normalise each item to 0–1 against its own bounds before combining, behind a
`ScoringSchemaContent.normalise` flag so existing single-scale schemas do not silently change value.

---

## 4. Open-vs-close reconciliation (G05 / C9) · **DONE** — see [`f17.11.md`](./f17.11.md)

> Shipped 2026-08-13. `generation.reconciliation` (off by default) names the two ends by key, or
> derives them from Adaptive Scope topic phases, and puts freshly-computed scores in the writer's
> prompt for the first time. The prompt block instructs the writer to name the disagreement, and
> forbids manufacturing one.

The workbook is unusually direct about this one:

> "Disagreement between what they say they need and what the scores show is the most valuable output
> the tool produces."

Merlin5 asks for goals at 0.2, asks what they want done at 15.1/15.2, and scores the sections in
between. Nothing currently holds the three against each other — the report writer sees them as
undifferentiated transcript.

**Shape of the work:** `generateReportFromInputs` already takes pre-assembled inputs, so this is an
inputs-plus-prompt change rather than a new pipeline: a `reconciliation` block carrying
`{ statedGoal, askedForActions, scoredResult, planCoverage }` and an instruction to **surface the
disagreement** rather than smooth it. It pairs with the blind-spot check — G04 exists precisely so
there is something in the result the respondent did not already believe.

---

## 5. One probe maximum across the opening (G03) · **~1 day**

**What the client specified:** probe only when an answer is too abstract to route ("a predictable
revenue engine"); do not probe when it is already routable ("reps who cannot hold a CFO
conversation"); **one probe for the whole opening**, because every probe costs a section of the
budget.

**What exists:** nothing session-scoped. The interviewer probes per its own strategy settings, and
`maxDataSlotAttempts` is per slot, not a shared allowance.

**Shape of the work:** a routable-or-not classifier on the opening's answers plus a session-scoped
probe counter. Note the two halves are separable — the counter is cheap; the classifier is the part
that needs care, since spending the probe on an already-routable answer is the failure G03 names.

---

## 6. Cohort reporting ignores partial assessment · **~half a day** · _a correctness trap_

`ScaleScore` now carries `assessedItemCount` / `totalItemCount` and `isPartiallyAssessed()` exists,
but **no cohort chart or segment table reads them**. A band computed from three of a scale's eight
items and one computed from all eight can still land in the same column, and the chart will look
exactly as confident either way.

Until this lands, a cohort report over an adaptive instrument is comparing respondents who answered
different instruments.

---

## 7. The PDF export narrows silently · **~an hour**

`loadSessionExport` already filters sections to the interview's scope, so an unasked question does
not appear — but the export does not print the `notAssessed` list the session-export builds. A
reader cannot tell a short instrument from a narrowed one.

The report's method panel says it; the export does not.

---

## 8. Nothing reports on respondent amendments · **~half a day**

Every amendment is recorded twice — on `InterviewPlan.amendments` and as a `source: 'respondent'`
topic — specifically so routing quality can be measured. Nothing reads either.

"How often did respondents have to correct the plan, and for which topics?" is the sharpest
available signal that a version's criteria are wrong, and it is one query away.

---

## 9. Routing Analyst reads one document · **~half a day**

`buildRoutingAnalysisInput` takes the **newest** source document only. An instrument delivered as
several files — a question bank plus a separate routing memo — needs either a re-ingest that merges
them or a multi-document input.

Merlin5 arrived as one workbook, so this has not bitten yet.

---

## 10. Smaller things

- **No drag-reorder of topics.** Up/down buttons only. Fine for a dozen, tedious for forty.
- **No duplicate-membership check.** A question claimed by two topics is tolerated (asked if either
  is in scope; attributed to the first in-scope topic in ordinal order) but an author almost never
  means it, and `validateAdaptiveScope` does not look.
- **The amendment cue gate is English-only.** A localised respondent surface needs the cue list per
  locale, or the regex replaced by a cheap classifier.
- **No replay of a recorded analysis.** The `AppAiRun` snapshot holds the analyst's output but not
  the resolved prompt, so a rubric change cannot be diffed against past runs.
- **Merlin5 criteria carry builder-facing sentences.** A few of the client's NOTES are addressed to
  whoever builds the thing ("See guard G02", "Ask nothing to elicit it"). Inert to the planner;
  trimming them automatically would have meant deciding which of the author's sentences count, so
  they are left for a human on the Topics tab.

---

## A note on where this is recorded

The project plan
([`../development-plan.md`](../development-plan.md)) covers **P0–P9 only** — its phase list stops at
P9, its `Status` field ends at "P9 done", and its "Work completed to date" log's newest entry is
2026-06-28. Everything from P10 onward, this phase included, is tracked in `planning/features/`
trackers plus the domain docs under `.context/app/questionnaire/`.

So "is C7 in the plan?" has a short answer: **no — nothing after P9 is.** This file is the record
for P17. Bringing the plan itself up to date across P10–P17 is a separate job, and a real one.

---

## Related

- [`f17.1-ui.md`](./f17.1-ui.md) · [`f17.4.md`](./f17.4.md) · [`f17.5.md`](./f17.5.md) ·
  [`f17.6.md`](./f17.6.md) · [`f17.7.md`](./f17.7.md) — the shipped trackers
- [`../../questionnaire/adaptive-scope.md`](../../questionnaire/adaptive-scope.md) — the domain doc
- [`../../research/merlin5-growth-assessor.md`](../../research/merlin5-growth-assessor.md) — the
  capability table (C1–C11) these are numbered against
- [`f15-followups.md`](./f15-followups.md) — the same shape, for Experiences
