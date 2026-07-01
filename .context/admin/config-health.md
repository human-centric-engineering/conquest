# Admin config-health

Surfaces **missing operationally-critical configuration** in the admin app so an operator isn't left guessing why a feature is silently dead (the motivating case: `CRON_SECRET` unset on Vercel → the maintenance cron refuses every request → respondent reports / eval runs / retries never run).

## What it checks

A registry of settings that are **optional in the env schema** (`lib/env.ts`) — so the app boots without them — yet disable features when missing. Startup-enforced vars (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`) are **deliberately excluded**: the process can't start without them, so at runtime they're never missing.

Platform registry — `lib/config-health/checks.ts`:

| Key            | Severity | Applies         | Detects                                                                         |
| -------------- | -------- | --------------- | ------------------------------------------------------------------------------- |
| `CRON_SECRET`  | critical | production only | `CRON_SECRET` set (dev is exempt — it drives the tick via `instrumentation.ts`) |
| `llm_provider` | critical | always          | any configured provider has its API-key env var set (`listProvidersWithStatus`) |
| `email`        | warning  | always          | `RESEND_API_KEY` + `EMAIL_FROM` set (`isEmailEnabled`)                          |
| `db_pooler`    | warning  | Vercel only     | `DATABASE_URL` looks pooled (`-pooler` / `:6543` / `pgbouncer=`)                |

## Security — presence only, never values

Every check's `detect()` returns a **boolean** — the report carries the var name, label, severity, description, remediation, and a `present` flag, but **never a config value**. Reuse the presence-only readers (`isApiKeyEnvVarSet`, `!!process.env[...]`). The API route logs counts only. A regression test asserts the serialised report contains no value.

## Flow

`runConfigHealthChecks()` (`lib/config-health/run.ts`) merges the platform registry with the fork's `appConfigHealthChecks`, evaluates each (skipping `productionOnly` checks outside prod and `applicable()`-gated checks that don't apply — those report `present: true` so they're never flagged), and returns a `ConfigHealthReport` with per-severity `summary` counts of applicable-and-unmet checks.

- **API:** `GET /api/v1/admin/config-health` (`withAdminAuth`, `API.ADMIN.CONFIG_HEALTH`) → `ConfigHealthReport`.
- **Dashboard card:** `/admin/overview` server-fetches the report and renders `<ConfigHealthBanner variant="card" />` — full detail of every unmet check (any severity). Renders nothing when clean.
- **Global banner:** `<ConfigHealthGlobalBanner />` in `app/admin/layout.tsx` (client, fetches once on mount) renders `variant="global"` — a slim **critical-only** strip on every admin page until the critical setting is fixed.

Both banners return `null` when there's nothing to show. Config is static per deploy, so there's no polling.

## Adding a check

- **Platform** (Sunrise): add a `ConfigHealthCheck` to `CONFIG_HEALTH_CHECKS` in `lib/config-health/checks.ts`.
- **Fork** (ConQuest / downstream): add to `appConfigHealthChecks` in `lib/app/config-health.ts` (fork-owned scaffold, merges cleanly on upstream pulls — same seam pattern as `lib/app/env.ts`).

A check is `{ key, label, severity, description, remediation, docsPath?, productionOnly?, applicable?, detect }`. Keep `detect` presence-only; use `productionOnly` for things dev handles differently (like the cron) and `applicable` for platform-specific relevance (like the serverless DB pooler).

## Related

- `.context/environment/services-env.md` — `CRON_SECRET` and the other env vars.
- `.context/orchestration/scheduling.md` — why `CRON_SECRET` / the cron matters.
- `.context/deployment/platforms/vercel.md` — Vercel setup (cron, pooled `DATABASE_URL`).
