# Forking ConQuest

> **Who this is for.** Two audiences, two halves. **Part A** is for a
> **client-engagement team** inheriting this repo to deliver a _different vertical_ —
> what to keep, what to rename, what to replace. **Part B** is for any fork that wants
> to **track upstream Sunrise** and contribute fixes back. Read Part A to re-skin the
> product; read Part B to stay current with the platform underneath it.

ConQuest is an **application fork of Sunrise**. The model — what's platform, what's
yours, and the discipline that keeps upstream merges cheap — is
[`CUSTOMIZATION.md`](../../../CUSTOMIZATION.md) (it opens "# Building on Sunrise").
The one-line summary of that model: **public-surface-first, fix-in-place,
promote-upstream**. This doc is the ConQuest-specific companion to it — it does not
restate the platform model, it points at it and adds the questionnaire-specific
detail.

The thing you're inheriting is a **conversational-questionnaire engine**: an admin
uploads a document, an agent extracts its structure, and respondents complete it
through a streaming conversation. That engine is the asset. A new engagement keeps the
engine and swaps the _vertical_ — the content, the naming, and the demo tenancy.

---

## Part A — Re-skinning for a new vertical

### A.1 What to keep verbatim

The whole **platform tier** (Sunrise) and the **reusable app machinery** stay. Don't
touch them to re-skin — they carry no vertical-specific assumptions:

- **Platform (Sunrise):** auth, `lib/` utilities, orchestration, security/rate-limit
  middleware, migration tooling. Treat as an upgradable dependency — see Part B.
- **The questionnaire engine** under `lib/app/questionnaire/**`: ingestion, the
  per-turn orchestrator, selection strategies, answer extraction/refinement,
  contradiction detection, completion logic, the session state machine, cost-cap
  enforcement, design evaluation. These are vertical-neutral — they operate on
  _whatever_ structure the extractor produces.
- **The chat surface** (`app/(protected)/questionnaires/**`,
  `components/app/questionnaire/**`) and admin surface
  (`app/admin/questionnaires/**`).
- **The theming module** (`lib/app/questionnaire/theming/**`) and the **demo-client
  infrastructure** — kept, but its _content_ is replaced (see A.4) and the demo tenancy
  itself is replaced (see A.5).
- **No questionnaire feature-flag layer to inherit.** ConQuest's per-feature flags
  (`APP_QUESTIONNAIRES_*_ENABLED` and `lib/app/questionnaire/feature-flag.ts`) were
  removed (2026-07) — every questionnaire feature is permanently on, so there is
  nothing to rename here. The **generic Sunrise** feature-flag infrastructure
  (`lib/feature-flags/`, `isFeatureEnabled`, the `/admin/features` page,
  site-wide `MAINTENANCE_MODE`) is untouched and still available if your fork wants
  to gate a new feature deliberately.

The rename surface below changes _identifiers and copy_, not behaviour. Resist editing
engine logic to fit a vertical — if the engine genuinely can't express your vertical,
that's a design conversation, not a rename.

### A.2 The rename surface

A new vertical replaces the word "questionnaire" and the "ConQuest" brand. Counts below
are live as of this writing (`grep -rIo <token> lib app components prisma`) — treat them
as orders of magnitude, re-run before you start:

| Token                        | ~Occurrences   | Where it lives                                            |
| ---------------------------- | -------------- | --------------------------------------------------------- |
| `questionnaire` (lowercase)  | ~2100          | code, routes, config keys, slugs, docs                    |
| `Questionnaire` (PascalCase) | ~800           | model names, type names, component names                  |
| `App*` Prisma models         | **18 models**  | `prisma/schema/app-questionnaire.prisma` (+ ~340 TS refs) |
| `app_*` table names          | **18 `@@map`** | same schema file                                          |
| `ConQuest`                   | ~55            | brand in docs, comments, seed copy                        |
| `conquest`                   | ~70            | brand in slugs, URLs, `package.json` name                 |

The 18 models: `AppQuestionnaire`, `AppQuestionnaireVersion`,
`AppQuestionnaireInvitation`, `AppQuestionnaireConfig`, `AppQuestionnaireSection`,
`AppQuestionSlot`, `AppQuestionTag`, `AppQuestionSlotTag`,
`AppQuestionnaireExtractionChange`, `AppQuestionnaireSourceDocument`, `AppDemoClient`,
`AppQuestionnaireSession`, `AppRespondentProfileSnapshot`, `AppAnswerSlot`,
`AppQuestionnaireSessionEvent`, `AppQuestionnaireTurn`,
`AppQuestionnaireEvaluationRun`, `AppQuestionnaireEvaluationFinding`.

### A.3 The rename `sed` recipes

**Do this on a branch, with a clean tree, and run `npm run validate` after each block.**
Order matters: rename the **most-specific tokens first** so a broad pass can't shred a
narrow one. The cardinal collision is `app_questionnaire` (table prefix) vs the bare
word `questionnaire` — rename the prefix _before_ the word, or the prefix becomes
`app_<newword>` half-renamed.

Pick your vertical noun first. Example: `questionnaire` → `survey`, `ConQuest` →
`Polaris`.

```bash
# 0. Scope: app code only. NEVER run these across lib/ (platform), node_modules, or .git.
SCOPE="lib/app app/api/v1/app app/admin/questionnaires app/(protected)/questionnaires \
       components/app prisma/schema/app-questionnaire.prisma prisma/seeds/app-questionnaire \
       tests/unit/lib/app tests/unit/components/app tests/integration/lib/app \
       tests/fixtures/app .context/app"

# 1. Table prefix BEFORE the bare word (the critical ordering).
sed -i '' 's/app_questionnaire/app_survey/g' prisma/schema/app-questionnaire.prisma

# 2. Prisma model prefix (PascalCase compound) before the bare PascalCase word.
grep -rIl "AppQuestionnaire" $SCOPE | xargs sed -i '' 's/AppQuestionnaire/AppSurvey/g'
grep -rIl "AppQuestion"      $SCOPE | xargs sed -i '' 's/AppQuestion/AppSurveyQuestion/g'  # AppQuestionSlot etc.

# 3. The bare words last.
grep -rIl "Questionnaire" $SCOPE | xargs sed -i '' 's/Questionnaire/Survey/g'
grep -rIl "questionnaire" $SCOPE | xargs sed -i '' 's/questionnaire/survey/g'

# 4. Brand.
grep -rIl "ConQuest" $SCOPE | xargs sed -i '' 's/ConQuest/Polaris/g'
grep -rIl "conquest" $SCOPE | xargs sed -i '' 's/conquest/polaris/g'   # also package.json "name"
```

**Then, and only then:**

```bash
# Rename the directories the recipe above edited contents of but not names of.
git mv lib/app/questionnaire           lib/app/survey
git mv app/admin/questionnaires        app/admin/surveys
git mv "app/(protected)/questionnaires" "app/(protected)/surveys"
git mv app/api/v1/app/questionnaires   app/api/v1/app/surveys
git mv prisma/schema/app-questionnaire.prisma prisma/schema/app-survey.prisma
git mv prisma/seeds/app-questionnaire  prisma/seeds/app-survey
# ...and the matching tests/ and .context/app/ trees.

npx prisma generate                    # regenerate the client against renamed models
npm run db:reset                       # dev only — rebuild schema + reseed from the renamed source
npm run validate                       # type-check + lint + format must be green
```

**What `sed` must NOT touch:**

- **`lib/app/` is two things.** The bootstrap-seam files there are **platform-named and
  stay**: `env.ts`, `rate-limit.ts`, `capabilities.ts`, `admin-nav.ts`, `db-drift.ts`
  (the auto-wired surface — see [`CUSTOMIZATION.md` §4](../../../CUSTOMIZATION.md)).
  Only `lib/app/questionnaire/**` is yours to rename. Scope the recipe to the
  questionnaire subtree, not all of `lib/app`.
- **The `app_` _platform_ convention vs the `app_questionnaire` _table_ prefix.** Step 2
  targets the full `app_questionnaire` string precisely so it can't touch the generic
  `app_` namespace.
- **`lib/`, `app/api/v1/` (non-`/app`), `app/(auth|public)/`, `components/ui/`,
  `components/admin/` (except demo-clients)** — all platform. Out of scope.

Renaming is mechanical but not free; budget a real review pass and lean on the
type-checker and the schema-shape tests to catch a half-finished rename.

### A.4 What to replace (content, not identifiers)

The engine is generic; the _vertical content_ is not. Replace:

- **Extraction agent + prompts** — the extractor is tuned to pull a questionnaire's
  structure. A different document shape (a survey, an intake form, an assessment) wants
  its own extraction prompt and possibly capability. Seeded under
  `prisma/seeds/app-questionnaire/` (the agent + capability units).
- **Branding defaults** — `SUNRISE_THEME_DEFAULTS` in
  `lib/app/questionnaire/theming/theme.ts` (CTA/accent colour, no default logo). These
  fill every gap a demo client leaves null.
- **Sample content and profile fields** — see A.5; the demo seed carries a worked
  example you'll swap wholesale.

### A.5 Demo-tenancy replacement

ConQuest ships a **demo-tenancy layer** so a salesperson can stand up a branded sample
client in one command. A real engagement replaces it. Everything demo-only is
**grep-isolated** behind a marker:

```bash
grep -rl "DEMO-ONLY" lib app components prisma   # the full demo surface
```

That surface is `lib/app/questionnaire/demo-clients/**` + `theming/**`,
`app/api/v1/app/demo-clients/**`, `app/admin/demo-clients/**` +
`components/admin/demo-clients/**`, the `AppDemoClient` model + its theme columns, the
`demoClientId` snapshot on invitations and the attribution column on questionnaires, the
`API.APP.DEMO_CLIENTS` block, the admin nav item, and the `LOAD_DEMO_CONTENT=1` seed
(`prisma/seeds/app-questionnaire/025-demo-content.ts` — a whole-file `// DEMO-ONLY`
unit nothing imports, discovered by the seed runner's glob, so deleting the file is a
clean removal). See [`demo-clients.md`](./demo-clients.md) § "Fork guidance" and the
[`runbook.md`](./runbook.md) "core product vs demo-tenancy" callout for the boundary
between demo scaffolding and the core product.

**Three replacement paths** (this doc is the canonical home for them):

1. **Delete entirely — single-tenant production.** The simplest. Remove the
   `DEMO-ONLY` surface above, drop the `AppDemoClient` model + the two FK columns
   (`AppQuestionnaire.demoClientId`, `AppQuestionnaireInvitation.demoClientId`) in a
   follow-up migration, and remove the `025-demo-content.ts` seed. Theme resolution
   falls back to `SUNRISE_THEME_DEFAULTS` for everyone. Choose this when one client owns
   the whole deployment.
2. **Rename to `AppTenant` + activate RLS — multi-tenant production.** Keep the table,
   rename `AppDemoClient` → `AppTenant`, and retrofit row-level security per
   [`../../architecture/multi-tenancy.md`](../../architecture/multi-tenancy.md)
   (the `TENANCY_MODE` seam). The `demoClientId` FKs become the tenant discriminator.
   Choose this when one deployment serves many isolated clients.
3. **Keep as `AppBrand` — branded single-tenant production.** Rename `AppDemoClient` →
   `AppBrand`, drop the `DEMO-ONLY` markers and the reset/seed-demo scaffolding, but
   keep the branding columns (CTA/accent/logo/welcome copy). Choose this when one client
   wants several branded questionnaire skins without tenant isolation.

The seed demo content (Northwind Logistics sample) is replaced or deleted regardless —
it's a sales fixture, never a production asset.

---

## Part B — Tracking upstream Sunrise

This half is for keeping the **platform underneath you** current. It consolidates the
mechanics that live across the platform docs into one "how to stay current" sequence —
follow the cross-references for the authoritative detail; don't expect this section to
restate them.

### B.1 Wire up the `upstream` remote

`origin` is your fork (here, `conquest`, private). **Sunrise is `upstream`** — public,
read-only, you never push to it:

```bash
git remote add upstream git@github.com:human-centric-engineering/sunrise.git
git remote set-url --push upstream DISABLED   # belt-and-braces: never push to upstream
git fetch upstream
```

### B.2 Merge a Sunrise release

The authoritative recipe is
[`../../database/migrations.md`](../../database/migrations.md) §"Staying in Sync with
Upstream Sunrise (Forks)" and §"Recipe: merging a Sunrise release". In short:

```bash
git fetch upstream
git merge upstream/main          # resolve the (usually rare) conflicts
npm run db:migrate:status        # see how the two migration histories interleave
npm run db:migrate:dev           # dev — or db:migrate:deploy for prod/CI
npm run db:drift-check           # confirm no unmodelled object got dropped
npm run validate
```

The histories combine by **timestamp-ordered interleaving** — that's why ConQuest names
its migrations with an `app_` prefix and a date, so a Sunrise migration and an app
migration sort deterministically.

### B.3 The semantic-conflict discipline

Textual merge conflicts are the easy case — git flags them. The dangerous ones are
**semantic**: a Sunrise change that compiles cleanly against your fork but breaks an
assumption. Two rules contain the blast radius:

- **Depend on the public surface, not internals.** If your app code only touches the
  named seams and documented contracts ([`CUSTOMIZATION.md`](../../../CUSTOMIZATION.md),
  [`VERSIONING.md` §"Public-surface contract"](../../../VERSIONING.md)), a Sunrise
  upgrade can only break you through a surface Sunrise promised to keep stable — a much
  smaller, version-gated set. Reaching into `lib/` internals is where silent semantic
  breakage hides.
- **Never edit Sunrise's migration SQL.** Editing an applied migration desyncs every
  environment that already ran it. To change the _result_ of a Sunrise migration, add
  your own **follow-up** `app_*` migration that alters the schema forward. Generate app
  migrations with `--create-only` and strip any phantom DROP/ALTER of platform
  unmodelled objects (pgvector indexes, the partial unique index) before applying —
  the full procedure is in [`schema.md`](./schema.md) §"Migration workflow (and the
  schema-fold footgun)".

### B.4 Decide whether an upgrade is safe

ConQuest tracks two versions independently: **`APP_VERSION`** (your `package.json`) and
**`SUNRISE_VERSION`** (`lib/sunrise-version.ts`, merged through from upstream — never
hand-edited). Use the platform version + its SemVer contract to judge a merge:

- [`CUSTOMIZATION.md` §8](../../../CUSTOMIZATION.md) — the two-version model and what to
  do on upgrade.
- [`VERSIONING.md` §"SemVer rules"](../../../VERSIONING.md) and §"`0.x` (alpha)
  semantics" — at `0.x`, semantics are **loose by design**: expect to do merge work and
  read the [`CHANGELOG.md`](../../../CHANGELOG.md) per release. A MINOR bump at `0.x`
  can carry breaking changes the contract won't formally cover until 1.0.

### B.5 Contribute generic fixes back

When Sunrise's surface doesn't cover an app need and the gap is **generic** (it bites
any fork, not just a questionnaire app), the discipline is **fix it upstream and pull it
down** — not patch it locally and carry the patch forever. The loop:

1. **Name the gap** in [`../planning/upstream-gaps.md`](../planning/upstream-gaps.md)
   (the open-gaps ledger): the gap, why it's a platform seam, the proposed fix, the
   interim mitigation.
2. **Raise it upstream** — issue + PR against Sunrise. Mitigate locally as a _tracked_
   patch in the meantime (recorded in the development plan's "Carried Sunrise patches").
3. **Pull the release down** and **retire the local patch** when the upstream fix lands;
   move the gap to **resolved** and record what shipped in
   [`contributions-upstream.md`](../planning/contributions-upstream.md).

ConQuest has already run this loop twice — see
[`contributions-upstream.md`](../planning/contributions-upstream.md) for the record.

---

## See also

- [`../../../CUSTOMIZATION.md`](../../../CUSTOMIZATION.md) — the app/platform model, the
  `lib/app/` seams, the satellite-User-FK pattern (authoritative).
- [`../../../VERSIONING.md`](../../../VERSIONING.md) — the public-surface contract and
  SemVer rules.
- [`../../database/migrations.md`](../../database/migrations.md) — the upstream-merge
  recipe (authoritative).
- [`demo-clients.md`](./demo-clients.md) · [`runbook.md`](./runbook.md) — the demo
  tenancy and how to operate it.
- [`../planning/upstream-gaps.md`](../planning/upstream-gaps.md) ·
  [`contributions-upstream.md`](../planning/contributions-upstream.md) — the
  fix-in-place / promote-upstream ledgers.
