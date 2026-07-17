# Questionnaire feature flags — removed (features permanently on)

> **Status: removed as of 2026-07.** The questionnaire product no longer has any
> per-feature flags. Every questionnaire capability is **always on**. This file is
> kept as a historical pointer; there is nothing to toggle.

## What changed

The questionnaire product originally dark-launched behind a master flag
(`APP_QUESTIONNAIRES_ENABLED`) and ~34 sub-flags (`APP_QUESTIONNAIRES_*_ENABLED`,
`APP_REPORT_FORMATTER_ENABLED`), stored as `feature_flag` rows. That layer has been
deleted:

- The resolver module `lib/app/questionnaire/feature-flag.ts` and the `APP_*_FLAG`
  name constants in `lib/app/questionnaire/constants.ts` are gone.
- Every route gate (`with*Enabled` / `ensure*Enabled`) and page gate (`is*Enabled`,
  `resolveQuestionnaireWorkspaceFlags`) was unwound — routes/pages no longer 404 or
  `notFound()` on a flag.
- The 35 seed units under `prisma/seeds/app-questionnaire/*-flag.ts` were deleted, so
  new environments never create the rows.
- Migration `20260716160000_remove_app_questionnaire_feature_flags` deletes the
  orphaned `APP_*` rows from existing environments (prefix-scoped; cannot touch
  `MAINTENANCE_MODE`).

Per-feature behaviour that used to be gated by a **sub-flag** is now governed solely by
each version's own **config toggles** (e.g. `respondentReport.enabled`,
`research.enabled`, `reasoningStreamEnabled`, `personaSelection.enabled`, cost budget) —
the version author's opt-ins, which were always the second half of the old gate.

## What remains

The only runtime toggle left in the system is site-wide **maintenance mode**
(`MAINTENANCE_MODE`), served by the generic Sunrise flag infrastructure — see
[`.context/admin/feature-flags.md`](../../admin/feature-flags.md). To gate a _new_
questionnaire feature in future, add a flag deliberately at that time; the default is
"ship it on".
