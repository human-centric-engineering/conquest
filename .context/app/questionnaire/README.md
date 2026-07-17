# Questionnaire — domain & technical docs

The technical documentation for ConQuest's questionnaire product. For the build
plan and feature trackers, see [`../planning/`](../planning/); for the platform
(Sunrise) reference, see [`../../substrate.md`](../../substrate.md).

## In this namespace

| Doc                                                          | Read it for                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`overview.md`](./overview.md)                               | The concept, the app/platform boundary, and which Sunrise primitives the app consumes                                                                                                                                                                         |
| [`schema.md`](./schema.md)                                   | The app-owned Prisma schema and its conventions (anchor models land in T0.1.3)                                                                                                                                                                                |
| [`development.md`](./development.md)                         | Day-to-day: where code lives, the `lib/app/**` boundary, commands, tests                                                                                                                                                                                      |
| [`ingestion.md`](./ingestion.md)                             | The `POST /api/v1/app/questionnaires` pipeline — parse → extract → persist (F1.1)                                                                                                                                                                             |
| [`reingest.md`](./reingest.md)                               | Re-ingest — replace a draft version's structure from a new source doc (F2.4)                                                                                                                                                                                  |
| [`configuration.md`](./configuration.md)                     | Per-version run-time config (selection, thresholds, modes, profile fields) + launch gate (F3.1)                                                                                                                                                               |
| [`invitations.md`](./invitations.md)                         | Respondent invitation lifecycle, token security, launch-blocker wiring, registration (F3.2)                                                                                                                                                                   |
| [`extraction-changes.md`](./extraction-changes.md)           | The revertible editorial change-record model, vocabulary, and write path (F1.1)                                                                                                                                                                               |
| [`admin-ui.md`](./admin-ui.md)                               | The admin read surface — list/detail/version-graph APIs + pages (P2 / F2.1 PR1)                                                                                                                                                                               |
| [`archiving.md`](./archiving.md)                             | Soft-delete — the `archivedAt` model (orthogonal to `status`), archive/restore API, list filter, Active/Archived UI (F14.11)                                                                                                                                  |
| [`agent-settings.md`](./agent-settings.md)                   | Agent Settings Evaluation — review/tune each agent's model/temperature/effort vs a deterministic OpenAI cost/perf baseline, hybrid "Explain with AI", and the pre-seeded OpenAI task defaults (F9.16)                                                         |
| [`diagnostics.md`](./diagnostics.md)                         | Per-invitation diagnostics — persisted error trail + per-turn telemetry rollup, the always-on capture seam, and the admin Diagnostics tab + drill-down deep-dive (F8.5)                                                                                       |
| [`selection-strategies.md`](./selection-strategies.md)       | The four next-question strategies (sequential/random/weighted/adaptive) + preview route (F4.1)                                                                                                                                                                |
| [`answer-extraction.md`](./answer-extraction.md)             | Per-turn answer extraction into typed slot intents — capability + preview route (F4.2)                                                                                                                                                                        |
| [`contradiction-detection.md`](./contradiction-detection.md) | Cross-slot logical contradiction detection — capability + preview route (F4.3)                                                                                                                                                                                |
| [`answer-refinement.md`](./answer-refinement.md)             | Refine/overwrite a captured answer with `refinementHistory` — capability + persisting route (F4.4)                                                                                                                                                            |
| [`completion-logic.md`](./completion-logic.md)               | Offer-to-submit gate + accept/hold resolution + completion-sweep — pure core, offer capability, two routes (F4.5)                                                                                                                                             |
| [`session-state-machine.md`](./session-state-machine.md)     | Session lifecycle transitions + event audit trail — transition table, admin route (F4.6)                                                                                                                                                                      |
| [`design-evaluation.md`](./design-evaluation.md)             | Seven LLM judges score a version's structure vs goal/audience + propose edits — pure core, capability, preview route (F5.1); persisted synchronous runs + admin run history (F5.2)                                                                            |
| [`per-turn-orchestrator.md`](./per-turn-orchestrator.md)     | The live streaming turn loop — pure orchestrator, SSE route, 3 access scenarios (incl. no-login anonymous), streamed offers (F6.1)                                                                                                                            |
| [`cost-cap-enforcement.md`](./cost-cap-enforcement.md)       | Per-session USD budget at the turn boundary — soft wrap-up nudge at 90%, hard 402 + auto-pause at 100%, summed turn cost (F6.3)                                                                                                                               |
| [`answer-slot-panel.md`](./answer-slot-panel.md)             | The live respondent answer panel beside the chat — `GET …/answers` read endpoint, scope config, confidence language, Revisit wiring (F7.2)                                                                                                                    |
| [`transcript-export.md`](./transcript-export.md)             | Respondent chat-transcript download — themed PDF / plain text, intro + support ref + Interviewer/Respondent labels + UTC timestamps, `transcript.pdf` / `transcript.txt` routes, lifecycle-bar + completion-screen control (F7.6)                             |
| [`reasoning-stream.md`](./reasoning-stream.md)               | Live "watch it think" reasoning feed — pure builder from `TurnResult`, `reasoning` SSE frame, overlay/inline placement, per-version persistence, respondent-safe exclusions, flag + Settings gates (F9.9)                                                     |
| [`presentation-mode.md`](./presentation-mode.md)             | How a respondent completes a session — chat / raw form / both toggle; the `?view=form` read model, `PUT …/answers` write API, edit-vs-fresh recording, respondent-edit protection, data-slot self-heal (F9.7)                                                 |
| [`interviewer-tone.md`](./interviewer-tone.md)               | Interviewer tone & persona — nine per-version tone sliders + free-text persona folded into the live phraser's prompt (`buildToneInstructions`), `tone` JSON config, flag + Settings gates (F-tone)                                                            |
| [`interviewer-personas.md`](./interviewer-personas.md)       | Selectable interviewer personas — a respondent chooses their interviewer from a named library (built-ins + admin edits); each persona is a `ToneSettings`, chosen at a carousel step, applied via `resolveEffectiveTone` at turn time (F-persona)             |
| [`respondent-intro.md`](./respondent-intro.md)               | Pre-questionnaire intro / splash screen — admin opt-in, adaptive how-it-works / what-you'll-get copy (`buildIntroCopy`), admin background with cohort override (`resolveSessionIntro`), `SessionEntry` gate, flag + per-version + fresh-session gates (F12.1) |
| [`chat-banner.md`](./chat-banner.md)                         | Respondent brand band — three-zone Brand · Title · Schedule header; `BandHeader` (`resolveSessionHeader`/`resolveVersionHeader`), `buildScheduleView` status/date derivation, `--app-on-surface` contrast token, responsive + open-ended/contrast handling    |
| [`anonymous-mode.md`](./anonymous-mode.md)                   | The cross-surface PII contract — per-surface gates, the profile snapshot rule, k-anonymity suppression, erasure cascade (F8.3)                                                                                                                                |
| [`feature-flags.md`](./feature-flags.md)                     | Historical note — the questionnaire flag layer was removed (2026-07); every feature is permanently on, only per-version config toggles remain, and site-wide `MAINTENANCE_MODE` is the sole runtime toggle                                                    |
| [`forking.md`](./forking.md)                                 | Forking this repo — re-skinning for a new vertical (keep/rename/replace, sed recipes, demo-tenancy replacement) and tracking upstream Sunrise (upstream remote, merge discipline, contributing fixes) (F9.3)                                                  |

## Where the code lives

| Concern      | Location                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| Domain logic | `lib/app/questionnaire/**` (platform-agnostic — no `next/*` or Prisma runtime imports) |
| HTTP API     | `app/api/v1/app/**`                                                                    |
| Admin UI     | `app/admin/questionnaires/**`                                                          |
| End-user UI  | `app/(protected)/questionnaires/**`                                                    |
| Models       | `prisma/schema/app-questionnaire.prisma`                                               |
| Seeds        | `prisma/seeds/app-questionnaire/**`                                                    |

Every surface is **always on** — the questionnaire feature-flag layer was removed
(2026-07), so there is no flag gate and no 404-when-off path. See
[`feature-flags.md`](./feature-flags.md).

## Status

The product is being built phase by phase — see
[`../planning/development-plan.md`](../planning/development-plan.md). These docs
grow with it: sections marked _stub_ are filled by the task that builds the
corresponding surface.
