# Questionnaire Pack download

The admin can download a **branded, shareable artifact** covering everything about how a
questionnaire is set up — title/version/goals, the question structure, the semantic data slots
(with their linked questions), the definitions/glossary, the experience-setup summary, (opt-in) the
latest F5.1–F5.3 design-evaluation run's judge findings, (opt-in) the
[Conditional Topics](./conditional-topics.md) routing logic in plain language, and (opt-in) the
[interviewer policy](./interviewer-policy-evaluation.md) with the F18.8 panel's verdict on it — as a
PDF, CSV, or Markdown file. The admin picks which of those eight sections to include from a dialog
opened by the **Questionnaire pack** button in the workspace header; five are ticked by default,
"Evaluation findings", "Conditional topics" and "The interviewer" are not (see below).

Distinct from the brand-free [blank instrument export](./admin-ui.md) (F14.9): the instrument is
the design-time reviewer copy of just the questions, deliberately unbranded. The Pack is the
external/showcase counterpart — it carries the ConQuest wordmark, tagline, website, and a closing
"About ConQuest" blurb, and additionally covers data slots (which the instrument doesn't) and the
experience-setup summary. The instrument lives only in the Structure tab's "Export / download"
menu; the Pack is additionally promoted to a header button (below). Neither replaces the other.

## What's in the document

- **Title, version & goals** — title, version number, goal, audience summary, section/question
  counts.
- **Questions** — the numbered section/question structure, reusing the same flattening the
  instrument export uses (`buildInstrumentModel`) so the two can never render a question
  differently.
- **Data slots** — each semantic data slot (name, theme, description, weight) with the prompts of
  the question(s) it covers, resolved by key against the version graph.
- **Definitions** — the accepted glossary appendix (same accepted-only set the instrument's
  reviewer copy carries — not the curated proposals/rejections the JSON definition export carries).
- **Experience setup** — every run-time setting, grouped by area (Access & participation,
  Respondent experience, Interviewer, Questioning & completion, Definitions, Reports, Safeguarding,
  Operations). **Derived from the [settings registry](#the-settings-registry), not hand-listed** —
  a config field added tomorrow appears here without anyone remembering to add it. Split into two
  tiers: the standard tier always renders; the technical tier (numeric tuning, prompt presence, cost
  and abuse thresholds, admin-only debugging) renders only when the admin ticks **Technical & tuning
  settings**, a sub-option nested under this section in the dialog.
- **Evaluation findings** (opt-in, off by default) — the [F5.1–F5.3 judge panel](./design-evaluation.md)'s
  most recent run for this version, **including findings still `pending` review** — this is a record of
  what the panel said, not a curated review outcome. Renders last, as an appendix, right before the
  closing "About ConQuest" blurb. `null` (not an empty state) when the version has never been evaluated
  is rendered as a "no evaluation has been run yet" line rather than an omitted section, so the
  toggle's meaning stays predictable regardless of whether a run exists.

  **The appendix leads with what the panel WANTS DONE.** Each flagged subject opens with the
  verdict: "A reword, as proposed by 2 of 3 judges — Clarity, Audience-Match", with every dissenting
  action kept as the next block down ("A deletion, as proposed by 1 of 3 judges"). It is built by
  `summariseGroupActions` — the console's own function, not a second implementation — so the
  document and the screen cannot reach different verdicts. The appendix previously printed severity
  tallies and a list of judges and left the reader to work out, from four prose paragraphs, that all
  four were asking for the same thing.

  The reconciled wordings sit **inside the block they answer**, chosen by the shared `wordingHost`:
  hung off whichever action leads, a contested question where the deletion won would print proposed
  wording under "A deletion", as if the panel wanted the question deleted and rewritten.

  **Each flagged question says who is actually asked it** — "Asked when it fits: Onboarding",
  "Never asked — in no topic" — from the finding's resolved `routingReach`. This is the one line
  connecting the pack's two opt-in appendices: without it the document explains a routing design in
  one section and critiques questions in another, and a reader weighing a deletion cannot see that
  only some respondents ever reach the question. `null` whenever Conditional Topics is off, so a
  questionnaire that does not route says nothing about routing.

  **Each judge's line carries the edit, the destination and the reviewer's own instruction.**
  `proposedEditSummary` comes from the shared `describeProposedEdit` (`evaluation/describe-edit.ts`)
  — the same sentence the console prints under the button that performs it, resolved off the
  EFFECTIVE op so an admin-edited override wins as it does at apply. `destination` says where a
  drafted question would land and whether anyone chose that. `applyInstruction` is the reviewer's own
  words, the one line on a finding written by a person rather than a model.

  **The appendix is grouped by question, not by judge**, and the model splits accordingly: `scores` is
  the seven-judge scoreboard (score/diagnostic/finding count, no findings) and `targets` is the work —
  one entry per flagged subject, in questionnaire order, with every judge's verdict beneath it. A
  question that four judges flagged is printed **once** with four verdicts under it, where the
  by-judge layout printed it four times, pages apart. The "N judge(s)" line over a target reads
  `judgeCount` (distinct judges) and never `judges.length` (one entry per _finding_) — one judge
  raising two points is one perspective, and counting findings there overstates the consensus the
  reader is being asked to act on. This is the same reasoning that made "By
  question" the default in the admin run-detail view (see
  [design-evaluation.md](./design-evaluation.md#reading-a-run--two-views-over-the-same-findings)) —
  and it matters more in a document, which has no toggle to switch. Grouping is the shared pure
  `groupFindingsByTarget` from `lib/app/questionnaire/evaluation/group-findings.ts`, deliberately the
  same function the console uses: the pack and the console must not disagree about what counts as one
  subject.

  **Reconciled rewordings ride with their question.** Each target also carries the run's
  cross-judge `alternatives` — one or two phrasings proposed to satisfy several judges at once (see
  [design-evaluation.md](./design-evaluation.md#cross-judge-reconciliation--the-step-after-the-panel))
  — printed _after_ the verdicts that produced them, because a resolution only reads as one once you
  have seen the disagreement. Dimension keys are mapped to judge labels on the way in: a pack is read
  by people who never learn the enum. `unresolvedBy` is printed too rather than swallowed — a rewrite
  that silently drops a judge's point reads as consensus. A target with one judge, a failed reconcile
  call, or a run older than the step simply carries none, and shows the judges' own suggestions.

  **CSV is the exception.** It emits three blocks — `# Judge scores`, `# Suggested rewordings` (one row
  per proposed phrasing) and `# Evaluation` (one row per target-judge pair, target columns first) — and the target text _does_ repeat down the rows of a
  contested question. A CSV row has to survive a sort, a filter, or a pivot on its own, so blanking
  continuation rows would break all three. "Name the question once" is a rule about documents a
  person reads top to bottom.

- **Conditional topics** (opt-in, off by default) — the [routing logic](./conditional-topics.md) explained
  in plain language for a stakeholder audience, not the authoring vocabulary: which topics are
  **always asked** (opening/core/closing), which are **asked when it fits** (conditional, with the
  admin's own plain-English criteria) — each
  rendered as a sentence ("Always include ... when ...") rather than an operator/action pair. When
  the version has never turned Conditional Topics on, the section still renders — it states that fact
  rather than being omitted, the same "state it, don't hide it" choice `PackEvaluations.hasRun: false`
  makes. `buildConditionalTopicsSection` (`build-pack-model.ts`) resolves a rule's topic/data-slot keys
  to their authored labels via the version's topics and data slots; an unresolvable key (one since
  deleted — silently skipped everywhere else in this feature) falls back to the raw key rather than
  dropping the rule, so a stale rule stays visible as something to clean up.

  **The routing settings are derived, not hand-listed.** They come from
  `ROUTING_SETTING_DESCRIPTORS` in `lib/app/questionnaire/settings-registry.ts`, declared
  `satisfies Record<keyof ConditionalTopicsSettings, RoutingSettingDescriptor>` so a new routing
  setting is a compile error until it is classified. This section previously named **four of the
  fifteen** fields on that object. Same two tiers as the setup summary: `standard` always renders,
  `technical` (the confidence floor, per-type timings, whether extra guidance is set) sits behind a
  sub-option.

  **Why a second registry, when `SETTING_DESCRIPTORS.conditionalTopics` exists.** That entry is a
  single descriptor covering a fifteen-field nested object, so adding a routing setting is _not_ a
  compile error there — its `rows()` body is hand-written prose and a new field simply never appears.
  `ROUTING_SETTING_DESCRIPTORS` is keyed per field, so it is. The two overlap deliberately, the way
  the interviewer section's appendix deliberately duplicates its one-line setup rows: the setup row
  is the summary, this is the appendix. **They must not drift** — a pack with both sections ticked
  prints both, and one setting described two ways reads as two settings. `maxOpeningProbes: 0` had
  already drifted ("None — never probe" against "Capped at 0 for the whole opening") before it was
  caught; the phrasings are now aligned. Whether the overlap should be collapsed is open — see the
  note in [P15 follow-ups](./planning/features/f15-followups.md) if it is picked up.

  **A topic can say which questions it covers** (`conditionalTopicsMembers`, off by default). Without
  it the pack lists topics in one section and questions in another with nothing tying them, and a
  reader cannot answer the obvious question: if this area is not selected for me, what am I not
  asked? It is off by default because it is the longest part of the section — a second pass over an
  instrument the pack has usually already printed in full. A membership key that no longer resolves
  keeps the raw key rather than being dropped, so a stale reference stays visible.

  **A topic's `trigger` is printed, not flattened away.** When the source document asked for a topic
  to be added on something said mid-conversation rather than on how the opening went, the product
  still selects it from the opening criteria — and the section says so ("The source document asks for
  this when: ... Today it is decided from the opening instead."). That gap is recorded on the topic
  precisely so a reviewer sees it; a pack printing only the criteria would show the approximation as
  though it were the intent.

  **The judge panel is called "Review of this routing"** (`conditionalTopicsEvaluation`, on by
  default), not "Scope evaluation". "Scope" is the pre-F17.29 name for this whole area, and a
  heading in a client-facing document is the last place it should survive; "no longer in the scope
  config" became "no longer part of the routing" for the same reason. CSV block headers follow
  (`# Routing review judge scores`, `# Routing review findings`). Excluding it yields `hasRun: false`
  rather than a missing field, so every serialiser handles it through the path it already had.

Each section is independently toggleable; an excluded section is `null` on the shared `PackModel`
so every serialiser skips it the same way. **Every section renders above the closing "About
ConQuest" blurb** — the interviewer block was for a while emitted after it in Markdown, which put a
whole appendix below the line where the document says it has ended.

#### Sub-options: the conclusions by default, the arguments on request

Four refinements sit under "Evaluation findings", and their defaults are what makes the section
readable rather than exhaustive:

| Sub-flag                | Checkbox                         | Default | What it adds                                             |
| ----------------------- | -------------------------------- | ------- | -------------------------------------------------------- |
| `evaluationVerdicts`    | The panel's verdict per question | `true`  | What the judges want done, the backing, and the dissent  |
| `evaluationRewordings`  | Suggested rewordings             | `true`  | The reconciled phrasings, and what no phrasing satisfies |
| `evaluationJudgeDetail` | Every judge's reasoning          | `false` | Each judge's own suggestion, argument, edit and steer    |
| `evaluationEvidence`    | Evidence quotes                  | `false` | The span each judge quoted                               |

**Judge reasoning defaulting off is a deliberate change to what this section used to produce.** It
is the bulk of the appendix — a contested question runs to about a page — and with the verdict
printed above it, a reader handed the pack usually wants the conclusion rather than four
near-identical arguments for it. Evidence is off for a second reason: judges routinely quote the
prompt the finding already sits under, so it is mostly the same sentence printed twice (the console
suppresses a quote that merely restates its target; the pack, having no card to compare against,
makes it an opt-in instead).

**When verdicts are off, the wordings move back below the judges.** They were there before verdicts
existed, for a reason that has not changed: a resolution only reads as one once you have seen the
disagreement. With a verdict to host them they sit inside it, which is nearer still.

**Why `evaluations`, `conditionalTopics` and `interviewerPolicy` default off, unlike the other five:** the Pack is the
external/showcase artifact — built to hand to a client or stakeholder. Judge findings are unreviewed
AI critique of the questionnaire (`this question is redundant`, `off-mission`, etc.), and shipping
that by accident in a document meant to showcase the questionnaire would be an easy, embarrassing
mistake. The routing logic is a different kind of risk — it's the instrument's _design_, not its
content, and not every reader needs to see how a client's respondents get routed before the admin
has decided to share that. The interviewer section carries a judge panel of its own, so it falls
under the first reason. Each, for its own reason, is something the admin opts into deliberately per
download rather than having to remember to opt out of.

### One vocabulary, three formats

Everything a reader sees is written in the words the admin console uses, and the mapping lives in
`lib/` so a client-facing PDF cannot end up saying something the screen does not.

- **Severity and review status.** `FINDING_SEVERITY_LABELS` / `FINDING_REVIEW_STATUS_LABELS`
  (`lib/app/questionnaire/evaluation/types.ts`) are the single source; the admin badge descriptors
  in `evaluation-status-badge.ts` take their `label` from them rather than declaring a second table.
  The pack used to print `[minor · pending]`.
- **`pending` is suppressed in the prose formats.** It is the state of nearly every finding in an
  untriaged run, so printing it on every line is a word to skip and no information — the same call
  the console's badge row makes. `decidedStatusLabel` returns `null` for it and the label for
  everything else.
- **Question type** goes through `questionTypeLabel()`; the pack used to print the stored
  `single_choice` where the console shows "Multi-Choice (One Answer)".
- **Dates** go through `formatPackDate` (`pack-brand.ts`): `11 Aug 2026, 09:12 UTC`. Always with the
  year, unlike `formatCompactDateTime`, which drops it within the current year — right for a dense
  admin table read today, wrong for a document filed and reopened next spring. **Pinned to UTC and
  the zone named**, because otherwise the same run prints as a different DAY depending on which
  region's server rendered the pack.
- **Every panel states which run it is showing** — "Last run … · N finding(s) across N flagged
  item(s)". Markdown carried this all along and the PDF did not, so the format most packs are
  downloaded as showed a scoreboard with no way to tell whether it predated the questionnaire beside
  it.

**CSV is the exception, and deliberately.** It keeps the raw enum column AND adds a labelled one
beside it (`severity` + `severity_label`, `status` + `status_label`, `target_type` +
`target_type_label`). A CSV row exists to be sorted, filtered and pivoted, and the raw value is the
stable key for all three — a pivot grouping on "Major" breaks the moment the label is reworded,
while one grouping on `major` does not. `pending` is written out there too: a blank cell in a
spreadsheet reads as missing data, not as "nothing decided yet".

### Branding

The PDF and Markdown outputs carry a header with the ConQuest wordmark ("Con" ink / "Quest"
marigold, matching `ConquestWordmark`'s light-mode palette), the "Conversational Questionnaires"
tagline, and `conquestinsights.com`. Both close with an "About ConQuest" blurb — product
description + use cases — authored once in `pack-brand.ts` so the two serialisers can't drift from
each other. The CSV carries only the leading brand row (wordmark, tagline, website) — no closing
blurb; its plain-data-table shape has no equivalent trailing section. No custom font is registered
(`@react-pdf/renderer` ships Helvetica only, as every other PDF document in this app does) — the
wordmark is Helvetica-Bold in the two brand colours, not the web's Fraunces serif.

## The settings registry

`lib/app/questionnaire/settings-registry.ts` declares **one descriptor per
`QuestionnaireConfigShape` field** — group heading, tier, and a `rows(config)` function producing
the presented label/value pairs.

**Why it exists.** The setup table used to be a hand-written array of ten rows, documented as "a
deliberate editorial choice". Every config field added after it was written simply never appeared in
the pack, silently — by the time anyone noticed, 10 of 49 settings were covered and the progress /
milestone-banner settings that had just shipped were invisible. The registry is declared

```ts
} satisfies Record<keyof QuestionnaireConfigShape, SettingDescriptor>;
```

so **adding a config field is now a compile error until it is classified.** New settings are
included by default; leaving one out of the shared artifact is a visible `tier: 'technical'` a
reviewer can argue with. Same pattern and same motivation as the platform's
[agent field registry](../../orchestration/agent-fields.md), which exists because hand-maintained
parallel field lists had already shipped real silent bugs.

**Adding a config field:** add it to `QuestionnaireConfigShape` +
`DEFAULT_QUESTIONNAIRE_CONFIG` as usual, then add one descriptor to `SETTING_DESCRIPTORS` — the
compiler and `tests/unit/lib/app/questionnaire/settings-registry.test.ts` both fail until you do.
Nothing else needs editing: the pack model, all three serialisers, and the dialog derive from it.

**Descriptor reference:**

| Field   | Meaning                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| `group` | One of `SETTING_GROUPS`; sets the heading the row sits under and the output order                                    |
| `tier`  | `standard` (always shown) or `technical` (behind the dialog opt-in) — the default for the rows this descriptor emits |
| `rows`  | `(config) => SettingRow[]` — **0..n** rows; a row may override `tier` for itself                                     |

Three behaviours worth knowing:

- **Nested blocks expand.** `respondentReport`, `cohortReport`, `tone`, `intro`,
  `personaSelection`, `interviewerStrategy` each emit many rows — one per meaningful sub-setting —
  rather than a JSON blob.
- **Inert settings emit nothing.** Milestone thresholds while banners are off, tone dials while a
  built-in persona governs, invitee fields on a public-only link. `rows` receives the whole config,
  so it can reason about the rest of it.
- **Prompt-shaped settings report presence, not content.** Report instructions, structure, and
  background context render as `Set` / `Not set`; free-text admin copy (support message, persona
  text) is whitespace-collapsed and clipped to 160 characters. A pack row is a table cell, and a
  client-facing PDF is not the place to dump a system prompt.

Per format: the PDF and Markdown render a sub-heading per group (Markdown opens a fresh GFM table
each time); the CSV keeps one flat table with a leading `group` column, which is what pivots in a
spreadsheet.

## Route

`GET /api/v1/app/questionnaires/:id/versions/:vid/pack?format=pdf|csv|md&meta=&questions=&dataSlots=&definitions=&setup=&setupTechnical=&evaluations=&evaluationVerdicts=&evaluationJudgeDetail=&evaluationRewordings=&evaluationEvidence=&conditionalTopics=&conditionalTopicsMembers=&conditionalTopicsEvaluation=&conditionalTopicsTechnical=&interviewerPolicy=`

Admin-only (`withAdminAuth`), the same `exportLimiter` sub-cap the instrument/definition routes
use. Each include flag is `true`/`false`; all default `true` except `evaluations`,
`conditionalTopics`, `interviewerPolicy` and `setupTechnical`, which default `false`. A sub-option
flag (`setupTechnical` today) is not a section — it widens the section it belongs to rather than
adding one, and is ignored when that section is off. `runtime = 'nodejs'` (react-pdf). Filename:
`pack-<slug>-v<N>.<ext>`, `Cache-Control: no-store`.

**Each opt-in section pays for its own query and no other download does.** The design-evaluation
run loads only when `evaluations=true`; the version's topics, Conditional Topics settings and scope
run only when `conditionalTopics=true`; the interviewer-policy run only when
`interviewerPolicy=true`. All three run in one `Promise.all`, so opting into several costs one round
trip rather than three. Every one of them loads **the most recent run for the version and only
that** (`createdAt desc`, `limit: 1`): the pack states the current position of a panel, never a run
history.

Registry: `API.APP.QUESTIONNAIRES.versionPack(id, versionId)`.

## Code map

| Concern                    | File                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| Brand copy (shared)        | `lib/app/questionnaire/export/pack-brand.ts`                                                            |
| Model builder (pure)       | `lib/app/questionnaire/export/build-pack-model.ts`                                                      |
| Settings registries (pure) | `lib/app/questionnaire/settings-registry.ts` (config + routing)                                         |
| CSV serialiser (pure)      | `lib/app/questionnaire/export/build-pack-csv.ts`                                                        |
| Markdown serialiser (pure) | `lib/app/questionnaire/export/build-pack-markdown.ts`                                                   |
| PDF document               | `components/app/questionnaire/export/pack-pdf-document.tsx`                                             |
| PDF render helper          | `app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf.tsx`                            |
| Route                      | `app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/route.ts`                                       |
| Dialog (UI)                | `components/admin/questionnaires/pack-export-dialog.tsx`                                                |
| Header button (primary)    | `components/admin/questionnaires/workspace/questionnaire-pack-button.tsx`                               |
| Menu entry point (2nd)     | `components/admin/questionnaires/definition-export-menu.tsx` ("Download pack…")                         |
| Latest evaluation run load | `app/api/v1/app/questionnaires/_lib/evaluation-run-routes.ts` (`loadLatestEvaluationRun`)               |
| Topics + settings load     | `app/api/v1/app/questionnaires/_lib/topic-routes.ts` (`loadTopics`, `loadConditionalTopicsSettings`)    |
| Latest scope run load      | `app/api/v1/app/questionnaires/_lib/scope-evaluation-run-routes.ts` (`loadLatestScopeEvaluationRun`)    |
| Latest policy run load     | `app/api/v1/app/questionnaires/_lib/policy-evaluation-run-routes.ts` (`loadLatestPolicyEvaluationRun`)  |
| Verdict + judge naming     | `lib/app/questionnaire/evaluation/group-actions.ts` (`summariseGroupActions`, `backing`, `wordingHost`) |
| Edit descriptions (shared) | `lib/app/questionnaire/evaluation/describe-edit.ts` (`describeProposedEdit`, `destinationSentence`)     |

## UI surface

Two entry points, both opening the same `PackExportDialog`:

- **Workspace header** (primary) — `QuestionnairePackButton`, a `secondary`-variant button beside
  Preview and Duplicate in the shared `/v/[vid]` layout header, so the Pack is reachable from every
  workspace tab rather than only from Structure. Rendered only when the version graph exists (the
  Pack renders the structure), the same gate Preview uses. `secondary` rather than the neighbours'
  `outline` gives it weight without claiming the primary slot that per-tab CTAs (Edit, Launch) use.
- **Structure tab's "Export / download" menu** (secondary) — `DefinitionExportMenu`'s third group,
  "Questionnaire pack" → **Download pack…**, kept for admins who look for downloads under an
  export menu.

The dialog offers eight section checkboxes (five default-checked; "Evaluation findings",
"Conditional topics" and "The interviewer" default-unchecked), any **sub-options** those sections
declare, and a format select (PDF / CSV / Markdown).

**Sub-options** are a generic `subOptions` array on the section descriptor, rendered indented under
their parent and disabled while it is off, so each reads as a refinement of its section rather than
as a section of its own. None of them counts toward the "pick at least one section" gate, since a
sub-option produces nothing on its own, and the route ignores any whose parent section is excluded.
The first was **Technical & tuning settings** under "Experience setup".

**Every top-level `PackInclude` flag must have a checkbox, and that is now enforced.**
`interviewerPolicy` shipped on the model and on the route with no row in the dialog, so the section
existed, built correctly, serialised correctly in two formats out of three, and could not be asked
for by anyone. `_noUnreachableSections` in `pack-export-dialog.tsx` resolves `Exclude<SectionKey,
listed keys>` into a `Record<…, never>`, which type-checks as `{}` while the list is complete and
fails naming the missing key the moment it is not.

Since the download URL depends on that dialog state (unlike the menu's static
`<a download>` links), Download sets `window.location.href` directly rather than using a plain
anchor — same-origin authenticated GET, `Content-Disposition: attachment` forces the download
without navigating away.

## Forking

Questionnaire-domain shape, sibling to the instrument export — strips alongside it. `pack-brand.ts`
is the one file a fork MUST edit (tagline/website/closing blurb are ConQuest's own, not generic
platform copy) before reusing this feature for a different product.
