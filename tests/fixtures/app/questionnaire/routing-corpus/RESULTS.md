# Routing corpus — ingestion results ledger

**Companion to [`README.md`](./README.md).** The README says what each of the ten
documents is for and what a correct result looks like. This file records what actually
happened, run by run — when it ran, against which build and which models, what it got
right, where it broke, and one number per run that can be compared to the last one.

Nothing here is inferred. Every row is filled in from a run that was actually performed;
an unrun document is left blank rather than estimated, and a run that was abandoned
half-way is recorded as such. A ledger that guesses is worse than no ledger, because the
trend line it draws is fiction.

> **Status: the corpus has a score. R010 (2026-08-26) scored the restraint band, so all ten documents
> now sit on one build (`f4ab51f48`).**
>
> **Corpus 84.0% · extraction band 95.7% · restraint band 56.7% · three critical failures ·
> NOT SHIPPABLE.**
>
> A 39-point gap between the bands, and one critical failure in every restraint-band document — the
> exact pattern the README predicted by name before anything was measured. One sentence explains all
> three: **the analyst will not decline.** Given a routing instruction the product cannot express it
> produces a plausible conditional topic instead of a gap, every time. See **T07**, now confirmed on
> docs 07, 08 and 10.
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

**An ellipsis is a second, separate case, and normalisation does not reach it.** R006 saw candidacy
signal 1 on doc 05 come back as `"Not every domain applies to every engagement... Use the following:"`
— an elision joining two spans that are ~250 characters apart in Appendix C. Neither half is
invented; the quote as a whole matches nothing. **Split on `...` / `…` and check each part
separately** before calling it fabricated. Only if a part still misses is it the real thing.

**A third shape is a construction, and it is the one to actually worry about.** R007 saw doc 06's
candidacy signal 2 come back as `"Getting started; The decision; The work itself; Management and
support; Team and culture; Reward and progression; Closing"` — the seven section headings joined
with semicolons. Every part is byte-exact; the whole is a structure that exists nowhere in the file.
Splitting on `;` as well as `…` catches it, but **do not just widen the matcher and move on**:
unlike stripped emphasis and elision, this is not a rendering artefact of a real span, it is an
assembled one. Record it in the notes when it appears (see **T10**).

**Compare against the text the model was given, not the file on disk.** R009 read all twelve of doc
01's quotes as fabricated before catching this. Doc 01 is a CSV, and the CSV parser renders each row
as `Section: … | Question ID: … | Question: … | Response type: … | When to ask: …`, so
`"When to ask: Only where PC2 is 4 or more"` is a real contiguous span of what the analyst read and
appears nowhere in the source file. Every ingest stores what was actually parsed on
`AppQuestionnaireSourceDocument.extractedText` for that version — **use that**. For the nine `.md`
fixtures it is the same bytes (the txt parser is a straight `buffer.toString('utf-8')`), so this
costs nothing and removes a trap that only fires on the formats a real customer uploads.

A quote that survives all three tests **against `extractedText`** and still does not match is the
real thing, and it is critical.

One watch item that is **not** critical but is worth recording in the notes: on **05**,
Appendix B's scoring note reads like a rule and is not one. If it becomes a routing rule,
say so.

### Doc 06 is scored out of 6, because three dimensions do not apply to it

The rubric above was written for documents that **have** routing, and doc 06 does not. Read
literally it punishes the correct result three times over, which R007 found the hard way:

- **T — Topic set.** `0` is "more than two [errors], or **no proposal at all**". When candidacy
  correctly declines, `stream/route.ts:230` never invokes the analyst, so there is no proposal —
  and that absence is the right answer, not a zero.
- **G — Grounding.** Scores the analyst's `sourceQuote`s. No analyst ran, so there are none.
- **C — Candidacy.** `2` requires "correct verdict, **with quoted signals**"; `1` is "correct
  verdict but thin — no quotes". A signal saying _"the document contains no branching
  instructions"_ has nothing to quote, because you cannot quote an absence. R007 run 1 filed two
  unquoted negative observations and was exactly right to.

**The convention:** score doc 06 on **P, C and R only, out of 6**, and mark T and G `n/a`. A
negative signal with no `sourceQuote` is worth full marks under C — quotes are required only where
the claim is that the document says something. The corpus score is the mean of the ten per-document
percentages, so doc 06 contributes its percentage of 6 like every other document contributes its
percentage of 10, and nothing else in the arithmetic changes.

What doc 06 still scores strictly is the thing it exists for: **any conditional topic is a critical
failure**, and so is a candidacy `null` (fail-soft — the check did not run), which is not the same
result as a candidacy `false`.

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

### R010 — 2026-08-26 · **THE FIRST FULL CORPUS SCORE (docs 07, 08, 10 ×2 each — the restraint band, scored at last)**

| Field                      | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| Commit                     | `f4ab51f48` on `fix/ingest-fidelity-phase-2` (clean tree — no local edits) |
| Ran by                     | Claude (agent), driven by John                                             |
| How                        | streaming ingest via `POST /questionnaires/stream` · 07 ×2, 08 ×2, 10 ×2   |
| Extractor model            | `openai/gpt-5.4`                                                           |
| Critic model               | `openai/gpt-5.4`                                                           |
| Candidacy model            | `openai/gpt-5.4-mini`                                                      |
| Analyst model              | `openai/gpt-5.4` (one hard failure — see **T13**)                          |
| Conditional topics enabled | no (fresh version each ingest)                                             |
| Total cost / wall time     | $1.231 across six ingests · 54–101s each                                   |
| Environment                | local dev DB, dev server on :3020                                          |

**All ten documents are now scored on `f4ab51f48`.** R006–R009 covered the extraction band; this run
covers 07, 08 and 10. One build, ten documents, so the three numbers below are comparable to each
other and are the first that can be compared to anything later.

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                                  |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | --------------------------------------------------------------------- |
| 01  | 1          | 1   | 2   | 1   | 2   | 2   | 8   | extract   | none     | R009 · T01 variance; declared types overridden                        |
| 02  | 2          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | R009 · T02 fix holds — 22 questions twice                             |
| 03  | 2          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | R009                                                                  |
| 04  | 3          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | R005                                                                  |
| 05  | 3          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | R006                                                                  |
| 06  | 3          | 2   | 2   | n/a | n/a | 2   | 6/6 | none      | none     | R007 · negative control, out-of-6 convention                          |
| 07  | 5          | 2   | 2   | 0   | 2   | 0   | 6   | analyst   | **YES**  | All five triggered blocks coerced — **T07**, now scored not control   |
| 08  | 4          | 2   | 2   | 2   | 1   | 0   | 7   | analyst   | **YES**  | Estate-planning trigger coerced; contradictions resolved not surfaced |
| 09  | 3          | 2   | 2   | 2   | 1   | 2   | 9   | analyst   | none     | R008 · four assembled quotes                                          |
| 10  | 5          | 1   | 2   | 0   | 1   | 0   | 4   | analyst   | **YES**  | **Stop condition discarded**; four triggers coerced                   |

**Corpus score: 84.0%** · **Extraction band (01–06, 09): 95.7%** · **Restraint band (07, 08, 10): 56.7%**
**Critical failures: 3 — one in every restraint-band document.**
**Verdict: NOT SHIPPABLE.**

#### This is precisely the pattern the two-band split was built to expose

> _"A pipeline can score full marks on 01–06 and still be unsafe to ship."_ — the README, written
> before any of this was measured.

A 39-point gap between the bands. The extraction band is close to solved: five of its seven
documents are perfect, and the two that are not lost their points to variance and a strict typing
check, not to anything unsafe. The restraint band fails **every** document, and the failures are the
named ones — the corpus predicted each of them by name before a single run happened.

**The single sentence that explains all three:** the analyst will not say "I cannot do this." Given a
routing instruction the product cannot express, it produces a plausible conditional topic instead of
a gap, every time, on all three documents. It is not unaware — each run filed at least one honest gap
naming the mid-interview mechanism — it gaps the _mechanism_ and then converts the _blocks_ anyway.

#### Doc 07 — 6/10, critical. T07 reproduced exactly, and it is no longer a control

All five triggered blocks proposed as `conditional` topics on **both** runs, with criteria quoting
the trigger language verbatim:

| Topic                                | Criteria proposed                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `triggered_block_domestic_abuse`     | "If the applicant discloses, **at any stage**, that they are…fleeing abuse"    |
| `triggered_block_care_leaver`        | "If it emerges **at any stage** that the applicant has been looked after…"     |
| `triggered_block_health_disability`  | "…**at any stage** — including **in passing** while answering something else"  |
| `triggered_block_immigration_status` | "If the applicant's immigration or residence status comes up **at any point**" |
| `triggered_block_rent_arrears`       | "If arrears of more than two months are mentioned **at any stage**"            |

Conditional Topics settles scope once, when the opening completes, so every one of these is decided
before the disclosure it waits for can happen. A disclosure of abuse in minute 40 does not add the
block. The document forbids exactly this — _"A trigger that fires in the final five minutes still
means the block is asked. Do not defer a triggered block to a second appointment"_.

**Identical to R005's control, on a later build, twice more.** That is now four runs across two
builds with the same result, which removes any remaining question of variance. `T=0` (five membership
errors against a ground truth that says these belong in `gaps[]`) and `R=0` (coercion of a trigger is
named in the rubric). Extraction and grounding were flawless — 11 sections, 36 questions, every quote
byte-exact — which is what makes this dangerous rather than obviously broken.

#### Doc 08 — 7/10, critical, and one run produced nothing at all

**Run 1 resolved all four contradictions in favour of the adviser notes.** Protection needs → `core`
for every client; Vulnerability → `closing` for every client; Attitude to risk → conditional with
_"Every client, except where the client is transacting on an execution-only basis"_; Estate planning
→ conditional on _"The client raises inheritance themselves"_. Each choice is the defensible one —
the notes are the later, more specific source — and the summary does say it applied "adviser-note
overrides", so this is not the fully silent failure the README feared.

**But it never says the two sources disagree.** One gap was filed, and it is about "Use judgement"
being too vague to formalise — not about the front sheet and page 2 contradicting each other four
times. An admin reads a tidy proposal and a summary describing revisions; nothing tells them the
instrument argues with itself and that a side was picked on their behalf.

**`R=0` is not a close call, because of Estate planning.** _"Only ever asked where the client raises
inheritance themselves"_ is a **trigger** — it fires when the client brings it up, mid-conversation —
and it was rendered as an opening-time criterion. That is doc 07's failure again, on a fourth
document, and it makes the score independent of any judgement about the contradictions.

**Run 2 produced no proposal at all — a hard schema failure, and the cause is a plain bug.** See
**T13**. It is recorded here rather than scored: doc 08's row is scored from run 1, because a
validation crash is a plumbing failure and says nothing about the analyst's judgement. Had run 2 been
the only run, doc 08 would have scored `T=0`, `R=0` and shown an admin nothing.

#### Doc 10 — 4/10, critical. The stop condition was discarded

The corpus's most exposed document, and it produced the failure the README names:

> _"an analyst that produces a tidy proposal here has silently discarded a stop condition."_

The eligibility screener says _"**stop the review** if the answer rules the partner out… End the
conversation here."_ On **both** runs it became an `opening` **topic with questions** — the
termination semantics gone entirely. Run 1 filed no gap about it whatsoever. Run 2 filed three gaps
and is much the better run, but even its eligibility gap says the dispute status _"cannot be
formalized as a topic criterion or hard rule"_ — an unformalisable-criterion framing. **It never says
this condition ends the interview.** A stop condition rendered as an opening question is not a
near-miss; it is the difference between "do not review this partner" and "review this partner, having
asked whether you should".

The four escalation triggers were coerced on both runs, criteria and all (_"even in passing, even
while answering something else"_). Mutual exclusivity — _"a partner takes one of these, not several"_
— went unexpressed and ungapped on run 1; run 2 gapped it correctly, which is the one thing that
moved between the runs.

`P=1`: run 1 minted 38 questions against the source's 36, the extra two being the screener bullets
turned into questions; run 2 landed 36 but moved an opening question into the Eligibility section.

#### T13 — a hard, unretryable analyst failure caused by two components disagreeing about a number

Doc 08 run 2's `routing_analysis` row: `status = 'failed'`, `model = 'n/a'`, error —

> `Routing analyst response was not valid against the schema after one retry (invalid at:
topics.6.questionKeys.0, topics.8.questionKeys.0)`

Those two paths are exact. Topic 6 is Protection Needs and topic 8 is Vulnerability, and their first
question keys — minted by the **extractor**, on the same ingest — are:

- `what_would_happen_financially_to_your_dependants_if_you_could_not_work` — **70 characters**
- `is_there_anything_about_your_circumstances_that_makes_dealing_with_this_harder` — **78 characters**

`analysis-schema.ts:77` validates every entry of `questionKeys` with `.max(TOPIC_KEY_MAX_LENGTH)`,
and `TOPIC_KEY_MAX_LENGTH` is **64** (`scope/types.ts:203`). `extraction-schema.ts:50` mints question
keys as `z.string().min(1)` — **no maximum at all**.

So the analyst faithfully echoed back real keys belonging to real questions and was rejected for it.
**The retry cannot help**: the only way to satisfy the schema is to shorten a key, and a shortened key
matches no question. The failure is durable — a `failed` routing_analysis is the "already tried"
signal the Topics tab reads, so it will not re-propose — and it is fail-soft, so the admin simply
sees no routing and no reason.

**Measured blast radius across all 42 corpus versions in this dev DB:** exactly one version has keys
over 64 (doc 08 run 2, two keys), and it is the **only** one of 40 routing analyses today that
failed. Four other versions came within nine characters of the cap and **doc 04 run 2 reached 63 —
one character short**. Key length varies run to run on the same document (doc 08's other run peaked
at 35), so this is a lottery every long-question instrument plays on every ingest.

**Filed as a plain bug, and the most shippable-blocking non-judgement item found so far.** Unlike
T07/T09/T10 it needs no product decision: either cap the key where it is minted, or raise/remove the
cap where it is validated. Capping at mint is the safer half — the DB column is `text` and unbounded,
so a long key is only ever a problem for whatever validates it next, and this is unlikely to be the
last validator.

#### What broke — the pattern across all three

**`gaps[]` is the load-bearing restraint signal and it is not carrying the load.** Three of the four
entries in the critical-failure table are "did this land in `gaps[]`". Across six restraint-band runs:

| Run  | Gaps filed | What was gapped                                         | What was coerced instead                 |
| ---- | ---------- | ------------------------------------------------------- | ---------------------------------------- |
| 07r1 | 1          | trigger timing/sequencing                               | all 5 triggered blocks                   |
| 07r2 | 1          | trigger timing/sequencing                               | all 5 triggered blocks                   |
| 08r1 | 1          | "Use judgement" is too vague                            | estate-planning trigger; 4 conflicts     |
| 08r2 | —          | _analysis failed (T13)_                                 | —                                        |
| 10r1 | 1          | mid-interview escalation timing                         | screener, mutual exclusivity, 4 triggers |
| 10r2 | 3          | dispute eligibility, mutual exclusivity, trigger timing | screener termination, 4 triggers         |

Every run gaps the _mechanism_ ("this timing cannot be expressed") and then proposes the _blocks_
anyway. The analyst demonstrably knows the product cannot do this — it says so, in prose, in the same
response — and converts them regardless. **That is one behaviour, not three bugs**, and it is the
thing to fix. It also means T07's product decision is bigger than doc 07: whatever is decided there
governs doc 08's estate planning and doc 10's four triggers too.

#### Scoring notes from this run

- **Candidacy legitimately quotes more than the document.** Doc 07 run 2 quoted `"Triggered block —
Domestic abuse"` — an **extracted section title**, not document text. The candidacy prompt is built
  from the document text **plus** section titles and question prompts, so that is a real span of what
  the model was given. Compare candidacy quotes against all three, not `extractedText` alone.
- **One near-miss recorded rather than scored.** Doc 10 run 1's third signal reproduces a sentence
  exactly but ends it with a colon where the document has a full stop. The Scoring section says
  punctuation must survive normalisation, deliberately. A terminal `.`→`:` is not the laundering that
  rule exists to prevent, so it was not called a fabrication — but it is the first time the rule has
  bitten something harmless and it is logged here in case it recurs.
- **Assembled quotes (T10) appeared on both hard documents** — 2 on doc 10 run 1, 5 on run 2, 1 on
  doc 08 run 1 — and cost each of them their `G` point. Third and fourth documents for T10.

#### Changed since last run

- **Nothing in the build.** R006–R010 all ran on `f4ab51f48` with a clean tree. That is what makes
  the corpus score above the first real one.
- **T07 promoted from control to scored**, on two further runs and a later build.
- **T13 raised** — plain bug, no decision needed, blocks nothing else.

---

### R009 — 2026-08-26 · **PARTIAL (docs 01, 02, 03 ×2 each — re-run on the current build; completes a real extraction band)**

| Field                      | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| Commit                     | `f4ab51f48` on `fix/ingest-fidelity-phase-2` (clean tree — no local edits) |
| Ran by                     | Claude (agent), driven by John                                             |
| How                        | streaming ingest via `POST /questionnaires/stream` · 01 ×2, 02 ×2, 03 ×2   |
| Extractor model            | `openai/gpt-5.4`                                                           |
| Critic model               | `openai/gpt-5.4`                                                           |
| Candidacy model            | `openai/gpt-5.4-mini`                                                      |
| Analyst model              | `openai/gpt-5.4`                                                           |
| Conditional topics enabled | no (fresh version each ingest)                                             |
| Total cost / wall time     | $0.563 across six ingests · 47–68s each                                    |
| Environment                | local dev DB, dev server on :3020                                          |

**Why this run exists.** R008 completed the extraction band but across four builds, which is seven
experiments and not a band. 01, 02 and 03 were the three still on old builds, and the three that
scored lowest. This re-runs them on `f4ab51f48` so the band means something.

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                              |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | ----------------------------------------------------------------- |
| 01  | 1          | 1   | 2   | 1   | 2   | 2   | 8   | extract   | none     | Analyst unchanged (still variance). P deducted by a **new check** |
| 02  | 2          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | **22 questions both runs — T02's non-determinism is gone**        |
| 03  | 2          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | Analyst flawless; every rewrite now declared, none narrowing      |
| 04  | 3          |     |     |     |     |     |     |           |          | not re-run (R005, effectively this build — see below)             |
| 05  | 3          |     |     |     |     |     |     |           |          | not re-run (see R006)                                             |
| 06  | 3          |     |     |     |     |     |     |           |          | not re-run (see R007)                                             |
| 07  | 5          |     |     |     |     |     |     |           |          | not run (control only in R005 — see **T07**)                      |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                                           |
| 09  | 3          |     |     |     |     |     |     |           |          | not re-run (see R008)                                             |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                                           |

**Corpus score:** _n/a — the restraint band has never been run_
**Extraction band (01–06, 09): 95.7%** — the first real one. **Restraint band: still not scored.**
**Verdict:** the extraction band is in good shape and the two fixes it was re-run to test both hold.
Shippability is unchanged and still gated on **T07**.

#### The first real extraction-band number

All seven extraction-band documents, all on `f4ab51f48`:

| Doc | Score | %   | Scored in | Movement                                                                         |
| --- | ----- | --- | --------- | -------------------------------------------------------------------------------- |
| 01  | 8/10  | 80  | R009      | ↓ from 9 (R001) — a new check, not a regression; see below                       |
| 02  | 10/10 | 100 | R009      | ↑ from 8 (R002) — T02/T03 fixes                                                  |
| 03  | 10/10 | 100 | R009      | ↑ from 9 (R004) — T05's unattributed half                                        |
| 04  | 10/10 | 100 | R005      | — (ran on `bbfbd28d1`+the gaps fix, which is exactly what `f4ab51f48` committed) |
| 05  | 10/10 | 100 | R006      | —                                                                                |
| 06  | 6/6   | 100 | R007      | — (out-of-6 convention)                                                          |
| 09  | 9/10  | 90  | R008      | —                                                                                |

**Mean: 95.7%.** Doc 04's row is the one caveat — it was scored on the working tree that became
`f4ab51f48`, not on the commit. Everything else is the commit.

#### What the re-run was for: both fixes hold

**T02 is dead. Doc 02 returned 22 questions on both runs.** R002 saw 22, 28, 23, 28, 28, 28 across
six ingests of this file — the defect that forced the splitting-policy decision. Two ingests are not
six, so this is evidence and not proof, but 22 is the source's true count and both runs hit it
exactly, with identical per-section counts (4, 4, 3, 3, 3, 3, 2). Doc 02 also now lands the topic set
perfectly: Part A `opening`, Part B `core`, Parts C–F `conditional`, Part G `closing` — which is the
**T04**-corrected ground truth. Both of the document's planted distractors were resisted: _"Part G is
completed by every school, last"_ became a `closing` phase and not a routing criterion, and _"if you
are unsure whether a part applies, complete it"_ became nothing at all. **8/10 → 10/10.**

**T05's plain-bug half holds. `unattributedPromptCount` was zero on all six ingests.** Doc 03 still
rewrites 9 of its 23 prompts on both runs — the rate has not moved — but every one is declared, and
**none narrows meaning**. R004's specific narrowing example did not recur: _"if the weather turns
mid-task"_ was left alone on run 1 and became _"if the weather changes mid-task"_ on run 2, which
preserves scope, where R004 saw _"during a work-at-height task"_ on three of six runs. The remaining
rewrites are self-containing ("the register" → "the confined-space register", "assessments" → "COSHH
assessments") or cosmetic ("Walk me through" → "Please walk me through"). Doc 03 also did the thing
its ground truth warns about — **it invented no `maxConditionalTopics`, no `fallbackTopicKeys` and no
`checkTopicPreference`**, on both runs. **9/10 → 10/10.**

#### What broke

**Doc 01's analyst is exactly where R001 left it — T01 is variance, confirmed.** Run 1 swept all
three Adherence questions into one `conditional` topic criteria'd on PC2 ≥ 4, although the source
marks AD1 `Always`. Run 2 **split it correctly**: `adherence` (core, 1 question — AD1) and
`adherence_support_for_polypharmacy` (conditional, 2 questions — AD2/AD3). Same file, same build.

The widening run did not do it blindly — it filed the honest gap again, naming the exact mechanism:
_"the section mixes one always-asked adherence question with two questions asked only where PC2 is 4
or more… every question must belong to exactly one topic and there can be only one conditional
criterion per topic."_ **T01 promoted to confirmed**, and the promotion makes the fix look cheaper
than R001 thought: the analyst already produces the preferred output about half the time, so this is
a prompt preference, not a missing capability.

**Doc 01 lost a P point to a check no previous run performed, and that needs saying plainly.** R001
scored doc 01 `P=2`. R009 scores `P=1`, and the difference is **not** evidence of a regression — it
is a stricter inspection. Doc 01 is the only source in the corpus that **declares its own answer
types** (a `Response type` column), which makes it the only one where honouring them is checkable,
and no earlier run appears to have opened `typeConfig`. Two things showed up:

- **Declared "Single choice" was overridden to `boolean` on 7 questions in run 1, and on none in run 2.** The rationale is reasonable each time ("the wording is binary and no other options are
  indicated") — but the document said `Single choice`, and the two runs disagree.
- **"Rating 1-5" (PM1) became `numeric` with `{min:1,max:5}` on both runs**, where the product has a
  `likert` type that exists for exactly this. Deterministic, and arguably the wrong target.

Neither is a fabrication and both are declared, so this is `P=1` ("a couple of questions mistyped"),
not worse. It is also the third sighting of the boolean-substitution shape after **T11**.

#### A plain bug found while checking doc 01, verified in code and by execution

Doc 01 run 1's change log contains **three questions whose recorded rationale contradicts what was
stored**: `infer_type` rows saying _"Source says single choice, but no answer options are provided,
so captured as free text **to avoid inventing choices**"_, `status = applied`, `supersededAt = null`
— against stored slots that are `single_choice` **with invented choices**.

The cause is not the extractor. A later repair pass — the scales/matrix specialist — upgraded those
three, and `changeForCorrect` (`_lib/orchestrate-extraction.ts:553`) writes its change row like this:

```ts
beforeJson: { suggestedType: original.suggestedType, suggestedTypeConfig: … },
afterJson:  { suggestedType: candidate.suggestedType, suggestedTypeConfig: … },
```

Two defects follow, and both are slips rather than judgements — its sibling `changeForMerge`, twelve
lines below, gets the first one right:

1. **No `key`.** `changeForMerge` puts `key` in both `beforeJson` and `afterJson`; `changeForCorrect`
   omits it, and `targetEntityId` is null. So the row that actually changed the question names no
   question, while the row it contradicts stays `applied` and un-superseded. That is what an admin
   reads.
2. **The revert is silently wrong, which is worse.** `planInferType`
   (`extraction-review/planner.ts:454`) reads `beforeJson.type` / `beforeJson.typeConfig`; this
   writer produces `beforeJson.suggestedType` / `suggestedTypeConfig`. The names never meet, so the
   recorded prior type is ignored and the planner takes its documented "no prior type recorded"
   branch — **`free_text`, with no config**. Verified by executing `planRevert` against a
   repair-shaped change: a `likert` → `matrix` repair plans as _"Restore question to type
   free_text."_ On this corpus it happens to land right, because the prior type really was
   `free_text`; on any repair that starts from a real type it is silent data loss on an operation
   whose whole promise is that it is revertible.

**Filed as T12 and flagged as a plain bug, which by this file's rules skips the queue.** It was
deliberately **not** fixed during R009: the point of this run was a single-build baseline across
seven documents, and it would be perverse to break that in the same session it was finally
established. It does not touch any scored dimension — the routing chain never reads these rows — so
fixing it cannot invalidate the 95.7%.

#### Changed since last run

- **Nothing in the build.** R006 through R009 all ran on `f4ab51f48` with a clean tree. Seven
  documents, one build, which is what makes the extraction-band number above the first real one.
- **Scoring procedure gained a rule that changes a past reading:** compare quotes against
  `AppQuestionnaireSourceDocument.extractedText`, not the file on disk. See below — doc 01 read as 12
  fabricated quotes until this was applied, and had none.
- **T01 promoted to confirmed** (R001 → R009, variance both times). **T12 raised.**

#### A scoring trap found while checking the quotes — the third one, and the worst

Doc 01 is the corpus's only CSV, and on the first pass **every one of its topic and candidacy quotes
read as fabricated** — twelve of them, which would have been twelve critical failures and a
not-shippable verdict on the trivial document.

All twelve are byte-exact. The mistake was comparing against the wrong artefact. The CSV parser
renders each row as `Section: … | Question ID: … | Question: … | Response type: … | When to ask: …`,
so `"When to ask: Only where PC2 is 4 or more"` is a real contiguous span **of the text the analyst
was given** and appears nowhere in the file on disk. The `.md` fixtures are read by a straight
`buffer.toString('utf-8')`, so raw and parsed are identical for nine of the ten documents, and the
distinction had never mattered.

**Always compare against `extractedText` on the version's `AppQuestionnaireSourceDocument` row.** It
is what the model actually read, it is stored per ingest, and for `.md` it costs nothing because it
is the same bytes. Written into the Scoring section above.

---

### R008 — 2026-08-26 · **PARTIAL (doc 09 ×2 — first scored run of it; completes the extraction band)**

| Field                      | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| Commit                     | `f4ab51f48` on `fix/ingest-fidelity-phase-2` (clean tree — no local edits) |
| Ran by                     | Claude (agent), driven by John                                             |
| How                        | streaming ingest via `POST /questionnaires/stream` · doc 09 ×2             |
| Extractor model            | `openai/gpt-5.4`                                                           |
| Critic model               | `openai/gpt-5.4`                                                           |
| Candidacy model            | `openai/gpt-5.4-mini`                                                      |
| Analyst model              | `openai/gpt-5.4`                                                           |
| Conditional topics enabled | no (fresh version each ingest)                                             |
| Extract tables             | on (default); irrelevant — `.md` has no tables                             |
| Total cost / wall time     | $0.176 across two ingests ($0.093 + $0.083) · 58s and 51s                  |
| Environment                | local dev DB, dev server on :3020                                          |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                           |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | -------------------------------------------------------------- |
| 01  | 1          |     |     |     |     |     |     |           |          | not run (see R001)                                             |
| 02  | 2          |     |     |     |     |     |     |           |          | not run (see R002)                                             |
| 03  | 2          |     |     |     |     |     |     |           |          | not run (see R004)                                             |
| 04  | 3          |     |     |     |     |     |     |           |          | not run (see R005)                                             |
| 05  | 3          |     |     |     |     |     |     |           |          | not run (see R006)                                             |
| 06  | 3          |     |     |     |     |     |     |           |          | not run (see R007)                                             |
| 07  | 5          |     |     |     |     |     |     |           |          | not run (control only in R005 — see **T07**)                   |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                                        |
| 09  | 3          | 2   | 2   | 2   | 1   | 2   | 9   | analyst   | none     | All three config surfaces set correctly; four quotes assembled |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                                        |

**Corpus score:** _n/a — partial_ · **Extraction band:** _see "The band is complete but there is still no band score"_ · **Restraint band:** _still not scored_
**Verdict:** the hardest thing doc 09 asks for — three configuration surfaces set at once from one
prose paragraph — was done perfectly, twice. The point it lost is **T10**, which R007 raised as
"harmless where it was found" and which has now turned up where it is not harmless.

**All three configuration surfaces landed, on both runs, exactly.** This is the document's whole
load and it carried it without a wobble:

| Surface                               | Ground truth (README)                                         | Run 1   | Run 2   |
| ------------------------------------- | ------------------------------------------------------------- | ------- | ------- |
| Topic set                             | Foundation always, 7 situational conditional, Closing closing | exact   | exact   |
| `maxConditionalTopics`                | `3` — a miss here is **not** partial credit                   | `3`     | `3`     |
| `depth` — Data management             | `light`                                                       | `light` | `light` |
| `depth` — Dissemination               | `light`                                                       | `light` | `light` |
| `depth` — Consent                     | `full`                                                        | `full`  | `full`  |
| `depth` — Vulnerable participants     | `full`                                                        | `full`  | `full`  |
| `depth` — the other three situational | unstated → schema default                                     | `full`  | `full`  |
| `fromDocument`                        | `true`                                                        | `true`  | `true`  |

Nothing was invented where the document is silent: no `fallbackTopicKeys`, no
`checkTopicPreference`, no `includeCheckTopic`, no hard rules. The vocabulary the README calls
"signposted" — "no more than three", "briefly", "in full" — was read correctly every time, and the
per-topic `depth` dial is the surface no previous document in the corpus had exercised at all.

**Extraction was deterministic and did something genuinely good.** 9 sections and 25 questions on
both runs with identical per-section counts (4, 4, 4, 2, 3, 3, 1, 2, 2). The secretary's notes and
the title block were pruned; each situational heading was shortened ("Situational area — Consent" →
"Consent") and **its applicability line preserved as the section description**, declared as
`add_section` with the rationale "preserved applicability guidance as the section description". That
is the right call — it keeps the routing sentence attached to the thing it routes. Run 2 did the
same thing but did not declare it as `add_section`, which is a bookkeeping inconsistency in the
change log rather than a difference in output. `unattributedPromptCount` zero on both; 7 and 6
`rewrite_prompt`, all cosmetic or self-containing, none narrowing.

#### What broke

**Four `sourceQuote`s per run are not spans. They are assemblies — and this is T10, escalated.**

R007 found the shape on a candidacy signal and recorded it as harmless, because a negative signal on
a declined document routes nothing. Doc 09 puts it on the **analyst's** `sourceQuote`, which is the
field the G dimension scores and the field the critical-failure table names. The same four topics
were affected on both runs, and they are not a random four — they are **exactly the four the
document names in its depth instructions**:

| Topic                   | Run 1 assembly                      | Run 2 assembly                                |
| ----------------------- | ----------------------------------- | --------------------------------------------- |
| Consent                 | criteria line + "in full" sentence  | heading + criteria line + "in full" sentence  |
| Vulnerable participants | criteria line + "in full" sentence  | heading + criteria line + "in full" sentence  |
| Data management         | "briefly" paragraph + criteria line | "briefly" paragraph + heading + criteria line |
| Dissemination           | "briefly" paragraph + criteria line | "briefly" paragraph + heading + criteria line |

**Every part is byte-exact and nothing is fabricated** — verified part by part after splitting on the
blank line. The analyst is stapling together the two or three real passages that jointly justify the
topic, separated by `\n\n`, and presenting the result as one quote. The pairing is substantively
_correct_: the criteria line plus the depth sentence genuinely is the evidence for that topic.

**Scored `G = 1`, not `G = 0`, and the reasoning matters more than the number.** `G = 0` is "any
fabricated quote — a span that appears nowhere in the file", and its target is invention. Nothing
here is invented. But `G = 2` requires "`sourceQuote` is a real span", and these are not: an admin
who searches the document for the quoted text will not find it, in the one field whose entire job is
to let them check the analyst's work. `1` is the only honest fit, and the rubric has no wording for
"over-complete" because until now nothing had produced it.

**Under the current literal wording this run has four critical failures, and it plainly does not.**
That is the strongest possible argument that **T10 is a definition problem, not a matcher problem** —
promoted to **confirmed**, on two documents and two stages.

**The deferral instruction went nowhere again — T09 confirmed.** Doc 09's secretary notes say _"Where
an area is clearly relevant but not among your three, note it for the committee rather than covering
it."_ The cap landed as `maxConditionalTopics: 3`; the instruction about what to do with the
remainder has no product expression and `gaps` was `[]` on both runs. That is the same shape as doc
05's _"record the remainder as deferred"_, now on a second document and a fourth observation.
**T09 promoted to confirmed**, and the question it asks is unchanged: is the R005 gaps bar
("cannot express it AT ALL") now too high for a partly-expressible instruction?

#### The band is complete but there is still no band score

Every extraction-band document has now been scored at least once — 01 (R001), 02 (R002), 03 (R004),
04 (R005), 05 (R006), 06 (R007), 09 (R008). **That is not a band score and must not be reported as
one.** They sit on four different builds, and this file's own rule is that a run on a different build
is a different experiment:

| Doc | Score | Build scored on   | Current?                                       |
| --- | ----- | ----------------- | ---------------------------------------------- |
| 01  | 9/10  | `e0a966ea6`+fixes | no                                             |
| 02  | 8/10  | `e0a966ea6`+fixes | no                                             |
| 03  | 9/10  | `0d129065f`+ph2   | no                                             |
| 04  | 10/10 | `bbfbd28d1`+gaps  | ~ (the gaps fix is what `f4ab51f48` committed) |
| 05  | 10/10 | `f4ab51f48`       | yes                                            |
| 06  | 6/6   | `f4ab51f48`       | yes                                            |
| 09  | 9/10  | `f4ab51f48`       | yes                                            |

**Re-running 01, 02 and 03 on `f4ab51f48` is what buys a real extraction-band number**, and those
three are also the three that scored lowest — 02 and 03 both lost their point at `extract`, which is
the stage `bbfbd28d1` and `f4ab51f48` changed. Doing that before touching the restraint band would
also mean any later prompt edit has a complete, single-build baseline behind it.

#### Changed since last run

- **Nothing in the build.** R006, R007 and R008 all ran on `f4ab51f48` with a clean tree, so docs
  05, 06 and 09 are directly comparable to each other and the only variable is the document.
- **Two tweaks promoted on evidence, not on judgement:** T09 (doc 05 → doc 09) and T10 (doc 06
  candidacy → doc 09 analyst). Neither was actioned — both still need a decision.

---

### R007 — 2026-08-26 · **PARTIAL (doc 06 ×2 — first scored run of the negative control)**

| Field                      | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| Commit                     | `f4ab51f48` on `fix/ingest-fidelity-phase-2` (clean tree — no local edits) |
| Ran by                     | Claude (agent), driven by John                                             |
| How                        | streaming ingest via `POST /questionnaires/stream` · doc 06 ×2             |
| Extractor model            | `openai/gpt-5.4`                                                           |
| Critic model               | `openai/gpt-5.4`                                                           |
| Candidacy model            | `openai/gpt-5.4-mini`                                                      |
| Analyst model              | **never invoked — candidacy declined, which is the correct result**        |
| Conditional topics enabled | no (fresh version each ingest)                                             |
| Extract tables             | on (default); irrelevant — `.md` has no tables                             |
| Total cost / wall time     | $0.131 across two ingests ($0.070 + $0.062) · 51s and 42s                  |
| Environment                | local dev DB, dev server on :3020                                          |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                 |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | ---------------------------------------------------- |
| 01  | 1          |     |     |     |     |     |     |           |          | not run (see R001)                                   |
| 02  | 2          |     |     |     |     |     |     |           |          | not run (see R002)                                   |
| 03  | 2          |     |     |     |     |     |     |           |          | not run (see R004)                                   |
| 04  | 3          |     |     |     |     |     |     |           |          | not run (see R005)                                   |
| 05  | 3          |     |     |     |     |     |     |           |          | not run (see R006)                                   |
| 06  | 3          | 2   | 2   | n/a | n/a | 2   | 6/6 | none      | none     | Declined twice. Scored out of 6 — see the convention |
| 07  | 5          |     |     |     |     |     |     |           |          | not run (control only in R005 — see **T07**)         |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                              |
| 09  | 3          |     |     |     |     |     |     |           |          | not run                                              |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                              |

**Corpus score:** _n/a — partial_ · **Extraction band:** _n/a_ · **Restraint band:** _still not scored_
**Verdict:** the negative control passes, twice, and it is the cheapest document in the corpus
because it passes. Still says nothing about shippability — **T07** stands and the restraint band is
still unscored.

**The false positive the document exists to provoke did not happen — at either layer.** Candidacy
returned `isCandidate: false` on both runs (confidence 0.97 and 0.91), no `routing_analysis` row was
written, and no `AppQuestionnaireTopicDraft` exists for either version. The bait did not bite: Q19
("Did you ever see or experience behaviour that concerned you?") produced no safeguarding topic, and
the Reward and progression block produced no role routing.

**And declining is visible in the bill.** Two ingests cost $0.131 against doc 05's $0.252 for the
same count, because the analyst call — the single most expensive step after extraction — never
happened. The candidacy gate paying for itself on a non-routing document is the behaviour it was
added for, and this is the first run that measures it rather than asserting it.

**Extraction was the most deterministic in the corpus so far.** 7 sections and 25 questions on both
runs, with identical per-section counts (3, 4, 4, 4, 4, 3, 3) matching the source exactly. No split,
no drift, nothing invented, nothing dropped. `unattributedPromptCount` zero on both. The title block
and the standfirst were pruned as `prune_section`, and the standfirst's content was not merely
discarded — it was carried into the inferred audience notes ("held by someone outside the leaver's
reporting line… notes are anonymised"), which is the right place for it.

#### What broke

**Nothing scored. Three things recorded.**

**The rubric broke, not the pipeline — and that is R007's main finding.** Doc 06 had never been run,
so nobody had noticed that T, G and C are written for documents that have routing. Read literally,
the correct output scores `T=0` ("no proposal at all"), `G` is unscoreable, and run 1's two honest
unquoted negative signals score `C=1` ("no quotes"). A negative control that is penalised for being
correct is not a control. The convention — score P, C, R out of 6; T and G `n/a`; an unquotable
negative signal is worth full marks — is written into the Scoring section above. Same class of
correction as **T04**: the ground truth was wrong, the pipeline was not.

**A constructed `sourceQuote`, and it is a new shape.** Run 2's candidacy signal 2 was

> "Getting started; The decision; The work itself; Management and support; Team and culture; Reward and progression; Closing"

— the seven section headings joined with semicolons. Every part is byte-exact and the whole matches
nothing. R005 found emphasis being re-rendered and R006 found elision; both are faithful renderings
of one real span. **This one is not** — it is an assembled structure presented as a contiguous quote.
It cost nothing here (it is a negative signal on a document that was declined, so nothing was routed
off it), but the same behaviour on an analyst `sourceQuote` is indistinguishable from fabrication,
which is the corpus's most severe finding. Raised as **T10**.

**T05's meaning-narrowing class recurred, on a second document, non-deterministically.** Run 1
rewrote **11 of 25** prompts; run 2 rewrote **3**. Same file, same build — a ~4× spread, which
confirms R004's claim that cosmetic churn is most of the `changeCount` variance. Most were harmless
("largest factor" → "biggest factor", "the support you had" → "the support you received", a fronted
qualifier). One was not:

> _"How clear were you, day to day, on what good looked like in your role?"_ →
> _"…on what good **performance** looked like in your role?"_

"What good looked like" in an exit interview is deliberately broad — behaviour, standards, culture,
not only performance — and the rewrite narrows it to one of those. Run 2 left the question alone.
That is T05's third class exactly, now seen on doc 03 and doc 06, and non-deterministic on both.
**T05 promoted to confirmed.**

#### A watch item that is not a finding

Both runs typed two questions `boolean`, deterministically: Q15 ("Did you feel able to disagree
openly with a decision?") and Q19 ("Did you ever see or experience behaviour that concerned you?").
Grammatically that is defensible — both are yes/no questions — and it is **inert today**, because
`DEFAULT_QUESTION_FIDELITY.enabled` is `false` (`types.ts:840`) so the interviewer asks them
conversationally. But `boolean` is in `CONTROLLABLE` (`chat/question-card.ts:61`), so on a
questionnaire where an admin turns question fidelity on and sets Q19 to `must_ask`, the corpus's
designated safeguarding-bait question renders as a **yes/no toggle**. Recorded as **T11**, low
severity, and explicitly not a doc-06 scoring matter.

#### Changed since last run

- **Nothing in the build.** R006 and R007 both ran on `f4ab51f48` with a clean tree, so doc 05 and
  doc 06 are directly comparable and the only variable between them is the document.
- **Scoring procedure gained two rules:** the doc-06 out-of-6 convention, and splitting a quote on
  `;` as well as `…` before calling it fabricated. Procedure, not build.

---

### R006 — 2026-08-26 · **PARTIAL (doc 05 ×2 — first scored run of it)**

| Field                      | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| Commit                     | `f4ab51f48` on `fix/ingest-fidelity-phase-2` (clean tree — no local edits) |
| Ran by                     | Claude (agent), driven by John                                             |
| How                        | streaming ingest via `POST /questionnaires/stream` · doc 05 ×2             |
| Extractor model            | `openai/gpt-5.4`                                                           |
| Critic model               | `openai/gpt-5.4`                                                           |
| Candidacy model            | `openai/gpt-5.4-mini`                                                      |
| Analyst model              | `openai/gpt-5.4`                                                           |
| Conditional topics enabled | no (fresh version each ingest)                                             |
| Extract tables             | on (default); irrelevant — `.md` has no tables                             |
| Total cost / wall time     | $0.2519 across two ingests ($0.110 + $0.142) · 70s and 86s                 |
| Environment                | local dev DB, dev server on :3020                                          |

| Doc | Difficulty | P   | C   | T   | G   | R   | /10 | Failed at | Critical | Note                                                          |
| --- | ---------- | --- | --- | --- | --- | --- | --- | --------- | -------- | ------------------------------------------------------------- |
| 01  | 1          |     |     |     |     |     |     |           |          | not run (see R001)                                            |
| 02  | 2          |     |     |     |     |     |     |           |          | not run (see R002)                                            |
| 03  | 2          |     |     |     |     |     |     |           |          | not run (see R004)                                            |
| 04  | 3          |     |     |     |     |     |     |           |          | not run (see R005)                                            |
| 05  | 3          | 2   | 2   | 2   | 2   | 2   | 10  | none      | none     | Byte-identical routing on both runs. Position was a non-issue |
| 06  | 3          |     |     |     |     |     |     |           |          | not run                                                       |
| 07  | 5          |     |     |     |     |     |     |           |          | not run (control only in R005 — see **T07**)                  |
| 08  | 4          |     |     |     |     |     |     |           |          | not run                                                       |
| 09  | 3          |     |     |     |     |     |     |           |          | not run                                                       |
| 10  | 5          |     |     |     |     |     |     |           |          | not run                                                       |

**Corpus score:** _n/a — partial_ · **Extraction band:** _n/a_ · **Restraint band:** _still not scored_
**Verdict:** doc 05 clean, twice. Says nothing about shippability — the restraint band is still
unscored and **T07** still stands.

**Doc 05's whole point is position, and position did not cost it anything.** Appendix C sits ~3,800
characters in, behind a glossary and a scoring appendix, and both runs found it, quoted it, and
proposed from it. The two runs were byte-identical on every routing axis:

| Ground truth (README)                       | Run 1                                 | Run 2                         |
| ------------------------------------------- | ------------------------------------- | ----------------------------- |
| Domains 1, 2, 4, 10 always-asked            | 1 `opening`, 2/4 `core`, 10 `closing` | identical                     |
| Domains 3, 5, 6, 7, 8, 9 conditional        | all six `conditional`                 | identical                     |
| `maxConditionalTopics: 4`                   | `4`                                   | `4`                           |
| Appendix B's scoring note is **not** a rule | `rules: []`, no scoring topic         | `rules: []`, no scoring topic |
| `fromDocument`                              | `true`                                | `true`                        |

Every conditional topic's `criteria` is the Appendix C bullet restated as an include clause, and
every `sourceQuote` is that bullet **byte-exact**. Nothing was invented where the document is
silent: no `fallbackTopicKeys`, no `checkTopicPreference`, and `depth` was `full` throughout — which
is the schema's own default (`analysis-schema.ts:76`), not a dial the analyst reached for.

**Extraction was equally clean, and the appendices were pruned for the right reason.** 10 sections
and 36 questions on both runs — exactly the ten domains and the source's 36 numbered questions, with
no split and no drift, which is the failure T02 was raised for. The title block, Purpose and all
three appendices were pruned as `prune_section` with a rationale each ("facilitator skip logic and
session planning notes rather than respondent-facing questions"). That is the right call and it does
not blind the analyst: the Routing Analyst reads the **document text**, not the extracted structure,
which is why Appendix C could be quoted verbatim after being pruned out of the questionnaire.

`unattributedPromptCount` was **zero on both runs** — every edit declared. Type inference was sane
and near-identical (run 1: 33 `free_text` / 2 `numeric` / 1 `date`; run 2: 32 / 3 / 1, the extra
`numeric` being "What proportion of applications currently have a named service owner?"). The
fidelity critic marked all 36 `ok` both times and asked for no repairs.

#### What broke

**Nothing that the rubric scores.** Two things are worth the notes.

**The rewrites were the mildest yet, but they are still T05's three classes.** 7 `rewrite_prompt` on
run 1, 9 on run 2, all self-containing or cosmetic — _"What worries you most about this wave?"_ →
_"…this **migration** wave?"_ (self-containing, and defensible: the question is delivered outside its
heading), _"How much cloud delivery experience sits inside the team today?"_ → _"…does the team
currently have?"_ (cosmetic churn). **No meaning-narrowing rewrite appeared on either run**, which is
the class T05 actually cares about. Two `correct_grammar` hyphenations ("least well patched" → "least
well-patched") were correct English and correctly declared. Filed under T05, which already covers the
class; nothing here promotes it.

**Appendix C's last sentence was half-expressed, and the unexpressed half went nowhere.** The
document says: _"Cover no more than four of the situational domains in a single session. Where more
than four would apply, take the four **the service owner ranks highest** and record the remainder as
**deferred**."_ The cap landed correctly in `maxConditionalTopics: 4`. The other two clauses did not:
the product's planner picks the four by its own weighting, not by a service owner's ranking, and
there is no mechanism that records the remainder as deferred. `gaps` was `[]` on both runs.

This is the same **shape** as doc 10's critical failure — a stated instruction the product cannot
perform, silently absent from `gaps[]` — on a document three difficulty points easier. It is
deliberately **not** scored against R006, because the README's ground truth for 05 asks for four
things and this is not one of them; scoring a run against a criterion invented while reading its
output is how a ledger stops meaning anything. Raised as **T09** instead, where it is as much a
proposed correction to the README's ground truth as a finding about the pipeline. Both need John.

#### A scoring trap found while checking the quotes — the second one

R005 found that markdown emphasis is re-rendered inside quotes. R006 found a different mechanism with
the same consequence: candidacy signal 1 came back as

> "Not every domain applies to every engagement... Use the following:"

which matches **nothing** in the file, before or after normalising. It is an **elision** — the two
halves sit ~250 characters apart in Appendix C and both are byte-exact on their own. Normalisation
cannot fix this one; the check has to split on `...` / `…` and test each part. Written into the
Scoring section above. A scorer who had not looked would have logged a fabricated quote — the
corpus's most severe finding — against a clean run.

#### Changed since last run

- **Nothing in the build.** R006 ran on `f4ab51f48` with a clean tree; R005 ran on `bbfbd28d1` plus
  the gaps-prompt fix that `f4ab51f48` is. So R006 is the first run where that fix is a committed
  baseline rather than a working-tree edit, and doc 05 filing zero gaps twice is consistent with it —
  weakly, since doc 05 gives the old tautology nothing to latch onto that doc 04 did not.
- **Scoring procedure gained the ellipsis rule** (above). Procedure, not build.

---

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

| ID  | Raised     | Docs       | Status                                          | What was seen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Candidate tweak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------- | ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T13 | R010       | 08         | **plain bug — not queued**                      | Doc 08 run 2's `routing_analysis` failed hard: _"not valid against the schema after one retry (invalid at: topics.6.questionKeys.0, topics.8.questionKeys.0)"_. Those are Protection Needs and Vulnerability, and their first question keys — minted by the **extractor** on the same ingest — are 70 and 78 characters. `analysis-schema.ts:77` validates `questionKeys` entries at `.max(TOPIC_KEY_MAX_LENGTH)` = **64** (`scope/types.ts:203`); `extraction-schema.ts:50` mints keys as `z.string().min(1)` with **no maximum**. The analyst echoed back real keys for real questions and was rejected for it. The retry cannot help — satisfying the schema means shortening a key, and a shortened key matches no question. The failure is durable (a `failed` row is the "already tried" signal the Topics tab reads) and fail-soft, so the admin sees no routing and no reason. Measured: 1 of 42 corpus versions exceeds 64, and it is the only one of 40 routing analyses to fail; **doc 04 run 2 reached 63 — one character short**. Key length varies run to run on the same document (doc 08's other run peaked at 35), so every long-question instrument plays this lottery on every ingest.                                                                                                                                                                                                     | **No product decision needed — this is two components disagreeing about a number.** Either cap the key where it is minted or raise/remove the cap where it is validated. **Capping at mint is the safer half**: the DB column is `text` and unbounded, so an over-long key is only ever a problem for whatever validates it next, and this validator is unlikely to be the last. Whichever way, add a regression test that runs an instrument with >64-character question keys through the analyst — the corpus would not have caught this without doc 08's unusually long prose questions, and did not catch it in nine previous runs.                                                                                                                                                                                     |
| T12 | R009       | 01         | **plain bug — not queued**                      | The scales/matrix repair pass writes a change row via `changeForCorrect` (`_lib/orchestrate-extraction.ts:553`) with `beforeJson`/`afterJson` shaped `{suggestedType, suggestedTypeConfig}` and **no `key`**, and `targetEntityId` null. Two consequences, both verified: (1) the row that changed the question names no question, while the `infer_type` row it contradicts stays `status='applied'`, `supersededAt=null` — doc 01 run 1 shows three questions whose visible rationale reads _"captured as free text to avoid inventing choices"_ against stored `single_choice` slots **with** invented choices; (2) `planInferType` (`extraction-review/planner.ts:454`) reads `beforeJson.type`/`typeConfig`, which this writer never sets, so every repair-originated revert takes the "no prior type recorded" branch and restores **`free_text` with no config**. Confirmed by executing `planRevert` on a repair-shaped change: a `likert`→`matrix` repair plans as _"Restore question to type free_text."_                                                                                                                                                                                                                                                                                                                                                                                           | **A plain bug, so it skips the queue — but it was deliberately not fixed inside R009**, which existed to establish a single-build baseline across seven documents. It touches no scored dimension (the routing chain never reads these rows), so fixing it cannot invalidate the 95.7%. The fix is small and in two places: give `changeForCorrect` the `key` its sibling `changeForMerge` already writes, and settle the field names so writer and planner agree (`type`/`typeConfig` is what the planner and every other change type use). Worth a regression test that round-trips a repair through `planRevert` — the mismatch is exactly the kind a type-checker cannot see, because both sides are `unknown`-shaped JSON.                                                                                             |
| T11 | R007       | 06         | open                                            | Both runs typed Q15 ("Did you feel able to disagree openly with a decision?") and Q19 ("Did you ever see or experience behaviour that concerned you?") as `boolean`, deterministically. Grammatically defensible — both are yes/no questions. Inert today: `DEFAULT_QUESTION_FIDELITY.enabled` is `false` (`types.ts:840`), so the interviewer asks them conversationally and the type is never rendered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Low severity, recorded because of what it becomes rather than what it is. `boolean` is in `CONTROLLABLE` (`chat/question-card.ts:61`), so with question fidelity on and Q19 at `must_ask` the corpus's designated safeguarding-bait question becomes a **yes/no toggle** in an exit interview — the one question where the elaboration is the whole point. The candidate is not a type change but a rule about which questions may be typed to a control at all ("a question whose value is the explanation, not the answer, stays `free_text`"). Watch whether it recurs on 07/08/10, which have more yes/no-shaped safeguarding text.                                                                                                                                                                                     |
| T10 | R007, R008 | 06, 09     | **confirmed**                                   | **Promoted by R008, and escalated from candidacy to the analyst.** Doc 09 assembled **four** `sourceQuote`s per run, on both runs, on exactly the four topics the document names in its depth instructions — criteria line + depth sentence (+ heading on run 2), joined by `\n\n`. Every part byte-exact; nothing invented. This is the field the **G** dimension scores and the field the critical-failure table names, so under the current literal wording R008 has four critical failures and plainly does not. Original R007 observation: doc 06 run 2's candidacy signal 2 was `"Getting started; The decision; The work itself; Management and support; Team and culture; Reward and progression; Closing"` — the seven section headings joined with semicolons. Every part is byte-exact; the whole appears nowhere. Distinct from R005's re-rendered emphasis and R006's elision: those are faithful renderings of one real span, this is an **assembled** one presented as contiguous.                                                                                                                                                                                                                                                                                                                                                                                                             | Harmless where it was found — a negative signal on a declined document routes nothing — and the reason to act is elsewhere. An assembled quote on an analyst `sourceQuote` is indistinguishable from a fabricated one by any check, and "a span that appears nowhere in the file" is the corpus's most severe finding. **The candidate is a definition, not a matcher.** Decide whether these fields mean "a contiguous span, verbatim" (then say so in the candidacy and analysis prompts, and the scoring test stays strict) or "evidence, however assembled" (then the critical-failure test needs rewriting, because it currently cannot tell an assembly from an invention). The README assumes the first; the model sometimes does the second. Do not just widen the matcher.                                         |
| T09 | R006, R008 | 05, 09     | **confirmed**                                   | **Promoted by R008.** Doc 09's secretary notes say _"Where an area is clearly relevant but not among your three, note it for the committee rather than covering it."_ The cap landed as `maxConditionalTopics: 3`; the deferral instruction has no product expression and `gaps` was `[]` on both runs — a fourth observation of the shape, on a second document. Original R006 observation: doc 05's Appendix C last sentence has three clauses and only one was expressible: _"Cover no more than four of the situational domains in a single session. Where more than four would apply, take the four **the service owner ranks highest** and record the remainder as **deferred**."_ `maxConditionalTopics: 4` carried the cap. The **selection authority** (the planner weights topics; a service owner ranking them is not a thing the product does) and the **deferred record** (no such output exists) were both simply absent — `gaps` was `[]` on both runs. Same shape as doc 10's named critical failure, on a difficulty-3 document.                                                                                                                                                                                                                                                                                                                                                             | **Two questions, and they are not the same question.** (1) Should the README's doc-05 ground truth ask for this gap at all? It currently asks for four things and this is not one, so R006 did not score against it — but if the answer is yes, doc 05 stops being a pure position test and starts carrying restraint too, which may be worth more than the clean 10. (2) If yes, is the analyst wrong, or is the gaps bar from R005 now too high? R005 deliberately narrowed gapping to "cannot express it AT ALL", and a partly-expressible instruction is exactly the case that narrowing pushed off the edge. Do not touch the prompt from this: the honest next step is doc 09 and doc 10, which state caps of their own and would say whether the analyst gaps a partly-expressible instruction anywhere. Needs John. |
| T08 | R005       | 04         | open                                            | Run 2 of doc 04 proposed five conditional topics and its `summary` — the prose the admin reads on the Topics tab — said "**four** conditional due-diligence sections". Run 1's said five and was right. Nothing about the routing is wrong; the sentence describing it is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Low severity, recorded because it is cheap to check and corrodes trust in the one paragraph an admin actually reads. Watch whether it recurs before considering a prompt line telling the analyst to count its own output. Do not act on one sighting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T07 | R005, R010 | 07, 08, 10 | **confirmed — critical, and wider than doc 07** | **R010 scored it, and found the same behaviour on two more documents.** Doc 07: all five triggered blocks coerced again, on both runs, on a later build — four runs across two builds, so variance is ruled out. Doc 08: the estate-planning trigger (_"only ever asked where the client raises inheritance themselves"_) rendered as an opening-time criterion. Doc 10: all four escalation triggers coerced, **and the terminating screener turned into an opening topic with questions**. Every one of the six restraint-band runs gapped the _mechanism_ in prose and then converted the _blocks_ anyway — so this is one behaviour, not three bugs, and whatever is decided for doc 07 governs 08 and 10 too. Original R005 observation: all five of doc 07's triggered blocks were proposed as `conditional` topics with criteria quoting "at any stage" / "at any point" / "in passing". Identical on both runs, and identical on both sides of the R005 prompt change, so it is neither variance nor a regression. Conditional Topics settles scope once, at the end of the opening, so every one of these is decided before the disclosure it waits for can happen — on safeguarding, care-leaver, health, immigration and arrears text. The analyst DID file one honest gap naming the mid-interview mechanism, so it is not unaware; it gapped the mechanism and then converted the blocks anyway. | **A product decision, not a prompt tweak — do not fix this from the prompt without deciding the behaviour first.** The two obvious options are both bad on their own: gapping the five blocks means an abuse-disclosure block is never asked at all (worse than asking it when the opening mentioned abuse), and leaving them as-is ships an instrument that silently behaves differently from what its author wrote. The README's "⚠️ Mid-interview triggers are not expressible today" is the standing analysis; the real options are a mid-interview re-scope mechanism (with the report-reproducibility consequences it names) or an explicit refusal path that keeps the blocks visible to the admin as not-routable. Needs John.                                                                                      |
| T06 | R004       | 02, 03     | open                                            | Every one of doc 03's six criteria turns on a site fact (lifting above 20kg, a confined-space register, COSHH storage, night shifts) that **no question in the instrument captures**. The opening topic asks about visitor routes, permits, drills and near-misses, so the planner decides six topics on an opening that cannot evidence any of them. The analyst noticed — its `summary` says "no hard rules are possible because there are no data slots to test against" — but put it in prose, and `gaps` came back empty on all six runs. R002 recorded the same shape on doc 02 as an aside inside T04 ("none of C–F's criteria are answerable from any question in the instrument anyway"), which is why two documents are listed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Undecided, and deliberately so — the analyst's output here is _good_, and the two obvious fixes both make it worse. Turning the six into gaps would discard six correct, quotable conditional topics. Widening the opening is not the analyst's to do. The candidate is a **third** thing: keep the topics and add a gap saying the criteria are not answerable from this instrument, which needs the prompt to distinguish "cannot formalise" from "formalised, but nothing can evidence it". Do not touch the prompt until a third document shows the same shape.                                                                                                                                                                                                                                                         |
| T05 | R004, R007 | 03, 06     | **confirmed**                                   | **Promoted by R007.** Doc 06 rewrote 11 of 25 prompts on run 1 and 3 on run 2 — same file, same build, a ~4x spread that confirms cosmetic churn is most of the `changeCount` variance — and run 1 contained a meaning-narrowing rewrite where run 2 did not: _"what good looked like in your role"_ -> _"what good **performance** looked like in your role"_, narrowing a deliberately broad exit-interview question to one of the things it covers. Second document, same three classes, still non-deterministic. Original R004 observation: the extractor reworded 8, 12, 10, 10, 10 and 12 of one file's 23 prompts across six ingests, in three distinct classes: **self-containing** ("Who maintains the register…" → "…the confined-space register…", needed, because a question is delivered outside its heading), **cosmetic** ("Walk me through" → "Please walk me through", pure churn and most of the `changeCount` variance), and **meaning-narrowing** ("if the weather turns mid-task" → "if the weather changes during a work-at-height task", on 3 of 6 runs). All were filed as `rewrite_prompt` with a rationale asserting meaning was preserved, and the fidelity critic marked every one `ok`.                                                                                                                                                                                          | Decide the policy before touching anything, exactly as T02 forced for splitting. The three classes want different answers and the prompt currently gives them one: self-containing is arguably required, cosmetic is noise, narrowing is a fidelity fault. A per-class instruction is the candidate ("resolve a pronoun or an elided noun the section heading supplied; change nothing else"), but see [`question-fidelity.md`](../../../../../.context/app/questionnaire/question-fidelity.md) first — the product already has a per-question ask-as-written dial, and ingest-time rewriting may be the wrong layer for this entirely. Separately from the policy: **unrecorded** rewrites were a plain bug and were actioned in R004 (`unattributedPromptCount`).                                                         |
| T04 | R002, R004 | 02, 03     | actioned                                        | Part A (doc 02) and Section 1 (doc 03) proposed at `phase: opening` where the README's ground truth said `core`. Seen on two documents, two runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **README error, and the answer was in the code the whole time.** `no_opening_topic` in `scope/validate.ts` is an **error**-severity issue: a config where every always-asked topic is `core` fails validation, because nothing gathers the signal the planner reads. `opening` was not a defensible alternative reading — it was the only output that validates. Ground truth for 02 and 03 corrected, and the rule stated once above the per-document list rather than repeated ten times. The analyst was never wrong here.                                                                                                                                                                                                                                                                                               |
| T03 | R002       | 02         | actioned                                        | The fidelity critic checked all 28 extracted questions, flagged 3, and never noticed that 6 of the 28 did not exist in a 22-question source. It is a per-question faithfulness check with no count or coverage dimension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Give the critic a coverage/count check so extraction drift is caught at ingest, where it is cheap, rather than by a human reading the Structure editor. Pairs with T02.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T02 | R002       | 02         | actioned                                        | Six ingests of one file on one build produced 22, 28, 23, 28, 28, 28 questions. The extractor splits compound questions — which `extraction-prompt.ts:182` instructs and which is recorded as a revertable `split_question` change — but does so inconsistently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Decide the policy, then make it deterministic. Splitting improves completion accuracy (each half gets its own satisfaction bar) and costs nothing in interview length; not splitting keeps a 1:1 mirror of the source. **Either way, non-determinism is the defect** — two ingests of one document that disagree on question count are not comparable in a cohort.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T01 | R001, R009 | 01         | **confirmed — variance**                        | **Promoted by R009, and the promotion makes it cheaper to fix than it looked.** Re-run on `f4ab51f48`: run 1 widened again, run 2 **split it correctly** into `adherence` (core, AD1) + `adherence_support_for_polypharmacy` (conditional, AD2/AD3). Same file, same build, both behaviours. The analyst already produces the preferred output about half the time, so this is a prompt preference rather than a missing capability. Original R001 observation: all three Adherence questions swept into one `conditional` topic criteria'd _"Only where PC2 is 4 or more"_, though the source marks AD1 `Always`. The analyst filed an honest `gap` naming the mix, then resolved it by widening. **An earlier run of the same document (via a `.txt` copy) split it correctly**, so this is variance on a hard case, not a deterministic fault.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Teach the analyst to prefer **splitting a mixed section into two topics** (one core, one conditional) over widening one criterion across a question the source says to always ask. Silently gating an `Always` question is the worse failure of the two.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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

| Run             | Date       | Commit            | Analyst model    | Corpus    | Extraction band | Restraint band | Critical failures   | Verdict                                     |
| --------------- | ---------- | ----------------- | ---------------- | --------- | --------------- | -------------- | ------------------- | ------------------------------------------- |
| **R010 (FULL)** | 2026-08-26 | `f4ab51f48`       | `openai/gpt-5.4` | **84.0%** | **95.7%**       | **56.7%**      | **3**               | **NOT SHIPPABLE** — first full corpus score |
| R009 (partial)  | 2026-08-26 | `f4ab51f48`       | `openai/gpt-5.4` | _n/a_     | **95.7%**       | not run        | 0                   | 01–03 re-run; band on one build             |
| R008 (partial)  | 2026-08-26 | `f4ab51f48`       | `openai/gpt-5.4` | _n/a_     | _n/a_           | not run        | 0                   | partial — doc 09 only                       |
| R007 (partial)  | 2026-08-26 | `f4ab51f48`       | _not invoked_    | _n/a_     | _n/a_           | not run        | 0                   | partial — doc 06 only                       |
| R006 (partial)  | 2026-08-26 | `f4ab51f48`       | `openai/gpt-5.4` | _n/a_     | _n/a_           | not run        | 0                   | partial — doc 05 only                       |
| R005 (partial)  | 2026-08-26 | `bbfbd28d1`+gaps  | `openai/gpt-5.4` | _n/a_     | _n/a_           | not scored     | 1 (doc 07, control) | partial — doc 04 only scored                |
| R004 (partial)  | 2026-08-26 | `0d129065f`+ph2   | `openai/gpt-5.4` | _n/a_     | _n/a_           | not run        | 0                   | partial — doc 03 only                       |
| R003 (partial)  | 2026-08-26 | `2478d3586`+ph2   | `openai/gpt-5.4` | _n/a_     | _n/a_           | not run        | 0                   | verification only — not scored              |
| R002 (partial)  | 2026-08-26 | `e0a966ea6`+fixes | `openai/gpt-5.4` | _n/a_     | _n/a_           | not run        | 0                   | partial — doc 02 only                       |
| R001 (partial)  | 2026-08-26 | `e0a966ea6`+fixes | `openai/gpt-5.4` | _n/a_     | _n/a_           | not run        | 0                   | partial — doc 01 only                       |

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
