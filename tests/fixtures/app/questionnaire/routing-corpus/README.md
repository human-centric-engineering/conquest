# Conditional Topics routing corpus

Ten synthetic instruments for measuring whether the ingest → candidacy → Routing
Analyst chain configures Conditional Topics well across **varied document shapes**, not
just the one workbook family it has been exercised on.

**No third-party content is reproduced here** — every document was written for this
repository, following the convention of the sibling `sample-questionnaire.md`.

**Results are recorded in [`RESULTS.md`](./RESULTS.md).** This file says what correct
looks like; that one is the ledger of what actually happened on each run — date, build,
resolved models, per-document scores, where it failed, and the trend across runs.

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

| #   | Difficulty     | File                                | Domain                   | Routing lives                                                     | Phrasing used                                                                             | Tests                                                                                                                                                                                      |
| --- | -------------- | ----------------------------------- | ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01  | **1** trivial  | `01-medication-review.csv`          | Community pharmacy       | Structured `When to ask` column                                   | "Only where…"                                                                             | Baseline. The Merlin-like easy case, in CSV rather than XLSX.                                                                                                                              |
| 02  | **2** easy     | `02-safeguarding-review.md`         | School safeguarding      | Prose "How to use this review" preamble                           | "only complete a part where…"                                                             | Prose instruction page at the front.                                                                                                                                                       |
| 03  | **2** easy     | `03-site-safety-audit.md`           | Industrial safety        | Inline notes under each heading                                   | "_Applies to:_"                                                                           | Routing scattered across the body, not centralised.                                                                                                                                        |
| 04  | **3** moderate | `04-grant-application-review.md`    | Grant-making             | **Section headings only**                                         | (no instruction sentence at all)                                                          | Conditionality encoded purely in headings — "Section 3 — Applicants requesting more than £50,000". Nothing states a rule.                                                                  |
| 05  | **3** moderate | `05-cloud-migration-readiness.md`   | Cloud migration          | **Appendix C, at the very back**                                  | "Ask Domain N only where…"                                                                | Position. Also carries a breadth cap ("no more than four") and a scoring note that is _not_ routing.                                                                                       |
| 06  | **3** moderate | `06-exit-interview.md`              | HR                       | **Nowhere**                                                       | —                                                                                         | **Negative control.** No conditionality exists. Correct answer: propose everything `core`, `fromDocument: false`, and say so. A proposal with conditional topics here is a false positive. |
| 07  | **5** severe   | `07-housing-needs-assessment.md`    | Local government housing | Prose, with an explicit two-mechanism explanation                 | "standing conditions" vs "**triggers**… at any point"                                     | ⚠️ **The unsupported case.** See below.                                                                                                                                                    |
| 08  | **4** hard     | `08-suitability-review.md`          | Financial advice         | A front-sheet table **and** contradicting adviser notes on page 2 | "Use it when…" vs "mandatory regardless" / "Skip where"                                   | Contradiction. Three direct conflicts, one deliberately vague ("Use judgement").                                                                                                           |
| 09  | **3** moderate | `09-ethics-review.md`               | Research ethics          | Prose secretary notes                                             | "prioritise no more than three" / "covered **briefly**" / "in full"                       | Breadth cap **and** depth modulation — the `depth: light \| full` dial.                                                                                                                    |
| 10  | **5** severe   | `10-franchise-operations-review.md` | Franchise operations     | Mixed, three mechanisms in one document                           | "stop the review" / "a partner takes one of these, not several" / "whenever they surface" | Combined hard case: a **terminating** screener, mutually-exclusive role routing, and mid-interview triggers.                                                                               |

## Difficulty ratings

The rating scores **how hard the document is for the pipeline to get right**, not how
hard it is for a person to read. Those two come apart, and 06 is the clearest case:
a human needs ten seconds to see there is no routing in it, while the analyst is the
one being asked to find some.

The ratings live here, not in the instruments. `.md` fixtures are read by the
plain-text parser (`lib/orchestration/knowledge/parsers/txt-parser.ts` — a straight
`buffer.toString('utf-8')`), so **every byte of a document body reaches the extractor
and the Routing Analyst**, HTML comments included. A line reading "difficulty 3 —
routing is in Appendix C" would hand the analyst the answer for the exact thing 05
exists to measure. Nothing that describes the expected result may sit inside a
document.

| Score | Band     | What it means                                                                                                 |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------- |
| **1** | trivial  | Routing is in a machine-readable field. Failure implicates plumbing, not judgement.                           |
| **2** | easy     | Routing is stated in prose, in one consistent form, and every criterion is quotable.                          |
| **3** | moderate | One thing is missing or misplaced — the instruction, its position, or the conditionality itself.              |
| **4** | hard     | The document argues with itself. Getting it right means declining to resolve the argument.                    |
| **5** | severe   | The document specifies routing the product cannot perform. The only correct output is a refusal plus a `gap`. |

The bands are not evenly spaced. **1–3 test extraction; 4–5 test restraint** — whether
the analyst will report that it cannot do something rather than produce a plausible
proposal that quietly misstates the author's instrument. A pipeline can score full
marks on 01–06 and still be unsafe to ship.

### Per document

- **01 — trivial.** A `When to ask` column, one rule per row, in CSV. The only wrinkle
  is that Adherence is _mixed_: AD1 is `Always` while AD2–AD3 are conditional, so the
  section does not map cleanly onto a single topic. Everything else is a lookup.

- **02 — easy.** One prose paragraph states the mechanism, and each Part's heading
  restates its own criterion ("Part C — Where the school has admitted a child looked
  after during the year"), so intent is doubly attested. Two mild distractors: "Part G
  is completed by every school, **last**" is ordering rather than routing, and "if you
  are unsure whether a part applies, complete it" is an inclusion bias that should not
  become a criterion.

- **03 — easy.** Six `_Applies to:_` notes, uniformly formatted, each directly
  quotable, with explicit guidance that an unmarked section is asked everywhere. Only
  harder than 02 in that intent is decentralised — the marker itself never varies.

- **04 — moderate.** No instruction sentence exists anywhere in the document.
  Conditionality is carried entirely by headings, so the analyst must infer a rule and
  then set `sourceQuote` to the heading. The failure to watch for is a fabricated
  quote: an invented "applicants requesting over £50,000 should complete Section 3"
  that appears in no line of the source.

- **05 — moderate.** The rules are clean once found; the difficulty is that they sit
  in Appendix C, behind a glossary and a scoring appendix, ~3,800 characters in. Two
  further traps: the numeric cap ("no more than four") must land in
  `maxConditionalTopics`, and Appendix B's scoring note reads like a rule but is not
  one. Not scored higher only because the document fits inside
  `MAX_CANDIDACY_DOCUMENT_CHARS` several times over — it tests position, not
  truncation.

- **06 — moderate.** Structurally the simplest document here and behaviourally one of
  the more revealing. There is nothing to find, and the analyst is under instruction to
  look. Bait is present: Q19 ("did you ever see or experience behaviour that concerned
  you?") invites a safeguarding topic, and the Reward and progression block looks
  role-shaped. Correct output is every topic `core`, `fromDocument: false`, and a
  sentence saying the document specifies no conditionality.

- **07 — severe.** The standing blocks A–D are a level-2 problem. The five triggered
  blocks are not solvable at all: Conditional Topics settles scope once, when the opening
  completes. The document goes out of its way to distinguish the two mechanisms and to
  forbid deferral, so there is no reading under which a trigger is an opening-time
  criterion. The dangerous failure is silent coercion — rendering "if the applicant
  discloses abuse **at any stage**" as "include when the opening mentions abuse" — on
  the most safety-critical block in the instrument.

- **08 — hard.** The front-sheet table and the page-2 adviser notes conflict four
  times, not three: Protection needs (conditional vs "mandatory regardless"),
  Vulnerability ("use judgement" vs "every client, without exception"), Attitude to
  risk (table says every client, notes add an execution-only exemption), and Estate
  planning — where the note is not merely a contradiction but a **trigger** ("only ever
  asked where the client raises inheritance themselves"), which makes it unexpressible
  as well as contested. Any output that silently picks a side has failed, however
  reasonable the side it picked.

- **09 — moderate.** Routing is legible; the load is that three configuration surfaces
  must be set at once from one prose paragraph — the topic set, `maxConditionalTopics: 3`,
  and per-topic `depth`. The vocabulary is signposted ("no more than three",
  "briefly", "in full"), which is what holds this at 3. A miss on `depth` is partial
  credit; a miss on the cap is not.

- **10 — severe.** Three mechanisms, and two of them are outside the product. The
  eligibility screener terminates the review rather than scoping it, and the four
  escalation triggers are mid-interview by construction ("whenever they surface, at
  any point"). Only the role sections are proposable — and even there, "a partner
  takes one of these, not several" is a mutual-exclusivity constraint the schema has
  no way to express, so it belongs in `gaps[]` alongside the rest. The most exposed
  document in the corpus: an analyst that produces a tidy proposal here has silently
  discarded a stop condition.

### What the spread does and does not cover

The corpus clusters at 3 — four of ten documents. That is a fair reflection of real
instruments, but it means the middle band carries the least discriminating power: a
run that scores 3/4 in that band tells you little about which failure mode is active.
The 1 and the two 5s are the informative ends. Nothing here scores above 5 for the
reasons in "Known gaps" — every document is clean, short, and Markdown or CSV, so
none of the ratings account for parser damage, 200-question scale, or routing that
falls past the candidacy cap.

## What "correct" looks like, per document

Recorded here so a run can be scored without re-deriving intent.

> **"Always-asked" is three phases, and exactly one of them is required.** `TOPIC_PHASES` is
> `opening | core | conditional | closing`, and a config with no `opening` topic fails validation
> with an **error**, not a warning — `no_opening_topic` in `scope/validate.ts`: _"nothing gathers the
> signal the agent needs before it can choose."_ So an always-asked topic proposed as `opening`
> rather than `core` is not a miss, and a proposal where every always-topic is `core` is the one
> that would be wrong. Score membership (conditional vs always) strictly and the split within
> always-asked as a judgement, unless the entry below names a phase specifically.
>
> This paragraph is a correction. It resolves **T04**, raised against doc 02 in R002 and seen again
> on doc 03 in R004: the ground truth below asked for `core` where the product requires `opening`,
> so the pipeline was being marked down for the only output that validates.

- **01** — 7 conditional topics (Adherence, Inhaler, Anticoagulation, Pain, Falls, Cost, plus none for the always-asked blocks). `fromDocument: true`, every criterion quotable.
- **02** — Parts A, B, G always-asked (one of A/B is the `opening`, G `closing`); C–F conditional. `fromDocument: true`.
- **03** — Sections 1 and 8 always (1 the `opening`, 8 `closing`); 2–7 conditional, six criteria all quotable. No cap, depth dial or fallback is stated anywhere, so **inventing one is the failure to watch for** — `maxConditionalTopics`, `fallbackTopicKeys` and `checkTopicPreference` should all be omitted.
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

Conditional Topics settles scope **once**, when the opening completes, and never revisits
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

  > **`.csv` was not ingestible until 2026-08-26.** The first trial run of doc 01 found
  > the questionnaire upload allowlist had never listed `.csv`, even though the parser
  > router has always had a `.csv` branch — so the corpus' _easiest_ document could not
  > be run as authored at all. Fixed by deriving the allowlist and every admin file
  > picker from one constant. Any run recorded before that date either did not cover
  > doc 01 or ran it through a `.txt` copy, which reaches the plain-text parser rather
  > than the CSV one and is **not** a comparable result — the CSV parser labels every
  > row with its column names (`… | When to ask: Always`), which is a materially
  > stronger signal to the extractor and the analyst than raw comma-separated text.

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
