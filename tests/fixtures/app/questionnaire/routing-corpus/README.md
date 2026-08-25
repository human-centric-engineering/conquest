# Adaptive Scope routing corpus

Ten synthetic instruments for measuring whether the ingest → candidacy → Routing
Analyst chain configures Adaptive Scope well across **varied document shapes**, not
just the one workbook family it has been exercised on.

**No third-party content is reproduced here** — every document was written for this
repository, following the convention of the sibling `sample-questionnaire.md`.

## Why this exists

Before this corpus, the pipeline's only real-world evidence was two versions of one
document family, and that document carried an explicit `ASK RULE` column — a
machine-readable routing instruction in a structured field. That is the friendliest
input the pipeline will ever see, and a good result on it says little about the
general case.

Nothing in the repo measures analyst quality across document types: the tests under
`tests/unit/lib/app/questionnaire/scope/` are unit tests of pure functions (prompt
assembly, schema validation, guardrail arithmetic), and `AiEvaluationRun` only accepts
a `subjectKind` of `agent` or `workflow` — the Routing Analyst is a capability
dispatched from a route handler.

## Ground truth is knowable here, and that is the point

For a real client instrument, "what should the analyst have proposed" needs the
author's judgement. These documents were **constructed**, so the intended routing is
known by construction and recorded below. That makes the corpus usable as a
regression fixture without a separate gold-set authoring exercise.

The trade is that synthetic documents are cleaner than real ones. This corpus tests
variety of _form and phrasing_; it does not test the messiness of a real PDF export.
See "Known gaps" below.

## The axes

| Axis                           | What varies                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Where routing intent lives** | structured column · prose preamble · inline notes · section headings only · back appendix · nowhere · two places that disagree |
| **Phrasing**                   | every document uses a different vocabulary for the same idea — see the table below                                             |
| **Semantics**                  | eligibility · role routing · breadth limits · depth modulation · terminating screeners · mid-interview triggers                |
| **Position**                   | routing at the front, inline, and past 20k characters at the back                                                              |
| **Domain**                     | ten unrelated fields, deliberately — the prompts were made domain-neutral in `708d830b5` and that change is otherwise untested |

## The documents

| #   | File                                | Domain                   | Routing lives                                                     | Phrasing used                                                                             | Tests                                                                                                                                                                                      |
| --- | ----------------------------------- | ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01  | `01-medication-review.csv`          | Community pharmacy       | Structured `When to ask` column                                   | "Only where…"                                                                             | Baseline. The Merlin-like easy case, in CSV rather than XLSX.                                                                                                                              |
| 02  | `02-safeguarding-review.md`         | School safeguarding      | Prose "How to use this review" preamble                           | "only complete a part where…"                                                             | Prose instruction page at the front.                                                                                                                                                       |
| 03  | `03-site-safety-audit.md`           | Industrial safety        | Inline notes under each heading                                   | "_Applies to:_"                                                                           | Routing scattered across the body, not centralised.                                                                                                                                        |
| 04  | `04-grant-application-review.md`    | Grant-making             | **Section headings only**                                         | (no instruction sentence at all)                                                          | Conditionality encoded purely in headings — "Section 3 — Applicants requesting more than £50,000". Nothing states a rule.                                                                  |
| 05  | `05-cloud-migration-readiness.md`   | Cloud migration          | **Appendix C, at the very back**                                  | "Ask Domain N only where…"                                                                | Position. Also carries a breadth cap ("no more than four") and a scoring note that is _not_ routing.                                                                                       |
| 06  | `06-exit-interview.md`              | HR                       | **Nowhere**                                                       | —                                                                                         | **Negative control.** No conditionality exists. Correct answer: propose everything `core`, `fromDocument: false`, and say so. A proposal with conditional topics here is a false positive. |
| 07  | `07-housing-needs-assessment.md`    | Local government housing | Prose, with an explicit two-mechanism explanation                 | "standing conditions" vs "**triggers**… at any point"                                     | ⚠️ **The unsupported case.** See below.                                                                                                                                                    |
| 08  | `08-suitability-review.md`          | Financial advice         | A front-sheet table **and** contradicting adviser notes on page 2 | "Use it when…" vs "mandatory regardless" / "Skip where"                                   | Contradiction. Three direct conflicts, one deliberately vague ("Use judgement").                                                                                                           |
| 09  | `09-ethics-review.md`               | Research ethics          | Prose secretary notes                                             | "prioritise no more than three" / "covered **briefly**" / "in full"                       | Breadth cap **and** depth modulation — the `depth: light \| full` dial.                                                                                                                    |
| 10  | `10-franchise-operations-review.md` | Franchise operations     | Mixed, three mechanisms in one document                           | "stop the review" / "a partner takes one of these, not several" / "whenever they surface" | Combined hard case: a **terminating** screener, mutually-exclusive role routing, and mid-interview triggers.                                                                               |

## What "correct" looks like, per document

Recorded here so a run can be scored without re-deriving intent.

- **01** — 7 conditional topics (Adherence, Inhaler, Anticoagulation, Pain, Falls, Cost, plus none for the always-asked blocks). `fromDocument: true`, every criterion quotable.
- **02** — Parts A, B core; G closing; C–F conditional. `fromDocument: true`.
- **03** — Sections 1 and 8 always; 2–7 conditional, six criteria all quotable.
- **04** — Sections 1, 2, 8 core; 3–7 conditional. **`sourceQuote` should be the heading itself.** Watch for the analyst inferring and correctly omitting quotes it cannot support.
- **05** — Domains 1, 2, 4, 10 core; 3, 5, 6, 7, 8, 9 conditional; `maxConditionalTopics: 4`. **The scoring note in Appendix B must not become a routing rule.** If candidacy misses this document, the 20k cap is implicated.
- **06** — All core. Zero conditional. `fromDocument: false`. Any conditional topic is a false positive.
- **07** — Standing blocks A–D conditional and correctly criteria'd. **The five triggered blocks must be reported in `gaps[]`, not converted into opening-time criteria.** See below.
- **08** — The three contradictions must surface — ideally as `gaps[]` — rather than being silently resolved by picking one side. "Use judgement" is unformalisable and belongs in gaps.
- **09** — `maxConditionalTopics: 3`; Data management and Dissemination at `depth: light`; Consent and Vulnerable participants at `depth: full`.
- **10** — Role sections mutually exclusive (three conditional topics, one applies). The two terminating screener conditions and the four escalation triggers should both land in `gaps[]` — the product can express neither.

## ⚠️ Mid-interview triggers are not expressible today

Documents 07 and 10 deliberately specify routing the product **cannot do**, because
that is where the honest-failure machinery matters most.

Adaptive Scope settles scope **once**, when the opening completes, and never revisits
it. Verified: `plan-scope.ts` is the only session-side caller of `planScope`, and the
design rationale is stated in `scope/amendment.ts` — _"The plan is decided once, from
an opening. That is the right design — a plan that shifted under a running interview
would make a finished report unreproducible."_

The nearest mechanism, respondent amendment (F17.6), is **not** this. It fires only on
an explicit request from the respondent, gated by a regex requiring an asking verb
("can we also cover…", "ask me about…"), and it deliberately avoids firing when a
subject merely comes up — the module names that as a failure mode to prevent:
_"risks widening an interview because someone mentioned a subject in passing."_ A
trigger is exactly "mentioned in passing", initiated by the instrument rather than the
respondent.

**So the correct behaviour on 07 and 10 is a reported gap, not a proposal.** The
dangerous failure is silent coercion: turning _"if the applicant discloses abuse at
any stage"_ into _"include when the opening mentions abuse"_. That reads as authored,
gets accepted, and the instrument then behaves differently from what its author wrote
— on the most safety-critical block in the document.

If trigger-based mid-interview scoping is wanted as a capability, it is a new
mechanism with real consequences for report reproducibility and cohort comparability,
not a prompt change.

## Known gaps in this corpus

Being explicit, so a good score here is not over-read:

- **Formats.** Everything is Markdown or CSV. `docx`, `pdf`, `xlsx` and `epub`
  parsers all exist (`lib/orchestration/knowledge/parsers/`) and none is exercised
  here. A PDF export with broken table structure is a realistic failure mode this
  corpus cannot see.
- **Scale.** The largest document is ~36 questions. Real instruments reach 200+, where
  `ROUTING_ANALYSIS_MAX_TOPICS` and the 12,288-token output cap start to bind.
- **Messiness.** These are clean. Real documents have inconsistent numbering, orphaned
  fragments, and headers repeated on every page.
- **Length — the candidacy cap is NOT tested.** The largest document here is 4,535
  characters; `MAX_CANDIDACY_DOCUMENT_CHARS` is 20,000. Every document fits inside the
  cheap check's read window several times over, so nothing in this corpus can tell us
  what happens when routing sits past it. Probing that needs a document with ~25,000
  characters of body **before** its routing appendix — i.e. roughly five times the size
  of 05. Document 05 tests _position_ (routing at the back) but not _truncation_.
