# Definitions / glossary (P16)

Questionnaires routinely lean on words whose meaning is not settled. The motivating case was a
spiritual-development questionnaire using **"higher-self"** and **"ego"** — terms where two
reasonable respondents answer differently because they understood the word differently. Before
this feature, nothing captured that: the interviewer phrased around the term with no shared
definition, the extractor inferred meaning from an undefined word, the contradiction detector
flagged two answers that had merely used the term in two senses, and the respondent guessed.

A glossary pins the meaning down once. Everything that asks, interprets, or reports on an answer
then reads from the same definition — and so does the respondent.

## The shape of it

| Piece           | Where                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Data model      | `AppGlossaryTerm`, `AppGlossaryDefinition`, `AppGlossaryDocument` in `prisma/schema/app-questionnaire.prisma`  |
| Pure domain     | `lib/app/questionnaire/glossary/` (types, normalize, matcher, injection, schemas, analysis-*, report-appendix) |
| Server resolver | `lib/app/questionnaire/glossary/resolve.ts` — **not** exported from the barrel (see below)                     |
| Route DB seam   | `app/api/v1/app/questionnaires/_lib/glossary-routes.ts`                                                        |
| Routes          | `…/versions/:vid/glossary` (GET/PUT), `…/glossary/analyse/stream` (POST), `…/glossary/document` (POST/DELETE)  |
| Agent           | `app-questionnaire-glossary-analyst` + capability `app_analyse_glossary_terms`                                 |
| Admin UI        | `app/admin/questionnaires/[id]/v/[vid]/definitions/` + `components/admin/questionnaires/glossary/`             |
| Respondent UI   | `components/app/questionnaire/glossary/`                                                                       |

## The curation gate

`AppGlossaryTerm.status` is the gate the whole feature hangs on:

- **`proposed`** — the analyst suggested it. **Inert.** Nothing but the review queue reads it.
- **`accepted`** — live, and only when it carries ≥1 **selected** definition (enforced by
  `saveGlossarySchema`, because an accepted term with nothing ticked would underline to a
  respondent with an empty popover).
- **`rejected`** — kept, not deleted, so a later analysis run does not re-propose it.

Because a proposal is inert, **the analysis run does not fork a launched version** — only the
reviewed save does. That is the same rule `AppDataSlotDraft` follows, and it is what keeps the
analysis endpoint a simple write.

## Matching

`glossary/matcher.ts` is the single decision point for "does this text use a defined term?", shared
by the respondent annotator **and** the prompt relevance filter. If those drifted, an agent could
be briefed on a term the respondent can't see, or the reverse.

- **Normalisation** (`normalize.ts`, also the DB's `normalizedTerm` and the save schema's duplicate
  check): lowercase; curly apostrophes → straight; **every hyphen/dash → space**; whitespace
  collapsed.
- **Longest match wins.** Surfaces are sorted longest-first before the alternation is built, because
  JS alternation is leftmost-_first-alternative_: `higher self|self` matches the two-word term,
  `self|higher self` would not.
- **Inflections, not stemming.** Four cheap variants per surface (`s`, `es`, `'s`, `s'`). No
  stemmer — "egoism" is not "ego". Irregulars are the admin's job via `aliases`.
- **Boundaries without lookbehind.** `\b` is wrong here (it fails at multi-word edges and treats an
  apostrophe as a boundary) and lookbehind is unavailable on Safari ≤16.3. So each candidate is
  checked manually against `/[\p{L}\p{N}_]/u` either side.
- **First occurrence only**, per rendered message. Four underlines of one word reads as emphasis,
  not as a control.
- **Caps**: 200 surfaces per index, 40 matches per text.

### A consequence worth knowing

Because hyphens are word separators, **"alter-ego" contains the standalone word "ego"** and will
match — exactly as "alter ego" does. That falls out of the same folding that makes "higher-self"
match "higher self". Treating hyphens as separators for matching but as word characters for
boundaries would be incoherent and would break the motivating case. Pinned in
`tests/unit/lib/app/questionnaire/glossary/matcher.test.ts`.

## Prompt injection

`glossary/injection.ts`, modelled on `rounds/briefing.ts` — including its cardinal contract: empty
in → `[]` out, so `section()` collapses the block and a version with no relevant terms costs
**zero tokens**. That property is asserted from four angles in
`tests/unit/lib/app/questionnaire/glossary/prompt-seams.test.ts`.

Per-turn seams are **relevance-filtered** (a 60-term glossary would crowd the question out of a
~220-token phraser prompt); the report seam is not.

| Seam                        | File                                                                    | Haystack                                      |
| --------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| Interviewer phraser         | `_lib/question-stream.ts` → `section('glossary', …)` after `<briefing>` | asked prompt, guidelines, recent messages     |
| Answer extraction           | `extraction/extraction-prompt.ts` → `section('glossary_rules', …)`      | candidate prompts + guidelines + user message |
| Refinement                  | `refinement/refinement-prompt.ts` → `section('glossary', …)` first      | answered prompts + user message + trigger     |
| **Contradiction detection** | `contradiction/detection-prompt.ts`                                     | answered prompts + values + latest message    |
| Report generation           | `report/generate.ts`                                                    | **no filter** — one call per session          |

**Contradiction detection is the highest-value seam.** Two answers that look contradictory are very
often the same contested term read two ways ("my ego is healthy" / "my ego gets in the way"). It
gains an extra rule _only when definitions are present_: two answers using two listed senses of a
term are **not** a contradiction. Without it the detector raises a false positive directly with the
respondent.

Multiple selected definitions serialise as `- ego: (1) …; (2) …` and are **never merged** — the
admin kept both senses deliberately.

Caps: `GLOSSARY_MAX_TERMS = 8` **per turn only**, `GLOSSARY_MAX_DEFINITION_CHARS = 280`.
`allGlossaryLines` (report generation) is deliberately uncapped — applying the phraser's budget
there gave the writer 8 terms while `buildGlossaryAppendix` printed all 60, so a reader saw
definitions the prose had been written without.

**Every per-turn seam is a Zod-validated capability dispatch**, and `BaseCapability.validate`
safe-parses against a NON-STRICT object — an args key the schema doesn't declare is silently
stripped. Two seams shipped inert for exactly this reason. `capability-args-wiring.test.ts` pins
the key's survival at each schema; a prompt-builder test cannot catch it, because it calls the
builder directly.

## Respondent surfaces

Gated on `glossaryRespondentHints`, resolved **server-side** — `resolveGlossaryForHints` returns
`[]` when the switch is off, so no client component carries a flag.

- **Chat** — `GlossaryMarkdown` replaces `<Markdown>` in the three assistant-turn render sites.
  Never the respondent's own messages: `UserBubble` is untouched.
- **Form labels** — `GlossaryText`. The label became a `<span>` (it carried no `htmlFor`), because
  a popover trigger inside a `<label>` would also toggle the labelled control.
- **Report + PDF** — a deterministic appendix, gated on the separate `glossaryReportAppendix`
  (default **off**: it changes a delivered document). The **blank instrument** export always carries
  it — that is the reviewer's copy, where the definitions are the most useful thing on the page.

### Why a `components` override and not a rehype plugin

`rehype-*` and `unist-util-visit` are not project dependencies, and the override approach is
_better_ here: react-markdown hands `<code>` and `<a>` to overrides as **elements**, never strings,
and the annotator only ever inspects **strings**. Excluding code spans and links is therefore
structural rather than a regex heuristic, and cannot drift. `strong`/`em` _are_ annotated — the
interviewer bolds a phrase per message and a term landing there must keep its definition.

## The Glossary Analyst

Prompt lives in **code** (`glossary/analysis-prompt.ts`), not the seeded agent's
`systemInstructions` — the same convention as the extractor and verifier. The hard part of that
prompt is **restraint**: a model asked "which words are ambiguous?" will happily return forty, so
most of the rubric is about what _not_ to propose.

Re-running is safe, and that is load-bearing: `persistProposedTerms` replaces only `proposed` rows,
leaves `accepted`/`rejected` untouched, and drops any proposal whose normalised surface is already
adjudicated — reporting that count separately so the UI can say "nothing **new**" rather than
"nothing found".

## Config

| Key                       | Default     | Effect                                           |
| ------------------------- | ----------- | ------------------------------------------------ |
| `glossaryPromptInjection` | `true`      | The five prompt seams above                      |
| `glossaryRespondentHints` | `true`      | Underline + popover in chat and on form labels   |
| `glossaryReportAppendix`  | **`false`** | Glossary appendix in the respondent report + PDF |

All three are inert without accepted terms, so the first two default on at zero cost.

## Fail-soft

`resolve.ts` catches and logs. The glossary **enriches** a turn; it does not enable one. A failed
read degrades to "no definitions this turn" and never breaks the conversation or the report.

## Deliberate non-decisions

- **Never AUTOMATICALLY mirrored to the knowledge base.** The KB is scoped per `AppDemoClient`; a
  glossary is per version. Two questionnaires for one client defining "ego" differently would put
  contradictory documents in one corpus, retrieved for _every_ report for that client, with the
  writer silently picking one — worse than not publishing, because the report _sounds_ grounded.
  There is also no unpublish (`uploadDocument` dedupes on hash and never retires the old row). The
  report writer gets the glossary directly from the DB anyway, correctly version-scoped. An explicit
  opt-in publish does exist — see below.
- **Version-scoped, not a shared library.** Terms fork with the version via `copyVersionGraph`. The
  model is shaped so a per-client library can be added later (`source` gains `library` + a nullable
  pointer) with no migration of existing rows.
- **`resolve.ts` is not in the barrel.** It imports `@/lib/db/client`; a client component importing
  the matcher through the barrel would drag server code into the browser bundle. Same trap
  documented on `authoring/definition-export.ts`.
- **`DEFINITION_EXPORT_SCHEMA_VERSION` stays at 1.** The parser rejects any other value outright, so
  bumping it would reject every previously-exported file. `glossary: z.array(…).default([])` keeps
  both directions compatible instead.

## Publishing to the client knowledge base (opt-in)

`POST …/glossary/publish` copies the accepted terms into the demo client's private knowledge tag as
a markdown document, so **other client-scoped agents** can retrieve them. That reach is the only
thing it buys — report generation already reads these definitions directly from this version.

It is never automatic and never happens on save. It is an explicit admin action behind a dialog that
names the client and states the blast radius, because it is the one write in this feature that
escapes the version boundary and cannot be forked back.

| Guard                                       | Why it exists                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 409 `NO_CLIENT_ATTRIBUTED`                  | The KB is scoped per client; with none there is nowhere to publish. A clear error beats a no-op the admin reads as success. |
| 409 `EMPTY_GLOSSARY`                        | No placeholder document lands in a client corpus.                                                                           |
| Name = `Glossary — <title> (v<n>)`          | Two questionnaires' glossaries are then at least _visibly_ distinct in the KB panel.                                        |
| Scope line atop the document                | Retrieval cannot tell them apart; this line is the only disambiguator a reader — or a writer that retrieved it — gets.      |
| `sourceUrl` → the version's Definitions tab | The only provenance back to where it came from.                                                                             |
| Tag applied via `upsert`                    | A re-publish of identical content dedupes to the existing document row, so the composite-PK write must be idempotent.       |

**There is no unpublish.** Removing a published glossary is a manual step in the knowledge-base
admin. If you don't need reach into other client-scoped agents, don't use this.

## Honest limits

- No stemmer, so irregular plurals and verb forms need explicit aliases.
- Matching is surface-based: a term used by a synonym the admin didn't list is not caught.
- The definitions document is stored as text only — it is never re-parsed, and only the first
  200 000 characters are kept (the whole document goes into one prompt).

## See also

- [`ingestion.md`](./ingestion.md) — the sibling authoring pipeline this deliberately does _not_ run inside
- [`configuration.md`](./configuration.md) — the three config keys in context
- [`forking.md`](./forking.md) — what travels with a version fork
- [`ai-run-provenance.md`](./ai-run-provenance.md) — the `glossary_analysis` run kind
