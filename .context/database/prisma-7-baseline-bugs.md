# Prisma 7 baseline-generation bugs

Five reproducible bugs in Prisma 7's `migrate diff --from-empty --to-schema` output, discovered during the 2026-05-29 migration squash and hand-folded into the baseline. This doc is the canonical reference for the workarounds. The same bugs occur for `prisma db push` against an empty database.

Track upstream filing here. None have public issue URLs yet — feel free to file once a clean minimal repro is extracted.

## Quick context

`prisma migrate diff --from-empty --to-schema prisma/schema --script` should emit DDL that recreates the exact deployed schema starting from an empty DB. We use this to consolidate many incremental migrations into a single baseline. The bugs below are cases where the generator's output omits something the Prisma model declared.

The pattern across all five: **the original incremental migration emitted the correct DDL** (because Prisma's per-change generator is well-tested). The `--from-empty` flat-generate path takes a different code path through the engine and loses information that the per-change path preserves.

## Inventory

| Bug ID | Description                                                               | Affected object                                  | Workaround                                                                                                                                                             | Upstream issue                                                          |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| B1     | `@@unique(name: …)` named unique constraint dropped to default-name index | `AiConversation` (`ai_conversation_inbound_key`) | Pin the DB name with `map:` in the schema (fixes baseline gen **and** the per-`migrate dev` phantom RENAME); baseline keeps the `ALTER TABLE ADD CONSTRAINT` hand-fold | [#283](https://github.com/human-centric-engineering/sunrise/issues/283) |
| B2     | NOT NULL omitted on array column with `@default([…])`                     | `AiProviderModel.deploymentProfiles`             | Manual `ALTER COLUMN SET NOT NULL`                                                                                                                                     | (not filed)                                                             |
| B3     | (same shape as B2)                                                        | `AiWebhookSubscription.agentIds`                 | Manual `ALTER COLUMN SET NOT NULL`                                                                                                                                     | (not filed)                                                             |
| B4     | (same shape as B2)                                                        | `AiWebhookSubscription.workflowIds`              | Manual `ALTER COLUMN SET NOT NULL`                                                                                                                                     | (not filed)                                                             |
| B5     | (same shape as B2)                                                        | `AiWebhookSubscription.retryBackoffMs`           | Manual `ALTER COLUMN SET NOT NULL`                                                                                                                                     | (not filed)                                                             |

## B1 — named UNIQUE constraint dropped to default-name UNIQUE INDEX

**The model declares:**

```prisma
model AiConversation {
  // …
  agentId     String
  channel     String?
  fromAddress String?

  @@unique([agentId, channel, fromAddress], name: "ai_conversation_inbound_key", map: "ai_conversation_inbound_key")
}
```

**Prisma 7 generates (without `map:`):**

```sql
CREATE UNIQUE INDEX "ai_conversation_agentId_channel_fromAddress_key"
  ON "ai_conversation" ("agentId", "channel", "fromAddress");
```

The `name:` argument is **ignored for the DB object** — Prisma derives the default name (`<table>_<col1>_<col2>_<col3>_key`). `name:` only ever controlled the _Prisma Client_ compound-key identifier (the `findUnique({ where: { ai_conversation_inbound_key: … } })` accessor), never the database constraint name.

**Why it matters:** unlike B2–B5 this isn't only a baseline-generation issue — it bites every fork on **every `prisma migrate dev`**. Because the deployed object is named `ai_conversation_inbound_key` but the schema-derived name is the default, each diff concludes the object is misnamed and injects a phantom

```sql
ALTER INDEX "ai_conversation_inbound_key" RENAME TO "ai_conversation_agentId_channel_fromAddress_key";
```

into the generated migration — even for migrations that touch unrelated tables. Forks have to hand-strip it (issue #283). The runtime lookup is **not** affected by the DB object's name or kind: `findUnique` resolves the `ai_conversation_inbound_key` accessor from the schema's `name:` (a client-side construct) and emits a plain `WHERE agentId=$1 AND channel=$2 AND fromAddress=$3` — it never looks the constraint up by name. The only real harm is the spurious, repeated migration churn (and, hypothetically, breaking `ON CONFLICT ON CONSTRAINT` — which the codebase does not use).

**Fix (schema):** pin the DB name with `map:` so Prisma's derived name matches the deployed object:

```prisma
@@unique([agentId, channel, fromAddress], name: "ai_conversation_inbound_key", map: "ai_conversation_inbound_key")
```

With `map:` the phantom rename disappears for fresh baselines and for every fork `migrate dev`. Verified empirically: a DB carrying the baseline's `ADD CONSTRAINT` shape diffs to an **empty migration** against the `map:`-pinned schema (Postgres introspects a constraint-backed unique index identically to a plain unique index), so **no migration is required** on existing databases.

**Baseline (unchanged):** the baseline keeps the explicit `ALTER TABLE ADD CONSTRAINT` hand-fold — it is applied history and must not be edited, and it diffs clean against the `map:` schema anyway:

```sql
ALTER TABLE "ai_conversation"
  ADD CONSTRAINT "ai_conversation_inbound_key"
  UNIQUE ("agentId", "channel", "fromAddress");
```

## B2–B5 — NOT NULL omitted on array column with `@default([…])`

**The model declares (B2 example):**

```prisma
model AiProviderModel {
  // …
  deploymentProfiles String[] @default(["hosted"])
}
```

**Prisma 7 baseline-generator emits:**

```sql
ALTER TABLE "ai_provider_model"
  ADD COLUMN "deploymentProfiles" TEXT[] DEFAULT ARRAY['hosted'];
```

The NOT NULL is **missing**. The original incremental migration correctly included `NOT NULL`; the `--from-empty` flat-generate path drops it.

**Why it matters:** A nullable array column changes the semantics — code that reads the field has to handle three states (`null`, empty array, non-empty array) instead of two (empty array, non-empty array). Worse, application code written against the original NOT NULL contract may dereference `null` and crash at runtime.

**Workaround (in baseline):** the `NOT NULL` is added to the column definition by hand:

```sql
"deploymentProfiles" TEXT[] NOT NULL DEFAULT ARRAY['hosted'],
```

The same workaround applies to **B3** (`agentIds`), **B4** (`workflowIds`), and **B5** (`retryBackoffMs`) — all three live on `AiWebhookSubscription` and all three follow the same pattern.

## How to confirm the bugs survive in a future Prisma release

When Prisma releases a new version, re-run the squash audit to see whether any of these still apply:

```bash
# 1. Apply every migration from scratch to a clean reference DB
dropdb sunrise_squash_old && createdb sunrise_squash_old
DATABASE_URL='postgresql://localhost/sunrise_squash_old' npx prisma migrate deploy

# 2. Generate a fresh baseline from the same schema
dropdb sunrise_squash_intent && createdb sunrise_squash_intent
npx prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema \
  --script > /tmp/fresh-baseline.sql

# 3. Apply the fresh baseline to scratch
dropdb sunrise_squash_scratch && createdb sunrise_squash_scratch
psql sunrise_squash_scratch < /tmp/fresh-baseline.sql

# 4. Diff with atlas — any output is a still-present generator bug
atlas schema diff \
  --from postgres://localhost/sunrise_squash_old?sslmode=disable \
  --to   postgres://localhost/sunrise_squash_scratch?sslmode=disable
```

Empty diff (after excluding `_prisma_migrations`) means the bug is fixed and the next baseline regeneration can stop hand-folding it.

## Filing upstream

The reproductions above are minimal: each can be extracted into a tiny `schema.prisma` with the single model and the single bug to demonstrate it without depending on Sunrise. If you file, link the issue here so future contributors can track the fix.

When the upstream fix lands, remove the corresponding `B*` block from this doc and the hand-fold from the baseline (or note in the row that the workaround is no longer needed on Prisma >= X.Y.Z).

## Related

- `prisma/migrations/00000000000000_baseline/migration.sql` — the hand-folded baseline
- `.context/database/prisma-unmodelled-objects.md` — separate A-series doc for objects Prisma cannot model at all (vs the B-series here which Prisma _should_ be able to model but doesn't, due to bugs)
- `.context/database/migrations.md` — migration workflow (general)
