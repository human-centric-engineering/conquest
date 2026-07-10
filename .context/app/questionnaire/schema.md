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
  - **F2.1 / P2** adds `goalProvenance String?` and `audienceProvenance Json?`
    (migration `20260602144835_app_questionnaire_version_provenance`) — the
    persisted admin-wins-per-field merge outcome (`FieldProvenance` /
    `AudienceProvenance` in `types.ts`). The admin read surface reads them to mark
    AI-inferred values rather than re-deriving from the change log. Same
    schema-fold footgun as the ingestion migration: `migrate dev` re-emitted the
    three pgvector `DROP INDEX` + the `searchVector` ALTER; stripped by hand, only
    the one app `ALTER TABLE` kept (the migration header names what was removed,
    and the schema-shape test guards it).
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
  `typeConfig` is opaque at the DB layer but pinned per type by
  `authoring/type-config-schema.ts`. A **`likert`** carries `{ min, max }` plus labels
  one of two faithful ways: **either** a complete `labels` array — one non-empty entry
  per scale point (`labels[i]` ⇒ value `min+i`), which the report and analytics render
  instead of a bare number — **or** just both endpoint labels `minLabel`/`maxLabel`, for
  a scale the source anchors only at its ends ("1 — Not at all … 5 — Very much"), where
  inventing middle words would be unfaithful. One of the two is **required at the write
  boundary** (`validateTypeConfig`) and at launch (the `scaleLabels` readiness check via
  `isLikertLabelled`): a fully _unlabelled_ rating with no qualitative meaning must use
  `numeric`. The read schema stays lenient so pre-backfill rows (legacy `minLabel`/
  `maxLabel`, or bounds-only) still validate answers; `npm run db:backfill:likert-labels`
  LLM-fills missing labels (or reclassifies a numeric scale). `hasCompleteLikertLabels()`
  is the stricter "every point named?" predicate (the report needs it to map each value
  to a word); `isLikertLabelled()` is the looser launch/save predicate (full labels **or**
  endpoints).
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

### Tagging (F2.2)

Migration `…_app_question_tags`. Two version-scoped, all-cascade models (no `User`
FK — UG-1). The vocabulary forks with the version (the fork writer copies tags and
re-links assignments through the slot id-map).

- **`AppQuestionTag`** (`app_question_tag`) — one tag in a version's vocabulary.
  `label` (display), `normalizedLabel` (trim + collapse-whitespace + lowercase — the
  case-insensitive dedup key), `color?` (a `TAG_COLORS` allowlist value, `types.ts`).
  `@relation` to the version `onDelete: Cascade`; `slots AppQuestionSlotTag[]`.
  `@@unique([versionId, normalizedLabel])`, `@@index([versionId])`.
- **`AppQuestionSlotTag`** (`app_question_slot_tag`) — the M:N join assigning a tag
  to a question. `questionSlotId`, `tagId`; both `@relation`s `onDelete: Cascade`.
  `@@unique([questionSlotId, tagId])`, `@@index` on each FK. **The tag+slot
  same-version invariant is enforced in the application layer** (the assignment route
  validates every tag id against the question's version before writing) — the
  denormalised `AppQuestionSlot.versionId` exists for exactly this check; no DB
  constraint spans the two tables' versions.

### Demo-client foundation (F2.5.1 — P2.5) · DEMO-ONLY

Migration `20260603081129_app_demo_client`. **Identity only** — an attribution +
branding partition, **not** a security boundary (full rationale + fork paths in
[`demo-clients.md`](./demo-clients.md)). Same schema-fold footgun as the ingestion
migration: `migrate dev` re-emitted the three pgvector `DROP INDEX` + the
`searchVector` ALTER; created with `--create-only`, stripped by hand, applied via
`db:migrate:deploy`. The migration header names what was removed; the schema-shape
test guards it.

- **`AppDemoClient`** (`app_demo_client`) — `slug` (`@unique`, kebab-case), `name`,
  `description?`, `isActive` (default `true`), timestamps;
  `questionnaires AppQuestionnaire[]` reverse relation (powers the list count + the
  delete guard). **No `User` FK** (global admin-managed fixture). **F3.4** added the
  nullable theme columns (`ctaColor`, `accentColor`, `logoUrl`, `welcomeCopy`) — their
  first renderer is the invitation email; null on any field → the Sunrise default
  (`resolveTheme()`). It also added the `invitations AppQuestionnaireInvitation[]`
  reverse relation (the brand-snapshot back-reference).
- **`AppQuestionnaire`** gains `demoClientId String?` + `demoClient` relation with
  **`onDelete: SetNull`** (a questionnaire outlives its demo client — attribution
  clears) and `@@index([demoClientId])`. `null` = generic Sunrise demo; no backfill.
  The admin `DELETE /demo-clients/:id` still refuses (409) while attributed — the
  SetNull is the schema-honest backstop, the 409-guard is the UX.

### Configuration (F3.1 — P3)

Migration `20260604090526_app_questionnaire_config`. Same schema-fold footgun as the
ingestion/demo-client migrations: `migrate dev` re-emitted the three pgvector
`DROP INDEX` + the `searchVector` ALTER; stripped by hand and applied via
`db:migrate:deploy`. The migration header names what was removed; the schema-shape
test guards it. Full behaviour in [`configuration.md`](./configuration.md).

- **`AppQuestionnaireConfig`** (`app_questionnaire_config`) — the per-version
  run-time configuration, **1:1 with the version** (`versionId @unique`,
  `@relation onDelete: Cascade`) so it **forks with the version** (the fork writer
  copies the row when present). Typed columns per setting — `selectionStrategy`,
  `minQuestionsAnswered`, `coverageThreshold`, `costBudgetUsd?`,
  `maxQuestionsPerSession?`, `voiceEnabled`, `contradictionMode`,
  `contradictionWindowN`, `anonymousMode` — plus `profileFields Json @default("[]")`
  (an ordered `ProfileFieldConfig[]`, not a relational model). **No `User` FK**
  (UG-1). **Lazy**: no row until the admin first saves; reads resolve an absent row
  to `DEFAULT_QUESTIONNAIRE_CONFIG`, and the launch gate keys on whether the row
  exists. `AppQuestionnaireVersion` gains the reverse `config AppQuestionnaireConfig?`.

### Invitations + branding (F3.2 / F3.4 — P3)

- **`AppQuestionnaireInvitation`** (`app_questionnaire_invitation`, F3.2) — one row per
  invited respondent, **pinned to the launched version** (`versionId` FK,
  `onDelete: Cascade`). `tokenHash @unique` (SHA-256 at rest), `status` lifecycle,
  plain-`String` `userId?`/`invitedByUserId` (UG-1, no relation). Indexes on
  `versionId`, `status`, `email`, `userId`. Full behaviour in [`invitations.md`](./invitations.md).
- **F3.4** (migration `20260604144743_app_questionnaire_invitation_branding`, same
  schema-fold strip as the others) added: the four nullable `AppDemoClient` theme
  columns (above) **and** `AppQuestionnaireInvitation.demoClientId String?` — a
  `DEMO-ONLY` brand snapshot with a real `demoClient` relation (`onDelete: SetNull`,
  `@@index([demoClientId])`) plus the matching `AppDemoClient.invitations` reverse
  relation. `null` = generic Sunrise theme; the snapshot points at the client directly
  so reattribution doesn't change a sent invitation's brand.

### Session + answers (F4.4 / F4.6 — P4)

- **`AppQuestionnaireSession`** (F4.4, migration
  `20260605091327_app_answer_slot_refinement`) — a respondent's run over a version:
  `versionId` (FK `onDelete: Cascade`), `status` (default `active`), `isPreview`,
  `respondentUserId String?` (plain String, UG-1; null until F6.1 binds real
  respondents), timestamps. A raw-SQL **partial unique index**
  (`idx_app_questionnaire_session_preview_per_version`, migration
  `20260605141500_app_session_preview_unique`, `WHERE "isPreview" = true`) enforces at
  most one preview session per version — Prisma can't model partial uniques, so it's
  invisible in the schema and guarded by a drift probe (`lib/app/db-drift.ts`). Author
  future migrations on this table with `--create-only` and strip any phantom DROP of it.
  Later additive columns: `abuseStrikes` (seriousness gate), `sensitivityLevel?` +
  `sensitivityNotes` (safeguarding memory), and `pendingContradiction Json?` (migration
  `20260617130000_app_session_pending_contradiction`) — the `probe`-mode contradiction parked
  across two turns for the confirm-before-overwrite flow (null = none pending; see
  [contradiction-detection.md](./contradiction-detection.md#probe-confirm-flow-probe-mode)).
- **`AppAnswerSlot`** (F4.4, same migration) — one captured answer per `(sessionId,
questionSlotId)` (the upsert unique), with `value Json`, `provenanceLabel`,
  `confidence?`, `refinementHistory Json` (default `[]`), and `lastUpdatedTurnId String?`
  (the F6.1 turn-loop seam; null until the live loop exists). Both FKs
  `onDelete: Cascade`.
- **`AppQuestionnaireSessionEvent`** (F4.6, migration
  `20260605141717_app_session_event`) — the append-only lifecycle audit trail. One row
  per recorded event: `sessionId` (FK `onDelete: Cascade` — events follow the session),
  `eventType` (plain String validated against `SESSION_EVENT_TYPES`), `fromStatus?` /
  `toStatus?` (both null for `cost_cap_reached`; `fromStatus` null for `created`),
  `reason?`, `metadata Json?`, `createdAt`. Indexed `@@index([sessionId])` and
  `@@index([sessionId, createdAt])`. Fully Prisma-modelled — no raw-SQL object, so no
  drift probe. The migration was hand-stripped of the usual phantom pgvector DROPs (the
  header names them; the schema-shape test guards the strip). F4.6 also adds `paused` to
  `SESSION_STATUSES` (additive tuple edit, no migration — `status` is a plain String
  column). See [`session-state-machine.md`](./session-state-machine.md).
- **`AppQuestionnaireTurn`** (F6.1, migration `20260606062423_app_questionnaire_turn`) —
  one persisted respondent turn over a live session. `sessionId` (FK `onDelete: Cascade` —
  turns follow the session), `ordinal` (1-based, derived `count+1` in the write
  transaction; **no `@@unique`** — a unique can throw under a retried turn, rare gaps are
  acceptable), `userMessage`/`agentResponse` (`@db.Text`), `targetedQuestionId String?`
  (plain String, no FK — symmetry with the JSON id array + UG-1 house style),
  `toolCalls Json` + `sideEffectAnswerIds Json` (read wholesale), `costUsd Float?`,
  `idempotencyKey String?` (F7.x retry — the send attempt's key, reused across its retries so
  a turn already persisted under it is replayed, not duplicated; migration
  `20260625082600_app_turn_idempotency_key`), `createdAt`. Indexed `@@index([sessionId])` and
  `@@index([sessionId, ordinal])`, plus `@@unique([sessionId, idempotencyKey])` — the retry
  dedup guard (NULLs stay distinct under Postgres, so the many key-less turns per session still
  coexist; the **`ordinal`** column deliberately stays un-uniqued, as above). The `recordTurn`
  seam writes a turn AND back-stamps `AppAnswerSlot.lastUpdatedTurnId` on the answers it
  touched, in one transaction — the seam that finally fires that column; on the unique-race it
  resolves to the winner's row rather than throwing. Both migrations hand-stripped of the
  phantom pgvector DROPs (schema-shape test guards the strip). See
  [`per-turn-orchestrator.md`](./per-turn-orchestrator.md).

### Respondent profile snapshot (F8.3 — P8)

- **`AppRespondentProfileSnapshot`** (F8.3, migration
  `20260609062611_app_respondent_profile_snapshot`) — the `profileFields` values a
  respondent supplied at session start, 1:1 with a session (`sessionId @unique`). `values
Json` (keyed by field `key`), `respondentUserId String?` denormalised from the session.
  **The first questionnaire model with a modelled `User` FK** — the deferred-UG-1
  "plain String, no `@relation`" posture is deliberately broken because this row IS personal
  data and must cascade on erasure. Both FKs `onDelete: Cascade`: the session FK (owned
  data) and the user FK (so `eraseUser()` removes it natively, no hook). **Never written for
  an anonymous session** (no row, not an empty row). Migration hand-stripped of the phantom
  pgvector DROPs (schema-shape test guards the strip + asserts both cascades). See
  [`anonymous-mode.md`](./anonymous-mode.md).

_Later phases extend this file. Each documents its models here as it lands._
