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

---

### UG-3 — `ExecutionDetailView` copy button leaks an uncleared `setTimeout`

_Status:_ **raised-upstream** ([sunrise#301](https://github.com/human-centric-engineering/sunrise/issues/301)) · _Opened:_ 2026-06-22 · _Surfaced by:_ PR #72 (`feat/generative-authoring`), 2026-06-15

**Gap.** The platform component `CollapsibleJsonCard` in
`components/admin/orchestration/execution-detail-view.tsx` schedules
`setTimeout(() => setCopied(false), 2000)` after a clipboard write but never clears
it. If the component unmounts within 2s the timer fires `setState` on a dead
component — a benign prod leak, but in tests it fires after jsdom teardown and throws
`ReferenceError: window is not defined`, failing the whole vitest run.

**Why upstream.** It's a platform component every consumer (and every fork's
`--changed` test graph) inherits; not app-specific.

**Proposed fix.** Track the timeout in a ref and `clearTimeout` on unmount and before
re-arming. Check sibling copy handlers in the same file for the same pattern.

**Interim mitigation.** No fork-edit of the component. ConQuest hardened its own test
to drive the clipboard-unavailable catch path (`writeText` rejects → `catch` → no
timer scheduled): `tests/unit/components/admin/orchestration/execution-detail-view.test.tsx`.

**References.** [sunrise#301](https://github.com/human-centric-engineering/sunrise/issues/301).

---

### UG-4 — Admin-added (date-stamped) provider models can't be saved and are mis-tiered

_Status:_ **raised-upstream** ([sunrise#302](https://github.com/human-centric-engineering/sunrise/issues/302)) · _Opened:_ 2026-06-22 · _Surfaced by:_ admin adding newer OpenAI models via discovery

**Gap.** Two defects on date-stamped / discovery-added models (e.g.
`gpt-5.5-pro-2026-04-23`). **(A)** Selecting one for a default-model assignment 400s
with `VALIDATION_ERROR` — the settings PATCH validates before `hydrateFromDb()`, so
the dropdown (DB-sourced) and write-validation (un-hydrated registry) disagree. **(B)**
A frontier "pro" model is labelled `(budget)` / "Infrastructure" — `deriveTierRole()`
falls back to `infrastructure` because the date suffix defeats name patterns, "pro"
isn't a frontier signal, and null pricing → `medium`.

**Why upstream.** Platform model registry + heuristics (`lib/orchestration/llm/**`);
hits any fork using model discovery, the supported way to add models.

**Proposed fix.** Hydrate before validate (or validate model ids against the same DB
source the dropdown uses); add a shared date-stamp normaliser reused across name
heuristics; recognise `pro`/`opus`/`ultra`/`-max` as frontier; degrade gracefully on
unknown cost; provide a re-derive/override path for already-stored rows.

**Interim mitigation.** Prefer statically-known model ids for default assignments;
use the admin tier override for mislabelled rows. No platform edit carried.

**References.** [sunrise#302](https://github.com/human-centric-engineering/sunrise/issues/302).

---

### UG-5 — Agent-builder skill doesn't document the `isSystem` core reservation

_Status:_ **raised-upstream** ([sunrise#303](https://github.com/human-centric-engineering/sunrise/issues/303)) · _Opened:_ 2026-06-22 · _Surfaced by:_ seeding persistent questionnaire app agents

**Gap.** `AiAgent.isSystem = true` is reserved for Sunrise core agents (it confers an
undeletable / undeactivatable / instruction-locked / backup-excluded lifecycle). The
API path can't set it, but the **seed path** can — and the `orchestration-solution-builder`
skill never says so. A developer copying a core seed (`010-model-auditor.ts`,
`016-evaluation-judges.ts`) as a template silently elevates an app agent into the
reserved class.

**Why upstream.** The skill and the reservation convention are platform-shipped;
affects any fork that seeds agents. Same flag exists on `AiCapability` / `AiAgentProfile`.

**Proposed fix.** Add the reservation rule to the skill + a correct app-agent seed
scaffold (`isSystem: false`, explanatory comment); optional CI/`pre-pr` lint for
`isSystem: true` in app-namespace seeds.

**Interim mitigation.** ConQuest seeds set `isSystem: false` explicitly, and the
`update` branch re-asserts `false` so re-seeding corrects any stray flag —
`prisma/seeds/app-questionnaire/*`.

**References.** [sunrise#303](https://github.com/human-centric-engineering/sunrise/issues/303) ·
`prisma/seeds/app-questionnaire/006-answer-extractor-agent.ts`.

---

### UG-6 — No admin honesty indicator for agents whose prompt is built at runtime

_Status:_ **raised-upstream — proposal** ([sunrise#304](https://github.com/human-centric-engineering/sunrise/issues/304)) · _Opened:_ 2026-06-22 · _Surfaced by:_ questionnaire capability agents (code-built prompts)

**Gap.** An agent dispatched for its provider/model binding only — with its system
prompt assembled in code — makes the stored `systemInstructions` / persona / guardrails
/ brand-voice fields, and the admin "Effective prompt preview — what the LLM actually
sees" panel, display text the model never receives. The platform gives no signal that
these fields are inert.

**Why upstream.** Programmatic capability dispatch (`extends BaseCapability`, structured
prompts built per-call from live data) is a platform-encouraged pattern; any fork using
it the intended way hits this. It is **deliberate and necessary**, not a bug to prevent.

**Proposed fix.** Optional, advisory, app-populated `AiAgent.runtimePromptManaged`
(+ `runtimePromptNote`), default off, behaviour-neutral; admin shows a per-agent
"instructions bypassed" callout and re-labels the preview. Open scope: a richer
registerable prompt-specimen seam (show the real runtime prompt) vs. the minimal flag.

**Interim mitigation.** ConQuest already solves its own visibility need app-side, more
richly than the proposal: an admin **Prompt Library** that renders the real code-built
prompts (placeholder-tokenised) plus a per-agent `instructionsAreLoadBearing` flag. So
ConQuest will **not** consume the core flag — this entry is "for the next fork", and a
candidate to leave at proposal until a second fork needs it.

**References.** [sunrise#304](https://github.com/human-centric-engineering/sunrise/issues/304) ·
`app/api/v1/app/questionnaires/_lib/prompt-catalog.ts` ·
`components/admin/questionnaires/prompt-library.tsx` ·
[`../questionnaire/admin-ui.md`](../questionnaire/admin-ui.md) § "Prompt library".

---

### UG-7 — No brand-name seam (app name hardcoded as "Sunrise")

_Status:_ **raised-upstream** ([sunrise#305](https://github.com/human-centric-engineering/sunrise/issues/305)) · _Opened:_ 2026-06-22 · _Surfaced by:_ ConQuest rebrand (2026-06-13)

**Gap.** "Sunrise" is hardcoded across user-facing surfaces — root + route-group layout
titles, `emails/*` templates, marketing copy (~45 refs). The only no-code seam is
`EMAIL_FROM_NAME` (email _sender_ display name); there is no `APP_NAME` equivalent for
the UI.

**Why upstream.** Renaming is the most universal fork need, and the strings live in
layouts/emails that upstream actively maintains — fix it at the source.

**Proposed fix.** A platform `BRAND` config driven by `NEXT_PUBLIC_APP_NAME` (default
`'Sunrise'`), read by layouts + emails; `SUNRISE_VERSION` explicitly excluded.

**Interim mitigation.** Until the seam lands, the app tolerates "Sunrise" in
titles/emails or carries a local edit on those files (merge-cheap; retire on the seam).

**References.** [sunrise#305](https://github.com/human-centric-engineering/sunrise/issues/305).

---

### UG-8 — Marketing-page customization forces fork-and-edit (no documented low-conflict pattern)

_Status:_ **raised-upstream** ([sunrise#306](https://github.com/human-centric-engineering/sunrise/issues/306)) · _Opened:_ 2026-06-22 · _Surfaced by:_ ConQuest Home/About/Contact rebrand (2026-06-13)

**Gap.** `CUSTOMIZATION.md` tells forks to edit `app/(public)/page.tsx`,
`about/page.tsx`, `contact/page.tsx` directly — producing large conflicts whenever
upstream touches them. No low-conflict pattern is documented. (The App Router won't let
a second file resolve to `/`, so the canonical route file must be touched either way.)

**Why upstream.** A docs/guidance gap in platform `CUSTOMIZATION.md` affecting every
fork; the thin-shim is generic.

**Proposed fix.** Document the **thin-shim** — reduce each route file to a one-line
re-export, content lives in new `components/app/marketing/*` files (Contact reuses
Sunrise `<ContactForm>` + `/api/v1/contact`, behaviour unchanged). Full content-seam
deferred unless multi-fork.

**Interim mitigation.** ConQuest uses the thin-shim locally — this is the carried
approach the docs change would bless.

**References.** [sunrise#306](https://github.com/human-centric-engineering/sunrise/issues/306).

---

### UG-9 — `runStructuredCompletion` doesn't forward a schema to the provider

_Status:_ **raised-upstream — proposal** ([sunrise#307](https://github.com/human-centric-engineering/sunrise/issues/307)) · _Opened:_ 2026-06-22 · _Surfaced by:_ questionnaire extractor schema-drift bug

**Gap.** `lib/orchestration/evaluations/parse-structured.ts` sends a free-form chat
prompt and never forwards a JSON schema / `responseFormat`. The model's only contract
is prose, so a prompt that omits a field name yields mis-keyed output and Zod
validation fails for every item.

**Why upstream.** Platform helper + provider adapters; shared by the evaluation summary
handler, the metric scorer, and fork extractors. Patching in the fork would fork a
platform seam.

**Proposed fix.** Optional `responseSchema` → provider `responseFormat`
(OpenAI `json_schema`; Anthropic forced-tool); purely additive, `parse` + temp-0 retry
remain the fallback for providers that ignore it.

**Interim mitigation.** Triggering bug already fixed downstream by naming the required
fields in `lib/app/questionnaire/ingestion/extraction-prompt.ts`; the prose contract
stays as belt-and-suspenders. This upstream change is hardening, not a bug fix.

**References.** [sunrise#307](https://github.com/human-centric-engineering/sunrise/issues/307) ·
`lib/app/questionnaire/ingestion/extraction-prompt.ts` ·
`lib/app/questionnaire/ingestion/extraction-schema.ts` (`extractionJsonSchema`).

---

### UG-10 — STT provider seam is batch-only (no live/streaming transcription)

_Status:_ **raised-upstream — proposal** ([sunrise#308](https://github.com/human-centric-engineering/sunrise/issues/308)) · _Opened:_ 2026-06-22 · _Surfaced by:_ P7 voice input (F6.2)

**Gap.** `LlmProvider.transcribe()` (`lib/orchestration/llm/types.ts`) is batch-only —
record, stop, upload, transcribe. There is no streaming variant for live interim
transcripts (words appearing as the respondent speaks).

**Why upstream.** A provider capability mirroring `chat()` → `chatStream()`; 4+ batch
consumers (admin chat transcribe, embed STT, knowledge ingestion, the questionnaire
transcribe route) already share the seam. An app-side realtime client would duplicate
key/provider resolution and forgo cost tracking.

**Proposed fix.** `transcribeStream()` + `TranscribeChunk`; server relays audio to the
provider and streams partial/final back over the existing SSE bridge; a "live" mode on
`MicButton`. The real risk is the client→server transport under Next 16 — **spike that
first**.

**Interim mitigation.** Batch voice input (`useVoiceRecording` / `MicButton`) stays;
live fill deferred until the seam exists. Gate behind the existing
`APP_QUESTIONNAIRES_VOICE_INPUT` flag (a DB `feature_flag` row).

**References.** [sunrise#308](https://github.com/human-centric-engineering/sunrise/issues/308) ·
`lib/orchestration/llm/types.ts` · `lib/hooks/use-voice-recording.ts` ·
`components/admin/orchestration/chat/mic-button.tsx`.

---

### UG-11 — `Lint & format` CI job skips docs-only PRs (repo-wide format check never runs)

_Status:_ **raised-upstream** ([sunrise#314](https://github.com/human-centric-engineering/sunrise/issues/314)) · _Opened:_ 2026-06-23 · _Surfaced by:_ the UG-3…UG-10 ledger PR — a docs-only change landed an unformatted `.md`, which then failed a later, unrelated code PR

**Gap.** The shared `.github/workflows/ci.yml` `lint` job (`Lint & format`) is gated
`if: needs.config.outputs.code == 'true'`, so it is skipped entirely on docs-only PRs.
But `npm run format:check` is **repo-wide** (`prettier --check … .`, Markdown included).
So an unformatted `.md` can land on `main` via a docs-only PR — unchecked — then fail
the **next** code PR's whole-repo `format:check`, misattributed to that unrelated PR.

**Why upstream.** The gap is in the shared `ci.yml`, so it hits Sunrise and **every
fork**. The fix is a platform-owned CI file — patching only downstream would diverge a
file upstream actively maintains.

**Proposed fix.** Remove the **job-level** `if` so `lint` runs on every PR; gate the
**ESLint step** instead (`if: code == 'true'`) — ESLint has no docs to check, so docs
PRs don't pay for it. Keep it **one job** so the single `npm ci` is shared (splitting
off a separate always-on format job would double `npm ci` on every code PR — poor for a
minute-capped fork). Note the exception in `.context/architecture/ci.md`.

**Interim mitigation.** **Already applied locally** — PR #102 (the CI fix) + PR #101
(the file that first tripped it). Unlike UG-3…UG-10, this is a **live carried patch**:
ConQuest's `ci.yml` / `.context/architecture/ci.md` now diverge from upstream. Tracked
as `pending-upstream` in [[development-plan#Carried Sunrise patches]]. The identical fix
was recommended on
[sunrise#314](https://github.com/human-centric-engineering/sunrise/issues/314) so the
divergence retires **conflict-free** when a Sunrise release includes it and we sync.

**References.**
[sunrise#314](https://github.com/human-centric-engineering/sunrise/issues/314) ·
`.github/workflows/ci.yml` · `.context/architecture/ci.md` · ConQuest PR #102 / #101.

---

### UG-12 — Chat handler cannot execute a pinned agent version snapshot

_Status:_ open · _Opened:_ 2026-07-18 · _Surfaced by:_ F14.15 (AI run provenance audit)

**Gap.** `AiAgentVersion.snapshot` stores an agent's full config at a point in time,
and `AiExperimentVariant.agentVersionId` lets an experiment pin a variant to one. But
nothing can _execute_ a snapshot. `drainStreamChat` → `streamChat` resolves an agent by
**slug** (`loadAgent(request.agentSlug)`, `lib/orchestration/chat/streaming-handler.ts`),
which always returns the **live** config. There is no seam to say "run this agent with
_this_ configuration".

The consequence was a live correctness bug, not just a missing feature: the experiment
run route created every variant's `AiEvaluationRun` against `experiment.agentId`
(the live agent) and ignored `variant.agentVersionId` entirely — the field was written at
create time and **read nowhere in any execution path**. A 2-arm "version A vs version B"
experiment therefore evaluated identical config twice, and `stats/winner.ts` reported the
resulting sampling noise as a winner with a Welch t-test and Cohen's d.

**Why upstream.** The seam is in the platform's chat handler, and every consumer of it
benefits: experiments (version A/B), evaluation runs (reproducible historical scores),
regression testing a prompt change before publishing, and workflow steps that want to
pin an agent the way `AiWorkflowExecution.versionId` already pins a workflow. Forking
`streaming-handler.ts` — a ~2,000-line file upstream actively maintains, with ~20
`agentSlug` references — would guarantee merge conflicts on every sync.

**Proposed fix.** Widen the chat request so the agent can be supplied as a resolved
config rather than only a slug — e.g. `agentConfig?: AgentSnapshot` taking precedence
over `agentSlug` in `loadAgent`, with the snapshot validated against the same Zod schema
the agent form uses. `AiAgentVersion.snapshot` is already the right shape. Then
`runAgentCase` passes the pin through and evaluation runs become reproducible.

**Interim mitigation.** **Carried patch applied locally** (F14.15), deliberately minimal
so it retires cleanly:

1. `AiEvaluationRun.agentVersionId` — new nullable column; the run route now copies
   `variant.agentVersionId` onto the run, so the pin is **recorded** even though it can't
   yet be honoured. When the upstream seam lands, the worker just reads it.
2. The run worker **fails a pinned run loudly** (`agent_version_pinning_unsupported`)
   rather than silently scoring the live agent under a pinned label.
3. The experiment run route **refuses a dataset-driven experiment whose variants all
   resolve to the same configuration** — the case that produced the meaningless winner.

Net effect: version-comparison experiments are blocked with a clear message instead of
returning confident, wrong numbers. Non-pinned single-config runs are unaffected.

**Consequence while this stays open: a dataset-driven experiment cannot complete.** The
two refusals above are exhaustive, and they surface at _different_ points:

| Variant config        | Refused where | What the admin sees                                                         |
| --------------------- | ------------- | --------------------------------------------------------------------------- |
| All variants unpinned | Run route     | 400 at press-time — "resolves to the same agent configuration"              |
| Any variant pinned    | Run worker    | The pinned arm fails on the next tick — `agent_version_pinning_unsupported` |

Since a variant's only differentiator is `agentVersionId`, every dataset-driven
experiment falls into one of those rows. The pinned case is deliberately left to the
worker rather than refused at the route: hoisting it into the route would make the
run-creation block unreachable and cost the regression net that has to work again the
moment this lands. The trade is that the admin learns one tick late — acceptable while
the worker's failure detail explains itself, and resolved outright when the seam ships.

**When implementing, also close this:** the run route copies `variant.agentVersionId`
onto the run **without checking the version belongs to `experiment.agentId`**
(`experiments/[id]/run/route.ts`). Harmless today — the route is admin-only and the
worker hard-fails every pinned run before execution — but the moment pinning becomes
executable, an admin could pin a variant to another agent's version and score a
comparison that is silently measuring the wrong agent. Validate the pin against the
experiment's agent in the same change that makes pins executable.

**References.** `lib/orchestration/chat/streaming-handler.ts` (`loadAgent`) ·
`lib/orchestration/evaluations/run-cases/agent-case.ts` ·
`lib/orchestration/evaluations/run-worker.ts` ·
`app/api/v1/admin/orchestration/experiments/[id]/run/route.ts` ·
`lib/orchestration/evaluations/stats/winner.ts` ·
[[development-plan#Carried Sunrise patches]] · `.context/app/planning/features/f14.15.md`.

---

### UG-13 — Maintenance tick does unconditional DB work, so a scale-to-zero database never suspends

_Status:_ **raised-upstream** ([sunrise#442](https://github.com/human-centric-engineering/sunrise/issues/442)) · _Opened:_ 2026-07-21 · _Surfaced by:_ Neon compute-hours investigation

**Gap.** `runMaintenanceTick()` fans out to its background tasks
**unconditionally** — there is no "is there any work?" pre-check, and none of the
tasks is time-throttled. An idle tick costs ~20 queries in core (~24 with the app
tasks), at least one of which is a write. On a long-running Postgres this is
invisible; on a **scale-to-zero database** (Neon, Aurora Serverless v2) it means
the compute **never idles**, so a near-zero-traffic deployment bills as if it ran
continuously.

Note the cost driver is **cadence, not query count**: autosuspend keys off compute
idle time, so one query a minute defeats a 5-minute timer exactly as well as
twenty. Making the tick cheaper does not help on its own.

Three core sub-bugs found alongside it, all documented on the issue:

1. `useHealthCheck` has **no `document.visibilityState` gating**
   (`components/status/use-health-check.ts`), so the admin overview's 30s
   `/api/health` poll — which runs `SELECT 1` — pins the DB awake from a
   forgotten browser tab, _with the cron disabled entirely_. The gating pattern
   already exists at `lib/hooks/use-auto-refresh.ts:78` and
   `components/admin/admin-sidebar.tsx:419`; it just isn't applied here.
2. Queued **evaluation runs have no inline kick** — `processPendingEvaluationRuns`
   is reachable only from the tick, so their start latency is exactly the cadence.
3. `queueMessageEmbedding` uses a **bare `void`** (`chat/streaming-handler.ts`),
   which Vercel freezes once the response is sent — so `backfillMissingEmbeddings`
   is likely load-bearing rather than the safety net it is described as.

**Why upstream.** Every file above is platform-owned, and every Sunrise fork
deployed on a serverless DB inherits the bill. The per-tick constants
(`MAX_PER_TICK`, `WORKER_TIME_BUDGET_MS = 45s` "leaves headroom in a 60s cron",
the `take:` caps) are all hardcoded to a 60s cadence, which is precisely what
stops a fork from safely slowing its own cron.

**Proposed fix.** An env-evaluated (never DB-read — the settings lookup would
itself defeat autosuspend) enable/cadence seam, with the per-tick caps and
`stuckExecutionThresholdMins` derived from the configured cadence rather than
hardcoded; plus `after()` kicks at the enqueue sites so deferred work stops being
cadence-bound. Suggested **not** off-by-default: in stock Sunrise the tick is the
sole trigger for webhook/hook retries, orphan/zombie recovery and scheduled
workflows, so off-by-default would present as a bug.

**Interim mitigation.** ConQuest owns its own cadence — `vercel.json` and
`app/api/v1/cron/maintenance/route.ts` are **app files, not in core** (core only
_recommends_ 60s at `.context/orchestration/scheduling.md`). Cron dropped to
hourly (`0 * * * *`), which is safe here because ConQuest's production data path
populates **none** of the platform tables the frequent tasks sweep — see
[`maintenance-cron.md`](../questionnaire/maintenance-cron.md) for the audit and
the conditions that would invalidate it.

**References.** `vercel.json` · `app/api/v1/cron/maintenance/route.ts` ·
`lib/orchestration/maintenance/run-tick.ts` · `lib/orchestration/retention.ts` ·
`components/status/use-health-check.ts` ·
[`.context/app/questionnaire/maintenance-cron.md`](../questionnaire/maintenance-cron.md).
