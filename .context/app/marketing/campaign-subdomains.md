# Campaign subdomains & the admin Marketing section

Segment-targeted campaign entry points (`hr.conquest…`, `cx.conquest…`) that carry a short
marketing pitch and hand the visitor straight into a **live conversational questionnaire** as the
conversion event — plus the admin surface that authors campaigns and works the leads they produce.

> **Status: design — none of this is built.** Sections headed **What exists / exists today** are
> verified against the code and carry file references; everything else is a proposal. Do not read
> this document as a description of shipped behaviour.

## TL;DR

**The idea.** Market-segment subdomains (`hr.`, `cx.`) are paid-traffic landing pages that hand the
visitor into a **live ConQuest questionnaire** — the demo _is_ the conversion event, not a video of
one. Alongside them, a free-trial suite on the apex lets anyone try real parts of the product on
their own material. Both feed one new admin **Marketing** section: campaign content, a light CRM, and
a lead pipeline.

**The assets, and what each costs to build.** Most of this is exposure of machinery that already
exists rather than new capability.

| Asset                    | Where                   | What it is                                                         | Build  |
| ------------------------ | ----------------------- | ------------------------------------------------------------------ | ------ |
| Campaign landing pages   | `hr.`, `cx.` subdomains | Segment pitch, use cases, testimonials, a named contact, demos     | Small  |
| Demo questionnaire       | on the campaign host    | A real walk-up session; captures name/email conversationally       | Config |
| **Compose from a brief** | apex `/build`           | Type a goal, watch a questionnaire assemble itself — the best hook | Small  |
| **Evaluator**            | apex `/evaluate`        | Upload your questionnaire, the 7 judges grade it with fixes        | Medium |
| Form-vs-conversation     | apex + campaign pages   | The same questions as a form and as a conversation, side by side   | Config |
| Template library         | apex `/templates`       | Expert questionnaires per market; "use this" needs an account      | Small  |
| Cost calculator          | apex                    | Existing heuristic estimator, zero LLM cost                        | Tiny   |
| Branded demos            | sales-assisted          | Already built (F2.5.1) — just wire it to the pipeline              | Wiring |
| Admin Marketing section  | `/admin/marketing`      | Campaigns, contacts, testimonials, leads, pipeline                 | Medium |

**Decisions already taken:** uploads persist as **claimable drafts** (signing up converts them);
the **email gate sits after the free preview**, not before the upload; the free evaluator tier is
**any 4 of the 7 judges**, all seven paid; **all four spend controls ship together**; campaign hosts
are `noindex` while the apex tools are the SEO assets.

**The three things most likely to hurt.** Unauthenticated LLM spend behind a URL you are paying to
send traffic to. The claim flow, because it touches identity and needs verified email. And marketing
from client respondent data, which is a trust event rather than a compliance footnote — see the
[guardrail](#own-research-programme).

**Where to start.** Phase 1 (extracting the homepage copy into a content object) is worth doing
whether or not any of this ships. Then measure one real run — three separate caps are blocked on that
number. See [Sequencing](#sequencing-and-ordering-constraints).

## The funnel

```
ad click → hr.conquest.com  (campaign landing page: pitch, use cases,
                             testimonials, named ConQuest contact, demo links)
         → CTA launches a real questionnaire version on the SAME host
         → conversational profile capture (name + email) mid-demo
         → session completes; lead lands in admin Marketing → Pipeline
```

The demo is not a mock. It is an ordinary launched questionnaire version, configured for walk-up
access, running on the campaign host.

## What already exists (verified)

The respondent surface runs on a campaign subdomain **unmodified**. Three facts make that true:

| Fact                                                                                                                                                                    | Where                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Browser API calls are relative — `getBaseURL()` returns `''` when `window` is defined, so every call is same-origin and the proxy's `Origin === Host` CSRF check passes | `lib/api/client.ts` (`getBaseURL`), `proxy.ts` (~line 103)     |
| The anonymous session token lives in `sessionStorage`, **not** a cookie — origin-scoped, no cookie-domain configuration                                                 | `components/app/questionnaire/chat/anonymous-session-boot.tsx` |
| `/q/[versionId]` is already a true no-login walk-up surface                                                                                                             | `app/(public)/q/[versionId]/page.tsx`                          |

Two more existing seams this design consumes rather than reinvents:

| Seam                       | What it gives us                                                                                                                                             | Where                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Per-request classification | The proxy already derives `x-surface` from the path and the root layout puts it on `<html data-surface>`; `<SurfaceSync>` keeps it correct across client nav | `lib/app/surface.ts`, `proxy.ts` (~line 282), `app/layout.tsx`             |
| Profile capture            | Admin-authored `profileFields`, each with `captureVia: 'form' \| 'conversational'`, split per field — this **is** the lead-capture mechanism                 | `lib/app/questionnaire/profile/resolve-capture.ts`, `capture-placement.ts` |
| Admin nav registration     | `initAppNav()` is a fork-owned scaffold; a new top-level section is a `registerNavSection({ … })` call                                                       | `lib/app/admin-nav.ts`, `lib/admin-nav/registry.ts`                        |
| Non-user PII precedent     | `AppWaitlistSignup` — prospects, no `User` FK, standalone PII triaged by an admin, already carries a `source` field                                          | `prisma/schema/app-waitlist.prisma`                                        |

### Two configuration constraints that silently break the funnel

Both are existing behaviour, and both fail quietly rather than loudly:

- **`anonymousMode` must be `false`.** `resolveSessionCapture` returns `null` under anonymous mode
  by design (the PII-free posture). An anonymous demo captures **no lead at all**.
- **`accessMode` must be `public` or `both`.** It defaults to `invitation_only` when unset
  (`lib/app/questionnaire/chat/anonymity.ts` — `version?.config?.accessMode ?? 'invitation_only'`),
  and a walk-up session create is refused.

A campaign that points at a misconfigured version should refuse to publish, naming which of the two
is wrong. Do not let this be discovered by watching an empty pipeline.

## Routing (proposed)

### The proxy stays lexical — it must not touch the database

`proxy.ts` runs on **every request**. A per-request Prisma read to resolve host → campaign is not
acceptable there, and campaigns are admin-created so a compiled-in registry is not an option either.

**Resolution: split the work.**

- The **proxy** does pure string work: extract the subdomain label, and if the host is a campaign
  host, rewrite `<label>.conquest…/…` → `/s/<label>/…` and set `x-segment: <label>`. No I/O, no
  validation of whether the campaign exists.
- The **route segment** (`app/(public)/s/[campaign]/…`) does the database lookup with ordinary Next
  caching, renders the campaign, and `notFound()`s an unknown or unpublished label.

This keeps the edge path cheap, makes the campaign page an ordinary cacheable route, and means
`/s/hr` is directly reachable in dev and in tests with no DNS involved.

### Path rules on a campaign host

| Path                                       | Behaviour                                               |
| ------------------------------------------ | ------------------------------------------------------- |
| `/`, campaign marketing pages              | Rewrite to `/s/<label>/…`                               |
| `/q/…`, `/x/…` (the demo)                  | **Serve on the campaign host** — this is the conversion |
| `/admin`, `/dashboard`, account/auth flows | 308 → apex                                              |
| Unknown subdomain label                    | 308 → apex                                              |

Serving the demo on the campaign host is deliberate. The instinct to send `/q` and `/x` back to the
apex "for consistency" is wrong here: redirecting mid-funnel breaks the campaign's visual continuity
and moves the visitor to a host their in-flight session state does not follow.

## Data model (proposed)

App-owned, `App`-prefixed, in a new `prisma/schema/app-marketing.prisma` so it does not touch
Sunrise-tracked files.

| Model                 | Holds                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppCampaign`         | `slug` (= the subdomain label, unique), display name, status (`draft \| published \| archived`), palette/theme tokens, SEO flags, owner contact FK, `content` JSON |
| `AppMarketingContact` | The "friendly face" — name, role, photo, short bio, email, booking link. Reusable across campaigns                                                                 |
| `AppCampaignDemo`     | Join row: campaign → questionnaire `versionId` + label + blurb + display order. Several demos per campaign                                                         |
| `AppTestimonial`      | Quote, attribution, org, optional logo. Reusable; joined to campaigns with an order                                                                                |
| `AppLead`             | Person + org + email + phone, source campaign slug, pipeline stage, owner, free-text notes, timestamps                                                             |
| `AppLeadActivity`     | Append-only timeline entry against a lead (note, status change, email logged, demo completed)                                                                      |

**Campaign copy is `content` JSON validated by Zod** — hero, "applications in this market", use-case
list, FAQ. It is per-campaign prose that nothing else joins against, and a JSON column keeps the
admin editor simple. Anything _reusable_ (contacts, testimonials, demos) gets a real table.

**Pipeline stages as a `const` tuple**, following the convention used throughout
`lib/app/questionnaire/types.ts` (`ACCESS_MODES`, `SESSION_STATUSES`): one declaration is the single
source of truth for the TypeScript union, the Zod enum, and the admin filter. Configurable stages
are a later concern — do not build a stage-definition table for v1.

### Pointers, not graph edges

`AppLead.sessionId` (the demo session that produced the lead) and `AppLead.campaignSlug` must be
plain `String?` with **no `@relation`** — the same UG-1 posture the session model applies to
`invitationId`, `roundId`, `cohortMemberId` and `stepId`, and for the same reason: they are
identity↔answer pointers read for funnel stats and lead routing, and must never become a graph edge
that joins identity to answer content or cascades transcript deletes. Copy that reasoning into the
schema comment; the existing comments in `app-questionnaire.prisma` are the model to follow.

### Attribution on the session

Add `campaignSlug String?` (and optionally the UTM triple) to `AppQuestionnaireSession`, same
pointer posture. This is what makes per-campaign funnel reporting a plain `where` clause.

## Privacy posture

The CRM stores personal data about people who are **not** `User` rows. `AppWaitlistSignup` is the
governing precedent and its schema comment states the rule:

> No User FK — these are prospects, not accounts — so the new-relation `onDelete` rule doesn't
> apply. `email` is standalone PII triaged by an admin rather than erased through `eraseUser()`.

Consequences for this design:

- `AppLead` / `AppLeadActivity` take **no `User` FK for the lead subject**, so the
  `SUBJECT_DATA_SOURCES` manifest rule in `CLAUDE.md` is not triggered by them.
- An `ownerId` referencing a ConQuest staff `User` **is** a new `User` relation and therefore needs
  an explicit `onDelete: SetNull` (retained business record) plus a manifest decision.
- Erasure for a lead is an admin action on the CRM, not `eraseUser()`. Build a delete that removes
  the lead and its activities. A lead who later becomes a respondent has two separate records by
  design; do not join them to "solve" that.
- Marketing consent and lawful basis are **not** modelled here and need a decision before any
  outbound email is sent from this data.
- **Client respondent data is never marketing material.** Benchmark or "state of the industry"
  content may draw only on ConQuest's own studies or on participants who consented to that specific
  use. Aggregation and k-anonymity make a cohort report safe _for the client who commissioned it_;
  they do not create a right to republish. Treat this as a hard line.

## Admin Marketing section (proposed)

A new **top-level** sidebar section, registered alongside the existing Questionnaires section in
`lib/app/admin-nav.ts` — a second `registerNavSection({ title: 'Marketing', … })` call. The registry
dedupes on `title` and renders app sections in first-registration order, so this is additive and
needs no platform edit.

| Page                              | Purpose                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `/admin/marketing/campaigns`      | List campaigns: slug, status, host reachability, leads-in-period                       |
| `/admin/marketing/campaigns/[id]` | Edit one campaign: content blocks, palette, contact, testimonials, demo links, publish |
| `/admin/marketing/pipeline`       | Board or table of leads by stage; drag/assign, open a lead                             |
| `/admin/marketing/leads/[id]`     | One lead: details, activity timeline, linked demo session, notes                       |
| `/admin/marketing/contacts`       | The reusable segment-owner profiles                                                    |
| `/admin/marketing/testimonials`   | The reusable testimonial library                                                       |

API-first per `CLAUDE.md`: every one of these gets `/api/v1/app/marketing/**` routes under
`withAdminAuth` before any UI is built, and inherits the section rate-limit cap with no handler work.

**Campaign editing is not a page builder.** Fixed, well-named content blocks with a Zod schema and a
live preview link to `/s/<slug>`. The moment it grows arbitrary block composition it becomes a CMS,
and that is a much larger product than this needs.

## The free evaluator (`/evaluate`)

A prospect uploads their own questionnaire, the judge panel grades it, and they get scored findings
with concrete proposed edits. Their own work is the demo — a stronger hook than any sample
conversation, because the output is immediately useful whether or not they ever buy.

### Placement: the apex, not a subdomain

`/evaluate` on the apex, linked from every campaign subdomain with campaign attribution. **Not** its
own subdomain. Three reasons:

- It is a **tool every segment wants**, not a segment framing. A subdomain fragments the product
  surface and buys no targeting.
- Campaign hosts are `noindex` (above). The evaluator is precisely the asset that _should_ rank
  organically — a compounding inbound channel rather than a paid-only one. Those two postures are
  incompatible on the same host.
- If it becomes paid it needs auth and billing, which work on the apex. A subdomain would
  reintroduce the cross-subdomain session problem this design otherwise avoids entirely.

### What exists today (verified)

| Piece                                                                                                        | Where                                                       |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Seven judges emitting **actionable findings** (`proposedChange` + `rationale` + `severity`), not bare scores | `lib/app/questionnaire/evaluation/`, `design-evaluation.md` |
| App-native dispatch — one `runStructuredCompletion` per dimension at the **reasoning** tier                  | `lib/app/questionnaire/capabilities/evaluate-structure.ts`  |
| A no-persistence preview route (admin-gated)                                                                 | `…/versions/[vid]/evaluate-preview/route.ts`                |
| Run + finding persistence, with `dimensionsRequested` / `dimensionsRun` and a `partial` status               | `AppQuestionnaireEvaluationRun`, `…EvaluationFinding`       |
| Document ingestion → version extraction                                                                      | `ingestion.md`, `…/questionnaires/import/route.ts`          |

A partial panel is therefore **already a first-class concept in the schema** — the free tier needs no
model change.

### Do not loosen the existing routes

Every ingestion and evaluation route today is `withAdminAuth`. The public flow gets its **own**
routes under `/api/v1/app/evaluate/**` with their own guards, quotas and caps, reusing the pure core
(`lib/app/questionnaire/evaluation/`) and the capability. Relaxing the guard on an existing admin
route to serve the public flow would expose the whole authoring surface.

### The flow

```
/evaluate → upload (hard limits enforced before extraction)
          → choose up to 4 of the 7 judges
          → queued extraction + evaluation
          → FREE PREVIEW: per-dimension scores, finding counts by severity,
            2–3 full findings
          → email to unlock the full findings list
          → report + "claim this questionnaire" → signup converts it to a
            real draft they can edit and launch
```

**Free panel: the visitor picks up to 4 of the 7 dimensions; all seven are the paid/registered
tier.** Chosen deliberately over a fixed subset — showing the full list and letting them self-select
proves the panel is deeper than what they got, and their choice tells you which dimension they
actually care about (a useful sales signal to store on the lead).

**The email gate sits after the preview, not before the upload.** They see real scores and a couple
of real findings first, then pay with contact details for the rest. Top-of-funnel volume stays
open, and the value is demonstrated before anything is asked.

### Retention: claimable draft

The uploaded questionnaire **persists as an unclaimed draft** keyed to the lead's email; signing up
converts it into a real questionnaire they can edit and launch. The prospect's own work is the thing
that pulls them into an account, which is the strongest conversion path available here.

The obligations that come with that choice:

- **A claim flow** — unclaimed drafts belong to an email address, not a `User`. On signup with a
  matching verified email, transfer ownership. The email must be _verified_ before transfer; an
  unverified match would hand a stranger's questionnaire to whoever claims the address.
- **A retention window for unclaimed drafts** with automatic purge, and it must be stated on the
  upload screen. These are third-party documents from people with no account and no relationship —
  indefinite retention is not defensible.
- **An admin view** of unclaimed drafts under Marketing, so a purge is observable rather than silent.
- Erasure on request is a Marketing admin action (same posture as leads — see
  [Privacy posture](#privacy-posture)), not `eraseUser()`.

### Spend control

The costliest surface in this document: extraction **plus** up to four reasoning-tier judges, on an
arbitrary uploaded file, behind a public URL. All four controls ship together at launch.

| Control                        | Detail                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Hard document limits           | Page count, file size and extracted question count capped; oversized uploads rejected **before** extraction |
| Per-IP / per-email quota       | N free evaluations per period, enforced as a handler sub-cap (the section cap alone is far too loose)       |
| Async queue with daily ceiling | Runs are queued jobs under a global daily spend cap; over the cap they queue rather than fail               |
| Reduced free panel             | Up to 4 of 7 dimensions free — roughly a 40% cut in judge spend per run, and the natural paid boundary      |

Reject oversized documents at upload with a clear message rather than truncating silently — a
half-extracted questionnaire produces judge findings that are wrong rather than merely thin, which is
worse than a refusal.

## The free-trial suite

The evaluator is one of several free exposures sharing the apex, the lead pipeline, and — where they
produce a questionnaire — the same claim flow. They **ladder**: each hands the visitor something more
valuable than the last, and only the last step needs an account.

| Asset                    | LLM cost per use               | Gate                | What it proves                 |
| ------------------------ | ------------------------------ | ------------------- | ------------------------------ |
| Cost calculator          | **None** (heuristic)           | none                | Credibility; cheap SEO surface |
| Template library         | None to browse                 | account to _use_    | Breadth, per segment           |
| Form-vs-conversation     | One short session              | none                | **The core differentiator**    |
| Compose from a brief     | Outline + one call per section | after preview       | The "wow"                      |
| Evaluator                | Extraction + up to 4 judges    | after preview       | Rigour                         |
| Branded demo (sales-led) | A full demo build              | qualified lead only | Fit, for a named prospect      |

The **"do not loosen the existing routes"** rule from the evaluator applies to every item here
without exception: each gets its own public route with its own quotas, reusing the pure core and the
capability. No existing `withAdminAuth` route is relaxed to serve a public flow.

### Compose from a brief

_The strongest hook in this document._ The visitor types a plain-English goal — "I want to understand
why our nurses are leaving" — and watches a complete, sectioned questionnaire assemble itself.

**What exists:** `app_compose_questionnaire` with two-phase streaming — one fast outline call, then
one structured call per section in parallel, emitting `outline` → (`section_done` | `section_error`)\*
→ `done` (`lib/app/questionnaire/ingestion/stream-compose.ts`, `generative-authoring.md`). A composed
questionnaire emits the same contract and persists through the same writer as an extracted one, so it
is **indistinguishable downstream** — the claim flow works on it unchanged.

**Why it may outrank the evaluator as the primary hook:** no upload friction, no document to hunt
for, and no third-party client data in play — so the privacy surface is far smaller. It is also
_cheaper_ to run than the evaluator (no extraction, no seven judges).

**Net-new:** a public streaming route (`POST /api/v1/app/evaluate/compose` or similar), a brief-length
cap, a section/question ceiling, and the shared per-IP/email quota. Everything else is reuse.

Composing and evaluating together form a three-step free loop that mirrors the real product:
**compose → evaluate → refine** — where refining is what needs the account.

### Form vs conversation, side by side

The product claim is "the structure of a form, the depth of a conversation". This makes that sentence
clickable: answer the same short question set as a plain form, then as a ConQuest conversation, and
see what each captured. The form yields flat answers; the conversation yields answers **plus**
follow-ups, inferred data slots and caught contradictions.

**What exists:** `presentationMode` already supports `chat`, `form` and **`both`** — the respondent
toggling mid-session over the same data (`presentation-mode.md`). The live answer-slot panel
(`answer-slot-panel.md`) already renders slot fills with confidence and provenance, which is exactly
the "here's what the conversation caught that the form didn't" evidence.

**This is mostly configuration, not engineering** — the pieces exist and are already composable. The
build is the comparison framing around them, plus a well-chosen five-question set where the
conversational depth is obvious rather than subtle. Belongs on campaign landing pages as well as the
apex.

### Segment template library

Expert-authored questionnaires per market — exit interview, onboarding, eNPS, churn, CSAT. Free to
browse and to try as a respondent; **"use this template" requires an account**.

**What exists:** the questionnaires themselves, the walk-up respondent surface, and
`copyVersionGraph()` (`app/api/v1/app/questionnaires/_lib/copy-version-graph.ts`) — which is exactly
the "give me my own copy of this" operation, already written and tested.

No LLM spend to browse, strong long-tail SEO ("exit interview questions template"), and it doubles as
each campaign subdomain's demo catalogue — one library, segment-filtered, serving both surfaces.

### Cost calculator

F3.3's pre-launch estimator is a **heuristic** priced through the model registry
(`cost-estimation.md`) — it costs nothing per run and has no abuse surface at all. Exposed publicly it
is a useful, indexable utility with essentially zero marginal cost.

Low emotional pull; include it because it is nearly free, not because it converts.

### Branded demos for qualified leads (already built)

F2.5.1 demo clients give attribution and branding so a questionnaire is "the Acme Bank demo"
(`demo-clients.md`, with an end-to-end walkthrough in `runbook.md`). This is the **sales-assisted**
middle of the funnel and it already works — a qualified lead in the pipeline should be one action away
from a branded demo. Integration into the Marketing section, not new capability.

### Own-research programme

Run a study **on ConQuest** — "State of Employee Feedback 2026" — and publish the report. Dogfooding,
a genuinely differentiated lead magnet, and every participant is a lead. Self-reinforcing in a way a
static asset is not.

> **Guardrail — benchmark content may only come from ConQuest's own studies or from participants who
> explicitly consented to that use. Never from aggregated client respondent data.** The structural
> k-anonymity in meetings protects respondents _within_ a client's cohort; it confers no right to
> reuse that data as marketing collateral. This is a customer-trust question, not a compliance
> footnote — see [Privacy posture](#privacy-posture).

### Deliberately not in the suite

- **The Config Advisor** is config-centric — it reads a version's settings and narrates the respondent
  experience they produce (`lib/app/questionnaire/advisor/`). Little standalone value, but a strong
  addition _inside_ the evaluator report as a "what this would actually feel like to answer" section.
- **Free facilitated meetings** are genuinely differentiated but high-touch and expensive. A sales play
  for qualified enterprise leads, not a top-of-funnel asset.

## DNS & environments

### Local — Herd + the `dev-proxy` registry

Local dev already runs on real hostnames over real HTTPS, not `localhost:3000`. The stack is Laravel
Herd (wildcard `.test` dnsmasq → nginx on :443 with the Valet CA) driven by the
[`dev-proxy`](https://github.com/human-centric-engineering/dev-proxy) registry: edit `apps.json`,
run `./apply.sh`, commit, and everyone else pulls and re-applies.

**What is already true (verified on this machine):**

| Fact                                                                                   | Evidence                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ConQuest is registered at `conquest.test` → port **3020**                              | `apps.json`; `herd proxies`                                                       |
| The app is already configured for it                                                   | `.env.local`: `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` = `https://conquest.test` |
| The port seam exists (Sunrise 0.8.0 ships `.env.development` with `PORT`)              | `SUNRISE_VERSION = '0.8.0'`, `.env.development` present                           |
| Herd's nginx block for the apex **already wildcards every subdomain to the same port** | `server_name conquest.test www.conquest.test *.conquest.test;`                    |
| The local certificate already covers them                                              | SANs: `DNS:conquest.test, DNS:*.conquest.test`                                    |
| dnsmasq resolves any `*.test` to `127.0.0.1`                                           | `foo.conquest.test → 127.0.0.1`                                                   |

**Consequence: campaign subdomains need no local DNS work at all.** `cx.conquest.test`,
`finance.conquest.test` and any slug an admin invents already resolve, already present a trusted
certificate, and already proxy to the ConQuest dev server on 3020 — no `apps.json` entry, no
`apply.sh` run, no `/etc/hosts`. Dev mirrors the production wildcard exactly.

#### The one entry that contradicts this design

`apps.json` currently registers an `hr` **subdomain of `conquest` on its own port 3021**, and Herd is
serving it:

```
hr.conquest.test → http://127.0.0.1:3021     # its own nginx block
*.conquest.test  → http://127.0.0.1:3020     # the apex's wildcard
```

nginx matches an exact `server_name` ahead of a wildcard, so **`hr` is the one campaign slug that
would _not_ reach the app** — it points at a separate instance that this design never creates. This
plan is one deployment routing by `Host`, exactly as production is one Vercel deployment behind a
wildcard domain.

Two notes on fixing it:

- **Repointing `hr` to 3020 will not work.** `flatten.js` validates ports as unique across the whole
  registry and fails the entire apply with `port 3020 claimed by both conquest.test and
hr.conquest.test`. The registry has no way to express "many hostnames, one instance".
- **The fix is to remove the `hr` subdomain entry** from `apps.json`, re-run `./apply.sh`, and
  `herd unproxy hr.conquest.test` to clear the stale block (apply.sh reports drift rather than
  deleting). The apex wildcard then serves `hr` like every other campaign slug.

If per-segment separate instances are ever genuinely wanted, that is a `dev-proxy` change (a
"several hosts share one port" concept), not something to work around here.

#### Why this is better than `localhost` for this plan specifically

Herd gives real HTTPS and true registrable-domain nesting, so **`SameSite` and cookie behaviour in
dev matches production**. `hr.conquest.test` and `conquest.test` share the registrable domain
`conquest.test` exactly as `hr.conquest.com` and `conquest.com` share `conquest.com` — which is
precisely the rule `dev-proxy`'s `$namingRule` exists to enforce.

That matters here more than usual: the host-scoped httpOnly run-credential failure described under
[Operational risks](#operational-risks) can actually be **reproduced locally**. On `localhost:3000`
it cannot be, and would first appear in production.

#### Sign-in gotcha

**Google OAuth does not work on `.test` domains** — dev sign-in is email/password only. Anyone who
has been using Google for local admin needs an email/password admin user before switching.

This bears directly on **E4**: the claim flow converts an unclaimed draft on signup with a _verified_
email. That path must be exercised locally with email/password, and no part of it may assume an OAuth
signup.

#### Still the fastest loop

None of the above is needed for most work: `https://conquest.test/s/hr` exercises the real code path
with no DNS involved. Only the proxy's host→rewrite step needs a real subdomain to test.

### Production

Because campaigns are **admin-created**, adding a Vercel domain by hand per campaign makes the admin
surface a lie — the campaign shows as published while the host 404s. (For a fixed set of two or
three permanent segments, explicit per-host CNAMEs would be simpler and sufficient; it is
self-service campaign creation that rules them out.)

**Use a wildcard domain (`*.conquest…`)**, which requires the apex to use Vercel's nameservers so the
wildcard certificate can be issued by DNS challenge. Any new slug is then live the moment it is
published, and **prod matches dev** — both serve every subdomain from one deployment behind one
wildcard. The alternative — calling the Vercel domains API from the admin publish action to add each
host explicitly — is more moving parts and more failure modes for the same outcome.

Moving the apex to Vercel's nameservers moves DNS for _everything_ on that domain, mail records
included. That is why it is called out as a lead-time item under
[Sequencing](#sequencing-and-ordering-constraints): decide it early, execute it late.

Either way the campaign list should show real host reachability rather than assuming it.

## Operational risks

**Unauthenticated LLM spend behind a paid-traffic URL.** This is the largest risk in the design. A
public demo promoted by ad spend is an open invitation to burn tokens. Before any campaign goes
live: a deliberately tight per-session cost cap on demo versions (the machinery exists —
`cost_cap_reached` session events carry `spentUsd` / `capUsd`), a per-IP sub-cap on **anonymous
session creation** specifically, and a spend alert. Budget LLM cost per lead alongside ad cost per
lead.

**Resume links cross hosts and break.** The experience run credential is an httpOnly, host-scoped
cookie, and outbound links are built from `env.NEXT_PUBLIC_APP_URL` — the apex (e.g.
`lib/app/questionnaire/report/notify-send.ts`). A visitor who starts on `hr.conquest…` and later
clicks an emailed link lands on the apex without the cookie and sees the "we can't open this
conversation here" screen. Nothing is lost, but it is a bad moment mid-funnel.

_Resolution for v1:_ campaign demos are **single-session and short** — no resume, no email
continuation. Treat that as a design constraint on the demo instrument rather than a bug to fix.

## SEO

Campaign entry points fed by paid traffic do not need to rank. `noindex` the campaign hosts, keep
them out of the sitemap, and do not cross-link them from the apex nav. This removes the
duplicate-content problem outright and removes any obligation to write distinct copy purely for
search. A campaign that later earns organic investment can be promoted to an indexed property then —
make `noindex` a per-campaign field so that promotion is a toggle.

## Keep out of the experience primitives

The Experiences `agentic_switcher` is general-purpose conditional routing and its model, vocabulary
and copy stay domain-neutral. Campaign and lead-gen semantics belong in the marketing layer only.
Demos are composed from ordinary questionnaire configuration; nothing in
`lib/app/questionnaire/**` should learn what a campaign is.

## Sequencing and ordering constraints

### Six rules that must hold

These are not preferences. Each one, broken, produces a failure that is expensive or embarrassing
rather than merely inconvenient.

1. **No public LLM surface goes live before its spend controls.** Applies to campaign demos
   (phase 5) and to every suite asset that calls a model (E1, E6). The controls are cheap to build
   and impossible to retrofit under load.
2. **Measure one real run before setting any cap.** The per-session cost cap, the per-IP/email
   quota and the daily ceiling are all _numbers_, and all three are currently unknown. One measured
   extraction-plus-four-judges run and one completed demo conversation unblock the lot. Do this
   early — it gates phase 5 and E1, and it also tells you whether the free tier is viable at
   paid-traffic volume.
3. **Decide marketing consent and lawful basis before the pipeline is used, not before it is
   built.** Phase 6 can ship without it; the first outbound email cannot.
4. **Enforce the two config constraints at campaign publish.** `anonymousMode: false` and
   `accessMode: public | both` — checked when a campaign is published, naming which is wrong. Both
   fail silently at runtime, and the symptom (an empty pipeline) points nowhere near the cause.
5. **Verified email before any claim transfer** (E4). An unverified match hands one person's
   questionnaire to whoever claims the address.
6. **Never relax an existing `withAdminAuth` route** to serve a public flow. Every public surface
   gets its own route over the shared pure core.

### What actually blocks what

| Item                             | Blocked by                   | Blocks                    |
| -------------------------------- | ---------------------------- | ------------------------- |
| Phase 1 — extract marketing copy | nothing                      | phase 3                   |
| Phase 2 — data model + admin     | nothing                      | phases 3, 6; E5; E9 demos |
| Phase 3 — `/s/[campaign]` routes | phases 1, 2                  | phase 4                   |
| Phase 4 — proxy rewrite          | phase 3                      | phase 7                   |
| Phase 5 — demo instruments       | rule 2 (measurement)         | campaigns being _useful_  |
| Phase 6 — leads + pipeline       | phase 2                      | E5                        |
| Phase 7 — wildcard DNS           | phase 4; nameserver decision | public launch             |
| E1–E3 — evaluator                | rule 2 (measurement)         | E4                        |
| E4 — claim flow                  | E3                           | E6                        |
| E5 — attribution                 | phase 2 (leads), E3          | —                         |
| **E7, E8, E9**                   | **nothing in either track**  | —                         |

Phases 3 and 4 are buildable before phase 5, but a campaign has nothing worth clicking until the
demo instruments exist — build them in parallel rather than discovering the gap at launch.

### Two lead-time items to start early even though they land late

- **The nameserver decision.** A wildcard domain needs the apex on Vercel's nameservers, which moves
  DNS for _everything_ on that domain — mail records included. It sits in phase 7 because that is
  when it is needed, but it must be **decided and planned** at the start. Discovering a mail-routing
  constraint on launch week is the bad version of this.
- **The measurement in rule 2.** It gates two phases and needs nothing but a working dev
  environment, so there is no reason to defer it.

### The cheapest credible first slice

Phase 1 is free value regardless — it is a refactor that improves the existing homepage whether or
not any campaign ships. After that, **E8** (form-vs-conversation) is the least work for a real public
asset: configuration over surfaces that already exist, no new public LLM route, no claim flow, no
quota design. **E6** is the better hook but carries E4 with it.

## Phasing

| Phase | Work                                                                                                                                                                                                 | Risk   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1     | Extract the marketing copy in `components/app/marketing/conquest-home.tsx` (794 lines, copy interleaved with JSX) into a content object rendered by one layout component. Apex output byte-identical | None   |
| 2     | `app-marketing.prisma` + `/api/v1/app/marketing/**` + the admin Marketing section (campaigns, contacts, testimonials). No public surface yet                                                         | Low    |
| 3     | `/s/[campaign]` public landing routes reading the DB, CTAs launching configured demo versions. Reachable by path, no DNS                                                                             | Low    |
| 4     | Proxy `classifySegment(host)` + rewrite + apex-redirect rules; `data-segment` theming                                                                                                                | Low    |
| 5     | Author the demo instruments — short, `public` access, non-anonymous, conversational name/email capture, tight cost cap. **The real work, and it is content/config rather than engineering**          | Medium |
| 6     | Leads + pipeline + `campaignSlug` on sessions + funnel reporting + per-IP creation cap + spend alerts                                                                                                | Medium |
| 7     | Wildcard domain in production, `noindex`, reachability checks                                                                                                                                        | Low    |

Phase 1 is worth doing on its own merits regardless of whether campaigns ship.

### Free-trial suite track (independent)

The suite lives on the apex and shares only the lead pipeline, so it does **not** depend on any
subdomain work. It can ship before, after, or alongside — sequence it on business priority, not
technical order. Its one hard dependency is phase 2, and only for the parts that capture a lead
(E5 onwards); E1–E4 can be built and demoed before any lead model exists.

| Phase | Work                                                                                                                                | Risk   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| E1    | Public `/api/v1/app/evaluate/**` routes over the existing pure core + capability, with hard document limits and per-IP/email quota  | Medium |
| E2    | Async run queue with a global daily spend ceiling; admin visibility of queue depth and spend                                        | Medium |
| E3    | `/evaluate` UI — upload, pick up to 4 of 7 dimensions, preview (scores + severity counts + 2–3 findings), email unlock, full report | Low    |
| E4    | Unclaimed-draft model, verified-email claim-on-signup flow, retention window + purge job, admin view under Marketing                | Medium |
| E5    | Attribution into the pipeline (campaign slug, chosen dimensions as a sales signal); organic SEO for `/evaluate`                     | Low    |

E4 is the phase most likely to be underestimated: the claim flow touches identity, and the
verified-email requirement is a correctness constraint rather than a nicety.

**Only E6 depends on E1–E4.** E7, E8 and E9 share the apex and the pipeline but need nothing from
the evaluator — the template library's "use this template" is an ordinary signed-in copy via
`copyVersionGraph()`, not the unclaimed-draft claim flow, and E8/E9 produce no artefact to claim at
all. Any of the three can ship first:

| Phase | Work                                                                                                                                                       | Risk |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| E6    | **Compose from a brief** — public streaming route over `app_compose_questionnaire`, brief/section caps, shared quota. **Needs E4** (reuses the claim flow) | Low  |
| E7    | **Template library** — public listing + try-as-respondent + "use this template" over `copyVersionGraph()`; segment-filtered for the subdomains             | Low  |
| E8    | **Form-vs-conversation comparison** — `presentationMode: 'both'` plus the answer-slot panel; a chosen question set and the framing around it               | Low  |
| E9    | **Cost calculator** public surface; **demo clients** wired into the lead pipeline                                                                          | Low  |

E6 is worth pulling forward if only one thing ships: it is the cheapest to run, the least
privacy-exposed, and probably the best hook — but it carries E4 with it. If the goal is the earliest
credible public asset for the least work, **E8 is the cheapest** (configuration over existing
surfaces, no new public LLM route, no claim flow, no quota design).

## Open questions

- **Marketing consent / lawful basis** for outbound contact from CRM leads — undecided, and blocking
  before any campaign email is sent.
- **Lead dedupe** when the same person completes demos on two campaigns — one lead with two
  activities, or two leads? Affects the pipeline UX more than the schema.
- **Cost cap value** per demo session, which needs a real measurement of a completed demo run.
- **Unclaimed-draft retention window** for the evaluator — needs a number, and it must be stated on
  the upload screen before launch.
- **Where the paid boundary sits** if the evaluator gets popular: the full seven-judge panel is the
  obvious first upgrade, but re-runs after edits, and applying findings automatically, are both
  plausible instead. Deferred until there is usage to read.
- **Free-tier quota values** (evaluations per IP and per email per period) and the daily spend
  ceiling — all three need a measured cost per evaluation run first.
- Whether a **segment-specific admin** (raised as a later possibility) means a filtered view of this
  section or genuinely separate surfaces. Nothing here forecloses either; the campaign slug is a
  stable identifier stored on leads and sessions precisely so that choice stays open.

## Related documentation

- [`../../orchestration/generative-authoring.md`](../../orchestration/generative-authoring.md) — the two-phase composer behind compose-from-a-brief
- [`../questionnaire/presentation-mode.md`](../questionnaire/presentation-mode.md) — `chat` / `form` / `both`, the basis of the comparison demo
- [`../questionnaire/cost-estimation.md`](../questionnaire/cost-estimation.md) — the heuristic estimator exposed as the public calculator
- [`../questionnaire/demo-clients.md`](../questionnaire/demo-clients.md) — branded demos for qualified leads
- [`../questionnaire/design-evaluation.md`](../questionnaire/design-evaluation.md) — the seven judges, the dispatch seam, and the finding contract the evaluator exposes
- [`../questionnaire/ingestion.md`](../questionnaire/ingestion.md) — document upload and extraction, the evaluator's front door
- [`../questionnaire/anonymous-mode.md`](../questionnaire/anonymous-mode.md) — the identity axis and why capture is null under anonymous mode
- [`../questionnaire/configuration.md`](../questionnaire/configuration.md) — `accessMode`, `anonymousMode` and the rest of version config
- [`../questionnaire/cost-cap-enforcement.md`](../questionnaire/cost-cap-enforcement.md) — the per-session spend ceiling the demos depend on
- [`../questionnaire/experience-continuity.md`](../questionnaire/experience-continuity.md) — the run credential and why it is host-scoped
- [`../../ui/surface-theming.md`](../../ui/surface-theming.md) — the `data-surface` mechanism `data-segment` mirrors
- [`../../security/rate-limiting.md`](../../security/rate-limiting.md) — section caps and where per-flow sub-caps belong
- [`../../privacy/data-erasure.md`](../../privacy/data-erasure.md) — why non-`User` PII sits outside `eraseUser()`
