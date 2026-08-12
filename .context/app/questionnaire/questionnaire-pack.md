# Questionnaire Pack download

The admin can download a **branded, shareable artifact** covering everything about how a
questionnaire is set up — title/version/goals, the question structure, the semantic data slots
(with their linked questions), the definitions/glossary, the experience-setup summary, and (opt-in)
the latest F5.1–F5.3 design-evaluation run's judge findings — as a PDF, CSV, or
Markdown file. The admin picks which of those six sections to include from a dialog opened by the
**Questionnaire pack** button in the workspace header; five are ticked by default, "Evaluation
findings" is not (see below).

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

Each section is independently toggleable; an excluded section is `null` on the shared `PackModel`
so every serialiser skips it the same way.

**Why evaluations default off, unlike the other five:** the Pack is the external/showcase artifact —
built to hand to a client or stakeholder — and judge findings are unreviewed AI critique of the
questionnaire (`this question is redundant`, `off-mission`, etc.). Shipping that by accident in a
document meant to showcase the questionnaire would be an easy, embarrassing mistake, so the admin
opts in deliberately per download rather than having to remember to opt out.

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

`GET /api/v1/app/questionnaires/:id/versions/:vid/pack?format=pdf|csv|md&meta=&questions=&dataSlots=&definitions=&setup=&setupTechnical=&evaluations=`

Admin-only (`withAdminAuth`), the same `exportLimiter` sub-cap the instrument/definition routes
use. Each include flag is `true`/`false`; all default `true` except `evaluations` and
`setupTechnical`, which default `false`. `setupTechnical` is a sub-option of `setup`, not a seventh
section — it widens the setup summary rather than adding one, and is ignored when `setup=false`. `runtime = 'nodejs'` (react-pdf). Filename: `pack-<slug>-v<N>.<ext>`,
`Cache-Control: no-store`. The evaluation run is only loaded (`loadLatestEvaluationRun`) when
`evaluations=true` — the common case skips that query entirely.

Registry: `API.APP.QUESTIONNAIRES.versionPack(id, versionId)`.

## Code map

| Concern                    | File                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Brand copy (shared)        | `lib/app/questionnaire/export/pack-brand.ts`                                              |
| Model builder (pure)       | `lib/app/questionnaire/export/build-pack-model.ts`                                        |
| Settings registry (pure)   | `lib/app/questionnaire/settings-registry.ts`                                              |
| CSV serialiser (pure)      | `lib/app/questionnaire/export/build-pack-csv.ts`                                          |
| Markdown serialiser (pure) | `lib/app/questionnaire/export/build-pack-markdown.ts`                                     |
| PDF document               | `components/app/questionnaire/export/pack-pdf-document.tsx`                               |
| PDF render helper          | `app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf.tsx`              |
| Route                      | `app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/route.ts`                         |
| Dialog (UI)                | `components/admin/questionnaires/pack-export-dialog.tsx`                                  |
| Header button (primary)    | `components/admin/questionnaires/workspace/questionnaire-pack-button.tsx`                 |
| Menu entry point (2nd)     | `components/admin/questionnaires/definition-export-menu.tsx` ("Download pack…")           |
| Latest evaluation run load | `app/api/v1/app/questionnaires/_lib/evaluation-run-routes.ts` (`loadLatestEvaluationRun`) |

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

The dialog offers six section checkboxes (five default-checked, "Evaluation findings"
default-unchecked), one nested sub-checkbox — **Technical & tuning settings**, indented under
"Experience setup" and disabled while that parent is off — and a format select (PDF / CSV /
Markdown). The sub-option does not count toward the "pick at least one section" gate, since it
produces nothing on its own. Since the download URL depends on that dialog state (unlike the menu's static
`<a download>` links), Download sets `window.location.href` directly rather than using a plain
anchor — same-origin authenticated GET, `Content-Disposition: attachment` forces the download
without navigating away.

## Forking

Questionnaire-domain shape, sibling to the instrument export — strips alongside it. `pack-brand.ts`
is the one file a fork MUST edit (tagline/website/closing blurb are ConQuest's own, not generic
platform copy) before reusing this feature for a different product.
