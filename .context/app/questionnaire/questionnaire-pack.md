# Questionnaire Pack download

The admin can download a **branded, shareable artifact** covering everything about how a
questionnaire is set up — title/version/goals, the question structure, the semantic data slots
(with their linked questions), the definitions/glossary, and a curated summary of the
experience-setup config — as a PDF, CSV, or Markdown file. The admin picks which of those five
sections to include (all ticked by default) from a dialog on the Structure tab.

Distinct from the brand-free [blank instrument export](./admin-ui.md) (F14.9): the instrument is
the design-time reviewer copy of just the questions, deliberately unbranded. The Pack is the
external/showcase counterpart — it carries the ConQuest wordmark, tagline, website, and a closing
"About ConQuest" blurb, and additionally covers data slots (which the instrument doesn't) and the
experience-setup summary. Both live in the same "Export / download" menu; neither replaces the
other.

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

Each section is independently toggleable; an excluded section is `null` on the shared `PackModel`
so every serialiser skips it the same way.

### Branding

The PDF and Markdown outputs carry a header with the ConQuest wordmark ("Con" ink / "Quest"
marigold, matching `ConquestWordmark`'s light-mode palette), the "Conversational Questionnaires"
tagline, and `conquestinsights.com`. All three formats close with an "About ConQuest" blurb —
product description + use cases — authored once in `pack-brand.ts` so the three serialisers can't
drift from each other. No custom font is registered (`@react-pdf/renderer` ships Helvetica only, as
every other PDF document in this app does) — the wordmark is Helvetica-Bold in the two brand
colours, not the web's Fraunces serif.

## Route

`GET /api/v1/app/questionnaires/:id/versions/:vid/pack?format=pdf|csv|md&meta=&questions=&dataSlots=&definitions=&setup=`

Admin-only (`withAdminAuth`), the same `exportLimiter` sub-cap the instrument/definition routes
use. Each include flag is `true`/`false`, defaulting to `true`. `runtime = 'nodejs'` (react-pdf).
Filename: `pack-<slug>-v<N>.<ext>`, `Cache-Control: no-store`.

Registry: `API.APP.QUESTIONNAIRES.versionPack(id, versionId)`.

## Code map

| Concern                    | File                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| Brand copy (shared)        | `lib/app/questionnaire/export/pack-brand.ts`                                    |
| Model builder (pure)       | `lib/app/questionnaire/export/build-pack-model.ts`                              |
| CSV serialiser (pure)      | `lib/app/questionnaire/export/build-pack-csv.ts`                                |
| Markdown serialiser (pure) | `lib/app/questionnaire/export/build-pack-markdown.ts`                           |
| PDF document               | `components/app/questionnaire/export/pack-pdf-document.tsx`                     |
| PDF render helper          | `app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf.tsx`    |
| Route                      | `app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/route.ts`               |
| Dialog (UI)                | `components/admin/questionnaires/pack-export-dialog.tsx`                        |
| Menu entry point           | `components/admin/questionnaires/definition-export-menu.tsx` ("Download pack…") |

## UI surface

The Structure tab's "Export / download" menu (`DefinitionExportMenu`) gets a third group,
"Questionnaire pack" → **Download pack…**, opening `PackExportDialog`: five checkboxes (all
default-checked) and a format select (PDF / CSV / Markdown). Since the download URL depends on
that dialog state (unlike the menu's static `<a download>` links), Download sets
`window.location.href` directly rather than using a plain anchor — same-origin authenticated GET,
`Content-Disposition: attachment` forces the download without navigating away.

## Forking

Questionnaire-domain shape, sibling to the instrument export — strips alongside it. `pack-brand.ts`
is the one file a fork MUST edit (tagline/website/closing blurb are ConQuest's own, not generic
platform copy) before reusing this feature for a different product.
