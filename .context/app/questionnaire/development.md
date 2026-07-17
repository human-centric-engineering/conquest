# Questionnaire — development guide

How to work inside the questionnaire module. Assumes the foundations from F0.1 are
in place.

## Where things go

| You're adding…      | Put it in                                    | Notes                                                                      |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| Domain logic        | `lib/app/questionnaire/**`                   | Platform-agnostic; respects the `lib/app/**` boundary (below).             |
| An API route        | `app/api/v1/app/<resource>/route.ts`         | Inherits the 100/min `api` cap automatically.                              |
| Admin page          | `app/admin/questionnaires/**`                | Add the nav entry via `lib/app/admin-nav.ts`.                              |
| End-user page       | `app/(protected)/questionnaires/**`          |                                                                            |
| A model             | `prisma/schema/app-questionnaire.prisma`     | See [`schema.md`](./schema.md).                                            |
| A seed              | `prisma/seeds/app-questionnaire/NNN-slug.ts` | Basename must match `^\d{3}-[a-z0-9-]+\.ts$`; default-export a `SeedUnit`. |
| An agent capability | register in `lib/app/capabilities.ts`        | `registerAppCapability(new YourTool())`.                                   |

Always import via the `@/` alias — never relative paths (ESLint-enforced).

## The `lib/app/**` boundary

`lib/app/questionnaire/**` inherits Sunrise's portable-core boundary (flat-config
override in `eslint.config.mjs`, locked by
`tests/unit/eslint-app-boundary.test.ts`). In these files:

- **No runtime `next/*`** imports (type-only allowed). Framework glue goes in
  `app/` route handlers or a `lib/app/questionnaire/server/` module.
- **No `prisma` / `@prisma/*`** runtime imports (type-only allowed). DB access
  flows through `app/` handlers or `lib/` services. A helper that transitively
  hits Prisma is **server-only** even though it passes lint — only call it from
  server contexts.
- **No `react-dom`**, **no node built-ins** (`fs`, `path`, `node:*`).
- `@/` alias only — the relative-import ban is restated for this surface.

Full rationale: [`../../architecture/lint-toolchain.md`](../../architecture/lint-toolchain.md).

## No feature-flag gating

Questionnaire surfaces are **always on** — there is no flag to check and no
404-when-off path. The old master + sub-flag layer
(`APP_QUESTIONNAIRES_*_ENABLED`, `lib/app/questionnaire/feature-flag.ts`, the
`with*Enabled` / `is*Enabled` / `ensure*Enabled` gates) was removed; routes and
pages go straight to `withAuth` / `withAdminAuth` and their handler work. The
only remaining per-feature gates are each version's own **config toggles** (e.g.
`respondentReport.enabled`, `research.enabled`, `reasoningStreamEnabled`), and
the only site-wide runtime toggle is generic Sunrise `MAINTENANCE_MODE`. See
[`feature-flags.md`](./feature-flags.md).

```ts
export async function GET() {
  // no flag gate — straight to auth / handler work
  return successResponse({ status: 'ok' });
}
```

## Commands

```bash
npm run dev                    # dev server
npm run validate               # type-check + lint + format:check
npm run test                   # vitest (unit + integration; integration mocks Prisma)

npm run db:migrate:dev -- --name app_<change>   # create + apply an app migration (dev)
npm run db:drift-check         # verify platform unmodelled objects survived a migration
npm run db:seed                # apply new/changed seed units (recursive discovery)
npm run db:studio              # Prisma Studio
```

## Testing conventions

- Tests mirror source under `tests/unit/**` and `tests/integration/**`.
- Unit: pure functions, schema shape (via `Prisma.dmmf`).
- Integration: route handlers exercised with **mocked Prisma** (happy-dom, fake
  `DATABASE_URL`) — see existing `tests/integration/**` for the pattern. Real-DB
  guarantees come from CI's `migrate deploy` + drift-check jobs, not the Vitest run.
- The `RATE_LIMIT_BYPASS=true` test default makes the middleware a no-op; clear it
  in a test's `beforeEach` if you're specifically exercising rate limits.

See [`../../testing/`](../../testing/) for platform testing patterns.

## Seam map (what Sunrise already provides)

| Seam                | File (fork-owned scaffold, edit freely) | Consumer                                          |
| ------------------- | --------------------------------------- | ------------------------------------------------- |
| App env vars        | `lib/app/env.ts` (`appEnvSchema`)       | `lib/env.ts` (merged into the startup parse)      |
| App capabilities    | `lib/app/capabilities.ts`               | `lib/orchestration/capabilities/registry.ts`      |
| App admin nav       | `lib/app/admin-nav.ts`                  | `components/admin/admin-sidebar.tsx`              |
| App rate-limit      | `lib/app/rate-limit.ts`                 | `lib/security/rate-limit-middleware.ts`           |
| Recursive app seeds | `prisma/seeds/app-questionnaire/**`     | `prisma/runner.ts` (auto-discovered by `db:seed`) |

These ship empty/auto-wired — you fill the body, the platform calls it. Full
guide: [`../../../CUSTOMIZATION.md`](../../../CUSTOMIZATION.md) §4.

## Related

- [`overview.md`](./overview.md) · [`schema.md`](./schema.md)
- [`../planning/development-plan.md`](../planning/development-plan.md) · [`../planning/features/`](../planning/features/)
- [`../planning/upstream-gaps.md`](../planning/upstream-gaps.md)
