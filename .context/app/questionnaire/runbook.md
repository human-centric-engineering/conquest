# Operational runbook — spin up a demo client (F9.2)

> **DEMO-ONLY (mostly).** This runbook spins up a sales **demo client** end-to-end. The
> demo-tenancy steps (create a demo client, attribute, reset sessions) are stripped by a real
> client engagement — see [demo-clients.md] § "Fork guidance" and (P9) `forking.md`. The
> middle of the flow — load content → review → configure → launch → invite → run a session —
> is the **core product** and is identical for a real engagement (it just skips the demo-client
> attribution and reset). Read this before presenting to a prospect.

The goal: from a fresh checkout to a respondent answering the first question, in one sitting.
There are two paths — the **seeded fast path** (one command, for a stock demo) and the
**manual path** (when you need bespoke content for a specific prospect). Both end at the same
place: a launched questionnaire attributed to a demo client, ready to invite against.

---

## 0. Prerequisites (once per machine)

1. **App running against a real Postgres.** `docker-compose up` (or a local Postgres), then
   `npm run db:migrate:deploy && npm run db:seed`, then `npm run dev`.
2. **Feature flags are ON.** The questionnaire surface is gated by feature flags that are
   **database rows in the `feature_flag` table, not env vars** — the `APP_*_ENABLED` names look
   like env vars but are not. `npm run db:seed` turns the master flag (`APP_QUESTIONNAIRES_ENABLED`)
   on, but several capability sub-flags **dark-launch OFF** and must be enabled for the demo to show
   them. If a route 404s — or a configured behaviour (safeguarding, contradiction) doesn't fire —
   the flag is off; see [feature-flags.md] for the full matrix and how to toggle one. For the seeded
   demo, enable these `feature_flag` rows:
   - `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED` — the respondent chat surface.
   - `APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_ENABLED` — the "I noticed something" callout.
   - `APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_ENABLED` — safeguarding (tone-softening + support
     signpost on a sensitive disclosure). The demo questionnaire already opts in via its config and
     authors the support copy; this flag is the runtime gate that lets it run.
   - `APP_QUESTIONNAIRES_REASONING_STREAM_ENABLED` — the live "watch it think" reasoning feed.
3. **At least one LLM provider key** (e.g. `ANTHROPIC_API_KEY` in `.env.local`) — the manual
   upload path runs the extractor agent, and every respondent turn calls a model. The seeded
   fast path needs a key only once you start a session, not to seed.
4. **Email** — invitations send a real email. In dev, check the configured mail transport /
   preview; the invitation link also appears in logs.

---

## 1A. Seeded fast path (stock demo)

One command loads a ready-to-demo "Northwind Logistics" client + a launched questionnaire:

```bash
LOAD_DEMO_CONTENT=1 npm run db:seed
```

This creates (idempotently — safe to re-run):

- **Demo client** "Northwind Logistics (Demo)" (slug `northwind-logistics-demo`), branded
  (CTA/accent colours, logo, welcome copy).
- **Launched questionnaire** "Northwind Logistics — Onboarding Experience Review" — 2 sections,
  6 questions, attributed to that client. Runs **anonymously** (so "Preview as respondent" opens
  its real no-login surface) with **contradiction flagging** on (give inconsistent answers and the
  chat surfaces an "I noticed something" callout) and **safeguarding** on (disclose something
  sensitive — e.g. "I'm being abused by my boss" — and the agent softens its tone and signposts
  support once). Both need their sub-flags + the live-sessions flag on at runtime: the
  **contradiction-detection**, **sensitivity-awareness**, and **live-sessions** DB flags — see §0.

> **Preview as respondent** (on a launched version's admin page) always works, anonymous or not.
> An anonymous-mode version opens its real `/q/<versionId>` no-login surface; an invitation-gated
> one opens an admin-only preview (`/q/<versionId>?preview=1` → the admin-gated
> `POST …/questionnaire-sessions/preview` route, which mints a token-backed `isPreview` session that
> is **excluded from analytics**). The selected version's access mode is shown as an "Anonymous
> mode" / "Invitation only" badge next to its section/question counts.

Then skip to **§3 Invite a respondent** — or just hit **Preview as respondent** on the
questionnaire's admin page to try it yourself immediately. To confirm it loaded, open `/admin/questionnaires` —
the questionnaire shows `launched` and attributed to Northwind.

> **Gotcha — it didn't appear?** The seed no-ops unless `LOAD_DEMO_CONTENT=1`. If `db:seed` ran
> once **without** the flag, the runner recorded it as applied and won't re-run on an unchanged
> file. Clear its history row and re-seed:
>
> ```sql
> DELETE FROM "SeedHistory" WHERE name = 'app-questionnaire/025-demo-content';
> ```
>
> then `LOAD_DEMO_CONTENT=1 npm run db:seed`. (Re-seeding **replaces** the demo questionnaire,
> cascading any sessions/invitations against it — an explicit reset.)

---

## 1B. Manual path — create the demo client

For bespoke content, build it by hand. First the client:

1. Go to **`/admin/demo-clients`** → **New demo client** (`/admin/demo-clients/new`).
2. Fill **name** (e.g. "Acme Bank Demo"). The slug is derived from the name; you can override
   it (a collision returns 409). API equivalent: `POST /api/v1/app/demo-clients`.
3. Optional **branding** (the edit page has a live preview): CTA colour, accent colour, logo
   URL, welcome copy. Null fields fall back to the Sunrise default. These are snapshotted onto
   each invitation at send time — see [demo-clients.md] § "Theming module".

## 2. Load content, review, configure, launch

### 2.1 Load content — clone first, upload if net-new

**Duplicate (fastest)** — make a plain copy of any questionnaire and all its settings:

- A **Duplicate** action copies the current version — structure, tags, config, data slots, and
  scoring (no respondent data) — into a fresh draft titled "… — Copy" and drops you on it.
  Reachable three ways: the **⋯ menu** on each row of `/admin/questionnaires`, the **Duplicate**
  button in the workspace header (every tab), and **Export / download → Duplicate this
  questionnaire** on the Structure tab. API: `POST /api/v1/app/questionnaires/[id]/duplicate`.
- **Clone for client** (DEMO-ONLY) is the same copy plus demo-client attribution — on the
  **Settings** tab, pick the demo client. API: `POST /api/v1/app/questionnaires/[id]/clone-for-client`.

**Import a definition** — recreate a questionnaire exported elsewhere:

- **New questionnaire → Import definition** (or **Export / download → Import definition** on the
  Structure tab) uploads a previously-exported definition JSON and creates a new draft with full
  fidelity (structure, settings, data slots, scoring; embeddings regenerated). The inverse is
  **Export / download → Export definition (JSON)**. API: `POST /api/v1/app/questionnaires/import`.

**Upload + extract (net-new content)** — the platform's headline capability:

- On **`/admin/questionnaires`**, **Upload Questionnaire** → pick a `.pdf` / `.docx` / `.md` /
  `.txt`, optionally override goal/audience, submit. The extractor agent parses it into
  sections + questions + an inferred goal/audience synchronously and lands you on the detail
  page. API: `POST /api/v1/app/questionnaires` (multipart). See [ingestion.md].

### 2.2 Review & configure

- On the detail page, review the inferred **goal / audience** and accept or revert extraction
  changes (extraction-changes tab).
- Open the **Configuration** editor and set what the demo needs: selection strategy, completion
  thresholds, optional cost budget, voice toggle, **profile fields** (collected at session
  start unless anonymous mode is on), answer-panel scope. Saving the config row is itself part
  of the launch gate. See [configuration.md].

### 2.3 Launch

- In the status section, transition the version **draft → launched**. The launch gate requires:
  a goal, a non-empty audience, ≥1 section, ≥1 question, and a saved config row. API:
  `PATCH /api/v1/app/questionnaires/[id]/versions/[vid]/status`.

### 2.4 Attribute to the demo client

- On the detail page, use the **Demo client** picker to attribute the questionnaire to your
  client (the seeded path already did this). API: `PATCH /api/v1/app/questionnaires/[id]` with
  `{ demoClientId }`. Attribution is snapshotted onto invitations at send time, so re-attributing
  later doesn't change already-sent invites.

---

## 3. Invite a respondent

1. Go to the questionnaire's **Invitations** page: `/admin/questionnaires/[id]/invitations`.
2. Enter one email (or paste several). **Send** → mints a tokenised link and emails it, branded
   with the demo client's theme. API: `POST /api/v1/app/questionnaires/[id]/invitations`.
   - A 409 here means the version isn't launched — go back to **§2.3**.
   - Resend a failed one from the table. Full lifecycle + token security: [invitations.md].

The respondent receives an email; the link is `/questionnaire-invite?token=…`.

---

## 4. First session (respondent's view)

Walk this yourself with the invited email to rehearse the prospect's experience:

1. Open the email link → **`/questionnaire-invite?token=…`** (no login). Register (set a
   password) or, if the email already has an account, sign in. You're auto-logged-in and
   forwarded on.
2. **`/questionnaires/start`** bootstraps the session. If profile fields are configured (and
   not anonymous mode), you fill them here; they're snapshotted onto the session.
3. **`/questionnaires/[sessionId]`** — the live chat. The agent asks the first question; answer
   conversationally and watch answers land in the side panel. This needs
   `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED`. See [per-turn-orchestrator.md] and
   [answer-slot-panel.md].

---

## 5. Reset between prospects

After a demo, wipe respondent data so the next prospect starts clean:

- On the demo client's edit page (or `POST /api/v1/app/demo-clients/[id]/reset-sessions`),
  run **Reset sessions** (typed-slug confirmation). It hard-deletes every session/turn/answer/
  event for all questionnaires attributed to the client; the questionnaires, versions, config,
  and invitations remain. Details + the anonymous-mode refusal: [demo-session-reset.md].

---

## 6. Troubleshooting

| Symptom                                                    | Cause / fix                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin route or page **404s**                               | A feature flag is off — they're DB rows, not env vars. See [feature-flags.md].                                                                                                                         |
| Demo content didn't load after the seed                    | Seed no-op'd earlier — clear its `SeedHistory` row and re-seed (see **§1A** gotcha).                                                                                                                   |
| **409** when sending an invitation                         | The version isn't launched / has no launched version — launch it (**§2.3**).                                                                                                                           |
| Chat page loads but won't stream                           | `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED` off, or no LLM provider key configured.                                                                                                                     |
| Upload returns **422**                                     | Scanned PDF with no extractable text — use a text-based source.                                                                                                                                        |
| Upload returns **409**                                     | Exact bytes already ingested (SHA-256 dedup) — change the file or re-ingest the draft.                                                                                                                 |
| Selector ignores the **deepen-low-confidence** instruction | Its system prompt changed in seed `005-selection-agent` but re-seeding only re-asserts `isSystem`. Run `npm run db:seed` on a fresh DB, or admin-edit the Questionnaire Selector agent's instructions. |

---

## Road-test checklist (clean machine)

Run this on a fresh checkout + fresh DB before the phase ships. Tick each step; jot any friction
in the **Notes** column and fold the correction back into this doc.

| ✓   | Step               | Expected                                                                | Notes |
| --- | ------------------ | ----------------------------------------------------------------------- | ----- |
|     | Setup              | `docker-compose up`, migrate, seed, `npm run dev` come up clean         |       |
|     | Flags on           | `/admin/questionnaires` loads (no 404)                                  |       |
|     | Seeded fast path   | `LOAD_DEMO_CONTENT=1 npm run db:seed` → Northwind client + launched q'n |       |
|     | Manual client      | create a demo client with branding; preview renders                     |       |
|     | Duplicate          | Duplicate (row ⋯ / header / export menu) copies into a "— Copy" draft   |       |
|     | Import definition  | Import a previously-exported definition JSON → new draft, full fidelity |       |
|     | Clone              | Clone-for-client copies structure into a draft                          |       |
|     | Upload             | upload a `.docx`/`.pdf`; extraction produces sections + questions       |       |
|     | Configure + launch | set config, launch passes the gate                                      |       |
|     | Invite             | invitation email arrives, branded, with a working link                  |       |
|     | Session            | register → start → first question streams; answers land in the panel    |       |
|     | Reset              | reset-sessions clears runs; questionnaire + invitations remain          |       |

---

## See also

- [demo-clients.md] — the demo-tenancy model, branding, clone-for-client, fork guidance.
- [demo-session-reset.md] — the between-demos reset in full.
- [ingestion.md] · [configuration.md] · [invitations.md] · [feature-flags.md] — the core surfaces.

[demo-clients.md]: ./demo-clients.md
[demo-session-reset.md]: ./demo-session-reset.md
[ingestion.md]: ./ingestion.md
[configuration.md]: ./configuration.md
[invitations.md]: ./invitations.md
[feature-flags.md]: ./feature-flags.md
[per-turn-orchestrator.md]: ./per-turn-orchestrator.md
[answer-slot-panel.md]: ./answer-slot-panel.md
