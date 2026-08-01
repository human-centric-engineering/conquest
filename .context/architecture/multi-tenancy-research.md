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

| If you are…                                   | Start at                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Deciding whether to build MT into a fork      | [§2 The two questions](#2-the-two-questions) → [§9 Deployment topologies](#9-deployment-topologies)                       |
| Already committed and want the work breakdown | [§5 Gap register](#5-gap-register) → [§10 Sequencing](#10-sequencing-shape)                                               |
| A fork author worried about upstream merges   | [§7 Ownership matrix](#7-ownership-platform-tier-vs-fork-tier) → [§8 Downstream forks](#8-downstream-fork-considerations) |
| A Sunrise maintainer triaging #366 / #367     | [§6 The decision gate](#6-the-decision-gate) → [§7](#7-ownership-platform-tier-vs-fork-tier)                              |

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

| Decision                                                                          | Propagates to                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Tenant resolution**: subdomain / path / custom domain / token binding           | Cookies, CORS, CSP, TLS, every generated URL, all slug routes    |
| **Config sharing**: which of the eight admin-authored global models go per-tenant | The two singletons, seeding, backup, the admin console split     |
| **Credential model**: shared provider keys with quotas vs per-tenant BYO keys     | Cost attribution, encryption at rest, breaker/counter keying     |
| **Isolation topology**: pooled DB vs schema-per-tenant vs DB-per-tenant           | Whether planes 1–2 exist at all ([§9](#9-deployment-topologies)) |

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

| Item                                               | Owner    | Rationale                                          |
| -------------------------------------------------- | -------- | -------------------------------------------------- |
| `Org` / `OrgMembership` model                      | Depends  | Decided by §6's multi-org question                 |
| Org-role vocabulary, invitations UI, billing       | Fork     | Product-specific                                   |
| `orgId` columns + RLS migration                    | Fork     | Rides the fork's schema                            |
| Authorization predicate + guard signatures         | Platform | `lib/auth/guards.ts`, `utils.ts` — #366            |
| `role` known-values constant                       | Platform | Same files — #366                                  |
| Ownership-scope resolver                           | Platform | Shared predicate — #367                            |
| Admin API-key scope org dimension                  | Platform | `guards.ts:193-200`                                |
| Slug-route resolution redesign                     | Platform | `app/api/v1/{chat,inbound,webhooks}/**`            |
| Unique-constraint composites                       | Fork     | Rides the `orgId` migration                        |
| Process-cache keying (plane 3)                     | Platform | 20+ Sunrise-owned modules                          |
| Background-job tenancy + fairness (plane 4)        | Platform | `platform-jobs.ts`, `scheduler.ts`, `retention.ts` |
| Rate-limit `org` key                               | Platform | `RateLimitKey` is a closed union — see below       |
| Storage key scoping + token org claim              | Platform | `lib/storage/**`                                   |
| Per-tenant provider credentials                    | Split    | Schema fork-owned; resolution platform-owned       |
| Plans, metering rollups, invoicing                 | Fork     | Product                                            |
| Org in log/trace context                           | Platform | `lib/logging/context.ts`                           |
| Org-level export/erase entry points                | Platform | `lib/privacy/**`                                   |
| Two-tenant leakage harness + policy-coverage test  | Platform | Benefits every fork; needs schema knowledge        |
| Admin console split (platform-ops vs tenant-admin) | Platform | `app/admin/**` is one tree behind one guard        |
| Tenant resolution in `proxy.ts`                    | Platform | Root-level request pipeline                        |

**Fourteen of twenty rows are platform-tier.** Two of them — #366 and #367 —
are tracked. The other twelve are not.

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
- **Instance-per-tenant remains the right answer for a lot of forks**, and is
  Sunrise's current recommendation. The retrofit is justified by tenant count and
  self-serve signup, not by preference.

---

## 10. Sequencing shape

Not a commitment; the dependency order if it were built.

**Phase 0 — Decisions.** §6's five decisions. Nothing below can be sized first.

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
credentials, log/trace org, per-org backup.

**Phase 6 — Commercial plane.** Plans, quotas in the rate-limit key space,
metering rollups, invoicing.

**Phase 7 — Admin console split and impersonation.**

**Continuous — Assurance.** The two-tenant harness and the policy-coverage test
should land _with Phase 3_, not after. They are the only defence against every
subsequent phase silently regressing the boundary.

---

## 11. Risk register

Ranked by (impact × likelihood × how long it stays undetected).

| #   | Risk                                                            | Plane | Detectability                               |
| --- | --------------------------------------------------------------- | ----- | ------------------------------------------- |
| 1   | Background jobs run on a bypass role; a job bug crosses tenants | 4     | **None** — looks correct, is not            |
| 2   | Process cache serves tenant A's config to tenant B              | 3     | **None from the database**                  |
| 3   | New raw SQL added post-retrofit without policy coverage         | 1     | None without a lint rule                    |
| 4   | Storage key collision or leaked signed URL crosses tenants      | 5     | None — outside Postgres                     |
| 5   | Missed `orgId` on one child table                               | 1     | Only with a two-tenant harness              |
| 6   | Slug collision blocks a customer; error leaks existence         | 2     | Immediate but only in production            |
| 7   | Shared circuit breaker couples tenant failure domains           | 3     | Visible as unexplained cross-tenant outages |
| 8   | One tenant exhausts `globalMonthlyBudgetUsd`                    | Comm. | Immediate, total                            |
| 9   | Scheduler starvation from a heavy tenant                        | 4     | Visible as "our schedules are late"         |
| 10  | Controller/processor obligations unaddressed                    | Priv. | At audit or first subject request           |

Risks 1–4 share a property that should drive the sequencing: **they are
invisible to the mechanism that makes MT trustworthy.** RLS is a strong control
precisely because it fails closed — and none of the top four are governed by it.

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

1. **Multi-org membership?** (§6 — blocks #366 and #367.)
2. **Tenant resolution strategy?** Propagates further than any other decision
   and is currently unowned by any issue.
3. **Are the two singletons per-tenant?** If yes, that is a larger change than
   the playbook's "opt-in product decision" framing suggests.
4. **Do breakers and in-flight counters go per-tenant?** Per-tenant protects
   neighbours; global gives a better failure signal. Genuine trade-off.
5. **Shared provider credentials with quotas, or per-tenant BYO keys?**
6. **Does the `admin` API-key scope gain an org dimension, or is it declared
   platform-only?** (#366 secondary decision, still open.)
7. **Is the impersonation/support-access model in scope for the platform, or
   left to forks?** It is a compliance surface, which argues for platform.
8. **Should Phase 1 be decoupled from `TENANCY_MODE` entirely?** The #366
   comment argues yes — bespoke single-tenant forks need the operator-tier and
   ownership axes with no tenancy at all, which makes them the cheaper, earlier
   validation of the same seam.

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
- [`../../CUSTOMIZATION.md`](../../CUSTOMIZATION.md#the-appplatform-model) — the
  app/platform ownership model
- [`../../VERSIONING.md`](../../VERSIONING.md#public-surface-contract-tight-definition)
  — the public-surface contract
