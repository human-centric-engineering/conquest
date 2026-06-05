# Questionnaire — domain & technical docs

The technical documentation for ConQuest's questionnaire product. For the build
plan and feature trackers, see [`../planning/`](../planning/); for the platform
(Sunrise) reference, see [`../../substrate.md`](../../substrate.md).

## In this namespace

| Doc                                                    | Read it for                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`overview.md`](./overview.md)                         | The concept, the app/platform boundary, and which Sunrise primitives the app consumes           |
| [`schema.md`](./schema.md)                             | The app-owned Prisma schema and its conventions (anchor models land in T0.1.3)                  |
| [`development.md`](./development.md)                   | Day-to-day: where code lives, the `lib/app/**` boundary, flag gating, commands, tests           |
| [`ingestion.md`](./ingestion.md)                       | The `POST /api/v1/app/questionnaires` pipeline — parse → extract → persist (F1.1)               |
| [`reingest.md`](./reingest.md)                         | Re-ingest — replace a draft version's structure from a new source doc (F2.4)                    |
| [`configuration.md`](./configuration.md)               | Per-version run-time config (selection, thresholds, modes, profile fields) + launch gate (F3.1) |
| [`invitations.md`](./invitations.md)                   | Respondent invitation lifecycle, token security, launch-blocker wiring, registration (F3.2)     |
| [`extraction-changes.md`](./extraction-changes.md)     | The revertible editorial change-record model, vocabulary, and write path (F1.1)                 |
| [`admin-ui.md`](./admin-ui.md)                         | The admin read surface — list/detail/version-graph APIs + pages (P2 / F2.1 PR1)                 |
| [`selection-strategies.md`](./selection-strategies.md) | The four next-question strategies (sequential/random/weighted/adaptive) + preview route (F4.1)  |
| [`answer-extraction.md`](./answer-extraction.md)       | Per-turn answer extraction into typed slot intents — capability + preview route (F4.2)          |

## Where the code lives

| Concern      | Location                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| Domain logic | `lib/app/questionnaire/**` (platform-agnostic — no `next/*` or Prisma runtime imports) |
| HTTP API     | `app/api/v1/app/**`                                                                    |
| Admin UI     | `app/admin/questionnaires/**`                                                          |
| End-user UI  | `app/(protected)/questionnaires/**`                                                    |
| Models       | `prisma/schema/app-questionnaire.prisma`                                               |
| Seeds        | `prisma/seeds/app-questionnaire/**`                                                    |

Every surface is gated by the `APP_QUESTIONNAIRES_ENABLED` feature flag via
`isQuestionnairesEnabled()` / `ensureQuestionnairesEnabled()`
(`lib/app/questionnaire/feature-flag.ts`).

## Status

The product is being built phase by phase — see
[`../planning/development-plan.md`](../planning/development-plan.md). These docs
grow with it: sections marked _stub_ are filled by the task that builds the
corresponding surface.
