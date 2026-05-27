# Building on Sunrise

The canonical guide for building your own application **on top of** Sunrise —
whether you forked the repository on GitHub or copied it as a project starter.

Audience: external forkers and app teams. If instead you want to contribute a
change **back to Sunrise itself**, see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
For deep reference on any subsystem, see the [`.context/`](./.context/) docs.

---

## The app/platform model

Sunrise is two tiers of code living in one repository:

| Tier         | What it is                                                                                                                         | How you treat it                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Platform** | Sunrise itself — auth, API conventions, `lib/` utilities, orchestration, the security/rate-limit middleware, the migration tooling | An upgradable dependency. Prefer to extend it, not edit it. |
| **Your app** | The product you build — your routes, components, models, capabilities, business logic                                              | Freely yours. Add it in new files alongside the platform.   |

Two principles keep an upgrade from upstream a clean merge instead of a fight:

1. **Extend through the seams, don't fork-and-edit.** Sunrise exposes
   designed extension points — add OAuth providers in `lib/auth/config.ts`, add
   models to the Prisma schema, drop new routes under `app/api/v1/` (they
   inherit rate limiting automatically), add pages to a route group, register
   capabilities/agents/workflows in the orchestration layer, swap
   email/storage/analytics providers via their adapters. The fewer existing
   Sunrise files you modify, the smaller every future merge conflict.

2. **Depend on the public surface, not internals.** Build against Sunrise's
   stable helpers rather than reaching into their implementations:
   - `@/` import alias everywhere (never relative paths) — survives upstream file moves
   - API envelope: `successResponse()` / `errorResponse()` (`lib/api/responses.ts`)
   - Auth guards: `withAuth()` / `withAdminAuth()` (`lib/auth/guards.ts`)
   - The utilities in the **Key Utilities** table of [`CLAUDE.md`](./CLAUDE.md)
   - The documented contracts in [`.context/`](./.context/)

   These are the parts intended to stay stable across releases. Internals
   behind them can be refactored upstream; code that only touches the public
   surface rides those refactors for free.

**Where your code goes:**

| Your code                  | Put it in                                                  |
| -------------------------- | ---------------------------------------------------------- |
| Pages                      | a route group under `app/` (`(public)`, `(protected)`)     |
| API endpoints              | `app/api/v1/<resource>/`                                   |
| React components           | `components/`                                              |
| Business logic / utilities | `lib/`                                                     |
| Database models            | the Prisma schema + a migration                            |
| Agent tools                | a capability in the orchestration layer                    |
| Dependencies & scripts     | `package.json` — see [§6](#6-adding-dependencies--scripts) |

---

## 1. First steps

**Initial setup:**

- [ ] Fork or clone this repository
- [ ] Update `package.json`:
  - `name`: your-project-name
  - `description`: Your project description
  - `version`: 0.1.0 (or your initial version)
  - `author`: Your name/organization
  - `repository`: Your repository URL
- [ ] Update `README.md`:
  - Replace "Sunrise" with your project name
  - Update description and features list
  - Update repository URLs
- [ ] Copy `.env.example` to `.env.local`
- [ ] Configure required environment variables (see `.env.example`)
- [ ] Generate auth secret: `openssl rand -base64 32`
- [ ] Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` in `.env.local`
- [ ] Run: `npm install`
- [ ] Initialize database: `npm run db:migrate:dev`
- [ ] Start dev server: `npm run dev`
- [ ] Test at `http://localhost:3000`

---

## 2. Branding & theming

**Project name & metadata:**

- `package.json` → `name`, `description`
- `app/layout.tsx` → `metadata.title`, `metadata.description`
- `README.md` → main heading, description

**Colors & styling:**

- `tailwind.config.ts` → `theme.extend.colors`, `theme.extend.fontFamily`
- `app/globals.css` → CSS variables for light/dark themes (`:root`, `.dark`)
- Update primary, secondary, accent colors as needed

**Logo & favicon:**

- Replace `public/favicon.ico`
- Add logo images to `public/`
- Update `app/layout.tsx` → `metadata.icons`
- Update landing page hero: `app/(public)/page.tsx`

**Fonts:**

- Import fonts in `app/layout.tsx` (currently uses Inter)
- Update font family in `tailwind.config.ts`

---

## 3. Authentication

**Remove OAuth providers:**

- Edit `lib/auth/config.ts` → delete provider from `socialProviders` object
- Remove corresponding env vars from `.env.local` and `.env.example`
- Update login UI if needed: `app/(auth)/login/page.tsx`

**Add OAuth providers:**

- Add provider to `lib/auth/config.ts` (follow Google OAuth pattern)
- Add credentials to `.env.local`:
  - `<PROVIDER>_CLIENT_ID`
  - `<PROVIDER>_CLIENT_SECRET`
- Update `.env.example` with placeholder values
- Add provider button to `app/(auth)/login/page.tsx`

**Email-only authentication:**

- Remove `socialProviders` section from `lib/auth/config.ts`
- Remove OAuth buttons from `app/(auth)/login/page.tsx`
- Remove OAuth env vars from `.env.example`

---

## 4. Database schema

**Modifying the schema:**

- Edit `prisma/schema.prisma`
- Add/modify models as needed
- Create + apply a migration: `npm run db:migrate:dev` (dev) /
  `npm run db:migrate:deploy` (prod / CI)
- Update seed data under `prisma/seeds/` (see
  [`.context/database/seeding.md`](./.context/database/seeding.md))
- Regenerate the Prisma client: `npm run db:generate`

> `prisma db push` is intentionally not available as a script — it skips
> migration history and lets dev/prod diverge silently. Every schema change is
> a versioned, reviewable migration. See
> [`.context/database/migrations.md`](./.context/database/migrations.md).

**Adding fields to the User model:**

- Edit the `User` model in `prisma/schema.prisma`
- Run `npm run db:migrate:dev`
- Update API types: `types/index.ts` → `PublicUser` interface
- Update forms if needed: `components/forms/`

> **New `User` relations need an `onDelete` policy.** Any model with a
> `userId` / `createdBy` FK must declare `onDelete: Cascade` (personal data) or
> `onDelete: SetNull` (retained config/audit, FK nullable) — omitting it
> defaults to `Restrict` and silently breaks GDPR erasure. See
> [`.context/privacy/data-erasure.md`](./.context/privacy/data-erasure.md).

---

## 5. Landing page & routes

**Customizing pages:**

- **Landing page:** `app/(public)/page.tsx`
- **About page:** `app/(public)/about/page.tsx`
- **Contact page:** `app/(public)/contact/page.tsx`
- **Dashboard:** `app/(protected)/dashboard/page.tsx`
- **Settings:** `app/(protected)/settings/page.tsx`
- **Profile:** `app/(protected)/profile/page.tsx`

**Adding new pages:**

- **Public page:** Create `app/(public)/pricing/page.tsx` (uses public layout)
- **Protected page:** Create `app/(protected)/analytics/page.tsx` (uses protected layout)
- **Different layout:** Create a new route group, e.g. `app/(marketing)/layout.tsx`

**Navigation:**

- Update layouts in route groups: `app/(public)/layout.tsx`, `app/(protected)/layout.tsx`
- Update navigation components as needed

---

## 6. Adding dependencies & scripts

`package.json` is shared between the platform and your app, and an upstream
upgrade is a three-way merge. Keep your additions in regions Sunrise never
touches so that merge stays clean.

**Dependencies:**

- ✅ **Add your own freely** — `npm install <your-package>`. New entries don't
  collide with Sunrise's.
- ❌ **Don't change the version of a dependency Sunrise already declares.**
  Bumping or pinning a Sunrise-owned dependency yourself creates merge
  conflicts on every upgrade and can break platform code that relies on a
  specific version. Dependency versions are the platform's to manage — you
  receive them through upstream merges.
- If you genuinely need a newer version of a Sunrise-owned dependency, raise it
  upstream rather than overriding it locally.

**Scripts:**

- Sunrise owns the **unprefixed** script names (`dev`, `build`, `test`,
  `validate`, `db:*`, `smoke:*`, `email:*`, …).
- ✅ **Add your app's scripts under an `app:*` namespace** — e.g.
  `app:import`, `app:report`, `app:backfill`. Namespacing guarantees they never
  collide with a script a future Sunrise release adds.
- ❌ **Never edit or remove an existing Sunrise script.** Wrap it from an
  `app:*` script if you need to extend its behavior.

```jsonc
{
  "scripts": {
    "dev": "next dev", // ← Sunrise-owned: leave untouched
    "app:import": "tsx scripts/app/import.ts", // ← yours: app:* namespace
    "app:report": "tsx scripts/app/report.ts",
  },
}
```

Following this convention means `package.json` merges cleanly on every upgrade:
your dependencies and `app:*` scripts sit in regions upstream never edits.

---

## 7. Staying in sync with upstream Sunrise

When you pull a new Sunrise release into your fork, the biggest moving part is
the database migration history — your app's migrations and Sunrise's share one
directory.

- **One shared history.** App and Sunrise migrations both live in
  `prisma/migrations/` and are applied in timestamp order. On an upstream
  merge, new Sunrise migration folders **interleave with yours by timestamp**.
- **Name your migrations distinctly.** Prefix app migrations so you can tell at
  a glance which are yours when they interleave — e.g.
  `db:migrate:dev -- --name app_add_orders`. Prisma applies migrations by
  folder name in lexicographic (timestamp) order regardless of the label, so
  the prefix is purely for human triage.
- **After merging a release:** run `npm run db:migrate:status` to see what's
  pending, then `npm run db:migrate:dev` (dev) / `npm run db:migrate:deploy`
  (prod / CI) to apply the newly-merged Sunrise migrations.
- **Never edit Sunrise's migration SQL.** If you need to adjust the result, add
  your own follow-up migration. Editing an applied migration desyncs every
  environment.
- **Reading a release's migration set:** the migrations a release added are the
  new folders under `prisma/migrations/` — diff against your last-synced point
  with `git diff <last-sync>..<release> -- prisma/migrations/`.

The full reconciliation recipe — including `prisma migrate resolve --applied` /
`--rolled-back` for baselining or recovering a migration, the pgvector
extension requirement, and zero-downtime patterns — lives in
[`.context/database/migrations.md`](./.context/database/migrations.md).

---

## 8. Removing features

**Testing framework:**

- [ ] Delete `tests/` directory
- [ ] Delete `vitest.config.ts`
- [ ] Remove test scripts from `package.json` (`test`, `test:watch`, `test:coverage`)
- [ ] Uninstall: `npm uninstall vitest @vitest/ui happy-dom @testing-library/react @testing-library/user-event`

**Docker:**

- [ ] Delete `Dockerfile`, `Dockerfile.dev`
- [ ] Delete `docker-compose.yml`, `docker-compose.prod.yml`
- [ ] Delete `.dockerignore`
- [ ] Delete `DOCKER-TESTING.md`
- [ ] Remove Docker references from `README.md`

**OAuth providers:**

- [ ] Remove provider configs from `lib/auth/config.ts`
- [ ] Remove env vars from `.env.local` and `.env.example`
- [ ] Remove provider buttons from login page

**Specific pages/features:**

- [ ] Delete route folders you don't need (e.g., `app/(protected)/profile/`)
- [ ] Remove corresponding API endpoints: `app/api/v1/[resource]/`
- [ ] Clean up navigation references

---

## 9. Reference documentation

**Detailed guides:**

- [Architecture Overview](./.context/architecture/overview.md) — System design, component structure
- [Authentication](./.context/auth/overview.md) — better-auth integration, OAuth flows
- [API Endpoints](./.context/api/endpoints.md) — REST API reference, request/response formats
- [Database Schema](./.context/database/schema.md) — Prisma models, relationships
- [Database Migrations](./.context/database/migrations.md) — Migration workflow, upstream sync
- [Environment Variables](./.context/environment/reference.md) — Complete variable reference

**Quick references:**

- Commands: [`.context/commands.md`](./.context/commands.md)
- Substrate (full docs index): [`.context/substrate.md`](./.context/substrate.md)
- Testing: [`.context/testing/overview.md`](./.context/testing/overview.md)
- Deployment: [`.context/deployment/overview.md`](./.context/deployment/overview.md)
  </content>
