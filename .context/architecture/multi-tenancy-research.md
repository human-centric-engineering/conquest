# Multi-Tenancy: Research and Gap Analysis

> **Status: research, not a plan.** This document maps the full surface a
> multi-tenant Sunrise would have to cover. It is not a commitment to build any
> of it, and nothing here is implemented. Sunrise ships **single-tenant** and
> that remains the default.
>
> **Verified against `b7e30f06` (main) on 2026-08-01.** Every claim below was
> checked against the code at that commit; line references will drift.
> Appendices A–F carry the raw evidence.

## How to read this

| If you are…                                                                      | Start at                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deciding whether to build MT into a fork                                         | [§2 The two questions](#2-the-two-questions) → [§9 Deployment topologies](#9-deployment-topologies)                                                                |
| Already committed and want the work breakdown                                    | [§5 Gap register](#5-gap-register) → [§10 Sequencing](#10-sequencing-shape)                                                                                        |
| A fork author worried about upstream merges                                      | [§7 Ownership matrix](#7-ownership-platform-tier-vs-fork-tier) → [§8 Downstream forks](#8-downstream-fork-considerations)                                          |
| A Sunrise maintainer triaging #366 / #367                                        | [§6 The decision gate](#6-the-decision-gate) → [§7](#7-ownership-platform-tier-vs-fork-tier)                                                                       |
| Answering a tenant asking for their own data storage, region, or encryption keys | [§5A Data handling and storage flexibility](#5a-data-handling-residency-and-per-tenant-storage-flexibility) → [§9 Deployment topologies](#9-deployment-topologies) |
| Answering a tenant asking to bring their own AI provider, models, or API keys    | [§5B Provider credentials and per-tenant AI configuration](#5b-provider-credentials-and-per-tenant-ai-configuration)                                               |
| About to start building any of §5A/§5B                                           | [§5C The prerequisite and the alternative](#5c-the-prerequisite-5a-and-5b-assume-and-the-architecture-they-dont-consider) — **read this first**                    |

### Companion documents

- [`multi-tenancy.md`](./multi-tenancy.md) — **the playbook.** The RLS recipe,
  the model inventory, the proven policy pattern, the pooled-connection
  gotchas. It covers the _data plane_ and covers it well. This document is the
  research around it, and deliberately does not repeat it.
- Issues **#366** (org-scoped admin axis) and **#367** (intra-tenant ownership
  scope) — the two tracked control-plane seams. Both are currently `blocked`.
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#the-appplatform-model) — the
  app/platform ownership model that decides who may edit what.
- [`VERSIONING.md`](../../VERSIONING.md#public-surface-contract-tight-definition)
  — the public-surface contract that decides what a fork can depend on.

---

## 1. Executive summary

Sunrise today has an inert tenancy seam, a proven RLS pattern documented but
not built, and two blocked issues covering authorization. Against the two
questions people actually ask:

| Question                                                       | Coverage today |
| -------------------------------------------------------------- | -------------- |
| "Can a fork retrofit multi-tenancy without fighting upstream?" | **~50–60%**    |
| "Is Sunrise a multi-tenant platform?"                          | **~15%**       |

The gap is not mostly in the database. The playbook solves row isolation
properly — Postgres RLS below the query API, which covers ORM and raw SQL
identically. **Row isolation is one of five isolation planes, and it is the only
one anything currently addresses.** The other four (namespace, process,
temporal, external) are untracked, and three of them are _unreachable from
Postgres_ — RLS cannot help with a unique index, a Node heap, or an S3 bucket.

On top of the five planes sit two more concerns that are orthogonal to all of
them: the **control plane** (who may do what — #366/#367) and the **commercial
plane** (metering, plans, quotas, billing — entirely absent, no code at all).

The most important structural finding for fork authors: several gaps live in
**platform-tier files a fork is told not to edit**. Patched downstream they
become a merge conflict on every upstream sync — which is precisely the trap
#366 and #367 were filed to avoid, applied to files those issues do not cover.
[§8](#8-downstream-fork-considerations) enumerates them.

Two tenant-facing asks are treated separately because they cut across several
planes at once and are the questions customers actually put in writing:
**per-tenant control of data storage** ([§5A](#5a-data-handling-residency-and-per-tenant-storage-flexibility))
and **per-tenant choice of AI providers and credentials**
([§5B](#5b-provider-credentials-and-per-tenant-ai-configuration)). The short
answers: storage flexibility is realistic as a **published tier ladder** up to
database-per-tenant, and dedicated-deployment already ships — an open-ended
"any storage backend you name" promise is not realistic and should be declined
early. Per-tenant provider and model **selection is largely already built**
(`AiAgent.provider`/`model` plus the empty-string inheritance contract in
`agent-resolver.ts`); per-tenant **credentials** are structurally blocked by
the deliberate env-var-only key model and the total absence of any
reversible-secret storage, and per-tenant **defaults and budgets** are blocked
by the two singletons.

[§5C](#5c-the-prerequisite-5a-and-5b-assume-and-the-architecture-they-dont-consider)
qualifies both. §5A and §5B answer "how do we make **this install** more
flexible", and that question carries a prerequisite and an alternative that are
each larger than anything either section proposes. The prerequisite: **there is
no tenant context to pass** — no `AsyncLocalStorage` exists anywhere, so every
resolver seam those sections propose is blocked on a platform-wide change to
how identity flows. The alternative: **cell architecture**, under which
Sunrise's single-tenant install is already a well-formed cell and the expensive
rungs become properties of cell placement rather than application features.
Both change what the first commit should be.

---

## 2. The two questions

These get conflated constantly and they have different answers.

**Question A — fork enablement.** _Can a downstream fork build multi-tenancy on
Sunrise without permanently forking platform files?_ This is the question
Sunrise-as-a-template exists to answer. It is mostly about seam placement, and
it is cheap: seams cost single-tenant installs nothing.

**Question B — product.** _Should Sunrise itself ship multi-tenancy?_ This is a
product and commercial decision with a large maintenance tail: every future
feature acquires a tenancy dimension, every cache acquires a key, every
background job acquires a fairness policy, and the test matrix doubles.

The current position — recorded in
[`commercial-proposition.md`](../orchestration/meta/commercial-proposition.md)
— is "single-tenant per deployment; multi-tenancy by running separate
instances, with a documented retrofit path." **That position is defensible and
this document does not argue against it.** But it only holds if Question A is
answered well, because the retrofit path is the whole product promise for forks
that need MT.

Answering A well does _not_ require answering B yes. Most of §5 is A-work.

---

## 3. The five isolation planes

The organising idea of this document. A tenant boundary is not one thing; it is
five, and they fail independently.

| #   | Plane         | What must not cross tenants                                                        | Enforced by                     | Covered today |
| --- | ------------- | ---------------------------------------------------------------------------------- | ------------------------------- | ------------- |
| 1   | **Row**       | Table rows                                                                         | Postgres RLS + `orgId`          | Documented ✅ |
| 2   | **Namespace** | Identifiers, slugs, public URLs, dedup keys                                        | Unique indexes, route resolvers | ❌            |
| 3   | **Process**   | In-memory caches, breakers, counters, registries                                   | Application cache keys          | ❌            |
| 4   | **Temporal**  | Work running outside a request (cron, reapers, retention, workers)                 | Job scheduling + fairness       | ❌            |
| 5   | **External**  | Object storage, provider credentials/quota, outbound email/webhooks, logs, backups | Per-system scoping              | ❌            |

Two cross-cutting concerns sit above the planes:

- **Control plane** — authorization: which principal may act on which resource.
  Tracked in #366 (operator tier) and #367 (ownership scope). Blocked.
- **Commercial plane** — plans, quotas, metering, invoicing. No code exists.

### Why the plane framing matters

The playbook's central argument is correct and worth restating: app-layer
`where: { orgId }` cannot reach raw SQL, so isolation belongs in the database.
But that argument establishes RLS as the right tool **for plane 1 only**, and
it is easy to read the playbook as implying the problem is then solved.

Planes 2, 3 and 5 are structurally out of Postgres's reach:

- A **unique index is evaluated above RLS.** `INSERT` into a table with
  `slug @unique` fails on a collision with a row the caller cannot see. Tenant B
  gets `Unique constraint failed` for a slug tenant A took — a correctness bug
  _and_ a cross-tenant existence oracle.
- A **module-scoped `Map` in the Node heap** is invisible to the database. RLS
  governs what a query returns; it says nothing about what a process cached from
  a previous query.
- **S3, provider APIs, SMTP and log sinks** are not Postgres at all.

Plane 4 is subtler: RLS depends on a per-transaction `SET LOCAL app.current_org`,
and background work has no request, no session, and therefore no org to set. The
playbook's `withOrg()` wrapper has no answer for a cron tick that must
legitimately span tenants.

---

## 4. Verified current state

### What exists

| Asset                    | Location                                           | Notes                                                                 |
| ------------------------ | -------------------------------------------------- | --------------------------------------------------------------------- |
| `TENANCY_MODE` env       | `lib/env.ts`, default `single`                     | Enum seam, inert                                                      |
| Client chokepoint        | `lib/db/client.ts:35-42`                           | Throws on `multi`; ~575 importers inherit it                          |
| RLS playbook             | `.context/architecture/multi-tenancy.md`           | Recipe, inventory, gotchas                                            |
| RLS proof                | `scripts/spikes/rls-isolation-spike.mjs`           | Throwaway script, not wired into CI                                   |
| Fork seam convention     | `lib/app/*` (22 files)                             | Established pattern with a home for new seams                         |
| Second-axis precedent    | `AccountType` enum, `prisma/schema/auth.prisma:83` | Proof that an orthogonal axis can be added without overloading `role` |
| Erasure dependency graph | `.context/privacy/data-erasure.md`                 | Reusable as the org-teardown graph                                    |

### What does not exist

Verified by search at `b7e30f06`:

- **No `orgId` or `tenantId` on any of the 61 Prisma models.** Zero occurrences
  across `prisma/schema/*.prisma`.
- **No `Org`, `OrgMembership`, `Team`, or `Workspace` model.**
- **No `lib/tenancy/` directory** (despite `VERSIONING.md:75` naming
  `lib/tenancy/client.ts` as a covered seam — see [§12](#12-documentation-drift)).
- **No billing, plan, subscription or metering code.** No payment provider
  integration of any kind.
- **No better-auth plugins.** `lib/auth/config.ts` registers none; `role` is the
  single `additionalField` (`config.ts:775-782`); the session carries no org.
- **No org dimension in the rate-limit key space.** `RateLimitKey` is a closed
  union of `'ip' | 'session-user' | 'api-key' | 'embed-token'`
  (`lib/security/rate-limit-policy.ts:44`).
- **No cross-tenant leakage test.** 1,030 test files, none tenancy-aware.

---

## 5. Gap register

Each entry: what is there today (with evidence), why multi-tenancy breaks it,
what would be required, and who should own the fix.

### Plane 1 — Row isolation

**Today.** Fully documented in the playbook, not built. The model inventory
classifies owners, admin-authored global config, and system/cross-tenant models.
The RLS policy pattern is proven against real Postgres including the
`NULLIF`/empty-string footgun and the per-transaction requirement.

**What's still required beyond the playbook.**

1. **Child-row policy decision at scale.** The playbook offers denormalised
   `orgId` vs join-based policy per child table and recommends denormalising hot
   paths. That decision has to be made ~30 times, and denormalisation creates a
   write-consistency obligation on every insert path — including the raw-SQL
   inserts in `message-embedder.ts` and `document-manager.ts`.
2. **Raw-SQL inventory maintenance.** The playbook's table lists six files.
   There are now **three additional app-layer raw-SQL sites** it does not
   mention (Appendix A). A prose table of raw-SQL sites will drift; this should
   be test-enforced (see [§12](#12-documentation-drift)).
3. **`FORCE ROW LEVEL SECURITY`.** The playbook mentions table owners bypass
   their own policies. Getting the role split wrong is silent — it fails open.
4. **Migration ordering.** `orgId NOT NULL` requires a backfill against live
   data; the playbook says "backfill to a default org" but a real install has
   conversations, executions and cost logs with no natural org.

**Owner.** Playbook (docs) is platform. `Org` model, migration and backfill are
fork-owned, correctly.

**Risk if skipped.** Total — this is the isolation boundary itself.

---

### Plane 2 — Namespace isolation

**Today.** 41 unique constraints, of which a large set are **globally unique
human-meaningful identifiers** (full list in Appendix B):

| Constraint                                                              | Consequence under MT                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AiAgent.slug @unique` (`agents:9`)                                     | Tenant B cannot name an agent `support` if tenant A did           |
| `AiWorkflow.slug @unique` (`workflows:10`)                              | Same, for workflows                                               |
| `AiKnowledgeBase.slug`, `AiKnowledgeDocument.slug`, `KnowledgeTag.slug` | Same, across the knowledge layer                                  |
| `AiCapability.slug`, `AiAgentProfile.slug`                              | Shared-config models — arguably correct to stay global            |
| `AiProviderConfig.name` **and** `.slug`                                 | Blocks per-tenant provider configs outright                       |
| `FeatureFlag.name @unique` (`platform:20`)                              | No per-tenant flag values                                         |
| `McpExposedPrompt.name`, `McpExposedResource.uri`                       | Global MCP namespace                                              |
| `@@unique([channel, workflowId])` (`workflows:133`)                     | One trigger per channel per workflow, cross-tenant                |
| `@@unique([agentId, channel, fromAddress])` (`conversations:45`)        | Inbound conversation key; agentId scopes it, so this one survives |

**Why MT breaks it.** Two distinct failures:

- **Collision.** A unique index is checked above the RLS policy. Tenant B's
  `INSERT` fails against a row tenant B cannot read. The error message is a
  cross-tenant existence oracle, and the failure is unfixable by the tenant.
- **Addressability.** Slugs are _routing keys_, not just labels. Three public
  route families resolve by slug with no tenant in the path:
  - `app/api/v1/chat/agents/[slug]/validate-token/route.ts`
  - `app/api/v1/inbound/[channel]/[slug]/route.ts` — inbound Slack/Postmark/HMAC
  - `app/api/v1/webhooks/trigger/[slug]/route.ts`

  Under MT these must resolve _within_ a tenant, which means the tenant has to
  arrive some other way (subdomain, path prefix, token binding). RLS will
  correctly return zero rows for a cross-tenant slug — so the failure mode is a
  confusing 404 rather than a leak — but only if the tenant context was
  established before the query, which for an unauthenticated inbound webhook it
  is not.

**What's required.** Convert ~15 constraints to `@@unique([orgId, slug])`;
re-plan every slug-resolving route for tenant arrival; decide per-model whether
the namespace is per-tenant or genuinely global (`AiCapability` and
`AiProviderModel` are plausibly global; `AiAgent` and `AiWorkflow` are not).

**Owner.** The constraint change is fork-owned (it rides the `orgId` migration).
**The route-resolution redesign is platform-tier** — those routes are Sunrise
code and a fork cannot change how they resolve without forking them.

**Risk if skipped.** High and _silent in development_: a single-tenant test
suite and a two-tenant staging environment with distinct slugs both pass. It
surfaces when the second customer picks an obvious name.

---

### Plane 3 — Process isolation

**Today.** Process-global, module-scoped mutable state across at least 20
modules (Appendix C). The load-bearing examples:

| State                                                      | Keyed by            | Cross-tenant consequence                                        |
| ---------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| `settingsCache` (`lib/orchestration/settings.ts:294`)      | nothing — singleton | Tenant A's settings served to tenant B for up to 30s            |
| default-models cache (`llm/settings-resolver.ts:55`)       | nothing             | Same, for model routing                                         |
| `breakers` Map (`llm/circuit-breaker.ts:180`)              | provider slug       | Tenant A's failure storm opens the breaker for **every** tenant |
| `counts` Map (`llm/in-flight-counter.ts:24`)               | provider slug       | Tenant A's concurrency counted against tenant B's headroom      |
| model-registry hydrate cache                               | nothing             | Global model table assumed                                      |
| provider-manager, provider-test-cache                      | provider slug       | Shared credential state                                         |
| MCP session/tool/prompt/resource registries                | server-global       | One MCP namespace                                               |
| capability dispatcher, knowledge-access resolver           | varies              | Needs audit                                                     |
| in-memory rate-limit store (`rate-limit-stores/memory.ts`) | token               | Token has no org dimension                                      |

**Why MT breaks it.** RLS is irrelevant here — this state lives in the Node
heap, populated from queries that already passed policy. Two failure classes:

- **Correctness leak** (settings, registries): tenant B reads tenant A's cached
  configuration. This is a real data leak that no database control can catch.
- **Blast radius** (breakers, counters): not a leak, but a shared-fate coupling
  where one tenant's behaviour degrades every other tenant's service. In a
  commercial MT platform this is an SLA breach, not a bug.

**What's required.** Audit every module-scoped cache and either (a) key it by
org, (b) demote it to request scope, or (c) document it as deliberately global.
Then a lint rule or review checklist so new caches declare their tenancy
posture. Breakers and counters additionally need a _policy_ decision: per-tenant
breakers protect neighbours but lose the shared-signal benefit of a global one.

**Owner.** **Platform-tier, entirely.** Every file listed is Sunrise code. A
fork cannot key these without editing them.

**Risk if skipped.** High, and the settings-cache case is a genuine data leak
with no database-side detection.

---

### Plane 4 — Temporal isolation

**Today.** Background work runs on a maintenance tick with eight registered
platform jobs (`lib/orchestration/maintenance/platform-jobs.ts:103-162`) plus a
fork-owned app-job registry (`lib/app/jobs.ts`). Every one issues **global,
unscoped queries**:

| Job                                               | Query shape                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `processDueSchedules()`                           | `aiWorkflowSchedule.findMany({ where: { isEnabled, nextRunAt lte } , take: 50 })`                                                    |
| `retention`                                       | `deleteMany` across conversations, webhook deliveries, hook deliveries, cost logs, admin audit, executions, evaluation sessions/runs |
| `pendingExecutionRecovery`                        | Global scan of pending executions                                                                                                    |
| `orphanSweep`, `zombieReaper`                     | Global lease reclamation                                                                                                             |
| `embeddingBackfill`                               | Global, batch-capped at 25                                                                                                           |
| `webhookRetries`, `hookRetries`, `evaluationRuns` | Global queues                                                                                                                        |

**Why MT breaks it.** Three separate problems:

1. **No tenant context to set.** These run outside any request. `withOrg()`
   requires an org id that does not exist here. The options are (a) run the tick
   on a `BYPASSRLS` role — which re-opens the hole the whole RLS design closed,
   and means a bug in the ticker is a cross-tenant bug; (b) loop tenants and open
   one `withOrg` transaction per tenant per job — correct but O(tenants × jobs)
   transactions per tick; (c) split jobs into genuinely global (lease
   reclamation) and per-tenant (retention, schedules) and apply (a) only to the
   former under audit.
2. **Fairness.** `take: 50` on due schedules and batch caps elsewhere are
   first-come-first-served across all tenants. One tenant with 50 due schedules
   starves every other tenant for that tick. Multi-tenant schedulers need
   per-tenant quotas or round-robin, which is a real algorithm change, not a
   parameter.
3. **Per-tenant policy.** Retention windows are per-agent
   (`aiAgent.retentionDays`) and per-data-class globals. Tenants on different
   plans, in different jurisdictions, need different windows — and a
   _deleteMany_ driven by a global cutoff will over-delete for one tenant and
   under-delete for another.

**What's required.** A tenant-aware job execution model: per-tenant iteration
with fairness, an explicit and audited privileged path for genuinely global
sweeps, per-tenant retention configuration, and observability that attributes
tick work to tenants.

**Owner.** **Platform-tier.** `platform-jobs.ts`, `scheduler.ts` and
`retention.ts` are Sunrise-owned. The `lib/app/jobs.ts` seam lets a fork _add_
jobs; it does nothing to make the existing eight tenant-aware.

**Risk if skipped.** High. The bypass-role option in particular converts every
background-job bug into a potential cross-tenant incident, and it is the option
a fork under time pressure will pick because it is the only one that works
without upstream changes.

---

### Plane 5 — External isolation

**Today.**

- **Object storage** (`lib/storage/`, providers: S3, Vercel Blob, local). Keys
  are caller-supplied opaque strings (`UploadOptions.key`, `providers/types.ts:15`).
  There is no org prefix convention, no per-tenant bucket or prefix policy, and
  `lib/storage/access-tokens.ts` mints HMAC-signed access URLs that carry no org
  claim. Postgres RLS cannot reach any of this.
- **Provider credentials.** Env-var only by design (documented as a security
  property in `.context/admin/orchestration-providers.md`). One set of API keys
  for the whole install.
- **Outbound.** Webhooks (`AiWebhookSubscription`), event hooks, email, and
  channel adapters (Slack/Twilio/WhatsApp/Postmark) all resolve from global
  config.
- **Vector index.** One pgvector index over `AiKnowledgeChunk` and
  `AiMessageEmbedding` for all tenants.
- **Logging/tracing.** `getFullContext()` (`lib/logging/context.ts:174`) carries
  `requestId`, `userId`, IP, endpoint — **no org**.
- **Backup/restore.** `lib/orchestration/backup/exporter.ts` does global
  `findMany` over agents, capabilities, workflows, webhook subscriptions and
  tags — it exports the whole install.

**Why MT breaks it.** Storage is the sharpest: a signed URL is a bearer token
with no tenant claim, so key-guessing or a leaked URL crosses tenants with no
database involvement. Credentials are the most commercially significant: one
shared API key means one tenant's spend and one tenant's abuse are everyone's.
Observability without an org field makes incident response guesswork.

**What's required.** Org-prefixed storage keys plus an enforcement point (not a
convention — a convention is a plane-2-style silent failure); org claims in
storage access tokens; per-tenant provider credentials (encrypted at rest,
rotatable, attributable) _or_ hard per-tenant quotas on the shared key; org in
the log/trace context; per-tenant backup and restore; a decision on vector index
partitioning at scale.

**Owner.** **Platform-tier** for storage keys, access tokens, log context and
the exporter. Per-tenant credential storage is a shared design (schema fork-owned,
resolution platform-owned).

**Risk if skipped.** Storage: high, and undetectable from the database.
Credentials: commercial rather than security, but existential for a paid
product.

---

### Control plane — authorization

**Today.** Single global binary admin. `role` is a free-form `String` on `User`
(`auth.prisma:24`), asserted via `withAdminAuth` (`lib/auth/guards.ts:180-221`),
`hasRole`/`requireRole`, and the admin-tree gate. `withAdminAuth` takes **no
resource context**, so it cannot scope even in principle.

Also: an `admin`-scoped `AiApiKey` **bypasses the role check entirely**
(`guards.ts:193-200`) — the key's scope _is_ the capability check, no session
and no `role: 'ADMIN'` required. Under MT that is an unconditional cross-tenant
capability.

**Tracked.** #366 proposes: injectable authorization decision, an optional
resource resolver on `withAdminAuth`, centralised `role` known-values, an org
dimension (or explicit platform-only declaration) for the `admin` API-key scope,
a decision on better-auth's `organization` plugin, and a control-plane section
in the playbook. #367 proposes the ownership-scope axis reusing the same
predicate.

**What the issues get right.** The three-axis model (operator tier / ownership
scope / tenant boundary), "reuse, don't parallel", and the observation from the
Daybreak fork that the predicate needs two faces — a boolean `canRead` and a
Prisma `where`-fragment `subjectScope` — kept in lockstep by a parity test.

**What is still missing from them.**

- **Impersonation.** Mentioned only parenthetically under the better-auth
  `admin`-plugin question. Vendor support staff accessing a tenant's data is a
  hard requirement of MT SaaS and needs its own design: consent model, time
  bounds, banner, and an audit trail distinguishable from the tenant's own
  actions.
- **Admin surface split as work, not docs.** #366 item 6 asks for a
  documentation mapping of platform-ops vs tenant-admin surfaces. The actual
  work is a second console: `app/admin/*` is one tree behind one guard, and
  splitting it is navigation, layout, routing and dozens of pages.
- **Read guards.** #367 says "the read guards" resolve the predicate, but
  `withAuth` has no resource parameter either. Scoping reads is the larger half.

**Owner.** Platform-tier (as both issues correctly argue).

**Risk if skipped.** Total for the product; both issues are blocked, so nothing
downstream of them can start.

---

### Commercial plane — metering, plans, quotas, billing

**Today.** Nothing. No payment integration, no plan or subscription model, no
entitlement checks. What exists is adjacent but not the same thing:

- `AiCostLog` with per-execution USD attribution, and `checkBudget()`
  (`llm/cost-tracker.ts:427`) enforcing a per-agent cap and one **global**
  monthly cap read from the settings singleton (`globalMonthlyBudgetUsd`,
  `orchestration-providers.prisma:174`).
- Rate limiting with four key strategies, **none of them org**
  (`rate-limit-policy.ts:44`).

**Why MT breaks it.** A multi-tenant platform without per-tenant metering has no
way to price, no way to stop one tenant consuming the shared LLM budget, and no
way to answer "what did this customer cost us." `globalMonthlyBudgetUsd` under MT
means the first tenant to spend it stops the platform for everyone.

**What's required.** Plan/entitlement model; per-tenant quota enforcement in the
rate-limit key space; metering rollups from `AiCostLog` to a billing period;
invoicing and payment integration; overage and hard-stop policy; usage surfaced
to the tenant admin.

**Owner.** Plans, invoicing and payment integration are **fork-owned** — this is
product, and forks will differ. But **the org dimension in the rate-limit key
space is platform-tier and currently impossible for a fork to add** (see §8).

**Risk if skipped.** No commercial product; and operationally, an unmetered
shared LLM budget is a denial-of-wallet vector.

---

### Cross-cutting: tenant identity, lifecycle and resolution

**Today.** No `Org` model, no membership, no org in session, no tenant
resolution anywhere in `proxy.ts` (which handles request id, security headers,
rate limiting, surface classification, auth redirects and origin validation).

Bootstrap is install-scoped: the first non-service user on a fresh database is
promoted to `ADMIN`, gated on an `AuthBootstrap` singleton
(`lib/auth/config.ts:201-236`). The setup wizard is likewise install-scoped.

**What's required.**

1. `Org` + `OrgMembership` with an org-role enum; the multi-org question decides
   whether this is platform- or fork-owned ([§6](#6-the-decision-gate)).
2. **Tenant resolution strategy** — subdomain, path prefix, custom domain, or
   token binding. Each has consequences: subdomains affect cookie scope, CORS,
   CSP and certificate management; path prefixes affect every route and every
   generated link; custom domains add a provisioning and TLS story. This
   decision propagates further than any other on the list and is not mentioned
   in the playbook or either issue.
3. Active org in session (better-auth custom session fields or the
   `organization` plugin) and org switching.
4. Org lifecycle: provision → invite → suspend → delete, with delete reusing the
   erasure dependency graph.
5. Per-org bootstrap: "first user in this org becomes its admin" — a per-org
   concept the install-scoped `AuthBootstrap` singleton cannot express.

**Owner.** Split, and the split depends on §6.

---

### Cross-cutting: privacy and GDPR

**Today.** `exportUserData()` and `eraseUser()` with a 34-entry
`SUBJECT_DATA_SOURCES` manifest, test-enforced against the schema
(`tests/unit/lib/privacy/export-sources.test.ts`), plus two fork seams —
`lib/app/data-export.ts` and the erasure-hook registry
(`lib/privacy/erasure-hooks.ts`). This is the strongest-engineered part of the
codebase for this purpose.

**What MT changes.**

1. **Controller/processor flip.** Single-tenant, the operator is the data
   controller. Multi-tenant, **the tenant is the controller and the platform
   operator is a processor.** That changes who answers a subject request, what
   the DPA must say, sub-processor disclosure obligations, breach notification
   routing, and whether the operator may lawfully read tenant data at all
   (which loops back to impersonation design). This is a legal-posture change,
   not an engineering one, and it is invisible in the code.
2. **Org-level export and erasure.** Tenant offboarding needs "export everything
   for org X" and "erase org X" — different queries from the per-subject ones,
   and org deletion must not erase a user who belongs to another org.
3. **Multi-org subjects.** If a user may belong to several orgs, a subject
   request against them spans controllers. The existing manifest has no way to
   express "this row belongs to org A's controller."
4. **Per-tenant retention.** As noted in plane 4.

**Owner.** Platform-tier for the manifest's org dimension and org-level
export/erase entry points. Legal posture is the fork's (it is the one with
customers).

**Risk if skipped.** Regulatory rather than technical, and therefore easy to
defer past the point where it is expensive to fix.

---

### Cross-cutting: assurance and testing

**Today.** 1,030 test files, none tenancy-aware. The RLS proof is a standalone
throwaway script not wired into CI. There is no lint rule requiring raw SQL to
be policy-covered, and no test that runs the suite as two tenants.

**Why this matters more than usual.** Tenant isolation is a security boundary
whose failures are silent, are invisible in single-tenant development, and
compound: one missed `orgId` on one child table leaks indefinitely until a
customer notices. Every other item in this document is a one-time cost; this one
is the control that keeps them fixed.

**What's required.**

- A **two-tenant integration harness**: seed two orgs, run the API surface as
  each, assert zero cross-visibility. Should cover the raw-SQL paths explicitly.
- A **policy-coverage test** that parses the schema, lists tenant-owned tables,
  and fails if any lacks RLS enabled + a policy — the same enforcement shape as
  `export-sources.test.ts`, which is the proven pattern in this repo.
- A **raw-SQL lint** that fails on `$queryRawUnsafe`/`$executeRawUnsafe` outside
  an allowlist, so a new raw query is a conscious decision.
- **Cache-tenancy review checklist** for plane 3.

**Owner.** Platform-tier. The harness benefits every fork and cannot be written
once per fork without duplicating the schema knowledge.

---

## 5A. Data handling, residency, and per-tenant storage flexibility

> **Verified against `c6b3e441` (main) on 2026-08-07.** This section and
> [§5B](#5b-provider-credentials-and-per-tenant-ai-configuration) were added
> after the original sweep to answer two questions asked directly of the
> platform: _can tenants be given control over where and how their data is
> stored_, and _can tenants bring their own AI providers and credentials_.

### The ask, split into three things that get conflated

"Tenants want control over their data" is nearly always three separate
requirements wearing one coat, and they have very different costs.

| #      | Requirement   | What it actually means                                                                               | Cost centre                |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| **A1** | **Assurance** | Answer a security questionnaire / DPA with accurate, evidenced statements about handling and storage | Documentation + telemetry  |
| **A2** | **Guarantee** | The isolation claimed in A1 is enforced by a mechanism, not by discipline                            | The five planes in §3      |
| **A3** | **Bespoke**   | This particular tenant's data physically lives somewhere they specify, under keys they hold          | Deployment topology matrix |

A1 and A2 are table stakes for any paid multi-tenant product and are largely
answered by finishing the work already in §5. **A3 is the expensive one, and it
is the one asked for here.** The rest of this section is mostly about A3.

### What the code assumes today

Every one of these is a single-install assumption. None of them is wrong for a
single-tenant deployment; all of them are load-bearing if a tenant wants their
own storage arrangement.

| Assumption                               | Evidence                                                                                                                                                                                                               | Consequence for A3                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **One database, one DSN**                | `lib/db/client.ts` — one `Pool` over `env.DATABASE_URL`, memoised on `globalThis`                                                                                                                                      | A per-tenant DSN needs a **pool registry**, not a wrapped client. Different change from `withOrg` |
| **One storage provider**                 | `getStorageClient()` (`lib/storage/client.ts:41`) caches one provider chosen from `process.env` on first call                                                                                                          | Per-tenant bucket/region/backend needs the same registry treatment                                |
| **Storage keys carry no owner**          | `avatars/${userId}/avatar.jpg` (`lib/storage/upload.ts:102`); `${prefix}${randomUUID()}` (`upload-to-storage.ts:296`)                                                                                                  | No org prefix to enforce, and nothing to authorise a signed URL against                           |
| **Signed URLs carry no tenant**          | `lib/storage/access-tokens.ts` — payload is `{ key, expiresAt }`; the module comment states key-binding _is_ the whole access-control model                                                                            | A leaked or guessed URL crosses tenants with the database uninvolved                              |
| **One install-wide signing key**         | `BETTER_AUTH_SECRET` signs sessions, email-change JWTs (`lib/auth/change-email.ts:82`), storage access tokens, **and** approval tokens (`lib/orchestration/approval-tokens.ts:34`)                                     | One secret, four blast radii. No per-tenant key material exists anywhere                          |
| **No encryption-at-rest primitive**      | No `createCipheriv`/`createDecipheriv`, no KMS/Vault/Secrets-Manager client anywhere in `lib/`. The only cryptographic secret handling is **one-way** SHA-256 (`AiApiKey.keyHash`, `lib/orchestration/mcp/auth.ts:44`) | Customer-managed keys are not a config change — the envelope layer does not exist                 |
| **One vector index**                     | Single pgvector index over `AiKnowledgeChunk` / `AiMessageEmbedding`                                                                                                                                                   | Residency claims must cover embeddings, which are derived copies of the source text               |
| **Global export**                        | `lib/orchestration/backup/exporter.ts` — unfiltered `findMany` over agents, capabilities, workflows, webhook subscriptions, tags                                                                                       | No per-tenant backup, therefore no per-tenant restore or DR story                                 |
| **Privacy entry points are per-subject** | `eraseUser()`, `exportUserData()`, `SUBJECT_DATA_SOURCES` (`lib/privacy/export-sources.ts`)                                                                                                                            | Art. 15/17 work exists and is enforced by test — but there is no org-level erase or export        |

The last row is worth pausing on, because it is the strongest existing asset.
The `SUBJECT_DATA_SOURCES` manifest with its schema-parsing test is exactly the
kind of enforced-completeness mechanism the rest of this section keeps asking
for. **An org-level equivalent is a smaller job than building it from nothing**
— it is the same manifest with a second dimension.

### The flexibility ladder

Storage flexibility is not a yes/no. It is a ladder, and each rung is a
distinct product tier with a distinct cost. Naming the rungs is what stops a
sales conversation promising rung 6 and engineering budgeting for rung 1.

**This ladder assumes one install made progressively more capable.**
[§5C.2](#5c2-the-alternative-cells-and-sunrise-is-already-one) sets out the
architecture that inverts it, under which rungs 2–4 stop being application work
at all. Read rung 3 alongside
[§5C.3(a)](#5c3-four-corrections-to-5a-and-5b) — as written here it overstates
what application-level encryption can do.

| Rung  | What the tenant gets                                | What Sunrise must build                                                                                                         | Industry precedent                                                                      | Verdict                            |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| **0** | Shared everything, isolation by RLS                 | §5 planes 1–5                                                                                                                   | Universal for self-serve SaaS                                                           | The baseline                       |
| **1** | Org-prefixed keys, org claim in signed URLs         | Enforced key prefix (not a convention); `org` in the access-token payload and the read route's check                            | Universal                                                                               | **Do this regardless**             |
| **2** | Own bucket and/or region (data residency)           | Per-tenant storage resolution: a registry keyed by org replacing the singleton; residency recorded on `Org`                     | Standard enterprise tier (region pinning is near-universal)                             | **Realistic**                      |
| **3** | Customer-managed encryption keys (BYOK/CMEK)        | Envelope encryption layer + per-tenant data keys wrapped by the tenant's KMS; key-revocation path ("crypto-shredding")          | Standard at the top of the market — Snowflake, Databricks, Salesforce Shield, Slack EKM | **Realistic but expensive**        |
| **4** | Own database (DSN per tenant)                       | Pool registry, migration fan-out, tenant→DSN routing, N backup schedules                                                        | Common at tens-of-tenants scale                                                         | **Realistic, operationally heavy** |
| **5** | Own deployment                                      | Nothing — **this is what Sunrise does today**                                                                                   | Universal for regulated/high-ARPU                                                       | **Already available**              |
| **6** | Arbitrary bespoke storage backend of their choosing | A storage abstraction general enough for any backend, plus per-backend migrations, backup, DR, retention, export, vector search | **Effectively no precedent at product scale**                                           | **Not realistic**                  |

### The honest answer on rung 6

**A general "bring your own storage system" promise is not a feature, it is a
product line.** The reason is not that the abstraction is hard to write — it is
that every storage topology multiplies work that is invisible at design time:

- **Migrations** fan out. Every schema change runs N times, and one tenant's
  failed migration is a support incident, not a rollback.
- **Backup and DR** fan out, and a tenant-supplied backend means their RPO/RTO
  is now partly their responsibility and wholly your liability.
- **Retention and pruning** (`.context/orchestration/retention.md`) currently
  runs per data class against one database. Per-backend it becomes N jobs with
  N failure modes and no shared observability.
- **Subject access and erasure** (`SUBJECT_DATA_SOURCES`) must reach every
  backend, or your Art. 15 answer is silently short — the exact failure the
  existing manifest test was built to prevent.
- **Vector search** is the sharpest: pgvector similarity search is raw SQL
  against a Postgres index (Appendix A). A tenant on a non-Postgres backend
  does not get the knowledge base, or gets a second implementation of it.
- **Incident response** across heterogeneous backends is guesswork, and it is
  precisely when you least want guesswork.

The industry does not solve this by generalising the storage layer. It solves
it by **tiering the deployment topology** — the pool / bridge / silo model in
[§9](#9-deployment-topologies). Rungs 2, 3 and 4 are how real products give
enterprise tenants meaningful control; rung 5 is the escape hatch for the
tenant who genuinely will not share infrastructure. Sunrise already ships
rung 5. That is a legitimate answer to a demanding tenant, not a cop-out, and
it is worth saying so in a sales conversation before agreeing to rung 6.

One genuine exception is worth knowing: **BYO bucket for the bulk data plane
only** — the tenant supplies an S3 bucket in their own cloud account, reached
via a cross-account role, and only uploaded documents and exports live there.
Metadata, embeddings and everything transactional stay in the shared database.
This is a real pattern, it is materially cheaper than rung 4, and it satisfies
a surprising share of "we must hold our own data" requirements because the
documents are what the tenant actually cares about. In Sunrise it is rung 2
with an outward-facing credential model, and it maps onto the existing
`StorageProvider` interface.

### The one change that keeps the ladder reachable

Nothing above needs deciding now. But one small change decides whether rungs
1–4 stay reachable or become a rewrite:

**`lib/storage/` already has the right shape.** `StorageProvider`
(`providers/types.ts`) is a clean interface with three implementations. The
only thing blocking per-tenant storage is that `getStorageClient()` resolves it
**once, from `process.env`, into module state**. Turning that into a resolver
that takes a context and consults a registry is a genuinely small, low-risk
change that costs a single-tenant install nothing — and it is the difference
between "add a rung" and "rework the storage layer".

The database side is not as lucky. `lib/db/client.ts` exports a client
instance, not a factory, and ~575 importers depend on that shape. The `withOrg`
wrapper in the playbook preserves it; a per-tenant DSN does not. **Rung 4 is a
different retrofit from the one the playbook describes**, and a fork that reads
the playbook and assumes database-per-tenant is a lighter variant of it will be
surprised. (§9 already makes the related point that DB-per-tenant removes the
_documented_ work while leaving the _undocumented_ work — planes 3, 4 and 5 —
completely intact.)

Both resolvers above take a context. **That context does not exist today** —
see [§5C.1](#5c1-the-prerequisite-there-is-no-tenant-context-to-pass) before
treating either as a small change.

### What "answer the questions" actually requires

Requirement A1 — being able to answer a security questionnaire honestly — is
mostly documentation, but each answer has a code dependency. This table is the
useful form of the requirement, because it converts a compliance ask into a
work list.

| Questionnaire item                           | Answerable today?               | Code dependency                                                                                              |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Encryption in transit                        | Yes                             | Deployment-level (TLS)                                                                                       |
| Encryption at rest                           | Yes, inherited from DB/bucket   | Nothing — but "inherited" is the honest wording, not "we encrypt"                                            |
| **Customer-managed keys**                    | **No**                          | Rung 3 — no envelope layer exists                                                                            |
| **Key management / rotation**                | **Partially, and weakly**       | One `BETTER_AUTH_SECRET` across four token types; rotation invalidates all four at once                      |
| **Data residency**                           | **Only at rung 5**              | Rung 2 (storage) + rung 4 (database)                                                                         |
| Tenant isolation mechanism                   | Documented, not built           | Planes 1–5                                                                                                   |
| **Deletion SLA (Art. 17)**                   | **Per user yes, per tenant no** | Org-level `eraseUser()` equivalent; the erasure graph already exists                                         |
| **Subject access (Art. 15)**                 | **Per user yes, per tenant no** | Org dimension on `SUBJECT_DATA_SOURCES`                                                                      |
| **Sub-processor disclosure**                 | **Install-wide only**           | Depends on per-tenant provider routing — see [§5B](#5b-provider-credentials-and-per-tenant-ai-configuration) |
| **Audit evidence per tenant**                | **No**                          | Org in `getFullContext()` (`lib/logging/context.ts:174`)                                                     |
| **Breach scoping ("whose data was in it?")** | **No**                          | Same — without org in the log context this is reconstruction, not lookup                                     |
| Backup and restore per tenant                | **No**                          | Per-org exporter                                                                                             |

Four of these — org in the log context, org-level erase/export, org-prefixed
storage keys, and an org claim in access tokens — are individually small and
collectively decide whether the compliance answers are evidenced or asserted.
**They are worth more per unit of effort than anything else in this section**,
and they are all platform-tier (§7).

### Verdict on the storage requirement

- **A1 (assurance)** — realistic, and the cheapest high-value work in this
  document. Mostly the four small platform items above.
- **A2 (guarantee)** — realistic; it is §5 in full, already scoped.
- **A3 (bespoke)** — realistic **up to rung 4**, and rung 5 already ships.
  Rung 6 should be declined, and declined early: the honest position is a
  published tier ladder ("shared → own region → own keys → own database → own
  deployment"), not an open-ended commitment to accommodate any storage system
  a tenant names. Publishing the ladder is itself a sales asset; it converts an
  unbounded question into a price list.

---

## 5B. Provider credentials and per-tenant AI configuration

### Three separable asks, and only one of them is hard

The provider requirement decomposes more favourably than the storage one.

| #      | Ask                                                                       | Status today                                               |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **B1** | Tenant chooses provider/model for specific agentic processes              | **Largely already possible** — the seam exists             |
| **B2** | Tenant supplies their own API credentials (possibly from their own vault) | **Blocked** — structurally, not incidentally               |
| **B3** | Tenant sets their own defaults, allowed models, and budget policy         | **Blocked by the two singletons** — the underestimated one |

### B1 — the good news, in detail

Sunrise already has a per-agent provider override seam and it is not a
vestigial one:

- `AiAgent.provider`, `AiAgent.model`, `AiAgent.fallbackProviders` and
  `AiAgent.providerConfig` (`prisma/schema/orchestration-agents.prisma:13-16`)
  are per-agent columns.
- `resolveAgentProviderAndModel()`
  (`lib/orchestration/llm/agent-resolver.ts`) implements an explicit contract:
  **an empty string means "inherit the system default"; an explicit value
  always wins.** Per-agent choice is not a special case bolted on — it is the
  primary path, with inheritance as the fallback.
- `AiAgent` is already classified **tenant-owned** in the playbook's model
  inventory. So once `orgId` lands on it, per-tenant agent-level provider and
  model selection comes along **for free**, with no new seam.

That is a genuinely strong starting position, and it is the direct answer to
"a tenant wants their own provider and model for certain agentic processes":
the _selection_ half of that requirement is already built. What is missing is
the _credential_ half (B2) and the _policy_ half (B3).

Two catches, both real:

- **`AiProviderConfig.name` and `.slug` are globally `@unique`**
  (`orchestration-providers.prisma:43-44`). Per-tenant provider rows need the
  plane-2 composite treatment (Appendix B), and until then two tenants cannot
  both have a provider called `openai`.
- **Agents reference providers by slug string**, resolved globally. A
  per-tenant provider row changes what that string resolves to, which is a
  resolution change, not just a schema change.

### B2 — what breaks, with evidence

| Mechanism                        | Evidence                                                                                                                                                                                        | Why per-tenant credentials break it                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Env-var-only key model**       | `AiProviderConfig.apiKeyEnvVar` stores the _name_; value read from `process.env` at request time (`provider-manager.ts:655-660`)                                                                | The process environment is install-wide. There is no per-tenant `process.env`. This is the wall                                                                                |
| **No reversible secret storage** | No cipher or KMS client anywhere in `lib/`; `AiApiKey.keyHash` and `mcp/auth.ts:44` are **one-way** SHA-256                                                                                     | Inbound keys are verified by hash — correct. An **outbound** provider key must be _recovered_, which hashing cannot do. Nothing in the codebase can store a recoverable secret |
| **Provider instance cache**      | `instanceCache: Map<slug, {provider, cachedAt}>`, 5-min TTL (`provider-manager.ts:71`)                                                                                                          | Keyed by slug alone. With per-tenant credentials this **serves tenant A's authenticated client to tenant B** — plane 3, invisible from the database                            |
| **Circuit breaker**              | `getBreaker(slug)` — module `Map` keyed by slug (`circuit-breaker.ts:183`)                                                                                                                      | With shared keys, one tenant's abuse trips everyone's breaker. With BYO keys it is simply wrong: A's quota exhaustion opens B's breaker against a healthy key                  |
| **In-flight counter**            | `lib/orchestration/llm/in-flight-counter.ts`, same keying                                                                                                                                       | Same failure; concurrency limits become cross-tenant                                                                                                                           |
| **Cost attribution**             | `AiCostLog` has **no** `userId` or `orgId`; attribution runs through nullable `agentId`/`conversationId`/`workflowExecutionId`, all `onDelete: SetNull` (`orchestration-providers.prisma:2-27`) | Deleting an agent **orphans its cost history**. Per-tenant billing on this table needs a column, not a join                                                                    |
| **Cost reports**                 | Raw `$queryRawUnsafe` aggregation (`llm/cost-reports.ts`, Appendix A)                                                                                                                           | Covered by RLS _if_ the table carries `orgId` — which it does not today                                                                                                        |
| **Model registry hydration**     | `model-registry-db-hydrate.ts`, process-global                                                                                                                                                  | Per-tenant model catalogues need keying                                                                                                                                        |

The env-var-only design is not an oversight — it is **documented as a security
property** (`.context/admin/orchestration-providers.md:177-189`): the UI never
accepts, stores, transmits or displays a raw key; an exported provider bundle
is safe to share; a static search for key-shaped literals is a valid control.
Per-tenant credentials **give up all four of those properties**. That is the
real trade, and it should be made deliberately rather than discovered.

### The four credential models, compared honestly

| Model                                                               | Tenant controls                      | Sunrise must build                                                                                        | Failure modes                                                                                                                               | Right when                                                      |
| ------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **A — Shared platform keys, per-tenant quotas**                     | Nothing; sees a usage limit          | Org dimension in the rate-limit key space + cost caps per org (`RateLimitKey` is a closed union — §8)     | One tenant's abuse is everyone's rate limit unless quotas are hard; margin risk is yours                                                    | Self-serve, low ARPU, you want the margin and the simplicity    |
| **B — Tenant keys encrypted in Sunrise's database**                 | Their own vendor account and billing | Envelope encryption, key rotation, per-tenant cache keying, redaction discipline, secure recovery UX      | **You become custodian of other companies' vendor credentials.** Breach impact escalates from "our data" to "our customers' cloud accounts" | Rarely the right first choice — see below                       |
| **C — Reference into the tenant's own secret manager**              | Everything; can revoke unilaterally  | A credential-resolver interface, per-tenant fetch with short TTL, failure handling when the vault is down | Runtime dependency on the tenant's infrastructure; a vault outage is an incident you are blamed for                                         | Enterprise tenants who already run Vault/KMS and asked for this |
| **D — Gateway with virtual keys** (LiteLLM, Portkey, Bedrock-style) | Their own account behind the gateway | Point the provider `baseUrl` at the gateway; per-tenant virtual key                                       | Another hop, another sub-processor to disclose, and in-process cost tracking must be reconciled against the gateway's                       | You want per-tenant routing quickly and can accept a vendor     |

A fifth option is deliberately absent from that table because it does not apply
to every provider: **workload identity federation**, which stores no secret at
all and is the best answer where it works —
[§5C.3(b)](#5c3-four-corrections-to-5a-and-5b).

**Model B is the trap.** It looks like the smallest change — add an encrypted
column, done — and it carries by far the largest liability increase in this
document. Holding a tenant's Anthropic or OpenAI key means a compromise of your
database is a compromise of their vendor account, their spend, and their data
at that vendor. It puts you inside their incident response and inside their
vendor's abuse investigation. It is a defensible choice, and plenty of products
make it, but it should be made with the envelope encryption, rotation and
audit story built **first**, not retrofitted after the first enterprise deal.

Where the industry actually lands, for what it's worth: **A for self-serve, D
for fast enterprise routing, C for tenants who ask by name, B when a product
has already invested in secret management.** BYO-key is common in AI SaaS; BYO-key
_stored in the vendor's own database with no envelope layer_ is common too, and
is a recurring source of incident reports.

### The seam that avoids choosing now

The choice does not have to be made to keep all four models reachable. What
has to change is **where the credential comes from**:

Today: `provider-manager.ts` reads `process.env[config.apiKeyEnvVar]` inline.
That single call site is the entire coupling.

A platform-tier `resolveProviderCredential(config, ctx)` — defaulting to
exactly today's `process.env` lookup — turns every model above into an
implementation of one interface. **The `ctx` in that signature does not exist
today** ([§5C.1](#5c1-the-prerequisite-there-is-no-tenant-context-to-pass)) —
that, not the resolver, is the work. Cost to a single-tenant install once the
context exists: one indirection and no behaviour change. Without it, each credential model is a
patch to a platform file and therefore a permanent merge conflict for the fork
that applies it (§8).

The **second** half of that seam matters just as much and is easier to forget:
the provider instance cache, the circuit breaker and the in-flight counter must
all be keyed on **(provider slug + credential identity)** rather than slug
alone. Miss it and per-tenant credentials produce a plane-3 cross-tenant leak
that no database-level test can detect — risk #2 in [§11](#11-risk-register),
in its most concrete form.

### B3 — the underestimated one

Per-tenant _policy_ is harder than per-tenant _credentials_, and it is usually
discovered late:

- `AiOrchestrationSettings` is a singleton (`slug @unique @default("global")`,
  `orchestration-providers.prisma:169-171`). It holds `defaultModels`,
  `activeEmbeddingModelId` and `globalMonthlyBudgetUsd`.
- Every reader is written on "there is exactly one row", including the TTL
  process cache in `settings-resolver.ts` and the one in
  `lib/orchestration/settings.ts`.
- `activeEmbeddingModelId` is the sharpest: it names the model whose
  **dimension the vector columns are sized for**. Per-tenant embedding models
  are not a settings change — they are a schema and index question, because two
  tenants on different embedding models need differently-shaped vectors.

So "a tenant sets their own default models and budget" means de-singletoning
`AiOrchestrationSettings`, re-keying two caches, solving **cross-instance cache
invalidation** ([§5C.3(d)](#5c3-four-corrections-to-5a-and-5b)), and taking a
position on per-tenant embedding dimensions. §6 already flags the singletons; this is the
concrete form of that warning.

### Verdict on the provider requirement

- **B1 (per-agent provider/model choice)** — **realistic and mostly done.**
  The seam exists, is deliberate, and inherits tenancy from `AiAgent`'s `orgId`.
  The remaining work is the plane-2 composite on provider slugs.
- **B2 (tenant credentials)** — **realistic, but it is a security-posture
  decision rather than a feature.** Model D is the fastest credible route;
  model C is the best answer for tenants who asked for this by name; model B
  should not be the default. The credential-resolver seam plus cache re-keying
  is the platform-tier work that keeps all of them open.
- **B3 (tenant defaults and budget policy)** — **realistic but larger than it
  looks**, and it is the one most likely to be promised casually. Budget it
  with the singleton work, not with the credential work.

Both B2 and B3 also feed §5A's compliance table: a tenant asking "which
sub-processors touch our data?" cannot be answered install-wide once tenants
route to different providers, and cannot be answered at all without org in the
log and cost records.

---

## 5C. The prerequisite §5A and §5B assume, and the architecture they don't consider

> **Verified against `c6b3e441` (main) on 2026-08-07.** §5A and §5B both answer
> the question _"how do we make **this install** more flexible?"_ That question
> has a prerequisite they gloss over and an alternative they never raise. Both
> are larger than anything either section proposes, and both change what the
> first commit should be. This section exists because the seam-shaped answers
> in §5A/§5B are the **last mile** of the work, and reading them as the whole
> path will produce a plan that cannot be started.

### 5C.1 The prerequisite: there is no tenant context to pass

Every seam proposed in §5A and §5B has the shape `f(config, ctx)` — a storage
resolver that takes a context, a credential resolver that takes a context, a
cache keyed on the context's org. **No such context exists, and adding one is a
platform-wide change to how identity flows.**

Verified: there is **no `AsyncLocalStorage` anywhere in the codebase.**
`lib/logging/context.ts` — the closest thing to a request context — calls Next's
`headers()` on each invocation and returns `requestId`, `userId`, IP and
endpoint. That works inside a Next request and is unavailable everywhere else.

There are three distinct call-stack classes and they need three different
answers. Treating them as one is the mistake to avoid.

| Call stack                             | Has a session?                  | Where context must come from                                                                                                   |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **HTTP → route handler**               | Yes                             | `withAuth()` / `withAdminAuth()` (`lib/auth/guards.ts:88,167`) — they already wrap every route and already resolve the session |
| **Background jobs**                    | **No** — no request, no session | The **job record**, not ambient state. `run-tick.ts` is a single global tick guarded by a module-level `tickRunning` flag      |
| **Server components / server actions** | Yes, via `headers()`            | Same ALS store, established at the segment boundary                                                                            |

Two specifics worth stating because they are easy to get wrong:

- **`proxy.ts` is the wrong place to establish it.** Next runs the proxy as a
  separate invocation from the route handler; an `AsyncLocalStorage` store
  entered there does not survive into the handler. `proxy.ts` is the right place
  to _resolve_ the tenant (from subdomain, path or token) and pass it forward as
  a header — it is the wrong place to _hold_ it.
- **`lib/auth/guards.ts` is the natural entry point** and this is the one piece
  of good news in this subsection. Every API route already goes through
  `withAuth`/`withAdminAuth`; they already do the session lookup that would
  produce the org. Establishing the ALS store there covers the entire HTTP
  surface with two edits — and those two files are already platform-tier and
  already in scope for #366/#367.

**Background jobs get no ambient answer at all.** `run-tick.ts` runs one global
tick with a module-level overlap guard; `platform-jobs.ts` runs each task once
per interval across the whole install; the dev-mode driver is a `setInterval` in
`instrumentation.ts`. None of these has a tenant, and none can acquire one from
context. They need either per-tenant job rows or an explicit
tenant loop with the context set per iteration — which is the same conclusion
§5 reaches for plane 4, arrived at from the other direction, and it is why §10
insists phases 3 and 4 land together.

**The honest cost.** Ambient context is not free and its failure mode is bad:
context that is silently absent reads as "no tenant" rather than failing, which
is exactly the class of bug RLS was chosen to prevent. Mitigate it the same way
the template already mitigates the tenancy seam — **make the resolver throw when
`TENANCY_MODE=multi` and no context is set**, mirroring the existing guard in
`lib/db/client.ts:35-42`. Fail loud, not open.

**Verdict.** This is the first item of real work, before any seam in §5A or §5B.
Platform-tier, and not currently in the §7 matrix or any tracked issue.

### 5C.2 The alternative: cells, and Sunrise is already one

§5A frames storage flexibility as a ladder: one install, made progressively more
capable, with "own deployment" at the top as an escape hatch. **The architecture
large B2B platforms actually use for these requirements inverts that.** A thin
**control plane** (tenant registry, routing, identity, billing, provisioning)
sits in front of N independent **data-plane cells**, each a complete, ordinary
install. Tenant→cell placement is a routing decision, not an application
feature. Slack, Salesforce, Shopify (pods) and AWS itself are built this way.

The implication for this document is uncomfortable and should be said plainly:

**Sunrise's single-tenant install is already a well-formed cell.** One
`DATABASE_URL`, one storage provider, one environment, one set of provider keys,
`TENANCY_MODE=single`, no tenancy machinery to build. What is missing is not in
Sunrise and arguably should never be in Sunrise — it is the control plane, which
is a separate service.

Under that framing, §5A's expensive rungs stop being application work:

| §5A rung                      | As an application feature (pooled)                                             | As a cell property                                  |
| ----------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| **2** — own region / bucket   | Per-tenant storage registry, residency on `Org`                                | The cell runs in that region                        |
| **3** — customer-managed keys | Envelope encryption layer, per-tenant DEKs, rotation                           | The cell's database/bucket uses their KMS key       |
| **4** — own database          | Pool registry, DSN routing, migration fan-out                                  | The cell **is** their database                      |
| **B2** — own provider keys    | Credential resolver, cache re-keying, custody risk                             | The cell's `process.env` — today's model, unchanged |
| **B3** — own defaults/budget  | De-singleton `AiOrchestrationSettings`, keyed caches, distributed invalidation | The cell's singleton **is** their singleton         |

That last row is the striking one. **Per-tenant defaults, budgets and embedding
models — §5B's hardest item — are free in a cell and expensive in a pooled
install.** Same for provider credentials: the env-var-only security model §5B has
to trade away survives intact, because each cell has its own environment.

**What cells cost, honestly.**

- **The control plane is a whole system** — tenant registry, routing, cell
  placement, cross-cell identity, aggregated billing, and its own security
  boundary. It does not exist and Sunrise does not contain it.
- **Fixed cost per cell.** Bad economics below a certain ARPU. A hundred
  £20/month tenants cannot each have a Postgres instance.
- **Provisioning automation is a prerequisite, not a nice-to-have.** Cells only
  work if creating one is a pipeline (IaC + migration + seed + DNS + secrets),
  not a runbook. Sunrise ships Docker deployment; it does not ship that pipeline.
- **Upgrade fan-out.** Every release deploys N times, and version skew across
  cells becomes a support dimension.
- **Cross-cell reporting** — "usage across all tenants" needs its own
  aggregation layer, since no single database holds it.

**Where each wins.**

| Situation                                                        | Better fit       | Why                                                               |
| ---------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Many small tenants, self-serve signup, low ARPU                  | **Pooled + RLS** | Cell fixed cost dominates; §5's work amortises across all tenants |
| Few large tenants demanding residency, own keys, own database    | **Cells**        | Those are exactly the rungs cells give away for free              |
| Mixed market with an enterprise tier                             | **Bridge** (§9)  | Pooled cell for self-serve, dedicated cells above a threshold     |
| Regulated tenants who will not share infrastructure at any price | **Cells**        | The only answer; pooled RLS cannot be argued into acceptability   |

**The implication for sequencing.** The tenants driving the §5A requirement —
the ones asking for bespoke storage and their own keys — are the tenant profile
**cells serve best and pooled RLS serves worst**. That question should be
answered before §10's Phase 2, because the two paths diverge exactly there:
pooled needs `Org`/`OrgMembership` inside the app, cells need a tenant registry
outside it. Building the former and then choosing cells wastes phases 2–5.

This is **not** an argument against the playbook. Pooled RLS remains correct for
the self-serve case, and the bridge topology needs both. It is an argument
against treating the pooled retrofit as the default answer to a requirement that
arrived from an enterprise tenant.

### 5C.3 Four corrections to §5A and §5B

**(a) Encryption and searchability are in direct tension.** §5A's rung 3
("customer-managed keys") is misleading as written. Application-level envelope
encryption means the encrypted columns cannot be indexed, matched with `LIKE`, or
searched with pgvector — which removes the knowledge base outright, since
similarity search is raw SQL over a vector index (Appendix A). What satisfies
nearly every auditor is **volume-level encryption with a customer-managed KMS
key**, which RDS, Aurora and Cloud SQL all offer natively and which requires no
application change at all. Reserve application-level encryption for narrow
fields that are never queried. Read rung 3 as "customer-managed key on managed
storage", not "we encrypt the columns".

**(b) The best credential model is not in §5B's table.** All four options there
assume Sunrise ends up holding, referencing or proxying a secret. **Workload
identity federation** avoids the secret entirely: the tenant grants your workload
a role in their own cloud, and you exchange a short-lived token per request
(AWS `AssumeRoleWithWebIdentity`, GCP Workload Identity Federation, Azure
federated credentials). Nothing long-lived is stored, so the custody risk in
§5B — risk #7 in [§11](#11-risk-register) — does not exist. This works **today
for Bedrock and Vertex**. It does **not** work for the Anthropic and OpenAI
direct APIs, which authenticate with static keys; for those tenants §5B's
four-model comparison stands unchanged. If per-tenant credentials matter more
than provider choice, routing enterprise tenants through Bedrock/Vertex is a
cheaper answer than building a credential vault.

**(c) A gateway deletes problems rather than fixing them.** §5B files the
gateway as "option D, accept a vendor". The stronger case: the provider instance
cache, the circuit breaker, the in-flight counter and `AiCostLog` attribution are
each broken under tenancy **because Sunrise does provider management in-process**.
Extracting that into a gateway (self-hosted LiteLLM, or a purpose-built service)
removes all four at once instead of re-keying each — and makes the gateway the
billing source of truth, which also resolves the `onDelete: SetNull` orphaning
that makes `AiCostLog` unusable for invoicing. That is an architectural decision,
not a procurement shortcut. Cost: a network hop, a component to operate, a
sub-processor to disclose, and cost figures that must be reconciled rather than
computed.

**(d) Per-tenant config needs distributed cache invalidation.** §5B says
de-singletoning `AiOrchestrationSettings` means adding `orgId` and re-keying
caches. It also means solving invalidation across instances. Today's TTL caches
(`settings-resolver.ts`, `lib/orchestration/settings.ts`) are safe because config
is global and 30 seconds of staleness is invisible; per-tenant config edited by
per-tenant admins makes staleness visible and attributable. That needs Postgres
`LISTEN/NOTIFY` or Redis pub/sub — new infrastructure. There is precedent for
adding it optionally: `lib/security/rate-limit-stores/redis.ts` is a
dynamically-loaded store enabled by `RATE_LIMIT_STORE=redis`, with `ioredis` kept
out of `package.json`. Related: per-tenant **embedding dimensions** are not a
settings problem — the clean answer at that point is usually an external vector
store with per-tenant namespaces rather than a shared pgvector column.

### 5C.4 What this does to the first-work list

§5A and §5B each end with a verdict. Those verdicts are unchanged; their
**ordering** is not. Read against this section, the honest first-work list is:

| Order  | Work                                                                                                                                         | Why first                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **0**  | **Answer cells-vs-pooled** ([§5C.2](#5c2-the-alternative-cells-and-sunrise-is-already-one))                                                  | Changes whether phases 2–5 of §10 are the right work at all  |
| **1**  | **The four cheap compliance items** (§5A: org in log context, org-level erase/export, org-prefixed storage keys, org claim in access tokens) | Valuable under **both** answers, and the only items that are |
| **2**  | **The tenant-context primitive** ([§5C.1](#5c1-the-prerequisite-there-is-no-tenant-context-to-pass))                                         | Pooled only — but every seam in §5A/§5B is blocked on it     |
| **3**  | §10 phases 1–5 as written                                                                                                                    | Pooled only                                                  |
| **3′** | Provisioning pipeline + control plane                                                                                                        | Cells only — and mostly **outside this repository**          |

Item 1 is deliberately placed above item 0: those four items are worth doing
before the architectural question is settled, because they are needed under
either answer and they are what turns compliance answers from asserted into
evidenced.

---

## 6. The decision gate

Recorded on #366 and blocking both issues:

> **Can a user belong to more than one org?**

- **Yes** → adopt better-auth's `organization` plugin. You need its membership
  table and org switching, and the cost is real: adopting its table names and
  role vocabulary, and reconciling with Sunrise's existing hand-rolled
  invitation system — a collision, not a merge. `OrgMembership` becomes
  **platform-owned**.
- **No** → hand-roll. `orgId` on tenant-owned models plus a
  `resolveAdminScope(session)` predicate. Sunrise already ships working
  invitations; the plugin would replace working code to gain nothing.
  `OrgMembership` stays **fork-owned**.

Nothing downstream can be sized until this is answered.

### Four more decisions that gate almost as much

| Decision                                                                          | Propagates to                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tenant resolution**: subdomain / path / custom domain / token binding           | Cookies, CORS, CSP, TLS, every generated URL, all slug routes                                                                                                      |
| **Config sharing**: which of the eight admin-authored global models go per-tenant | The two singletons, seeding, backup, the admin console split ([§5B](#5b-provider-credentials-and-per-tenant-ai-configuration))                                     |
| **Credential model**: shared provider keys with quotas vs per-tenant BYO keys     | Cost attribution, encryption at rest, breaker/counter keying — four options compared in [§5B](#5b-provider-credentials-and-per-tenant-ai-configuration)            |
| **Isolation topology**: pooled DB vs schema-per-tenant vs DB-per-tenant           | Whether planes 1–2 exist at all ([§9](#9-deployment-topologies)); also the storage ladder in [§5A](#5a-data-handling-residency-and-per-tenant-storage-flexibility) |

The config-sharing decision deserves emphasis because the playbook makes it look
smaller than it is. Leaving `AiProviderConfig`, `AiCapability`, `FeatureFlag`
and friends global is the right _default_. But the two singletons —
`AiOrchestrationSettings` (`slug @default("global")`) and `McpServerConfig`
(same) — are not columns you can add an `orgId` to. Every reader is written on
"there is exactly one row," including the 30-second process cache in
`lib/orchestration/settings.ts`. Converting a singleton to a per-org row touches
every call site _and_ every cache that memoised it.

---

## 7. Ownership: platform-tier vs fork-tier

This is the matrix that decides whether the retrofit is sustainable. Anything
marked **Platform** that a fork implements locally becomes a merge conflict on
every upstream sync.

| Item                                               | Owner       | Rationale                                                                                                                         |
| -------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Org` / `OrgMembership` model                      | Depends     | Decided by §6's multi-org question                                                                                                |
| Org-role vocabulary, invitations UI, billing       | Fork        | Product-specific                                                                                                                  |
| `orgId` columns + RLS migration                    | Fork        | Rides the fork's schema                                                                                                           |
| Authorization predicate + guard signatures         | Platform    | `lib/auth/guards.ts`, `utils.ts` — #366                                                                                           |
| `role` known-values constant                       | Platform    | Same files — #366                                                                                                                 |
| Ownership-scope resolver                           | Platform    | Shared predicate — #367                                                                                                           |
| Admin API-key scope org dimension                  | Platform    | `guards.ts:193-200`                                                                                                               |
| Slug-route resolution redesign                     | Platform    | `app/api/v1/{chat,inbound,webhooks}/**`                                                                                           |
| Unique-constraint composites                       | Fork        | Rides the `orgId` migration                                                                                                       |
| Process-cache keying (plane 3)                     | Platform    | 20+ Sunrise-owned modules                                                                                                         |
| Background-job tenancy + fairness (plane 4)        | Platform    | `platform-jobs.ts`, `scheduler.ts`, `retention.ts`                                                                                |
| Rate-limit `org` key                               | Platform    | `RateLimitKey` is a closed union — see below                                                                                      |
| Storage key scoping + token org claim              | Platform    | `lib/storage/**`                                                                                                                  |
| Per-tenant provider credentials                    | Split       | Schema fork-owned; resolution platform-owned                                                                                      |
| Provider credential resolver seam                  | Platform    | `provider-manager.ts` — the `process.env` call site ([§5B](#5b-provider-credentials-and-per-tenant-ai-configuration))             |
| Provider cache / breaker / counter re-keying       | Platform    | Must key on credential identity, not slug alone                                                                                   |
| Per-tenant storage + DSN resolution registry       | Platform    | `lib/storage/client.ts`, `lib/db/client.ts` singletons ([§5A](#5a-data-handling-residency-and-per-tenant-storage-flexibility))    |
| Tenant-context primitive (ALS + job context)       | Platform    | `lib/auth/guards.ts`, `run-tick.ts` — blocks every seam above ([§5C.1](#5c1-the-prerequisite-there-is-no-tenant-context-to-pass)) |
| Cross-instance cache invalidation                  | Platform    | Per-tenant config makes staleness visible ([§5C.3](#5c3-four-corrections-to-5a-and-5b))                                           |
| Control plane + cell provisioning pipeline         | **Neither** | Outside this repository entirely ([§5C.2](#5c2-the-alternative-cells-and-sunrise-is-already-one))                                 |
| Plans, metering rollups, invoicing                 | Fork        | Product                                                                                                                           |
| Org in log/trace context                           | Platform    | `lib/logging/context.ts`                                                                                                          |
| Org-level export/erase entry points                | Platform    | `lib/privacy/**`                                                                                                                  |
| Two-tenant leakage harness + policy-coverage test  | Platform    | Benefits every fork; needs schema knowledge                                                                                       |
| Admin console split (platform-ops vs tenant-admin) | Platform    | `app/admin/**` is one tree behind one guard                                                                                       |
| Tenant resolution in `proxy.ts`                    | Platform    | Root-level request pipeline                                                                                                       |

**Nineteen of twenty-six rows are platform-tier.** Two of them — #366 and #367
— are tracked. The other seventeen are not. One row belongs to neither tier:
the control plane a cell architecture needs is a separate system, not a change
to this one.

---

## 8. Downstream fork considerations

Sunrise has a three-level fork topology and two reserved namespace tiers:

```
Sunrise (platform)
  └── framework fork          e.g. Daybreak     → lib/framework/, .context/framework/, prisma/schema/framework-*.prisma, framework_ table prefix
        └── leaf fork          e.g. ConQuest     → lib/app/, .context/app/, prisma/schema/app.prisma
```

Both tiers ship **empty** upstream, which is what lets a fork's files there
merge cleanly forever. Multi-tenancy is the hardest test of that model so far,
because it is the first capability that genuinely needs to reach into platform
files.

### The merge-conflict surface, concretely

If a fork implements MT today without upstream changes, it must edit these
Sunrise-owned files. Each becomes a conflict on every sync:

| File                                             | Why the fork must edit it                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `lib/db/client.ts`                               | Replace the guard with `withOrg` — **this one is sanctioned**                                |
| `lib/auth/guards.ts`                             | Org-aware `withAdminAuth` / `withAuth` — #366/#367                                           |
| `lib/auth/utils.ts`                              | `hasRole` / `requireRole` — #366                                                             |
| `lib/auth/config.ts`                             | Org in session, per-org bootstrap                                                            |
| `lib/security/rate-limit-policy.ts`              | Add `'org'` to `RateLimitKey` — see below                                                    |
| `lib/security/rate-limit-middleware.ts`          | Resolve the new key in the `switch` at line 250                                              |
| `lib/orchestration/settings.ts`                  | De-singleton + re-key the cache                                                              |
| `lib/orchestration/llm/settings-resolver.ts`     | Same                                                                                         |
| `lib/orchestration/llm/circuit-breaker.ts`       | Key breakers by org                                                                          |
| `lib/orchestration/llm/in-flight-counter.ts`     | Key counters by org                                                                          |
| `lib/orchestration/maintenance/platform-jobs.ts` | Tenant-aware iteration                                                                       |
| `lib/orchestration/scheduling/scheduler.ts`      | Per-tenant fairness                                                                          |
| `lib/orchestration/retention.ts`                 | Per-tenant windows                                                                           |
| `lib/storage/client.ts`, `access-tokens.ts`      | Key prefixing, org claim                                                                     |
| `lib/logging/context.ts`                         | Org in context                                                                               |
| `lib/orchestration/backup/exporter.ts`           | Per-org export                                                                               |
| `app/api/v1/{chat,inbound,webhooks}/**`          | Tenant-aware slug resolution                                                                 |
| `app/admin/**`                                   | Console split                                                                                |
| `proxy.ts`                                       | Tenant resolution                                                                            |
| `prisma/schema/*.prisma`                         | `orgId` + composite uniques — **sanctioned via fork schema files** but core files change too |

Only two of these are sanctioned fork edits. The rest are the merge fight
#347/#350/#366/#367 exist to prevent.

### The `RateLimitKey` case study

Worth singling out, because it shows how a _good_ seam can still be closed to
the case that matters.

`lib/app/rate-limit.ts` is a fork-owned registry seam. A fork can call
`registerRateLimitTier()` and `registerRateLimitRule()` — genuinely useful, and
listed in `VERSIONING.md`'s public surface. But:

```ts
// lib/security/rate-limit-policy.ts:44
export type RateLimitKey = 'ip' | 'session-user' | 'api-key' | 'embed-token';
```

`tier` is deliberately open (`RateLimitTier | (string & {})`). **`key` is a
closed union**, and it is consumed by a `switch` in
`lib/security/rate-limit-middleware.ts:250`. So a fork can register an org-scoped
_rule_ but cannot express an org-scoped _key_ — the exact thing per-tenant quota
enforcement requires. The seam is one type-widening and one registry away from
covering it.

**Generalisable lesson: a registry seam is only as open as its narrowest type.**
Worth auditing the other seams in `VERSIONING.md` for the same pattern before
declaring them fork-ready.

### Seam design principles

Distilled from the Daybreak fork's `canRead` / `subjectScope` work (documented
on #367) and from what the plane analysis implies:

1. **Async from day one.** Even where today's implementation is synchronous, a
   real team/grant lookup hits the database. Making the predicate
   `Promise`-returning up front avoids a sync→async sweep of every call site
   later.
2. **Two faces, one policy.** A row predicate (`canRead`) and a `where`-fragment
   (`subjectScope`) must be derivable from the same policy, with a parity test
   asserting they agree for every principal/resource pairing. A code review in
   Daybreak caught these diverging for admin-support viewers — build the parity
   into the API rather than leaving callers to reconcile.
3. **Open struct, not positional args.** `{ ownership?, tier?, org? }` means
   widening `own → team → all` or adding the tier axis is supplying an input to
   an existing predicate, not a signature change.
4. **Inert by default.** Same philosophy as `TENANCY_MODE`: at `single` the seam
   is a no-op and single-tenant installs pay nothing. This is what makes
   platform-tier seams politically cheap to land.
5. **Chokepoint, not sweep.** `lib/db/client.ts` is the model: one module,
   ~575 inheritors. Where a chokepoint already exists, widen it; do not add a
   parallel path.
6. **Fail closed, and fail loud.** The `TENANCY_MODE=multi` throw is the right
   pattern — a half-finished retrofit should refuse to boot rather than run
   unscoped.
7. **Enforce inventories with tests, not prose.** See [§12](#12-documentation-drift).

### Guidance for fork authors, today

**Do now, safely:**

- Build the ownership-scope layer fork-locally in its final generic shape (the
  Daybreak pattern), so delegating to the upstream resolver later is a deletion.
- Keep `orgId` additions in your own schema files where the fork tiers allow.
- Namespace your storage keys by org from the first upload, even without
  enforcement — retrofitting key layout across existing objects is painful.
- Put org in your own log context wrappers.
- Write the two-tenant leakage harness early. It is the cheapest thing on this
  list and the only one that catches regressions in all the others.

**Wait for upstream, or accept a permanent conflict:**

- Guard signatures and the authorization predicate (#366/#367).
- Rate-limit key space.
- Process-cache keying and background-job tenancy.
- Slug-route resolution.

**Do not:**

- Do not fork `lib/auth/guards.ts`. It is the single chokepoint that makes the
  eventual upstream seam a drop-in; a local copy converts a one-line future
  change into a permanent divergence.
- Do not reflexively add `orgId` to the admin-authored global config models. The
  playbook is right that this is a product decision per model, and the
  reflexive sweep creates work that is hard to reverse.
- Do not run background jobs on a `BYPASSRLS` role without an explicit, audited,
  documented decision — it is the path of least resistance and it silently
  undoes the isolation guarantee.
- Do not put tenancy machinery in `lib/app/` if you are a **framework** fork.
  That tier belongs to your leaf forks; use `lib/framework/`.

### Fork-first informs upstream

The working model demonstrated on #367 is worth stating as policy: a fork that
needs a seam before it lands builds it **in its final generic shape** locally,
then feeds the contract back so the upstream version composes down cleanly. The
fork gets unblocked, upstream gets a design validated against real use rather
than speculation, and the eventual migration is a delegation plus a deletion.

The prerequisite is that the fork resists the temptation to build the _specific_
thing it needs. `canRead(viewer, subject, scope)` with an unused `tier` field is
harder to write than `isOwner(userId, row)` and is the reason the contract
transfers.

---

## 9. Deployment topologies

Worth stating plainly, because "make Sunrise multi-tenant" often means "avoid
running many instances" and that trade is not obviously in MT's favour.

| Topology                            | Isolation planes needed   | Cost                                                         | Good fit                                          |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| **Instance per tenant** (today)     | none                      | N deployments, N databases, N upgrade windows                | Few, large, high-trust tenants; regulated markets |
| **Database per tenant, shared app** | 3, 4, 5 (not 1, 2)        | Connection management, N migrations, tenant→DSN routing      | Tens of tenants; strong isolation story to sell   |
| **Schema per tenant, shared DB**    | 3, 4, 5 (mostly not 1, 2) | `search_path` discipline, migration fan-out, catalogue bloat | Hundreds of tenants; middle ground                |
| **Pooled, RLS** (playbook's target) | **all five**              | Everything in §5                                             | Many small tenants; self-serve signup; low ARPU   |
| **Bridge** (pooled + siloed tier)   | all five, twice           | Both models maintained simultaneously                        | Mixed market with an enterprise tier              |

Two observations:

- **Database-per-tenant eliminates planes 1 and 2 entirely** — the two the
  playbook and the constraint sweep address — at the cost of operational fan-out.
  Planes 3, 4 and 5 remain, and are the _untracked_ ones. So it reduces the
  documented work while leaving the undocumented work intact. Forks choosing it
  on the strength of the playbook alone will be surprised.
- **The "instance per tenant" row is the cell model without a control plane.**
  Add one — tenant registry, routing, provisioning pipeline — and the row turns
  from an operational burden into an architecture that hands you §5A's rungs
  2–4 and §5B's B2/B3 without building any of them.
  [§5C.2](#5c2-the-alternative-cells-and-sunrise-is-already-one).
- **Instance-per-tenant remains the right answer for a lot of forks**, and is
  Sunrise's current recommendation. The retrofit is justified by tenant count and
  self-serve signup, not by preference.

---

## 10. Sequencing shape

Not a commitment; the dependency order if it were built.

**Phase −1 — The topology question.** Pooled-vs-cells
([§5C.2](#5c2-the-alternative-cells-and-sunrise-is-already-one)). It precedes
every decision below, because under a cell answer phases 2–5 are not the right
work.

**Phase 0 — Decisions.** §6's five decisions. Nothing below can be sized first.

**Phase 0.5 — The tenant-context primitive.**
[§5C.1](#5c1-the-prerequisite-there-is-no-tenant-context-to-pass). Absent from
the original sweep and blocking every seam in §5A/§5B.
`withAuth`/`withAdminAuth` covers the whole HTTP surface in two edits;
background jobs get no ambient answer and need an explicit per-job context.

**Phase 1 — Control plane (unblocks everything).** #366 + #367: injectable
predicate, resource resolver, `role` constants, API-key scope decision.
Delivers value at `TENANCY_MODE=single` for bespoke single-tenant forks — which
is why the #366 comment argues for decoupling it from tenancy mode, and why it
is the cheapest place to start.

**Phase 2 — Tenant identity.** `Org`/`OrgMembership`, session, resolution
strategy, lifecycle, per-org bootstrap.

**Phase 3 — Row + namespace planes.** `orgId` columns, RLS migration, role
split, composite uniques, slug-route redesign. **Phases 3 and 4 must land
together** — a scheduler running on a bypass role while RLS is enabled is worse
than either alone, because it looks isolated and is not.

**Phase 4 — Temporal + process planes.** Job tenancy and fairness, cache keying,
breaker/counter policy, singleton de-singletoning.

**Phase 5 — External plane.** Storage keys and token claims, per-tenant
credentials, log/trace org, per-org backup. The four cheap, high-value items
from [§5A](#5a-data-handling-residency-and-per-tenant-storage-flexibility) —
org in the log context, org-level erase/export, org-prefixed storage keys, org
claim in access tokens — can and should be pulled forward; they are the
difference between compliance answers that are evidenced and ones that are
asserted. Rungs 2–4 of the storage ladder and credential models C/D are
product-tier decisions that hang off this phase, not prerequisites for it.

**Phase 6 — Commercial plane.** Plans, quotas in the rate-limit key space,
metering rollups, invoicing.

**Phase 7 — Admin console split and impersonation.**

**Continuous — Assurance.** The two-tenant harness and the policy-coverage test
should land _with Phase 3_, not after. They are the only defence against every
subsequent phase silently regressing the boundary.

---

## 11. Risk register

Ranked by (impact × likelihood × how long it stays undetected).

| #   | Risk                                                                                                   | Plane | Detectability                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Background jobs run on a bypass role; a job bug crosses tenants                                        | 4     | **None** — looks correct, is not                                                                                                                                                                       |
| 2   | Process cache serves tenant A's config to tenant B                                                     | 3     | **None from the database**                                                                                                                                                                             |
| 3   | Per-tenant provider credentials cached by slug alone — tenant A's authenticated client serves tenant B | 3     | **None from the database** — the concrete form of risk #2 ([§5B](#5b-provider-credentials-and-per-tenant-ai-configuration))                                                                            |
| 4   | New raw SQL added post-retrofit without policy coverage                                                | 1     | None without a lint rule                                                                                                                                                                               |
| 5   | Storage key collision or leaked signed URL crosses tenants                                             | 5     | None — outside Postgres                                                                                                                                                                                |
| 6   | Missed `orgId` on one child table                                                                      | 1     | Only with a two-tenant harness                                                                                                                                                                         |
| 7   | Custody of tenants' vendor API keys with no envelope-encryption layer                                  | 5     | Only at breach time, when the blast radius is the tenant's cloud account ([§5B](#5b-provider-credentials-and-per-tenant-ai-configuration))                                                             |
| 8   | Slug collision blocks a customer; error leaks existence                                                | 2     | Immediate but only in production                                                                                                                                                                       |
| 9   | Shared circuit breaker couples tenant failure domains                                                  | 3     | Visible as unexplained cross-tenant outages                                                                                                                                                            |
| 10  | A bespoke per-tenant storage arrangement agreed in a sales cycle                                       | 5     | Immediate, and expensive — migrations, backup, DR, retention, Art. 15 export and vector search each need a per-backend variant ([§5A](#5a-data-handling-residency-and-per-tenant-storage-flexibility)) |
| 11  | One tenant exhausts `globalMonthlyBudgetUsd`                                                           | Comm. | Immediate, total                                                                                                                                                                                       |
| 12  | Scheduler starvation from a heavy tenant                                                               | 4     | Visible as "our schedules are late"                                                                                                                                                                    |
| 13  | Controller/processor obligations unaddressed                                                           | Priv. | At audit or first subject request                                                                                                                                                                      |

Risks 1–5 share a property that should drive the sequencing: **they are
invisible to the mechanism that makes MT trustworthy.** RLS is a strong control
precisely because it fails closed — and none of the top five are governed by
it.

---

## 12. Documentation drift

Three concrete drifts found while verifying, and one recommendation.

| Drift                                                                                                     | Where                    |
| --------------------------------------------------------------------------------------------------------- | ------------------------ |
| "The schema has **60 models**" — it now has **61**                                                        | `multi-tenancy.md:65`    |
| Raw-SQL table lists 6 files; there are 3 further app-layer sites (Appendix A)                             | `multi-tenancy.md:47-54` |
| `lib/tenancy/client.ts` named as a covered seam; the file does not exist (the seam is `lib/db/client.ts`) | `VERSIONING.md:75`       |

None is serious in isolation. Together they make the point: **a hand-maintained
inventory of security-relevant sites drifts within months.** The raw-SQL table is
the one that matters — it is the list of places RLS is doing the load-bearing
work, and a new entry that nobody notices is exactly risk #3.

**Recommendation.** Enforce it the way this repo already enforces the privacy
manifest. `tests/unit/lib/privacy/export-sources.test.ts` parses the schema and
fails the build when a model is added without an export disposition, and
`CLAUDE.md` forbids deleting from the manifest to make the test pass. The same
shape applies here:

- A test that greps for `$queryRaw*` outside an allowlist and fails on new
  entries.
- A test that parses the schema, derives the tenant-owned model list, and (under
  `TENANCY_MODE=multi`) asserts RLS is enabled with a policy on each.

Both are cheap, both fail loudly, and both survive the author leaving.

---

## 13. Open questions

0. **Pooled install or cells?** The question that precedes every other one here
   ([§5C.2](#5c2-the-alternative-cells-and-sunrise-is-already-one)). Sunrise's
   single-tenant install is already a well-formed cell; what is missing is a
   control plane, which is a separate system. Under a cell answer, most of §5
   is not the right work.
1. **Multi-org membership?** (§6 — blocks #366 and #367.)
2. **Tenant resolution strategy?** Propagates further than any other decision
   and is currently unowned by any issue.
3. **Are the two singletons per-tenant?** If yes, that is a larger change than
   the playbook's "opt-in product decision" framing suggests — and it is what
   gates per-tenant default models and budgets
   ([§5B](#5b-provider-credentials-and-per-tenant-ai-configuration), B3).
   Sub-question: can two tenants use **different embedding models**? That is a
   vector-dimension question, not a settings question.
4. **Do breakers and in-flight counters go per-tenant?** Per-tenant protects
   neighbours; global gives a better failure signal. Genuine trade-off.
5. **Shared provider credentials with quotas, or per-tenant BYO keys?** Four
   models are compared in
   [§5B](#5b-provider-credentials-and-per-tenant-ai-configuration). The prior
   question is whether Sunrise is willing to become a **custodian of other
   companies' vendor credentials** — that is a security-posture decision, and
   answering it "no" makes the gateway and vault-reference models the only
   candidates.
6. **Does the `admin` API-key scope gain an org dimension, or is it declared
   platform-only?** (#366 secondary decision, still open.)
7. **Is the impersonation/support-access model in scope for the platform, or
   left to forks?** It is a compliance surface, which argues for platform.
8. **Should Phase 1 be decoupled from `TENANCY_MODE` entirely?** The #366
   comment argues yes — bespoke single-tenant forks need the operator-tier and
   ownership axes with no tenancy at all, which makes them the cheaper, earlier
   validation of the same seam.
9. **How far up the storage ladder does Sunrise commit?**
   ([§5A](#5a-data-handling-residency-and-per-tenant-storage-flexibility).)
   Publishing the ladder is itself the deliverable; the engineering question is
   only where the published line sits. Rung 5 (dedicated deployment) already
   ships.
10. **Is `AiCostLog` given a tenant column, or is attribution left to the
    nullable `SetNull` FK chain?** Today deleting an agent orphans its cost
    history, which is tolerable for reporting and not tolerable for billing.
11. **How is tenant context carried?**
    ([§5C.1](#5c1-the-prerequisite-there-is-no-tenant-context-to-pass).)
    `AsyncLocalStorage` entered in `withAuth`/`withAdminAuth` covers HTTP;
    background jobs need an explicit answer, and "it defaults to no tenant" is
    the wrong one. Sub-question: does the resolver throw when
    `TENANCY_MODE=multi` and no context is set?
12. **Does `BETTER_AUTH_SECRET` stay a single install-wide key?** It currently
    signs sessions, email-change JWTs, storage access tokens and approval
    tokens. Per-tenant key material — and a rotation story that does not
    invalidate all four at once — is a prerequisite for any credible
    key-management answer.

---

## Appendix A — Raw SQL sites

Verified at `b7e30f06`. The playbook's table covers rows 1–5 plus the exempt
health check; rows 6–8 are app-layer sites it does not list.

| #   | File                                                                                 | Line(s)       | Method                                  |
| --- | ------------------------------------------------------------------------------------ | ------------- | --------------------------------------- |
| 1   | `lib/orchestration/knowledge/search.ts`                                              | 354, 447      | `$queryRawUnsafe` (pgvector)            |
| 2   | `lib/orchestration/knowledge/document-manager.ts`                                    | 160           | `$executeRawUnsafe`                     |
| 3   | `lib/orchestration/knowledge/seeder.ts`                                              | 138, 237, 256 | `$queryRawUnsafe` / `$executeRawUnsafe` |
| 4   | `lib/orchestration/chat/message-embedder.ts`                                         | 87            | `$executeRawUnsafe`                     |
| 5   | `lib/orchestration/llm/cost-reports.ts`                                              | 185, 321      | `$queryRawUnsafe`                       |
| 6   | `app/api/v1/chat/stream/route.ts`                                                    | 140           | raw                                     |
| 7   | `app/api/v1/admin/orchestration/conversations/search/route.ts`                       | 143           | `$queryRawUnsafe`                       |
| 8   | `app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/[position]/route.ts` | 70            | raw                                     |
| —   | `lib/db/utils.ts`                                                                    | 14, 41        | `SELECT 1` health check — exempt        |

Scripts (out of request path, but run against production data in some setups):
`scripts/embeddings-reset.ts`, `scripts/smoke/knowledge-hybrid-search.ts`,
`scripts/test-knowledge-base.ts`.

## Appendix B — Unique constraints requiring an org composite

Human-meaningful or routing-relevant constraints only; key hashes and
already-scoped composites omitted.

| Model                     | Constraint                                    | File:line                               |
| ------------------------- | --------------------------------------------- | --------------------------------------- |
| `AiAgent`                 | `slug @unique`                                | `orchestration-agents.prisma:9`         |
| `AiAgentProfile`          | `slug @unique`                                | `orchestration-agents.prisma:147`       |
| `AiCapability`            | `slug @unique`                                | `orchestration-agents.prisma:226`       |
| `AiWorkflow`              | `slug @unique`                                | `orchestration-workflows.prisma:10`     |
| `AiWorkflowTrigger`       | `@@unique([channel, workflowId])`             | `orchestration-workflows.prisma:133`    |
| `AiKnowledgeBase`         | `slug @unique`                                | `orchestration-knowledge.prisma:18`     |
| `AiKnowledgeDocument`     | `slug @unique`                                | `orchestration-knowledge.prisma:57`     |
| `KnowledgeTag`            | `slug @unique`                                | `orchestration-knowledge.prisma:152`    |
| `AiKnowledgeChunk`        | `chunkKey @unique`                            | `orchestration-knowledge.prisma:121`    |
| `AiProviderConfig`        | `name @unique`, `slug @unique`                | `orchestration-providers.prisma:43-44`  |
| `AiProviderModel`         | `slug @unique`                                | `orchestration-providers.prisma:69`     |
| `AiOrchestrationSettings` | `slug @unique @default("global")` — singleton | `orchestration-providers.prisma:171`    |
| `FeatureFlag`             | `name @unique`                                | `platform.prisma:20`                    |
| `SeedHistory`             | `name @unique`                                | `platform.prisma:55`                    |
| `McpServerConfig`         | `slug @unique @default("global")` — singleton | `mcp.prisma:12`                         |
| `McpExposedPrompt`        | `name @unique`                                | `mcp.prisma:74`                         |
| `McpExposedResource`      | `uri @unique`                                 | `mcp.prisma:97`                         |
| `AiOutboundMessage`       | `dedupKey @unique`                            | `orchestration-conversations.prisma:67` |
| `AiWorkflowExecution`     | `@@unique([dedupKey])`                        | `orchestration-workflows.prisma:245`    |
| `AiWorkflowStepDispatch`  | `idempotencyKey @unique`                      | `orchestration-workflows.prisma:280`    |

Already tenant-safe once the parent carries `orgId`:
`@@unique([agentId, channel, fromAddress])`, `@@unique([agentId, version])`,
`@@unique([agentId, capabilityId])`, `@@unique([workflowId, version])`,
`@@unique([datasetId, position])`, `@@unique([runId, casePosition])`,
`@@unique([executionId, stepId])`, `@@unique([userId, agentId, key])`.

## Appendix C — Process-global state

| Module                                                             | State                    | Current key      |
| ------------------------------------------------------------------ | ------------------------ | ---------------- |
| `lib/orchestration/settings.ts:294`                                | `settingsCache`, 30s TTL | none             |
| `lib/orchestration/llm/settings-resolver.ts:55`                    | default-models map       | none             |
| `lib/orchestration/llm/circuit-breaker.ts:180`                     | `breakers` Map           | provider slug    |
| `lib/orchestration/llm/in-flight-counter.ts:24`                    | `counts` Map             | provider slug    |
| `lib/orchestration/llm/model-registry.ts` / `-db-hydrate.ts`       | hydrated registry        | none             |
| `lib/orchestration/llm/provider-manager.ts`                        | provider instances       | provider slug    |
| `lib/orchestration/provider-test-cache.ts`                         | connectivity results     | provider slug    |
| `lib/orchestration/mcp/{session,tool,prompt,resource}-registry.ts` | registries               | server-global    |
| `lib/orchestration/capabilities/dispatcher.ts`                     | dispatcher state         | needs audit      |
| `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts`        | access cache             | agent            |
| `lib/orchestration/hooks/registry.ts`                              | hook registry            | none             |
| `lib/security/rate-limit-stores/memory.ts`                         | LRU of timestamps        | rate-limit token |
| `lib/orchestration/evaluations/run-claim.ts`                       | claim state              | needs audit      |
| `lib/orchestration/maintenance/platform-jobs.ts`                   | last-run times           | job name         |

Not exhaustive — the audit itself is Phase 4 work.

## Appendix D — Background jobs

Registered in `lib/orchestration/maintenance/platform-jobs.ts:103-162`; fork
extension point at `lib/app/jobs.ts`.

| Job                        | Interval   | Scope today                         |
| -------------------------- | ---------- | ----------------------------------- |
| `webhookRetries`           | every tick | global queue                        |
| `hookRetries`              | every tick | global queue                        |
| `orphanSweep`              | 2 min      | global lease reclamation            |
| `zombieReaper`             | 5 min      | global                              |
| `embeddingBackfill`        | 15 min     | global, batch 25                    |
| `retention`                | 1 hour     | global `deleteMany` across 8 tables |
| `pendingExecutionRecovery` | 2 min      | global                              |
| `evaluationRuns`           | every tick | global queue                        |

Plus `processDueSchedules()` (`lib/orchestration/scheduling/scheduler.ts:224`),
`take: 50` per tick, no tenant fairness.

## Appendix E — Global configuration and singletons

| Model                     | Shape                            | Playbook classification |
| ------------------------- | -------------------------------- | ----------------------- |
| `AiOrchestrationSettings` | **singleton**, `slug = "global"` | admin-authored global   |
| `McpServerConfig`         | **singleton**, `slug = "global"` | admin-authored global   |
| `AiProviderConfig`        | per-provider row                 | admin-authored global   |
| `AiProviderModel`         | per-model row                    | admin-authored global   |
| `AiCapability`            | per-capability row               | admin-authored global   |
| `AiAgentProfile`          | per-profile row                  | admin-authored global   |
| `AiAgentCapability`       | join                             | admin-authored global   |
| `FeatureFlag`             | per-flag row                     | admin-authored global   |
| `KnowledgeTag`            | per-tag row                      | admin-authored global   |
| `AuthBootstrap`           | **singleton**, install-scoped    | system                  |

## Appendix F — Tenant-relevant public routes

| Route                                                           | Auth              | Tenant arrives how?  |
| --------------------------------------------------------------- | ----------------- | -------------------- |
| `app/api/v1/chat/agents/[slug]/validate-token`                  | invite token      | undecided            |
| `app/api/v1/chat/stream`                                        | session / API key | undecided            |
| `app/api/v1/inbound/[channel]/[slug]`                           | HMAC signature    | undecided            |
| `app/api/v1/webhooks/trigger/[slug]`                            | API key           | undecided            |
| `app/api/v1/embed/chat/stream`                                  | embed token       | token could bind org |
| `app/api/v1/embed/widget-config`, `widget.js`, `speech-to-text` | embed token       | token could bind org |
| `app/api/v1/mcp/**`                                             | MCP API key       | key could bind org   |
| `app/api/v1/contact`                                            | none              | n/a — cross-tenant   |

The embed, MCP and API-key routes have a natural answer (bind the org to the
credential). The inbound and webhook routes do not — they are addressed by a
global slug and authenticated by a shared-secret signature.

---

## Related

- [`multi-tenancy.md`](./multi-tenancy.md) — the RLS playbook (data plane)
- [`overview.md`](./overview.md) — the single-tenant baseline
- [`../privacy/data-erasure.md`](../privacy/data-erasure.md) — the `onDelete`
  graph that doubles as the org-teardown dependency graph
- [`../privacy/data-export.md`](../privacy/data-export.md) — subject access and
  the test-enforced source manifest
- [`../orchestration/retention.md`](../orchestration/retention.md) — per-data-class
  retention that MT would make per-org
- [`../orchestration/scheduling.md`](../orchestration/scheduling.md) — the tick
  model that plane 4 has to make tenant-aware
- [`../security/rate-limiting.md`](../security/rate-limiting.md) — the policy
  table and its key space
- [`../admin/orchestration-providers.md`](../admin/orchestration-providers.md)
  — the env-var-only API-key security model that §5B has to trade away
- [`../storage/overview.md`](../storage/overview.md) — the `StorageProvider`
  interface §5A relies on for rungs 1–4
- [`../orchestration/cost-estimation.md`](../orchestration/cost-estimation.md)
  — pre-run estimates, the input to any per-tenant budget policy
- [`../../CUSTOMIZATION.md`](../../CUSTOMIZATION.md#the-appplatform-model) — the
  app/platform ownership model
- [`../../VERSIONING.md`](../../VERSIONING.md#public-surface-contract-tight-definition)
  — the public-surface contract
