# Anonymous mode — the PII contract (F8.3)

A version-level boolean, `AppQuestionnaireConfig.anonymousMode` (default `false`), governs
whether respondent identity may be **collected, persisted, or surfaced** for that version.
F8.3 hardens the guarantee across every surface that touches session data and adds the
respondent **profile snapshot** (collected only on the non-anonymous surface).

## The invariant

When `anonymousMode = true`, for that version:

- **No identity is persisted that links a session to a person.** Authenticated
  anonymous-direct and no-login sessions bind `respondentUserId = null` / mint a signed
  token; profile fields are never collected.
- **No identity reaches any admin read surface.** Respondent name, the profile snapshot,
  and raw conversational turns are all dropped at the **data boundary** (the loader /
  aggregator), not merely hidden in the UI.
- **Granular analytics that could re-identify a small cohort are withheld** (k-anonymity).

Anonymity is about not linking data to a person — it is **not** about redacting the survey
data itself. Structured answer _values_ are always exported (they're the point of the
export); what's withheld is identity, free-text prose, and small-cohort detail.

## Per-surface gates

| Surface                      | File                                                                                     | Behaviour when `anonymousMode = true`                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Authed-direct session create | `questionnaire-sessions/_lib/create.ts`                                                  | `respondentUserId` bound, but **no profile snapshot** ever written                                |
| No-login session create      | `questionnaire-sessions/_lib/create.ts` (`createAnonymousSession`)                       | `respondentUserId = null`; no profile                                                             |
| Profile capture (form gate)  | `profile/resolve-capture.ts` (`resolveSessionCapture`) + `[id]/profile` PUT              | Resolver returns `null` (no gate) and the PUT rejects — no snapshot ever written (F8.7)           |
| Conversational capture       | `messages/route.ts` (guards on `!anonymousMode`)                                         | No interviewer directive injected, no extraction/snapshot (F8.7)                                  |
| Single-session PDF           | `questionnaire-sessions/_lib/session-export.ts` + `export/build-session-export-model.ts` | Identity query skipped; `respondent` and `profile` null                                           |
| Bulk CSV/JSON export         | `export/results-loader.ts`                                                               | Names skipped; `turns = []`; `profile = null` per session                                         |
| Distributions analytics      | `analytics/distributions.ts`                                                             | Identity-free by construction; small-cohort detail suppressed (below)                             |
| Funnel analytics             | `analytics/funnel.ts`                                                                    | Counts-only; small-cohort counts suppressed                                                       |
| Cost analytics               | `analytics/cost.ts`                                                                      | Per-session spend table dropped (session ids are a re-identification handle)                      |
| Invitations                  | `questionnaires/[id]/invitations/_lib/read.ts`                                           | Orthogonal — invitations are the _invited_ (non-anonymous) surface; an anonymous version has none |

## The profile snapshot rule

`AppRespondentProfileSnapshot` (1:1 with a session) holds the `profileFields` values a
respondent supplied at session start. **Decision D1 — no row, not an empty row:** an
anonymous session writes **no** snapshot at all. Absence is the strongest, most testable
invariant — a test asserts `appRespondentProfileSnapshot.create` was never called, and
there is structurally no PII at rest. Read paths additionally null the profile when
anonymous, as defence in depth.

**As of F8.7** capture no longer happens pre-session. It rides the respondent carousel as a
blocking form gate (default) or is gathered conversationally, and the gate keys off
`anonymousMode` (not authed-vs-public) — so a public no-login link CAN collect a name, while
an anonymous version never does. The invariant above is unchanged (anonymous ⇒ no snapshot,
enforced in the resolver, the PUT, and the workspace). Full mechanics:
[`profile-capture.md`](./profile-capture.md).

## k-anonymity suppression

`K_ANONYMITY_THRESHOLD = 5` (`analytics/privacy.ts`, client-safe so admin panels label it).
Below this many non-preview sessions, granular analytics detail is withheld — a tiny
sample can re-identify an individual answer. Applied at the aggregator:

- **distributions** — per-question `detail` becomes `{ kind: 'suppressed' }`, counts zeroed,
  result `suppressed: true`.
- **funnel** — all stage + anonymous counts zeroed, `suppressed: true`.
- **cost** — the top-spend-session table emptied (`topSessionsSuppressed: true`); aggregate
  spend (total / by-capability / trend) carries no identity and is always returned.

An empty cohort (`0` sessions) is **not** "suppressed" — it genuinely has no data.

### Temporary alpha bypass (dashboard only)

While the product is in the `alpha` release stage (`IS_ALPHA`, driven by the existing
`NEXT_PUBLIC_RELEASE_STAGE`, see `lib/app/release-stage.ts` — **not a separate flag**), the
**analytics-dashboard** aggregators (distributions, funnel, cost) bypass the low-N floor via
`isAnalyticsPanelSuppressed()` (`analytics/privacy.ts`) so the team can see analytics on the tiny
cohorts alpha produces. `ALPHA_ANALYTICS_ANONYMITY_DISABLED` gates it, and the admin analytics view
(`analytics-view.tsx`) shows a visible "disabled for alpha testing" note whenever it is active. This is
**scoped to the dashboard only** — cohort reports (`cohort-report/dataset.ts`), safeguarding alerts
(`analytics/safeguarding.ts`), the data-slot material floor, and the version's explicit
**anonymous-mode** session-table suppression all still enforce k-anonymity via `isCohortSuppressed()`.
It **auto-restores** the moment the stage moves off `alpha` — no code change is needed for GA. The same
`alpha` stage also gates the alpha **session-ref browser** (`/admin/questionnaires/sessions`).

## Erasure

`AppRespondentProfileSnapshot` is the **first** questionnaire model with a modelled `User`
FK (the deferred-UG-1 "plain String, no relation" posture is deliberately broken because
this row IS personal data). Both FKs declare `onDelete: Cascade`: the session FK (owned
data) and the user FK (personal data). The user cascade means `eraseUser()`'s
`prisma.user.delete()` removes the snapshot natively — **no erasure hook needed**. See
[`../../privacy/data-erasure.md`](../../privacy/data-erasure.md).
