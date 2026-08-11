# Questionnaire Pack download

The admin can download a **branded, shareable artifact** covering everything about how a
questionnaire is set up — title/version/goals, the question structure, the semantic data slots
(with their linked questions), the definitions/glossary, a curated summary of the experience-setup
config, and (opt-in) the latest F5.1–F5.3 design-evaluation run's judge findings — as a PDF, CSV, or
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
- **Experience setup** — a small, hand-picked, non-technical subset of the run-time config (access
  mode, presentation mode, voice/attachments, early finish, session resume, respondent/cohort
  report on/off, whether definitions show to respondents). Deliberately NOT the full
  `QuestionnaireConfigShape` — that has 40+ internal tuning knobs (confidence floors, cost budgets,
  reasoning-trace timings) that mean nothing outside the admin console.
- **Evaluation findings** (opt-in, off by default) — the [F5.1–F5.3 judge panel](./design-evaluation.md)'s
  most recent run for this version: each of the seven dimensions' score/diagnostic plus every finding
  it raised, **including findings still `pending` review** — this is a record of what the panel said,
  not a curated review outcome. Renders last, as an appendix, right before the closing "About
  ConQuest" blurb. `null` (not an empty state) when the version has never been evaluated is rendered
  as a "no evaluation has been run yet" line rather than an omitted section, so the toggle's meaning
  stays predictable regardless of whether a run exists.

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

## Route

`GET /api/v1/app/questionnaires/:id/versions/:vid/pack?format=pdf|csv|md&meta=&questions=&dataSlots=&definitions=&setup=&evaluations=`

Admin-only (`withAdminAuth`), the same `exportLimiter` sub-cap the instrument/definition routes
use. Each include flag is `true`/`false`; all default `true` except `evaluations`, which defaults
`false`. `runtime = 'nodejs'` (react-pdf). Filename: `pack-<slug>-v<N>.<ext>`,
`Cache-Control: no-store`. The evaluation run is only loaded (`loadLatestEvaluationRun`) when
`evaluations=true` — the common case skips that query entirely.

Registry: `API.APP.QUESTIONNAIRES.versionPack(id, versionId)`.

## Code map

| Concern                    | File                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Brand copy (shared)        | `lib/app/questionnaire/export/pack-brand.ts`                                              |
| Model builder (pure)       | `lib/app/questionnaire/export/build-pack-model.ts`                                        |
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

The dialog offers six checkboxes (five default-checked, "Evaluation findings" default-unchecked)
and a format select (PDF / CSV / Markdown). Since the download URL depends on that dialog state (unlike the menu's static
`<a download>` links), Download sets `window.location.href` directly rather than using a plain
anchor — same-origin authenticated GET, `Content-Disposition: attachment` forces the download
without navigating away.

## Forking

Questionnaire-domain shape, sibling to the instrument export — strips alongside it. `pack-brand.ts`
is the one file a fork MUST edit (tagline/website/closing blurb are ConQuest's own, not generic
platform copy) before reusing this feature for a different product.
