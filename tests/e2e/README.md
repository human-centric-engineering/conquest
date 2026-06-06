# End-to-end tests (Playwright)

These protect the F7.1 respondent **chat surface** — most importantly the sales-critical
no-login demo happy path. They run against a real Next.js server and a real database, so they
need a provisioned environment. Tests that need fixtures **skip** (rather than fail) when the
fixture isn't supplied, so CI stays green until it's wired.

## One-time setup

```bash
npm install                      # @playwright/test is a dev dependency
npx playwright install chromium  # download the browser binary
```

## Running

```bash
# Boots `next dev` automatically against a local DB:
npm run test:e2e

# Or point at an already-running server (preview deploy, `next start`, …):
E2E_BASE_URL=https://staging.example.com npm run test:e2e

# Interactive runner:
npm run test:e2e:ui
```

## Environment variables

| Variable                    | Purpose                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`              | Target an external server instead of the managed `next dev`.                              |
| `E2E_VERSION_ID`            | A **launched** questionnaire version with `anonymousMode = true` — drives the happy path. |
| `E2E_LIVE_SESSIONS_ENABLED` | Set to `true` when the env has the live-sessions flag ON (skips the 404-gate test).       |

## Provisioning the happy-path fixture

The demo happy path needs three things in the target environment:

1. **Flags on** — enable the `APP_QUESTIONNAIRES_ENABLED` and
   `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED` feature-flag rows (and
   `APP_QUESTIONNAIRES_VOICE_INPUT_ENABLED` if exercising voice). These are DB rows, set via
   the admin feature-flags UI or a seed.
2. **A launched anonymous version** — a questionnaire whose latest version is `launched` with
   run-time config `anonymousMode = true` and at least one question. Capture its version id and
   pass it as `E2E_VERSION_ID`.
3. **An LLM provider** — the per-turn orchestrator makes real model calls, so a provider must be
   configured (e.g. an OpenAI provider + model). Without one, the turn loop can't compose a reply
   and the happy path will time out.

Then:

```bash
E2E_VERSION_ID=<versionId> E2E_LIVE_SESSIONS_ENABLED=true npm run test:e2e
```

## Not yet covered

- **Authenticated invitation flow** (`/questionnaires/start?...` → redirect → chat). Needs a
  logged-in storage-state fixture (`globalSetup` that signs in via the auth API and saves
  cookies). Tracked as a follow-up.
