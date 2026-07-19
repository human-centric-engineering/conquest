# Planning — historical record

This folder holds the phased build plan and the per-feature trackers (`features/f*.md`)
written **as each feature was built**. They are a record of what was planned and shipped at
the time, not a description of current behaviour.

## Read this before trusting a tracker

> **The `APP_*_ENABLED` feature-flag layer described throughout these trackers no longer
> exists.** The questionnaire product originally dark-launched behind a master flag
> (`APP_QUESTIONNAIRES_ENABLED`) and ~34 sub-flags, stored as `feature_flag` rows. That layer
> was deliberately removed in migration `20260716160000_remove_app_questionnaire_feature_flags`;
> the seed units that created the rows are deleted, and no executable code references those
> flag names. ConQuest routes are gated by `withAdminAuth` alone.
>
> 49 trackers in this folder still describe flag gates. That prose is **history**. Do not
> reintroduce the flag layer, and do not treat "gated by `APP_…_ENABLED`" in a tracker as a
> statement about how the code behaves today. See
> [`../questionnaire/feature-flags.md`](../questionnaire/feature-flags.md) for the removal record.

Trackers may also cite file paths from an earlier directory layout that have since moved or
been renamed. Verify any path against the working tree before relying on it.

For current behaviour, start from [`.context/app/README.md`](../README.md) and the per-domain
pages under [`.context/app/questionnaire/`](../questionnaire/).
