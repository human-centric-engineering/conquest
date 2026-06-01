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

_Status:_ open · _Opened:_ 2026-06-01 · _Surfaced by:_ F0.1 (schema foundations)

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
