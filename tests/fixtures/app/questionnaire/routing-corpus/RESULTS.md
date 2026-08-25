# Routing corpus — ingestion results ledger

**Companion to [`README.md`](./README.md).** The README says what each of the ten
documents is for and what a correct result looks like. This file records what actually
happened, run by run — when it ran, against which build and which models, what it got
right, where it broke, and one number per run that can be compared to the last one.

Nothing here is inferred. Every row is filled in from a run that was actually performed;
an unrun document is left blank rather than estimated, and a run that was abandoned
half-way is recorded as such. A ledger that guesses is worse than no ledger, because the
trend line it draws is fiction.

> **Status: no runs recorded yet.** The log below is empty by design — copy the template
> in [Recording a run](#recording-a-run) for the first one.

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
7. **Clean up.** Ten questionnaires per run accumulate; archive or delete the run's
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

_Newest first. No runs recorded yet._

---

## Trend

One row per run. The three percentages and the critical-failure count are the whole point
of the file; everything above exists to make them mean the same thing each time.

| Run          | Date | Commit | Analyst model | Corpus | Extraction band | Restraint band | Critical failures | Verdict |
| ------------ | ---- | ------ | ------------- | ------ | --------------- | -------------- | ----------------- | ------- |
| _(none yet)_ |      |        |               |        |                 |                |                   |         |

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
