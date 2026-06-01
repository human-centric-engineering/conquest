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

   **Worked example — the ingestion migration (F1.1 / PR1).**
   `20260601144112_app_questionnaire_ingestion` is the canonical demonstration of
   this footgun _and_ of how it can bite mid-apply. `migrate dev` prepended four
   phantom statements: `DROP INDEX` of the three pgvector indexes
   (`idx_ai_knowledge_chunk_search_vector`, `idx_knowledge_embedding`,
   `idx_message_embedding`) and `ALTER … "searchVector" DROP DEFAULT`. Two lessons:
   - **Prisma 7 does not wrap a `migrate dev` apply in a transaction.** The three
     DROPs committed before the ALTER failed (`42601` — `searchVector` is a
     GENERATED column, so `DROP DEFAULT` is invalid). Result: a _partially applied_
     migration — platform indexes really gone, app tables never created, and a
     failed row in `_prisma_migrations`. Do not assume a failed migration rolled
     back; **verify** (`pg_indexes`, `information_schema.columns`).
   - **Recover surgically, not with `db:reset`.** Prisma refuses `migrate reset`
     when invoked by an AI agent, and reset needlessly destroys dev data anyway.
     The clean path: (1) recreate the dropped platform indexes from the
     **baseline** migration's exact DDL (it is their source of truth); (2)
     `prisma migrate resolve --rolled-back <name>`; (3) strip the phantom
     statements from `migration.sql`; (4) `db:migrate:deploy` (applies the SQL
     as-is — unlike `migrate dev`, it does not re-diff and cannot re-introduce the
     phantoms); (5) `db:drift-check`. The committed `migration.sql` carries a
     header naming exactly what was stripped.

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

### Ingestion graph (T1.1.1–T1.1.3 — F1.1 / PR1)

Migration `20260601144112_app_questionnaire_ingestion`. All children cascade from
the version; no `User` FK anywhere (UG-1 — uploader/reverter identity is a plain
`String` set from the session via `logAdminAction`).

- **`AppQuestionnaireVersion`** gains `goal String?` and `audience Json?` (a
  structured `AudienceShape`, exported from `lib/app/questionnaire/types.ts` in
  PR2). They live on the **version**, not `AppQuestionnaire` — the versioning model
  pins them where launch (F3.1) and judges (F5) operate. Plus relations to the three
  new child models below.
- **`AppQuestionnaireSection`** (`app_questionnaire_section`) — a section/group
  within a version. `ordinal`, `title`, `description?`; `@relation` to the version
  `onDelete: Cascade`; `questions AppQuestionSlot[]`; `@@index([versionId])`.
  Extraction provenance lives on the change records, not here.
- **`AppQuestionSlot`** (`app_question_slot`) — one question. Carries a
  **denormalised `versionId`** (F2.2 validates tag+slot share a version) and a
  per-version stable `key` slug: `@@unique([versionId, key])`. Vocabulary:
  `prompt`, `guidelines?`, `rationale?`, `type` (default `free_text`;
  `free_text|single_choice|multi_choice|likert|numeric|date|boolean`), `typeConfig`
  `Json?`, `required`, `weight` (default `1.0`, feeds F4.1), `extractionConfidence?`.
  Cascades through its `section` (no direct version FK). **No `embedding` column —
  deferred to F4.1** (pgvector is a Prisma-unmodelled object with no consumer until
  then). `@@index([versionId])`, `@@index([sectionId])`.
- **`AppQuestionnaireExtractionChange`** (`app_questionnaire_extraction_change`) —
  the revertible audit trail of every editorial decision the extractor made.
  `changeType` (the full deep-spec vocabulary, documented in
  `extraction-changes.md` as the write path lands in PR2–PR4),
  `targetEntityType` (`section|question|version`), `targetEntityId?`, `sourceQuote?`,
  `beforeJson?` (restored on F2.3 revert), `afterJson?` (null for `prune_*`),
  `rationale?`, `confidence?`, `status` (default `applied`), `revertedAt?`,
  `revertedByUserId?` (plain `String`, no FK — UG-1). `@@index([versionId, status])`,
  `@@index([changeType])`.
- **`AppQuestionnaireSourceDocument`** (`app_questionnaire_source_document`) — the
  uploaded doc. `fileName`, `fileHash` (sha256, for F2.4 dedup), `byteSize`,
  `mimeType?`, `pageCount?`, `warnings?`, `extractedText @db.Text` (what extraction
  consumed; F2.3 verifies source quotes against it), `bytes Bytes?` (optional raw
  upload for F2.4 re-parse). `@@index([versionId])`, `@@index([fileHash])`.

_Later phases extend this file — config & invitations (P3), session models (P4),
evaluation links (P5), turns (P6), etc. Each documents its models here as it lands._
