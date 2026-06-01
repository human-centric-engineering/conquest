# Upstream gaps

Forward-looking ledger of places where **Sunrise's public surface doesn't yet
cover an app need**. Each entry is a gap we've identified but not (or not fully)
closed — the seam Sunrise would ideally grow so the app stops working around it.

This is the sibling of two sections in
[`development-plan.md`](./development-plan.md):

- **Decisions log** — choices we've made and why.
- **Carried Sunrise patches** — platform changes we've _already_ made locally,
  awaiting upstream.

An **upstream gap** is the step before a carried patch: a need we've named, with
a proposed fix, that we haven't built yet (and shouldn't work around quietly).
Per the [building-on-Sunrise](../../../CUSTOMIZATION.md) model, a _generic_
missing seam should be **fixed upstream in Sunrise and pulled down**, not forked
in place.

**Lifecycle:** `open` → `raised-upstream` → `in-progress-upstream` → `resolved`
(retired here; may briefly appear in Carried Sunrise patches while the release
catches up).

**Entry template:**

```
### UG-N — <short title>

_Status:_ open · _Opened:_ YYYY-MM-DD · _Surfaced by:_ <feature/task>

**Gap.** What Sunrise doesn't cover.
**Why upstream.** Why it's a platform seam, not app-specific.
**Proposed fix.** The seam we'd add upstream.
**Interim mitigation.** What the app does until then.
**References.** Files / docs.
```

---

### UG-1 — No app-extensible registry for Prisma-unmodelled DB objects

_Status:_ **resolved** ([sunrise#284](https://github.com/human-centric-engineering/sunrise/issues/284) → PR #286, merged to `upstream/main`; pulled into Conquest in the 2026-06-01 sync) · _Opened:_ 2026-06-01 · _Resolved:_ 2026-06-01 · _Surfaced by:_ F0.1 (schema foundations)

**Resolution.** Sunrise added exactly the proposed seam: `lib/db/drift-probes.ts`
(probe types + merge logic) and an app hook `lib/app/db-drift.ts` exporting
`registerAppDriftProbes()`, which `scripts/db/check-drift.ts` now merges into its
probe set. Apps register their own unmodelled objects (FK constraints, custom
indexes) without touching platform files. When the first user-owned link lands in
**F2.1**, register its hand-written FK constraint via this hook instead of carrying
a local patch.

**Gap.** Sunrise's recommended way to relate app data to a user
([`CUSTOMIZATION.md` §5](../../../CUSTOMIZATION.md)) is a **plain-`String` FK with
no Prisma `@relation`** plus a **hand-written FK constraint** in the migration
SQL — because a `@relation` would require a field on the merge-prone `User` model.
That hand-written constraint is invisible to the Prisma schema, which causes three
problems:

1. **`prisma migrate dev` may silently `DROP` it.** Prisma computes the desired DB
   state from the schema; since the schema has no relation for the constraint,
   future `migrate dev` runs treat it as drift and emit a `DROP`. This is the exact
   footgun documented in `scripts/db/check-drift.ts` ("`prisma migrate dev` against
   a schema-folded DB will silently emit DROP statements for them on every
   schema-diff run").
2. **The drift inventory isn't app-extensible.** Sunrise probes its own unmodelled
   objects (pgvector indexes, a GENERATED tsvector column, CHECK constraints,
   partial unique indexes, tsearch config) via a **hardcoded** `DRIFT_OBJECTS`
   array in `scripts/db/check-drift.ts` + the inventory at
   [`../../database/prisma-unmodelled-objects.md`](../../database/prisma-unmodelled-objects.md).
   There is no seam for an app to register _its own_ unmodelled objects, so CI
   won't notice if an app's hand-written FK gets dropped.
3. **The `onDelete` guard can't see it.** The schema-level guard that enforces
   "new `User` relations need an `onDelete` policy" inspects `@relation onDelete`
   only. A plain-scalar FK has no relation, so its policy lives solely in
   hand-written SQL that nothing verifies — risking orphaned rows (silent GDPR
   retention violation) or a broken `eraseUser()` (`P2003`). See
   [`../../privacy/data-erasure.md`](../../privacy/data-erasure.md).

**Why upstream.** This bites _any_ fork that follows Sunrise's own recommended
recipe — it isn't questionnaire-specific. The right fix is a platform seam, not a
per-app workaround (and editing the platform-owned drift script/inventory in the
fork is exactly the fork-and-edit trap the customization model warns against).

**Proposed fix.** An **app-extensible drift-probe registrar**, mirroring the four
existing `lib/app/*` bootstrap seams — e.g. a `lib/app/db-drift.ts` exporting
`registerAppDriftProbes()` that `scripts/db/check-drift.ts` merges into its probe
set. Apps then declare their unmodelled objects (FK constraints, custom indexes)
without touching platform files, and CI probes them alongside the platform's.

**Interim mitigation.** **Avoid scalar `User` FKs until genuinely needed.** F0.1's
anchor models (`AppQuestionnaire`, `AppQuestionnaireVersion`) use only an
**app-internal `@relation` (`onDelete: Cascade`)** — fully Prisma-modeled, clean
drift, no unmodelled object, seen by the `onDelete` guard. The first real
user-owned link lands in **F2.1** (authoring/ownership); when it does, expect to:
register an erasure hook via `lib/privacy/erasure-hooks.ts`, add a local drift
probe, and **carry it as a tracked patch** until this upstream seam exists.

**References.** `CUSTOMIZATION.md` §5 · `scripts/db/check-drift.ts` ·
[`../../database/prisma-unmodelled-objects.md`](../../database/prisma-unmodelled-objects.md)
· [`../../privacy/data-erasure.md`](../../privacy/data-erasure.md) ·
[`features/f0.1.md`](./features/f0.1.md) (Correction #2).

---

### UG-2 — Prisma 7 ignores `@@unique(name:)` → phantom constraint RENAME (B1)

_Status:_ **resolved** ([sunrise#283](https://github.com/human-centric-engineering/sunrise/issues/283) → PR #285, merged to `upstream/main`; pulled into Conquest in the 2026-06-01 sync) · _Opened:_ 2026-06-01 · _Resolved:_ 2026-06-01 · _Surfaced by:_ F0.1 (T0.1.3 init migration)

**Resolution.** Sunrise pinned the DB constraint name with `map:`
(`@@unique([...], name: "ai_conversation_inbound_key", map: "ai_conversation_inbound_key")`)
so Prisma's derived name matches the deployed object — the phantom
`ALTER INDEX … RENAME` no longer appears, and forks stop hand-stripping it on every
`migrate dev`. The baseline migration kept its `ADD CONSTRAINT` hand-fold (the edit
was comment-only; DDL unchanged, diffs empty). Note for already-provisioned DBs:
the comment-only baseline edit changes the migration file's checksum, so databases
that applied the pre-sync baseline carry a stale `_prisma_migrations.checksum` — a
silent drift until the next `migrate dev` flags the baseline as edited. Fix is a
one-row checksum `UPDATE` (data-preserving) or `db:reset` (dev); fresh clones and
CI are unaffected.

**Gap.** Prisma 7's `migrate diff` ignores `@@unique([...], name: "...")` on
`AiConversation`, so every `migrate dev` — even against an in-sync DB — emits a
phantom `ALTER INDEX "ai_conversation_inbound_key" RENAME TO …` that must be
hand-stripped from the generated app migration. The DB is correct; the diff is
wrong (the baseline already documents this as its "B1" note). It sits in the same
family as the inherent schema-fold `DROP`s of platform unmodelled objects
(pgvector indexes, the `searchVector` column) that `migrate dev` also emits —
those aren't a bug (Prisma can't model them; caught by `db:drift-check`), whereas
B1 is a fixable schema-hygiene issue.

**Why upstream.** Hits any fork that runs `migrate dev` to add its own models, and
`scripts/db/check-drift.ts` does not probe the constraint name — so a careless
accept renames the prod constraint that `ON CONFLICT ON CONSTRAINT` relies on.

**Proposed fix.** Pin the DB constraint name with `map:`
(`@@unique([...], name: "ai_conversation_inbound_key", map: "ai_conversation_inbound_key")`)
so Prisma's derived name matches the DB and the phantom rename disappears.

**Interim mitigation.** Generate with `--create-only`, **strip all phantom
DROP/ALTER/RENAME** of platform objects, apply with `migrate deploy`, then
`db:drift-check`. The init migration's schema-shape test guards against re-leak.
Procedure: [`../questionnaire/schema.md`](../questionnaire/schema.md).

**References.** `prisma/migrations/00000000000000_baseline/migration.sql` (B1
comment) · `prisma/schema/orchestration-conversations.prisma` ·
[`../questionnaire/schema.md`](../questionnaire/schema.md) ·
[`features/f0.1.md`](./features/f0.1.md) (Correction #1 / T0.1.3).
