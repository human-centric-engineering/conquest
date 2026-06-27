# Cohorts & Rounds

> Gated by the `APP_QUESTIONNAIRES_COHORTS` feature flag (a `feature_flag` DB row, seeded
> disabled by `prisma/seeds/app-questionnaire/047-cohorts-flag.ts`). Opt-in on top of
> `APP_QUESTIONNAIRES_ENABLED`. When off: the admin routes/tabs `404`/hide and the respondent
> access guard is inert (no session ever carries a `roundId`).

## What it is

A **cohort** is a named group of people (e.g. a team) that belongs to a [demo client](./demo-clients.md).
A **round** is a **time-bound** delivery of one or more questionnaires to a cohort.

The cardinal rule: **a round is the only way to make a questionnaire time-bound.** A session
started outside a round carries no `roundId` and stays open-ended — exactly today's behaviour,
untouched. The round's window (`opensAt`/`closesAt`, adjustable mid-round) plus its `status`
(`draft → open → closed`, with a manual admin close) are what gate respondent access.

A person (by email) may belong to **multiple cohorts** under the same demo client — membership is
per-cohort, with no global email uniqueness, so cohorts freely overlap.

> **Analytics scoping:** the questionnaire [Analytics](../admin/questionnaire-analytics.md) surface
> can be **scoped to a round** (`?roundId=`) — distributions, funnel, cost, and safeguarding all
> filter to one round's sessions, so a cohort's run is analysed in isolation rather than blended with
> another cohort's round on the same questionnaire. A generated **cross-respondent Cohort Report**
> (`cohort` report kind) — a single narrative over a whole round — remains a later stage with its
> own flag; this phase ships the per-round scoping + completion counts.

## Data model

All in `prisma/schema/app-questionnaire.prisma`. The cohort/round **internal** graph uses real
cascading relations; the **session linkage** columns are plain `String` (no `@relation`) — the
same deliberate UG-1 posture as `invitationId`, because they are identity↔answer pointers that
must never become a cascading graph edge.

| Model                         | Key fields                                                                                                         | Notes                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `AppCohort`                   | `demoClientId` (FK Cascade), `name`, `description?`, `createdBy?`                                                  | A cohort belongs to one demo client.                                                                                              |
| `AppCohortMember`             | `cohortId` (FK Cascade), `email`, `name`, `status` (active\|removed), `removedAt?`                                 | `@@unique([cohortId, email])` → multi-cohort membership. Roster identity, NOT a login.                                            |
| `AppQuestionnaireRound`       | `cohortId` (FK Cascade), `name`, `status` (draft\|open\|closed), `opensAt?`, `closesAt?`, `closedAt?`, `closedBy?` | Window adjustable mid-round; manual close stamps `closedAt`/`closedBy`.                                                           |
| `AppQuestionnaireRoundItem`   | `roundId` (FK Cascade), `questionnaireId` (FK Cascade), `versionId?`                                               | M:N — a round bundles **distinct** questionnaires; `versionId` optionally pins a version. `@@unique([roundId, questionnaireId])`. |
| `AppCohortSubgroup`           | `cohortId` (FK Cascade), `name`, `description?`, `ordinal`, `createdBy?`                                           | Reusable roster partition for [round phasing](#round-phases-staggered-subgroups). `@@unique([cohortId, name])`.                   |
| `AppRoundPhase`               | `roundId` (FK Cascade), `subgroupId` (FK Cascade), `opensAt?`, `closesAt?`, `endMode` (hard\|relaxed), `ordinal`   | A subgroup's staggered window on a round. `@@unique([roundId, subgroupId])`.                                                      |
| `AppCohortMember` (+)         | `subgroupId?` (FK SetNull)                                                                                         | A member belongs to 0–1 subgroup of their cohort.                                                                                 |
| `AppQuestionnaireSession` (+) | `roundId?` (plain String), `cohortMemberId?` (plain String), `cohortSubgroupId?` (plain String)                    | Null = open-ended. Pointers for access enforcement + per-round / per-member / per-phase stats.                                    |

Member **removal is soft**: `status: removed` + `removedAt` is stamped, the row is kept, so any
session pointing back to it survives. Status — not deletion — drives access.

## Status vocabularies (single source)

`lib/app/questionnaire/rounds/types.ts`: `COHORT_MEMBER_STATUSES`, `ROUND_STATUSES`. The schema
`status` column, the Zod enums, and any UI badge all derive from these tuples (validated at the
boundary with `narrowToEnum`, the house style).

## The access guard

Pure core: `lib/app/questionnaire/rounds/access.ts` → `evaluateRoundAccess(subject)` returns a
typed verdict (`{ ok } | { ok:false, status, code, message }`). Order of denial (most structural
first):

1. `QUESTIONNAIRE_NOT_IN_ROUND` (409) — the session's questionnaire isn't bundled in the round.
2. `ROUND_NOT_OPEN` (409) — status not `open`, or now is before `opensAt`.
3. `ROUND_WINDOW_CLOSED` (409) — now is after `closesAt`, **even if status is still `open`** (the
   window is the time-bound, independent of the flag).
4. `PHASE_NOT_YET_OPEN` / `PHASE_WINDOW_CLOSED` (409) — when the member has a [round phase](#round-phases-staggered-subgroups),
   the check runs against their EFFECTIVE window (round, narrowed by the phase); a phase-scoped denial
   gets its own code/message ("your group opens later"). No phase → the round-level codes above.
5. `COHORT_MEMBER_REMOVED` (403) — the (known) member is removed.

DB-loading wrapper: `app/api/v1/app/questionnaire-sessions/_lib/round-access.ts` →
`assertRoundAccess({ roundId, cohortMemberId, versionId, onMissingRound })`. It loads the round +
(optional) member + whether the version's questionnaire is bundled, then delegates. A member from
a **different cohort** than the round's, or a missing member, is treated as removed.
`onMissingRound` differs by phase: `deny` at **create** (a bad reference → 404 `ROUND_NOT_FOUND`),
`allow` at **continue** (a since-deleted round simply stops gating; the session keeps its history).

### Where it's enforced

| Phase               | Seam                                                                   | Behaviour on denial                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start               | `questionnaire-sessions/_lib/create.ts` (the two invitation creators)  | Round context comes from the invitation row (not the request). Returns the verdict; mints no session. Persists `roundId`/`cohortMemberId` when allowed.                                                                                            |
| Continue (per turn) | `questionnaire-sessions/[id]/messages/route.ts`, after the status gate | Round-level denial **auto-pauses** the session (`pauseSession(reason:'round_closed')`, mirroring the cost-cap precedent — the status gate then 409s every later turn); a removed member is 403 **without** pausing, so re-adding lets them resume. |
| Resume              | `questionnaire-sessions/[id]/lifecycle/route.ts`                       | A closed round / removed member can't be re-entered.                                                                                                                                                                                               |

`buildTurnContext` (`questionnaires/_lib/turn-context.ts`) now exposes `roundId`/`cohortMemberId`
so the continue gate reads them without a second query. Resume is **round-scoped**:
`findResumableSession*` (`chat/resumable-session.ts`) filters on `roundId ?? null`, so a closed
round can't resume a stale session and two rounds keep separate sessions.

### The grant mechanism — per-member round invitations

A session's round context is **server-trusted, not client-supplied**: it is stamped on the
respondent's **invitation** and the session inherits it from there, so round membership can't be
forged. `AppQuestionnaireInvitation` carries `roundId` + `cohortMemberId` (plain String, UG-1);
`createSessionFromInvitation` / `createSessionFromInviteToken` read the round context off the
resolved invitation row (`roundContextOf`) — the session-create request bodies accept **no** round
fields. A walk-up (`createSessionForVersion`) or public (`createAnonymousSession`) start is never
round-bound (no cohort member to bind to) — a round is delivered to known people via invitations.

`POST /api/v1/app/rounds/:id/invitations` (`rounds/_lib/invites.ts` → `generateRoundInvitations`)
mints one invitation per **active** member × per bundled questionnaire-version (resolving each
item's pinned version, or the questionnaire's current launched version), stamping the round,
member, and the cohort's demo client, and pinning the token expiry to each member's EFFECTIVE close
(their [phase](#round-phases-staggered-subgroups)'s hard close when staggered, else the round's
`closesAt`). It reuses the existing invitation token machinery and the frictionless
`/q/[versionId]?i=<token>` link shape, so a round link flows through the same no-login session path —
it just additionally carries the round binding. Idempotent: a member already invited for a (version,
round) pair is skipped, so re-running tops up newly added members. An optional `{ send: true }` body
(or the per-phase send action) also **emails** each freshly-minted link (frictionless URL) and flips
it `pending → sent`; omitted, it mints copy/paste links only.

## Round phases (staggered subgroups)

> Gated by `APP_QUESTIONNAIRES_ROUND_PHASES_ENABLED` (sub-flag of cohorts, seed `053`,
> `isRoundPhasesEnabled` / `withRoundPhasesEnabled`). Off → the subgroup/phase surfaces 404/hide and
> the access guard uses the round window for everyone (today's behaviour). See [F13.3](../planning/features/f13.3.md).

A round can stagger access by cohort **subgroup** so one group (e.g. the Senior Leadership Team) goes
before the rest — for a pilot ahead of a wider rollout, or to SEED [Learning Mode](./round-context-and-learning.md)
for those who follow (the digest is round-scoped and rebuilds on each completion, so the early phase
naturally feeds later ones — no extra wiring).

- **`AppCohortSubgroup`** — a reusable named partition of the cohort's roster, defined once and
  carried across rounds. **`AppCohortMember.subgroupId`** (FK `onDelete: SetNull`) assigns a member to
  0–1 subgroup. **`AppRoundPhase`** (`@@unique([roundId, subgroupId])`) attaches a window + `endMode`
  (`hard | relaxed`) to a subgroup on one round. **`AppQuestionnaireSession.cohortSubgroupId`** is the
  per-session snapshot (plain String, UG-1) that drives per-phase stats without a member join.
- **Effective window** — `resolveEffectiveWindow(round, phase)` (`rounds/phases.ts`): the phase OPEN
  always applies (staggering the start is the point); the phase CLOSE applies only under `hard` end
  mode — `relaxed` defers to the round close (the phase close is then just a notification target). No
  phase → the round window unchanged. Phase windows must **nest** inside the round window
  (`validatePhaseWindowNesting`, enforced at the admin seam).
- **Enforcement** — `assertRoundAccess` loads the member's subgroup + its phase (flag-gated) and
  passes it to `evaluateRoundAccess`; same start/continue/resume seams as the round window.
- **Staggered send** — round invites store only a token hash, so "sending" is folded into generation:
  `generateRoundInvitations(roundId, by, { subgroupId, send })` emails just that subgroup's
  freshly-minted links. Per-phase **"Send invites"** → `POST …/rounds/:id/phases/:phaseId/send-invites`.
  Auto-stagger: `dispatchDuePhaseInvitations` (every open phase whose window has opened, idempotent) via
  the app-owned `POST /api/v1/app/rounds/maintenance/dispatch-phase-invites` — point a scheduled
  workflow (`AiWorkflowSchedule` cron) or external cron at it; it does **not** fork the platform tick.
- **Stats** — `sessionCountsBySubgroup` (one grouped query, keyed by the session snapshot) → per-phase
  started/completed/rate on `RoundPhaseView`, shown in the admin Phases panel.

Subgroup CRUD: `/api/v1/app/cohorts/:id/subgroups[/:subgroupId]`; member assignment via member PATCH
(`{ subgroupId }`, validated same-cohort). Phase CRUD: `/api/v1/app/rounds/:id/phases[/:phaseId]`.
Admin: a **Subgroups** panel on the cohort page (+ a per-member subgroup selector on the roster) and a
**Phases** panel on the round page.

## Admin surface

Two flag-gated tabs are appended to the [demo-client detail](./demo-clients.md) sub-nav
(`demoClientTabs({ cohortsEnabled })` in `demo-clients/nav.ts`):

- **Cohorts** (`/admin/demo-clients/[id]/cohorts`) — searchable table (members, rounds, completion
  rate). Drill-in: roster management (add / soft-remove / reactivate) + the cohort's rounds.
- **Rounds** (`/admin/demo-clients/[id]/rounds`) — searchable table across the client's cohorts
  (status, window, members, started/completed, completion rate), with a manual **Close** action.
  Drill-in: bundled questionnaires (attach/detach), editable window, close/reopen.

The **round detail** page is a long, flag-gated single scroll (Bundled questionnaires · Phases ·
Additional context · Learning mode · Cohort report · Member invitations). On wide screens a sticky
scroll-spy rail (`components/admin/section-rail.tsx`, shared with the questionnaire
[settings panel](./configuration.md#ui)) sits beside it for wayfinding — each `<section>` carries
`id` + `data-section-rail` + `data-section-label`, and the rail lists those inside
`#round-sections`, so sections appear in the rail exactly when their flag renders them. The
demo-client tab bar itself stays a flat single tier — only 4–6 tabs, no secondary nav needed.

## API

Admin, `withAdminAuth`, flag-gated (404 when off). Registry: `API.APP.COHORTS`, `API.APP.ROUNDS`.

| Route                                             | Verb             | Purpose                                                                    |
| ------------------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `/api/v1/app/cohorts?demoClientId=&q=`            | GET/POST         | List (enriched) / create.                                                  |
| `/api/v1/app/cohorts/:id`                         | GET/PATCH/DELETE | Detail (with roster) / edit / delete (cascades).                           |
| `/api/v1/app/cohorts/:id/members`                 | GET/POST         | Roster / add (409 on duplicate email).                                     |
| `/api/v1/app/cohorts/:id/members/:memberId`       | PATCH/DELETE     | Edit / reactivate · **soft** remove.                                       |
| `/api/v1/app/rounds?demoClientId=\|cohortId=&q=`  | GET/POST         | List (enriched) / create (name defaults to cohort + dates).                |
| `/api/v1/app/rounds/:id`                          | GET/PATCH/DELETE | Detail / edit (name/desc/window/status draft↔open) / delete.               |
| `/api/v1/app/rounds/:id/close`                    | POST             | Manual close (409 if already closed).                                      |
| `/api/v1/app/rounds/:id/invitations`              | POST             | Generate per-member round invitations (the grant) → counts + minted links. |
| `/api/v1/app/rounds/:id/questionnaires[/:itemId]` | POST/DELETE      | Attach (409 if already bundled) / detach.                                  |

**Stats** follow the enriched-list discipline (`questionnaires/_lib/list.ts`): a fixed query
budget, no per-row N+1. `rounds/_lib/stats.ts` `sessionCountsByRound` does one grouped sweep
(`by: ['roundId','status']`, `isPreview:false`); "completed" is the literal `status==='completed'`.
The cohort list sums its cohorts' rounds.

Mutations are audited (`app_cohort.*`, `app_cohort_member.*`, `app_round.*`).
