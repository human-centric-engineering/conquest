# Routing corpus — ingestion results ledger

**Companion to [`README.md`](./README.md).** The README says what each of the ten
documents is for and what a correct result looks like. This file records what actually
happened, run by run — when it ran, against which build and which models, what it got
right, where it broke, and one number per run that can be compared to the last one.

Nothing here is inferred. Every row is filled in from a run that was actually performed;
an unrun document is left blank rather than estimated, and a run that was abandoned
half-way is recorded as such. A ledger that guesses is worse than no ledger, because the
trend line it draws is fiction.

> **Status: five partial runs recorded (R001 — doc 01, R002 — doc 02, R003 — verification,
> R004 — doc 03, R005 — doc 04; all 2026-08-26).** No full corpus run has been performed, so there
> is no corpus score. Four of the ten documents have been scored, all from the extraction band
> (difficulty 1, 2, 2, 3).
>
> **The restraint band has still never been scored — and the one control run into it found a
> critical failure.** R005 ran doc 07 twice as a control for a prompt change and both runs coerced
> all five of its mid-interview triggered blocks into opening-time criteria. See **T07**. A rising
> extraction band against an unscored restraint band is exactly the pattern the two-band split
> exists to expose.

---

## What a "run" is

One pass of all ten corpus documents through the streaming ingest, on one build, with the
models as configured on that build. Partial runs are allowed and should be recorded as
partial (score the documents you ran; leave the rest blank; say why in the notes) — but a
corpus score is only comparable to another corpus score when both cover all ten.

The chain each document goes through, and therefore the places it can fail:

| Stage         | What runs                                                                                        | Failure looks like                                                           |
| ------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **parse**     | `lib/orchestration/knowledge/parsers` — `.md` via the txt parser, `.csv` via the CSV parser      | Upload rejected, empty body, mangled table                                   |
| **extract**   | The questionnaire extractor + the fidelity critic (`AppAiRun.kind = 'extraction_verify'`)        | Missing sections, invented questions, wrong answer types                     |
| **candidacy** | The ingest-time check (`kind = 'scope_candidacy'`) — is this document a routing candidate at all | Wrong verdict; or fail-soft `null` (agent missing, no provider, timeout)     |
| **analyst**   | The Routing Analyst (`kind = 'routing_analysis'`) — the topic/rule/gap proposal                  | Wrong topics, ungrounded criteria, coerced triggers, dropped stop conditions |
| **settings**  | The analyst's `maxConditionalTopics` / `depth` / `fallbackTopicKeys` on the proposal             | Caps and depth dials silently dropped                                        |

Candidacy is deliberately fail-soft — a missing agent resolves to "not run", not to an
error. So **"the check did not run" and "the check said no" look similar from the UI and
are not the same result.** Check the `AppAiRun` rows before scoring a `no`; the query is
below.

---

## Producing a run

1. **Dev server against a seeded DB.** The chain needs the extractor, the fidelity critic,
   the candidacy agent and the Routing Analyst seeded and each bound to a live provider.
   A run where one of them is absent is a plumbing run, not an intelligence run — note it
   and discard the score.
2. **Upload each of the ten files through the streaming ingest** (admin → Questionnaires →
   new questionnaire → upload). Streaming matters: the streaming route runs candidacy and,
   when it fires, the Routing Analyst in the same pass the admin is watching. The
   non-streaming route does not, and a run mixing the two is not comparable to one that
   did not.
3. **Title them so the SQL can find them.** Convention: `R00N — 07 housing needs`, where
   `R00N` is the run id from the log below.
4. **Read the proposal on the Conditional topics tab** (URL segment is still `topics`). Score
   the proposal as proposed. **Do not accept it** — acceptance edits the version, and the
   thing being measured is what the analyst offered an admin, not what an admin made of it.
5. **Pull the run rows** for timings, cost, resolved models and failures (below).
6. **Score, fill in the template, append to the log.** Newest run at the top.
7. **File what the run suggests changing in [Candidate tweaks](#candidate-tweaks)** — do not edit
   a prompt off the back of one run. Promote an entry to **confirmed** when a second run sees it
   again; that, not a single striking result, is what justifies a change.
8. **Clean up.** Ten questionnaires per run accumulate; archive or delete the run's
   questionnaires once it is recorded, or the next person's list is unusable.

### Pulling the run rows

`AppAiRun` (`app_ai_run`) carries when it ran, the model that actually served it after any
fallback, duration, cost and the error on a failure. Per run, against the dev DB:

```sql
SELECT q.title,
       r.kind,
       r.status,
       r.provider,
       r.model,
       r."durationMs",
       r."costUsd",
       r."createdAt",
       r.error
FROM app_ai_run r
JOIN app_questionnaire_version v ON v.id = r."versionId"
JOIN app_questionnaire q ON q.id = v."questionnaireId"
WHERE q.title LIKE 'R001 —%'
ORDER BY q.title, r."createdAt";
```

The `kind` values that matter here are `extraction_verify`, `scope_candidacy` and
`routing_analysis`. A document with no `scope_candidacy` row did not have the check run at
all. A `routing_analysis` row with `status = 'failed'` is also the durable "already tried"
signal the Topics tab reads, so a failed analysis will not silently re-propose later.

**On `provider` / `model`.** These now hold the binding that actually served the call, for all
three kinds. Before 2026-08-26 they held the agent row's _configured_ values — and these agents
ship with an empty model on purpose, binding to the reasoning tier at call time — so the columns
read `''`, `'n/a'` or `'resolved-at-runtime'` for calls that had really run on `openai/gpt-5.4`.
A run recorded before that date cannot name its models from this table; join `ai_cost_log` on the
`agentId` and timestamp instead.

`'n/a'` is now the single spelling for "no model served this", and it is a real answer rather
than a gap: the call failed before reaching a provider. Do not fill it in from the agent row —
that is the bug that was fixed.

**On `costUsd`.** It is populated for all three ingest kinds from R002 onward. Before that it was
always `NULL` — the three ingest-chain writers (`stream/route.ts`, `scope-candidacy.ts`,
`routing-analysis.ts`) simply never passed it, though the session-side writers did — so the query
above returned a blank cost column and a run had to be priced by joining `ai_cost_log` on a
timestamp. A `0` on a `scope_candidacy` row predating R002 means "the model was not in the pricing
registry", not "this was free".

The full prompt as sent and the raw reply are on `promptSnapshot` / `outputSnapshot` of the
same row (capped and flagged `truncated`) — that is where to look when a score is
surprising and the UI does not explain it.

---

## Scoring

Five dimensions per document, each **0, 1 or 2**. Ten points per document; the per-document
score is that out of 10, and the corpus score is the mean of the ten, as a percentage.

| #   | Dimension                | 2 — pass                                                                                                                     | 1 — partial                                                                             | 0 — fail                                                                                    |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P   | **Parse & extract**      | Every section present, question count right, answer types sane, nothing invented                                             | One section or a couple of questions wrong, duplicated or mistyped                      | Parse error, or a structure that would need re-authoring rather than correcting             |
| C   | **Candidacy**            | Correct verdict, with quoted signals (**06 must not fire**)                                                                  | Correct verdict but thin — no quotes, or a confidence far out of line with the document | Wrong verdict, **or the check did not run** (fail-soft `null` — see the SQL above)          |
| T   | **Topic set**            | Topics and phases match the README's "what correct looks like" for that document                                             | Up to two membership or phase errors                                                    | More than two, or no proposal at all                                                        |
| G   | **Grounding**            | Every conditional topic has criteria in the document's words; `sourceQuote` is a real span, or correctly absent (cf. **04**) | One or more quotes thin, truncated, or missing where the document had a usable sentence | **Any fabricated quote** — a span that appears nowhere in the file. Also a critical failure |
| R   | **Restraint & settings** | What the product cannot express is in `gaps[]`; stated caps and depth land in the settings; `fromDocument` correct           | A settings miss (a dropped cap or depth dial) with no coercion anywhere                 | Coercion of a trigger, a contradiction silently resolved, or a stop condition dropped       |

**Where it failed** is recorded as the earliest stage that broke: `parse`, `extract`,
`candidacy`, `analyst`, `settings`, or `none`. A document that failed at `extract` tells
you nothing about the analyst, and its T/G/R scores should be read with that in mind —
note it rather than scoring the analyst on rubble.

### Critical failures override the score

The README's warning is the reason this section exists: _a pipeline can score full marks
on 01–06 and still be unsafe to ship._ These are the failures that make a run **not
shippable regardless of its number**:

| Doc    | Critical failure                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| any    | A fabricated `sourceQuote` — a quoted span that is not in the document                                         |
| **06** | Any conditional topic at all. The document contains no conditionality; a proposal here is a false positive     |
| **07** | Any of the five triggered blocks rendered as an opening-time criterion (silent coercion, on safeguarding text) |
| **08** | A contradiction resolved by quietly picking a side, rather than surfaced as a gap                              |
| **10** | The terminating screener absent from `gaps[]` — a stop condition discarded                                     |

### Compare a quote with markdown normalised, or you will report a failure that is not one

A fabricated `sourceQuote` is the corpus's most severe finding, so the test for one has to be right.
**Substring search against the raw file is not it.** Models re-render markdown emphasis as they
quote, and R005 saw both spellings on one document: the gap quote on doc 07 was the trigger passage
with its `**bold**` markers **stripped**, and candidacy signal 2 was `**Standing conditions**`
rendered as `“Standing conditions”`. Both are faithful to the word; a raw substring check calls both
critical failures.

Before comparing, normalise BOTH sides: collapse whitespace (documents hard-wrap, quotes do not),
strip `**` and `_`, and fold curly quotes to straight ones. Nothing beyond that — case, punctuation
and hyphens must survive, because "near-misses" → "near misses" is a real edit and a looser matcher
launders it.

A quote that still does not match after that normalisation is the real thing, and it is critical.

One watch item that is **not** critical but is worth recording in the notes: on **05**,
Appendix B's scoring note reads like a rule and is not one. If it becomes a routing rule,
say so.

### The two bands

The difficulty ratings in the README are not evenly spaced, and averaging across them
hides the thing that matters. Record both sub-scores:

- **Extraction band** — documents rated 1–3: **01, 02, 03, 04, 05, 06, 09** (7 docs). Can
  the pipeline find routing that is there, and not find routing that is not.
- **Restraint band** — documents rated 4–5: **07, 08, 10** (3 docs). Will it decline. This
  is the band that decides shippability.

A rising extraction band with a flat restraint band is a pipeline getting better at the
easy half. That is the pattern the two numbers exist to expose.

### The judge panel is a second signal, not this score

The Conditional Topics evaluation panel (F17.21 — four judges, 0–1 per dimension) scores a
version's **persisted** scope config, so it has nothing to read until a proposal is
accepted, and step 4 above says not to accept. If you do want panel numbers, accept the
draft on a duplicate of the run's questionnaire and record them in the optional column —
they measure the panel's agreement with the corpus ground truth, which is its own useful
signal, and they are not a substitute for scoring against the README.

---

## Recording a run

Copy this block to the top of [the log](#run-log), fill it in, and add one row to
[the trend table](#trend).

```markdown
### R00N — YYYY-MM-DD

| Field                      | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| Commit                     | `<short sha>` on `<branch>`                                |
| Ran by                     |                                                            |
| How                        | streaming ingest, admin UI · all ten / partial (say which) |
| Extractor model            | `<provider>/<model>` (resolved, from `AppAiRun`)           |
| Critic model               |                                                            |
| Candidacy model            |                                                            |
| Analyst model              |                                                            |
| Conditional topics enabled | before ingest? yes/no                                      |
| Extract tables             | on/off                                                     |
| Total cost / wall time     |                                                            |
| Environment                | local dev DB / other                                       |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | ---- |
| 01  | 1          |     |     |     |     |     |     |           |          |      |
| 02  | 2          |     |     |     |     |     |     |           |          |      |
| 03  | 2          |     |     |     |     |     |     |           |          |      |
| 04  | 3          |     |     |     |     |     |     |           |          |      |
| 05  | 3          |     |     |     |     |     |     |           |          |      |
| 06  | 3          |     |     |     |     |     |     |           |          |      |
| 07  | 5          |     |     |     |     |     |     |           |          |      |
| 08  | 4          |     |     |     |     |     |     |           |          |      |
| 09  | 3          |     |     |     |     |     |     |           |          |      |
| 10  | 5          |     |     |     |     |     |     |           |          |      |

**Corpus score:** __ % · **Extraction band (01–06, 09):** __ % · **Restraint band (07, 08, 10):** __ %
**Verdict:** shippable / not shippable — <critical failures, or "none">

#### What broke

<One short paragraph per document that lost points. Say what the pipeline produced and what
the README said it should have produced. Quote the analyst where the wording is the
problem — a coerced criterion is only recognisable in its own words.>

#### Changed since last run

<What in the build moved: prompt edits, model swaps, schema changes. This is the column
that turns the trend table into an explanation rather than a graph.>
```

---

## Run log

_Newest first._

### R005 — 2026-08-26 · **PARTIAL (doc 04 ×4, plus doc 07 twice as a control)**

| Field                      | Value                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Commit                     | `bbfbd28d1` + the gaps-prompt fix on `fix/ingest-fidelity-phase-2`                  |
| Ran by                     | Claude (agent), driven by John                                                      |
| How                        | streaming ingest via `POST /questionnaires/stream` · doc 04 ×4, doc 07 ×2 (control) |
| Extractor model            | `openai/gpt-5.4`                                                                    |
| Critic model               | `openai/gpt-5.4`                                                                    |
| Candidacy model            | `openai/gpt-5.4-mini`                                                               |
| Analyst model              | `openai/gpt-5.4`                                                                    |
| Conditional topics enabled | no (fresh version each ingest)                                                      |
| Total cost / wall time     | ~$0.28 across six ingests (`ai_cost_log`) · 45–70s each                             |
| Environment                | local dev DB, dev server on :3020                                                   |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                              |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | ----------------------------------------------------------------- |
| 01  | 1          |     |     |     |     |     |     |           |          | not run (see R001)                                                |
| 02  | 2          |     |     |     |     |     |     |           |          | not run (see R002)                                                |
| 03  | 2          |     |     |     |     |     |     |           |          | not run (see R004)                                                |
| 04  | 3          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | Clean on every axis, twice before a prompt change and twice after |
| 05  | 3          |     |     |     |     |     |     |           |          | not run                                                           |
| 06  | 3          |     |     |     |     |     |     |           |          | not run                                                           |
| 07  | 5          |     |     |     |     |     |     |           |          | **control only — NOT scored.** See "The doc 07 control" below     |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                                           |
| 09  | 3          |     |     |     |     |     |     |           |          | not run                                                           |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                                           |

**Corpus score:** _n/a — partial_ · **Extraction band:** _n/a_ · **Restraint band:** _still not scored_
**Verdict:** doc 04 is not shippable evidence on its own, and the doc 07 control below is the reason
that sentence matters more than the 10.

**Doc 04 — the first 10/10, and it earned it on the axis the document exists to test.** Doc 04
contains no instruction sentence anywhere: its conditionality is carried entirely by section
headings, and the README's named failure mode is a fabricated quote — an invented "applicants
requesting over £50,000 should complete Section 3" that appears in no line of the file. Nothing of
the kind happened. Every topic's `sourceQuote` is the heading itself, byte-exact, on all four runs,
and every one of the five candidacy signals quotes a real span too.

Everything else was deterministic across the four: 8 sections, 27 questions, one `opening` (Section
1), one `core` (Section 2), five `conditional` (Sections 3–7), one `closing` (Section 8) — exactly
the ground truth. Type inference was identical and sensible both sides of the prompt change ("What
is the total amount you are requesting?" → `numeric`, "When were your last accounts independently
examined or audited?" → `date`, everything else `free_text`). No cap, depth dial or fallback was
invented where the document is silent. `fromDocument: true`.

Extraction fidelity was markedly better than doc 03: 5, 1, 5 and 5 prompts differed from the source
across the four runs and **`unattributedPromptCount` was zero on every one** — every edit was
declared. The rewrites are mild ("money" → "funding") with one worth noting: _"Which community does
the work serve, and roughly how many people?"_ → _"…and roughly how many people **will it reach**?"_
shifts served to reached. Filed under T05, which already covers the class.

#### What broke

**Nothing in doc 04's own scoring — the finding is one the rubric cannot see.** Run 1 filed **five**
gaps; run 2, same file, same build, filed **none**. The five all said a version of _"the document
clearly routes this topic by requested amount, but there are no data slots to test that amount
mechanically, so no hard include rule can be formalized."_

That is a tautology, and provably so: `buildRoutingAnalysisInput` reads `version.dataSlots`, and
data slots are generated by a **separate, later** pass — verified, every version created during
these runs had zero. **At ingest the analyst can never propose a single hard rule**, so "no data
slot for this" is true of every conditional topic in every ingest-time analysis that will ever run.
A gap saying it describes the platform, not the document.

Both readings were available in the prompt, which is why it went both ways on one build. The gaps
section opened with _"you cannot turn it into a clean topic **or hard rule** — the condition names
something not in DATA SLOTS"_, and with DATA SLOTS empty every conditional topic satisfies that
test. Run 1 followed the letter of the instruction. Run 2 followed _"Zero is the common and correct
answer"_ six lines later.

It matters because `gaps[]` is the load-bearing restraint signal: three of the four entries in the
critical-failure table are "did this land in `gaps[]`". A gaps array that routinely fills with
platform tautologies on easy documents trains a reader — and a scorer — to skim it, and doc 10's
dropped stop condition is one line in the same array.

#### The doc 07 control — and a critical failure found while running it

Doc 07 was run **twice, purely to check the gaps fix had not over-suppressed** the gaps that must
survive: once on the committed prompt, once on the fixed one. It is **not scored** and doc 07's row
stays blank. Two runs of a difficulty-5 document is a control, not a result.

**The fix passed its control.** Both runs filed exactly one gap, and the fixed prompt's version is
the better-aimed of the two: pre-fix it blamed _"there are no data slots"_; post-fix it names the
mechanism — _"the mid-interview requirement to insert it immediately, reorder the remainder, and
still ask it if disclosed very late"_ — quoting the trigger passage. So the change removes the
tautology without silencing a real gap.

**But both runs coerced all five triggered blocks, which is doc 07's named critical failure.** Every
one of them was proposed as a `conditional` topic:

| Topic                                | Criteria proposed                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `triggered_block_domestic_abuse`     | "If the applicant discloses, **at any stage**, that they are…fleeing abuse"    |
| `triggered_block_care_leaver`        | "If it emerges **at any stage** that the applicant has been looked after…"     |
| `triggered_block_health_disability`  | "…**at any stage** — including **in passing** while answering something else"  |
| `triggered_block_immigration_status` | "If the applicant's immigration or residence status comes up **at any point**" |
| `triggered_block_rent_arrears`       | "If arrears of more than two months are mentioned **at any stage**"            |

Conditional Topics settles scope **once**, when the opening completes. So a criterion reading "at
any stage" is decided at the end of the opening and never revisited: a disclosure of abuse in minute
40 does not add the block. The document goes out of its way to forbid exactly this — _"A trigger
that fires in the final five minutes still means the block is asked. Do not defer a triggered block
to a second appointment"_ — and the interviewer would simply not ask.

It is a gentler failure than the README feared. The criteria are **verbatim quotes**, "at any stage"
included, rather than the silently reworded _"include when the opening mentions abuse"_ — so the
coercion is legible to an admin who knows the engine plans once. It is the same failure all the
same, on the most safety-critical block in the corpus.

**This is not caused by the prompt change** — it is identical on both sides of it, which is the
whole reason the pre-fix baseline was run. Filed as **T07**, and it is the one entry in this table
that is a product decision rather than a prompt tweak. See the README's "⚠️ Mid-interview triggers
are not expressible today", which anticipated it.

#### A scoring trap found while checking the quotes

Two of doc 07's quotes appear nowhere in the file as literal substrings — which is the corpus's
single most severe critical failure — and **neither is fabricated**:

- The gap's quote is the trigger passage with its `**bold**` markers **stripped**.
- Candidacy signal 2 is `**Standing conditions**` rendered as `“Standing conditions”` — the markdown
  emphasis translated into typographic quotation marks.

Both are faithful to the word. A scorer checking quotes by substring search will report a critical
failure on the restraint band and be wrong. **Normalise markdown emphasis before comparing** — strip
`**`/`_` and fold curly quotes — as well as whitespace. Written into the Scoring section above.

#### Changed since last run

- **The gaps rubric no longer offers "not in DATA SLOTS" as a stand-alone reason to gap.** The bar
  is now "cannot express it AT ALL — not as a conditional topic's criteria, and not as a hard rule",
  with an explicit line that a condition you DID express as criteria is not also a gap, and that an
  empty DATA SLOTS list (i.e. every ingest) makes the old test true of everything. "Fires
  mid-interview rather than at the opening" was added as a named gap reason, which it never was.
  Five regression tests in `analysis-prompt.test.ts`, including one asserting the old clause is
  gone.
- **Evidence, stated honestly:** doc 04 gaps went 5 and 0 before, 0 and 0 after. Three of four
  post-change observations are zero against one of two before — consistent with the fix, not proof
  of it, since run 2 was already zero. The doc 07 control is the stronger signal, because it shows
  the change does not cost a legitimate gap.

---

### R004 — 2026-08-26 · **PARTIAL (doc 03 only — first scored run of it)**

| Field                      | Value                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Commit                     | `0d129065f` + the Phase 2 counter on `fix/ingest-fidelity-phase-2`                 |
| Ran by                     | Claude (agent), driven by John                                                     |
| How                        | streaming ingest via `POST /questionnaires/stream` · **partial — doc 03 only**, ×6 |
| Extractor model            | `openai/gpt-5.4`                                                                   |
| Critic model               | `openai/gpt-5.4`                                                                   |
| Candidacy model            | `openai/gpt-5.4-mini`                                                              |
| Analyst model              | `openai/gpt-5.4`                                                                   |
| Conditional topics enabled | no (fresh version each ingest — the candidacy check requires an untouched version) |
| Extract tables             | default (on; PDF-only, so inert for a `.md`)                                       |
| Total cost / wall time     | **$0.586** across six ingests (`ai_cost_log`) · 45–60s each                        |
| Environment                | local dev DB, dev server on :3020                                                  |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                                      |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | ------------------------------------------------------------------------- |
| 01  | 1          |     |     |     |     |     |     |           |          | not run (see R001)                                                        |
| 02  | 2          |     |     |     |     |     |     |           |          | not run (see R002)                                                        |
| 03  | 2          | 1   | 2   | 2   | 2   | 2   | 9   | extract   | none     | Analyst flawless; extractor rewords a third of the prompts, some silently |
| 04  | 3          |     |     |     |     |     |     |           |          | not run                                                                   |
| 05  | 3          |     |     |     |     |     |     |           |          | not run                                                                   |
| 06  | 3          |     |     |     |     |     |     |           |          | not run                                                                   |
| 07  | 5          |     |     |     |     |     |     |           |          | not run                                                                   |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                                                   |
| 09  | 3          |     |     |     |     |     |     |           |          | not run                                                                   |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                                                   |

**Corpus score:** _n/a — partial_ · **Extraction band:** _n/a_ · **Restraint band:** _not exercised_
**Verdict:** not comparable — one document, in the easy band. The restraint band is still untouched
after four runs.

**Six ingests of one file, and the structural half is now flat.** 8 sections and 23 questions on
every one of the six; 8 topics with 6 conditional on every one of the six; `disallowedEditCount`
absent (zero) throughout. Doc 03 numbers nothing — its questions are bare bullets under headings —
so this is the first evidence that R003's determinism holds on a document the extractor cannot
count its way through. The critic's coverage read was `matches` at 23 on all six.

**The analyst had a clean run and it is worth saying what that looked like.** All eight topics
carried a `sourceQuote` that is an exact byte-for-byte span of the file, verified by search, not by
reading. The six `_Applies to:_` notes became six conditional topics whose criteria are the note's
own sentence. Sections 1 and 8 were the two always-asked topics. Nothing was invented where the
document is silent: `maxConditionalTopics`, `fallbackTopicKeys` and `checkTopicPreference` were all
omitted, `rules` was empty with the honest reason given ("no data slots to test against"), and
`gaps` was empty on a document that has no unexpressible routing in it. `fromDocument: true`.

#### What broke

**P = 1 — the extractor rewords, variably, and sometimes without saying so.** Structure and count
are exact; the wording is not. Across six ingests, 8, 12, 10, 10, 10 and 12 of the 23 prompts came
out differing from the source, and 1, 1, 2, 0, 0 and 1 of those arrived with **no change record at
all**. An unrecorded edit is the part that is a defect rather than a policy question: the editorial
log is what the review surface renders and what F2.3 reverts, so a prompt the extractor rewrote
without filing lands in the Structure editor looking like the author's own words, and cannot be
reverted to them. `"Where do pedestrians and plant come closest to each other?"` → `"Where do
pedestrians and **mobile** plant come closest to each other?"` went unrecorded on four of the six.

**A note on the cost figure**, since the ledger tells you to read it from `AppAiRun`: those rows sum
to $0.134 for this run, not $0.586. The difference is the extractor's own call, which is the most
expensive of the four and **has no `AppAiRun` row of any kind** — `extraction_verify` prices the
critic, not the extraction. Price a run from `ai_cost_log` or it reads about four times cheaper than
it is.

The fidelity critic marked every reworded question `ok`, on all six runs — correctly, and that is
the point. It is asked whether a question still faithfully asks what the source asks, and a
reworded question does. No per-question verdict can see this; only the source can, which is why the
fix below is a string comparison rather than another prompt.

**The rewrites are not uniformly harmless.** Three classes, and they want different answers:

- _Self-containing._ `"Who maintains the register and how current is it?"` →
  `"Who maintains the **confined-space** register…"`; `"What separates them, physically?"` →
  `"What physically separates **pedestrians and mobile plant**?"`. These are arguably necessary —
  a question is delivered conversationally, outside its section heading, so a prompt that depends
  on the heading for its referent is genuinely broken without this.
- _Cosmetic._ `"Walk me through…"` → `"**Please** walk me through…"`; `"…had not considered"` →
  `"…had not considered **before**"`. Harmless, and pure churn: they are most of why one file
  produces a different `changeCount` (34, 40, 36, 39, 46, 40) on every run.
- _Meaning-narrowing._ `"What happens if the weather turns mid-task?"` → `"What happens if the
weather changes **during a work-at-height task**?"` (3 of 6 runs), and `"How is edge protection
inspected, and how is **that** recorded?"` → `"…how is **that inspection** recorded?"`. Both
  narrow what was asked. Both were filed as `rewrite_prompt` with a rationale claiming meaning was
  preserved.

Filed as **T05**, not acted on: which of the three the product wants is a policy call, and the
parking rule exists for exactly this.

#### Changed since last run

- **`unattributedPromptCount` — a third deterministic counter on the `extraction_verify` row**,
  sibling to `disallowedEditCount`. It counts questions whose prompt matches neither a span of the
  source nor the `after` prompt of any change record, which is precisely "an edit nobody can see".
  Whitespace-flattened before comparison so a hard-wrapped source line still matches a single-line
  prompt; nothing else is normalised, because `near-misses` → `near misses` and `reads` →
  `reviews` are edits and a looser matcher would quietly shrink the number. Omitted from the row
  when zero. Non-blocking, like its siblings: by the time it is readable the questions exist.
  Verified live on three ingests against an independent offline diff — 0, 0 and 1, agreeing both
  times it mattered.
- **The corpus README's ground truth for docs 02 and 03 was wrong about phases** and has been
  corrected. See T04 below.

---

### R003 — 2026-08-26 · **PARTIAL (doc 02 only — verification of the T02/T03 fixes)**

| Field                      | Value                                                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| Commit                     | `2478d3586` + the Phase 2 changes on `fix/ingest-fidelity`                |
| Ran by                     | Claude (agent), driven by John                                            |
| How                        | streaming ingest via `POST /questionnaires/stream` · doc 02 ×4, doc 03 ×1 |
| Extractor model            | `openai/gpt-5.4`                                                          |
| Critic model               | `openai/gpt-5.4`                                                          |
| Candidacy model            | `openai/gpt-5.4-mini`                                                     |
| Analyst model              | `openai/gpt-5.4`                                                          |
| Conditional topics enabled | no (fresh version each ingest)                                            |
| Environment                | local dev DB, dev server on :3020                                         |

**Not scored.** This run existed to verify that faithful ingest holds, not to score the corpus. The
scoreable row for doc 02 is R002's.

**Question count, four ingests of doc 02: 22, 22, 22, 22.** Against R002's 22, 28, 23, 28, 28, 28 on
the same file. The extractor is now forbidden to split compound questions, and `disallowedEditCount`
was absent (zero) on all four — the instruction is landing, not merely present. Sections 7/7 and the
analyst's proposal (7 topics, 4 conditional) were identical on every run.

**The critic's new coverage read was right on both shapes.** Doc 02: `{"assessment": "matches",
"sourceQuestionCount": 22}` four times out of four. Doc 03, which numbers nothing, was run as a
control to check the critic counts rather than echoes — it found the bullet list and reported
`"The source contains 23 bullet-point questions across sections 1-8, and 23 questions were
extracted"`, matching the 23 extracted.

**What this run did NOT establish.** No `extra_questions` or `missing_questions` verdict was
observed live — only `matches`. The vocabulary is covered by prompt-level unit tests, and the doc-03
control shows the count is independently derived, but the discriminating case has not been seen in
the wild. Worth watching on the first full corpus run.

---

### R002 — 2026-08-26 · **PARTIAL (doc 02 only)**

| Field                      | Value                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Commit                     | `e0a966ea6` + the ingest-fidelity and candidacy fixes on `fix/ingest-fidelity`      |
| Ran by                     | Claude (agent), driven by John                                                      |
| How                        | streaming ingest via `POST /questionnaires/stream` · **partial — doc 02 only**      |
| Extractor model            | `openai/gpt-5.4`                                                                    |
| Critic model               | `openai/gpt-5.4`                                                                    |
| Candidacy model            | `openai/gpt-4.1-nano` (attempts 1–2), then `openai/gpt-5.4-mini` (attempts 3–6)     |
| Analyst model              | `openai/gpt-5.4`                                                                    |
| Conditional topics enabled | no (fresh version each attempt — the candidacy check requires an untouched version) |
| Extract tables             | default (on; PDF-only, so inert for a `.md`)                                        |
| Total cost / wall time     | ~$0.42 across six ingests · 48–88s each                                             |
| Environment                | local dev DB, dev server on :3020                                                   |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                            |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | --------------------------------------------------------------- |
| 01  | 1          |     |     |     |     |     |     |           |          | not run (see R001)                                              |
| 02  | 2          | 1   | 2   | 1   | 2   | 2   | 8   | extract   | none     | Analyst near-ideal; extraction question count varies run to run |
| 03  | 2          |     |     |     |     |     |     |           |          | not run                                                         |
| 04  | 3          |     |     |     |     |     |     |           |          | not run                                                         |
| 05  | 3          |     |     |     |     |     |     |           |          | not run                                                         |
| 06  | 3          |     |     |     |     |     |     |           |          | not run                                                         |
| 07  | 5          |     |     |     |     |     |     |           |          | not run                                                         |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                                         |
| 09  | 3          |     |     |     |     |     |     |           |          | not run                                                         |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                                         |

**Corpus score:** _n/a — partial_ · **Extraction band:** _n/a_ · **Restraint band:** _not exercised_
**Verdict:** not comparable — one document, in the easy band. The restraint band is still untouched.

**Six ingests, not one, and the row scores the sixth.** The first attempt failed at `candidacy` and
scored nothing below C; the run was then used to find and fix the cause, and repeated. Recording it
as one row would hide the most useful thing this run produced, so the sequence is below.

#### What broke

**C = 0 on attempt 1 — the check did not run.** No `scope_candidacy` `AppAiRun` row, no cached
verdict, and the stream went straight from "Checking for conditional routing…" to `done`. The cause
was not variance: `gpt-4.1-nano` emitted a stray `}` after each signal object, both attempts failed
to parse, and the fail-soft returned `null` — so the ingest completed having silently skipped
Conditional Topics entirely. Sampled directly against the API, that model malformed **4 of 24**
calls; the temp-0 retry path failed **1 in 10** on its own.

Chasing it turned up a **deterministic** fault underneath, which matters more than the model: the
`sourceQuote` cap (500 chars) and the `signals` cap (8) were enforced by Zod, stated nowhere in the
prompt, and a violation threw away the whole verdict. **Corpus doc 05 failed this way 3/3 on every
model tested**, `gpt-5.4` included — which means doc 05's candidacy check had never once worked and
never would have. Frontier models were not immune, they simply failed the other cap: `gpt-5.4`
returns nine or ten signals where the contract allows eight.

Measured over all ten corpus documents, schema enforcement on:

| Model                      |     Clean | Latency | $/call   | How it failed       |
| -------------------------- | --------: | ------- | -------- | ------------------- |
| `gpt-4.1-nano` _(was)_     | 20/24 raw | ~2.6s   | $0.00026 | malformed JSON      |
| `gpt-4o-mini`              |     45/50 | ~2.6s   | $0.00039 | `sourceQuote` > 500 |
| `gpt-5.4-nano`             |     38/40 | ~2.0s   | $0.00020 | `sourceQuote` > 500 |
| **`gpt-5.4-mini`** _(now)_ | **60/60** | ~1.7s   | $0.00086 | —                   |
| `gpt-5.4` _(reasoning)_    |     17/20 | ~3.5s   | $0.00530 | `signals` > 8       |

**P = 1 — the question count is not stable.** Six ingests of the same file on the same build
produced **22, 28, 23, 28, 28 and 28** questions against a source with 22 numbered items. The
extractor is splitting compound questions ("Who is the DSL this year, **and** when did they last
complete advanced training?" → two), which `extraction-prompt.ts` explicitly instructs it to do, and
every split was recorded as a revertable `split_question` change. So this is disclosed, not
invented — but it is applied inconsistently, and two ingests of one document that disagree on the
question count are not comparable in a cohort. Parked as **T02**.

The fidelity critic did not notice. It checked all 28 and flagged 3 — correctly downgrading two
`date` types to `free_text` — because it is a **per-question** check with no count or coverage
dimension. Parked as **T03**.

**T = 1 — Part A placed at `opening` rather than `core`.** Everything else matched: A/B universal,
C–F conditional, G closing, `fromDocument: true`. Both README distractors were handled _well_ —
"Part G … last" became `phase: closing` rather than a criterion, and "if you are unsure whether a
part applies, complete it" became `fallbackTopicKeys: [C,D,E,F]` rather than a criterion, which is
the ideal reading of an inclusion bias. Whether `opening` is an error at all is arguable; scored
against the README as written, and parked as **T04** because it may be the ground truth that needs
the edit.

G = 2: all six `sourceQuote`s verified as exact spans, zero fabrication. R = 2: no invented caps or
depth dials. C = 2 on every attempt after the fix, `isCandidate: true`, confidence 1.0, three quoted
signals.

#### Changed since last run

1. **The candidacy JSON schema is forwarded.** `scopeCandidacyJsonSchema` existed and was
   unit-tested since P17.19 but was wired to nothing.
2. **Caps clip instead of rejecting**, and the prompt now states all three to the model.
3. **The candidacy agent is bound to `openai/gpt-5.4-mini`** rather than left empty to resolve the
   routing tier. Clear the binding to fall back as before.
4. **`AppAiRun.costUsd` is populated** for `extraction_verify`, `scope_candidacy` and
   `routing_analysis` — the three ingest writers never passed it. `gpt-5.4-mini` was added to the
   pricing registry, without which the new binding logged $0.00.

---

### R001 — 2026-08-26 · **PARTIAL (doc 01 only)**

| Field                      | Value                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ |
| Commit                     | `e0a966ea6` + the uncommitted ingest-fidelity fixes on `fix/ingest-fidelity`   |
| Ran by                     | Claude (agent), driven by John                                                 |
| How                        | streaming ingest via `POST /questionnaires/stream` · **partial — doc 01 only** |
| Extractor model            | `openai/gpt-5.4`                                                               |
| Critic model               | `openai/gpt-5.4`                                                               |
| Candidacy model            | `openai/gpt-4.1-nano`                                                          |
| Analyst model              | `openai/gpt-5.4`                                                               |
| Conditional topics enabled | no (fresh version — the candidacy check requires an untouched version)         |
| Extract tables             | default (on; PDF-only, so inert for a CSV)                                     |
| Total cost / wall time     | $0.1139 · 76s                                                                  |
| Environment                | local dev DB, dev server on :3020                                              |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                      |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | --------------------------------------------------------- |
| 01  | 1          | 2   | 2   | 1   | 2   | 2   | 9   | analyst   | none     | AD1 (`Always`) swept into the conditional Adherence topic |
| 02  | 2          |     |     |     |     |     |     |           |          | not run                                                   |
| 03  | 2          |     |     |     |     |     |     |           |          | not run                                                   |
| 04  | 3          |     |     |     |     |     |     |           |          | not run                                                   |
| 05  | 3          |     |     |     |     |     |     |           |          | not run                                                   |
| 06  | 3          |     |     |     |     |     |     |           |          | not run                                                   |
| 07  | 5          |     |     |     |     |     |     |           |          | not run                                                   |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                                   |
| 09  | 3          |     |     |     |     |     |     |           |          | not run                                                   |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                                   |

**Corpus score:** _n/a — partial_ · **Extraction band:** _n/a_ · **Restraint band:** _not exercised_
**Verdict:** not comparable — a single document, and the only one in the trivial band.

**Why partial.** This run existed to verify the ingest-fidelity fixes end to end, not to score the
corpus. Doc 01 was chosen because it is the one the `.csv` blocker made unrunnable. The other nine
were not attempted; the restraint band (07, 08, 10) — the band that decides shippability — is
untouched, so nothing here says the pipeline is safe to ship.

#### What broke

**T = 1 — the Adherence split.** The analyst put all three Adherence questions into one
`conditional` topic criteria'd _"Only where PC2 is 4 or more"_. The document marks AD1 `Always`,
so a patient on one to three medicines would now never be asked "In a typical week how often do
you miss a dose?" — the section's only universal question, silently gated. The README names this
as doc 01's one wrinkle, and the analyst did notice it: it filed a `gap` saying the section
_"mixes one always-asked question with two questions asked only where PC2 is 4 or more"_ and that
it could not split them _"while keeping every question in exactly one topic"_. Reporting the
conflict is the honest half; resolving it by widening the criterion over AD1 is the wrong half.

Worth recording that a **prior run of the same document through a `.txt` copy split it correctly**
into `adherence` (core, AD1) and `adherence_support_needs` (conditional, AD2–AD3). Same build,
same models, different parse. So this is analyst variance on a genuinely hard case, not a
regression from the fixes — none of which touch the analyst prompt. It is the single most useful
thing this run found. Parked as **T01** in [Candidate tweaks](#candidate-tweaks) rather than acted
on: one observation of a case that has already been seen going the other way is not evidence.

Everything else was clean. P: 9/9 sections, 22/22 questions, every answer type faithful — the
critic flagged **zero** questions (against four on the earlier `.txt` run), so the repair pass did
not run at all. C: `isCandidate: true`, confidence 1.0. G: all ten `sourceQuote`s verified as exact
spans of the parsed CSV; zero fabrication. R: `fromDocument: true`, no invented caps or depth
dials, one honest gap.

#### Changed since last run

First recorded run. The build carries the four ingest-fidelity fixes this run was made to verify:

1. **`.csv` accepted.** Doc 01 could not previously be ingested at all — the allowlist never
   listed `.csv` though the parser router always had a branch for it. Server guards and all six
   admin file pickers now derive from one constant.
2. **The critic's numeric carve-out.** `Rating 1-5` was being flagged as a type mismatch, sending
   the repair specialist to build an unanchored likert the write schema rejects by design. Both
   the flag and the wasted round-trip are gone.
3. **Numeric bounds kept.** PM1 now persists as `numeric` with `{"min":1,"max":5}` instead of an
   empty config.
4. **Resolved-model provenance.** All three `AppAiRun` rows name a real provider and model; the
   models in the table above were read from `AppAiRun` alone, with no join to `ai_cost_log`.

---

## Candidate tweaks

Things a run suggested changing, parked here **deliberately unactioned** until more runs say
whether they are real.

**Why parking is the rule, not caution.** These documents are read by an LLM, so two runs of the
same file on the same build can differ — T01 below was seen going both ways. A prompt edit made
from one observation is as likely to encode the noise as fix the fault, and prompt edits are the
hardest change here to attribute later: the next run moves for a reason nobody can separate from
the edit. A tweak earns its way out of this table by recurring, or by being a bug rather than a
judgement.

Statuses: **open** (seen once, watching) · **confirmed** (seen on ≥2 runs, worth acting on) ·
**actioned** (changed — say in which run's "Changed since last run") · **dropped** (did not recur,
or judged correct as-is).

> **T02 and T03 skipped the queue deliberately.** The parking rule exists because a prompt edit made
> from one observation is as likely to encode noise as fix a fault. Neither of these was a judgement
> call: T02 was **non-determinism** (one file, one build, six different question counts), which is a
> defect whatever the right count is, and T03 was a **structural blind spot** (a per-question critic
> cannot see a wrong question set) rather than a case of the critic judging badly. Both are the
> "plain bug" exception at the bottom of this section.

| ID  | Raised     | Docs   | Status                   | What was seen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Candidate tweak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------- | ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T08 | R005       | 04     | open                     | Run 2 of doc 04 proposed five conditional topics and its `summary` — the prose the admin reads on the Topics tab — said "**four** conditional due-diligence sections". Run 1's said five and was right. Nothing about the routing is wrong; the sentence describing it is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Low severity, recorded because it is cheap to check and corrodes trust in the one paragraph an admin actually reads. Watch whether it recurs before considering a prompt line telling the analyst to count its own output. Do not act on one sighting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T07 | R005       | 07     | **confirmed — critical** | All five of doc 07's triggered blocks were proposed as `conditional` topics with criteria quoting "at any stage" / "at any point" / "in passing". Identical on both runs, and identical on both sides of the R005 prompt change, so it is neither variance nor a regression. Conditional Topics settles scope once, at the end of the opening, so every one of these is decided before the disclosure it waits for can happen — on safeguarding, care-leaver, health, immigration and arrears text. The analyst DID file one honest gap naming the mid-interview mechanism, so it is not unaware; it gapped the mechanism and then converted the blocks anyway.                                                                           | **A product decision, not a prompt tweak — do not fix this from the prompt without deciding the behaviour first.** The two obvious options are both bad on their own: gapping the five blocks means an abuse-disclosure block is never asked at all (worse than asking it when the opening mentioned abuse), and leaving them as-is ships an instrument that silently behaves differently from what its author wrote. The README's "⚠️ Mid-interview triggers are not expressible today" is the standing analysis; the real options are a mid-interview re-scope mechanism (with the report-reproducibility consequences it names) or an explicit refusal path that keeps the blocks visible to the admin as not-routable. Needs John.                              |
| T06 | R004       | 02, 03 | open                     | Every one of doc 03's six criteria turns on a site fact (lifting above 20kg, a confined-space register, COSHH storage, night shifts) that **no question in the instrument captures**. The opening topic asks about visitor routes, permits, drills and near-misses, so the planner decides six topics on an opening that cannot evidence any of them. The analyst noticed — its `summary` says "no hard rules are possible because there are no data slots to test against" — but put it in prose, and `gaps` came back empty on all six runs. R002 recorded the same shape on doc 02 as an aside inside T04 ("none of C–F's criteria are answerable from any question in the instrument anyway"), which is why two documents are listed. | Undecided, and deliberately so — the analyst's output here is _good_, and the two obvious fixes both make it worse. Turning the six into gaps would discard six correct, quotable conditional topics. Widening the opening is not the analyst's to do. The candidate is a **third** thing: keep the topics and add a gap saying the criteria are not answerable from this instrument, which needs the prompt to distinguish "cannot formalise" from "formalised, but nothing can evidence it". Do not touch the prompt until a third document shows the same shape.                                                                                                                                                                                                 |
| T05 | R004       | 03     | open                     | The extractor reworded 8, 12, 10, 10, 10 and 12 of one file's 23 prompts across six ingests, in three distinct classes: **self-containing** ("Who maintains the register…" → "…the confined-space register…", needed, because a question is delivered outside its heading), **cosmetic** ("Walk me through" → "Please walk me through", pure churn and most of the `changeCount` variance), and **meaning-narrowing** ("if the weather turns mid-task" → "if the weather changes during a work-at-height task", on 3 of 6 runs). All were filed as `rewrite_prompt` with a rationale asserting meaning was preserved, and the fidelity critic marked every one `ok`.                                                                      | Decide the policy before touching anything, exactly as T02 forced for splitting. The three classes want different answers and the prompt currently gives them one: self-containing is arguably required, cosmetic is noise, narrowing is a fidelity fault. A per-class instruction is the candidate ("resolve a pronoun or an elided noun the section heading supplied; change nothing else"), but see [`question-fidelity.md`](../../../../../.context/app/questionnaire/question-fidelity.md) first — the product already has a per-question ask-as-written dial, and ingest-time rewriting may be the wrong layer for this entirely. Separately from the policy: **unrecorded** rewrites were a plain bug and were actioned in R004 (`unattributedPromptCount`). |
| T04 | R002, R004 | 02, 03 | actioned                 | Part A (doc 02) and Section 1 (doc 03) proposed at `phase: opening` where the README's ground truth said `core`. Seen on two documents, two runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **README error, and the answer was in the code the whole time.** `no_opening_topic` in `scope/validate.ts` is an **error**-severity issue: a config where every always-asked topic is `core` fails validation, because nothing gathers the signal the planner reads. `opening` was not a defensible alternative reading — it was the only output that validates. Ground truth for 02 and 03 corrected, and the rule stated once above the per-document list rather than repeated ten times. The analyst was never wrong here.                                                                                                                                                                                                                                       |
| T03 | R002       | 02     | actioned                 | The fidelity critic checked all 28 extracted questions, flagged 3, and never noticed that 6 of the 28 did not exist in a 22-question source. It is a per-question faithfulness check with no count or coverage dimension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Give the critic a coverage/count check so extraction drift is caught at ingest, where it is cheap, rather than by a human reading the Structure editor. Pairs with T02.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T02 | R002       | 02     | actioned                 | Six ingests of one file on one build produced 22, 28, 23, 28, 28, 28 questions. The extractor splits compound questions — which `extraction-prompt.ts:182` instructs and which is recorded as a revertable `split_question` change — but does so inconsistently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Decide the policy, then make it deterministic. Splitting improves completion accuracy (each half gets its own satisfaction bar) and costs nothing in interview length; not splitting keeps a 1:1 mirror of the source. **Either way, non-determinism is the defect** — two ingests of one document that disagree on question count are not comparable in a cohort.                                                                                                                                                                                                                                                                                                                                                                                                  |
| T01 | R001       | 01     | open                     | All three Adherence questions swept into one `conditional` topic criteria'd _"Only where PC2 is 4 or more"_, though the source marks AD1 `Always`. The analyst filed an honest `gap` naming the mix, then resolved it by widening. **An earlier run of the same document (via a `.txt` copy) split it correctly**, so this is variance on a hard case, not a deterministic fault.                                                                                                                                                                                                                                                                                                                                                         | Teach the analyst to prefer **splitting a mixed section into two topics** (one core, one conditional) over widening one criterion across a question the source says to always ask. Silently gating an `Always` question is the worse failure of the two.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Working the table

- **One line per observation, raised against the run that found it.** If a later run sees it again,
  add that run to `Raised` and move it to **confirmed** — that is the promotion signal.
- **Record the ones that did not recur too.** Marking T0n **dropped** after three clean runs is a
  real result: it says the pipeline is variable there, which is worth knowing before anyone trusts
  a single-run score.
- **Never edit a prompt straight from a `What broke` paragraph.** It goes here first. The whole
  point of the ledger is that changes are attributable to evidence, and evidence means more than
  one run.
- **A tweak that is a plain bug can skip the queue** — a fabricated quote, a dropped stop
  condition, a crash. Those are not judgement calls and do not need corroboration.

---

## Trend

One row per run. The three percentages and the critical-failure count are the whole point
of the file; everything above exists to make them mean the same thing each time.

| Run            | Date       | Commit            | Analyst model    | Corpus | Extraction band | Restraint band | Critical failures   | Verdict                        |
| -------------- | ---------- | ----------------- | ---------------- | ------ | --------------- | -------------- | ------------------- | ------------------------------ |
| R005 (partial) | 2026-08-26 | `bbfbd28d1`+gaps  | `openai/gpt-5.4` | _n/a_  | _n/a_           | not scored     | 1 (doc 07, control) | partial — doc 04 only scored   |
| R004 (partial) | 2026-08-26 | `0d129065f`+ph2   | `openai/gpt-5.4` | _n/a_  | _n/a_           | not run        | 0                   | partial — doc 03 only          |
| R003 (partial) | 2026-08-26 | `2478d3586`+ph2   | `openai/gpt-5.4` | _n/a_  | _n/a_           | not run        | 0                   | verification only — not scored |
| R002 (partial) | 2026-08-26 | `e0a966ea6`+fixes | `openai/gpt-5.4` | _n/a_  | _n/a_           | not run        | 0                   | partial — doc 02 only          |
| R001 (partial) | 2026-08-26 | `e0a966ea6`+fixes | `openai/gpt-5.4` | _n/a_  | _n/a_           | not run        | 0                   | partial — doc 01 only          |

### Reading it honestly

- **The middle band carries the least information.** Four documents sit at difficulty 3, so
  a corpus score can move a few points on noise in the band that discriminates least. Look
  at the ends: 01 dropping implicates plumbing, and the restraint band moving is the only
  movement that changes what is safe to ship.
- **Model changes are not build changes.** A resolved model differing from the last run
  (fallback, a provider swap, a seed change) makes the two runs different experiments.
  Record it in "Changed since last run" or the trend is comparing two things.
- **A good score here is bounded by the corpus.** Everything is clean Markdown and CSV,
  the largest document is ~4.5k characters, and nothing exercises `docx`/`pdf`/`xlsx`
  parsing, 200-question instruments, or routing past `MAX_CANDIDACY_DOCUMENT_CHARS`. The
  README's "Known gaps" section is the list of things a 100% here does not tell you.
