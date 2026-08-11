# Respondent surface config — one row, many projections

**Code:** `lib/app/questionnaire/chat/surface-config.ts` · `lib/app/questionnaire/chat/anonymity.ts`

## The rule

**A respondent page reads a version ONCE.** Every per-version fact the surface needs — its title,
its brand client, and one config switch per affordance — projects off a single `cache()`d row.
Adding a new switch means adding a column to `SURFACE_CONFIG_SELECT` and a projection to
`anonymity.ts`. It must **never** mean a new `prisma.appQuestionnaireVersion.findUnique`.

## Why

The `resolve*ForVersion` helpers are deliberately narrow — each answers one question ("is the mic
on?", "may this surface promise anonymity?") and is independently callable. That is good API shape
and bad query shape: each used to issue its own single-column `findUnique`, so
`/q/[versionId]` fired **15 round trips** per load and grew by one with every config switch shipped.
Concurrency, not latency, was the real cost — the reads run in a `Promise.all`, so the bill lands as
connection-pool pressure under load rather than TTFB.

`cache()` resolves the tension: the helpers keep their narrow signatures and their independence,
but within one request they share one query. No page had to change, and any future surface that
calls several of them gets the collapse for free.

Measured on a branded questionnaire — one load of `/q/[versionId]`, counted from the dev server's
`prisma:query` log (`.next/dev/logs/next-development.log`):

| Read                                   | Before | After |
| -------------------------------------- | ------ | ----- |
| Version title (`resolveVersionHeader`) | 1      | —     |
| Theme (version → `AppDemoClient`)      | 2      | 1     |
| 10 × config switch                     | 10     | —     |
| Glossary (hints + report appendix)     | 2      | 1     |
| Shared surface row                     | —      | 1     |
| Admin preview banner (`?preview=1`)    | +1     | —     |
| **`findUnique` calls**                 | **15** | **3** |
| **SQL SELECTs on `app_*`**             | **33** | **8** |

The SQL count runs ahead of the call count because Prisma emits one SELECT per relation level — a
`findUnique` selecting `questionnaire` and `config` is three statements, and one selecting only
relations spends its parent statement on a bare `SELECT id`.

Two, on an unbranded questionnaire — the `AppDemoClient` lookup only fires when the questionnaire is
attributed, and it is necessarily a second hop (it needs `demoClientId` first).

## What is in the row

`SURFACE_CONFIG_SELECT` carries the surface's **scalar switches only**: `anonymousMode`,
`accessMode`, `voiceEnabled`, `attachmentsEnabled`, `presentationMode`, `answerSlotPanelScope`,
`inlineCorrectionEnabled`, `sessionResumeEnabled`, `showProgressPercentText`, and the four
`reasoningStream*` columns. Plus, from the version row itself, `questionnaireId` / `versionNumber` /
`status` (the admin preview banner) and `questionnaire.{title, demoClientId}`.

It does **not** carry the config's JSON columns (`tone`, `personas`, `personaSelection`,
`interviewerStrategy`, `respondentReport`, `cohortReport`, `intro`, `profileFields`,
`inviteeFields`, `milestoneBannerThresholds`). Those are authored content, not surface behaviour,
and every one of them would be paid for on every respondent page load. When you need them, use
`CONFIG_SELECT` in `app/api/v1/app/questionnaires/_lib/detail.ts` — the admin read view — instead.

## Two things to preserve

**The defaults are not uniform.** The loader returns the row verbatim and normalises nothing,
because each projection applies its own default. `presentationMode` falls back to `both`;
`accessMode` to the safe `invitation_only`; `voiceEnabled`/`attachmentsEnabled` to off;
`inlineCorrectionEnabled`/`sessionResumeEnabled`/`showProgressPercentText` to on. Config is 1:1 and
**lazy** — an absent row means "every default", not "no questionnaire".

**`reasoningStreamEnabled` is three-state, not two.** No config row → defaults (enabled, overlay).
A config row with `reasoningStreamEnabled: false` → `null` (off). That is why
`resolveReasoningPlacementForVersion` tests `version.config` for presence rather than writing
`?? true`. Flattening it silently turns the feature on for every questionnaire that switched it off.

## What is deliberately NOT in the row

**The glossary.** `glossary/resolve.ts` has its own `cache()`d row (`loadGlossaryRow`) selecting all
three gate columns plus the accepted term/definition tree, with each surface's gate applied as a
projection — so hints and the report appendix on one page share one read instead of pulling the tree
twice. It stays separate because that read is **best-effort**: it catches, logs, and degrades to
"no definitions this turn" rather than failing the conversation. A page's primary row must not
inherit a fail-soft contract — a glossary outage would become a blank page.

**Anything session-scoped.** This row is keyed on `versionId`. The authenticated surface reads the
same switches off its session-ownership query and does not call these helpers at all.

The one session-keyed consumer is `session/resolve-respondent-surface.ts`, which serves
`GET …/questionnaire-sessions/:id/surface` for surfaces that boot on the CLIENT and therefore get
no props from a server render (the facilitated-meeting participant — see
`experience-meetings.md`). It obeys the rule rather than bending it: a session→version lookup
first, then `loadVersionSurface` like everyone else. It writes its projections out instead of
calling the nine `resolve*ForVersion` helpers, because it runs in a route handler where `cache()`
memoisation cannot be assumed and nine helper calls could mean nine queries. That second copy of
the fallbacks is pinned field-for-field against the originals by
`tests/unit/lib/app/questionnaire/session/resolve-respondent-surface.test.ts`.

## Tests

- `tests/unit/lib/app/questionnaire/chat/surface-config.test.ts` — the select contract: every
  switch a projection reads is selected, no JSON column is, `null` passes through unnormalised.
- `tests/unit/lib/app/questionnaire/chat/anonymity.test.ts` — each projection's default, including
  the three-state reasoning rule.
- `tests/unit/lib/app/questionnaire/glossary/resolve.test.ts` — that one query shape serves every
  gate, and that the gates stay independent.
