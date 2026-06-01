# Questionnaire — schema

> Records the app schema's location, conventions, and migration workflow. The
> per-model reference grows as each phase adds its models; the anchor
> (`AppQuestionnaire` + `AppQuestionnaireVersion`) landed in
> [F0.1 / T0.1.3](../planning/features/f0.1.md).

## Location

App models live in a **dedicated** file: `prisma/schema/app-questionnaire.prisma`.

Prisma 7's multi-file schema picks up every `.prisma` file in `prisma/schema/`.
The platform's own `app.prisma` already holds platform models (`ContactSubmission`,
`FeatureFlag`, `AuthBootstrap`), so the questionnaire schema is kept in its own
file to stay clearly separate and conflict-free on upstream syncs.

## Conventions

- **`App…` prefix** on every model; **`@@map("app_…")`** (snake_case) table names.
- **App-internal relations** use a normal Prisma `@relation` with an explicit
  **`onDelete`** — these are fully modeled, seen by the schema-level `onDelete`
  guard, and create no drift.
- **`User` foreign keys are deferred.** The plain-`String`-FK recipe
  (`CUSTOMIZATION.md` §5) creates a Prisma-unmodelled object with real maintenance
  cost; nothing in early phases needs user ownership, so we don't add one until
  it's genuinely required (F2.1). See
  [`../planning/upstream-gaps.md`](../planning/upstream-gaps.md) (UG-1) before
  adding the first `User` FK.
- **`onDelete` policy is mandatory** on any new `User` relation
  (`Cascade` for personal data, `SetNull` for retained config/audit). Account
  deletion routes through `eraseUser()` — never `prisma.user.delete()`. See
  [`../../privacy/data-erasure.md`](../../privacy/data-erasure.md).

## Migration workflow (and the schema-fold footgun)

1. Edit `prisma/schema/app-questionnaire.prisma`.
2. `npm run db:migrate:dev -- --name app_<change>` (app migrations are
   prefixed so they're easy to spot when they interleave with upstream's by
   timestamp).
3. **Review the generated `migration.sql` and strip every statement that isn't
   yours.** Prisma 7's diff emits _phantom_ DDL against platform objects on every
   `migrate dev` run — the database is correct; the diff is wrong. Delete all of
   it (DROP / ALTER / **RENAME**), keeping only your intended `CREATE`/`ALTER`.
   Two known classes:
   - **A-series — DROP/ALTER of objects Prisma can't model**: the pgvector
     GIN/HNSW indexes, the `GENERATED` `searchVector` column, CHECK constraints,
     partial unique indexes. Inventory: `scripts/db/check-drift.ts` +
     [`../../database/prisma-unmodelled-objects.md`](../../database/prisma-unmodelled-objects.md)
     (probed by `db:drift-check`).
   - **B1 — a RENAME of a fully-modelled unique constraint**, e.g.
     `ALTER INDEX "ai_conversation_inbound_key" RENAME TO …`. Prisma 7's
     `migrate diff` ignores `@@unique(name:)`, so it perpetually wants to rename a
     constraint the baseline deliberately created (see the `B1` comment in
     `prisma/migrations/00000000000000_baseline/migration.sql`). Not covered by
     `db:drift-check` — catch it here, by eye.

   The init migration (`20260601095814_app_questionnaire_init`) was trimmed of all
   of the above; its schema-shape test guards against any of it leaking back in.

4. `npm run db:drift-check` → all platform probes must still pass.
5. `npm run db:generate` (also runs on `postinstall`) to refresh the client.

Full reconciliation / upstream-sync recipe:
[`../../database/migrations.md`](../../database/migrations.md).

## Schema-shape test

Model shape is asserted in a fast unit test via **`Prisma.dmmf`** (no DB needed):
model presence, fields, `@@index` / `@@unique`, relation `onDelete`, and `@@map`
names. Live FK integrity is covered by `npm run db:drift-check` and CI's
`migrate deploy` job, so no `information_schema` test is required at this stage.

## Models

### Anchor (T0.1.3)

- **`AppQuestionnaire`** (`app_questionnaire`) — the root. `id`, `title`,
  `status` (`draft` default), timestamps; `versions AppQuestionnaireVersion[]`.
  _No `User` FK yet_ (see above).
- **`AppQuestionnaireVersion`** (`app_questionnaire_version`) — a version of a
  questionnaire. `@relation` to `AppQuestionnaire` with `onDelete: Cascade`;
  `versionNumber`, `status`, timestamps; `@@unique([questionnaireId,
versionNumber])`, `@@index([questionnaireId])`.

_Later phases extend this file — ingestion graph (P1), config & invitations (P3),
session models (P4), evaluation links (P5), turns (P6), etc. Each documents its
models here as it lands._
