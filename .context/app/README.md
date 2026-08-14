# ConQuest app docs (`.context/app/`)

Entry point for the **application tier's** documentation. This namespace holds
everything specific to ConQuest — the conversational-questionnaire product built
on Sunrise. The **platform tier** (Sunrise itself) is documented separately at
[`../substrate.md`](../substrate.md).

> **Why a separate root.** Sunrise reserves `app` for the fork everywhere —
> `lib/app/`, `app/api/v1/app/`, `prisma/schema/app-*.prisma`,
> `prisma/seeds/app-*/`. Mirroring that in the docs (`.context/app/**`) gives one
> clean "this is the application, not the platform" boundary across code _and_
> docs: a fork into a real client engagement owns `.context/app/`; everything
> else is upstream's and merges through on each Sunrise sync.

## Namespaces

| Namespace                            | Holds                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`planning/`](./planning/)           | The phased build plan, per-feature trackers (`features/`), and the `upstream-gaps.md` ledger            |
| [`questionnaire/`](./questionnaire/) | Domain & technical docs for the questionnaire product — overview, schema, day-to-day development guide  |
| [`marketing/`](./marketing/)         | Campaign subdomains and the admin Marketing section — segment landing pages, demo funnels, CRM/pipeline |
| [`research/`](./research/)           | Pre-build research — client requirement analyses and solution-option write-ups. Nothing here is shipped |

### `planning/`

- [`development-plan.md`](./planning/development-plan.md) — **the app's source of
  truth.** Project → Phase → Feature → Task, with the Decisions log and Carried
  Sunrise patches sections at the end.
- [`features/`](./planning/features/) — one tracker per promoted feature
  (e.g. [`features/f0.1.md`](./planning/features/f0.1.md)): PR-sized task table,
  dependencies, live status.
- [`upstream-gaps.md`](./planning/upstream-gaps.md) — forward-looking ledger of
  places where Sunrise's public surface doesn't yet cover an app need. Sibling to
  the plan's Decisions log / Carried Sunrise patches; entries retire when fixed
  upstream.

### `marketing/`

- [`campaign-subdomains.md`](./marketing/campaign-subdomains.md) — **design, not
  shipped.** Segment campaign entry points (`hr.`, `cx.`) that hand visitors into
  a live questionnaire, plus the admin Marketing section (campaign content,
  contacts, testimonials, leads/pipeline). Also the free-trial
  suite on the apex — `/evaluate`, compose-from-a-brief, the form-vs-conversation
  comparison, the template library and the cost calculator. Covers the proxy-stays-lexical rule,
  the two config constraints that silently break capture, the non-`User` PII
  posture, and the demo-spend risk.

### `research/`

- [`merlin5-growth-assessor.md`](./research/merlin5-growth-assessor.md) — **research,
  not shipped.** Conceptual requirements for an adaptive diagnostic: an unscored
  opening that exists only to generate routing signal, an inference step that
  assembles a per-respondent section set under a time budget and six guardrails,
  and a report built on the disagreement between stated need and scored result.
  Names the eleven capabilities, maps each onto what we already have, and compares
  five build options (recommendation: one instrument + a first-class per-session
  Assessment Plan; the Experience switcher stays for routing _between_ instruments).

### `questionnaire/`

- [`README.md`](./questionnaire/README.md) — index for the domain/technical docs.
- [`overview.md`](./questionnaire/overview.md) — the concept and the app/platform
  boundary (what's consumed from Sunrise, where app code lives).
- [`schema.md`](./questionnaire/schema.md) — the app-owned Prisma schema
  (`prisma/schema/app-questionnaire.prisma`) and its conventions.
- [`development.md`](./questionnaire/development.md) — how to work in the module:
  commands, the `lib/app/**` boundary, feature-flag gating, testing.

## How to use

- **AI assistants:** start from the relevant namespace, not everything. Planning
  questions → `planning/`; "how does the questionnaire app work / where do I add
  X" → `questionnaire/`; platform questions (auth, rate limiting, orchestration,
  Prisma migrations) → [`../substrate.md`](../substrate.md).
- **Humans:** read `planning/development-plan.md` for the build narrative, then
  drill into `questionnaire/` for the technical detail.

## Where the app code lives

| Concern      | Location                                 |
| ------------ | ---------------------------------------- |
| Domain logic | `lib/app/questionnaire/**`               |
| HTTP API     | `app/api/v1/app/**`                      |
| Admin UI     | `app/admin/questionnaires/**`            |
| End-user UI  | `app/(protected)/questionnaires/**`      |
| Models       | `prisma/schema/app-questionnaire.prisma` |
| Seeds        | `prisma/seeds/app-questionnaire/**`      |

## Related

- [`../../README.md`](../../README.md) · [`../../CLAUDE.md`](../../CLAUDE.md) — project intro + AI working rules
- [`../../CUSTOMIZATION.md`](../../CUSTOMIZATION.md) — the building-on-Sunrise model and extension seams
- [`../substrate.md`](../substrate.md) — the platform documentation index
