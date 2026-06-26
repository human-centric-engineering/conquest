# Config Advisor — AI review of a version's whole configuration

> An admin-triggered panel on the version **Settings** tab. It reads the entire questionnaire
> (structure, goal/audience, run-time config, data slots, scoring, lifecycle/session state),
> **streams a narrative** describing the experience the current settings produce and the current
> state, then lists **conflicts** and **one-click suggestions**. Ephemeral and re-runnable — nothing
> is persisted, and it never runs on its own.

## When it runs

Only when the admin presses **Run advisor** / **Re-run**. There is no GET, no auto-run on tab
visit, on apply, or on settings change. Each run is two reasoning LLM calls (a streamed narrative +
a structured analysis), so it is flag-gated and rate-limited like the other paid sub-flows.

## Flag + agent

- **Flag** `APP_QUESTIONNAIRES_ADVISOR_ENABLED` (DB row, seeded **disabled** by
  `prisma/seeds/app-questionnaire/056-advisor-flag.ts`). Resolved by `isAdvisorEnabled()` /
  gated by `withAdvisorEnabled()` in `lib/app/questionnaire/feature-flag.ts`. ANDs with the master
  `APP_QUESTIONNAIRES_ENABLED`. The workspace flag is surfaced as `flags.advisor`
  (`resolveQuestionnaireWorkspaceFlags`), which the Settings page reads to decide whether to render.
- **Agent** slug `app-questionnaire-advisor` (`QUESTIONNAIRE_ADVISOR_AGENT_SLUG`), seeded by
  `057-advisor-agent.ts` with empty `model`/`provider` (resolved at runtime via `agent-resolver.ts`),
  `visibility: 'internal'`, a monthly budget cap. Loaded by slug in the route for the provider
  binding + cost attribution. Not a chat agent — dispatched programmatically.

## Flow

1. **Route** `POST /api/v1/app/questionnaires/:id/versions/:vid/advisor/stream`
   (`app/api/v1/app/questionnaires/[id]/versions/[vid]/advisor/stream/route.ts`):
   `withAdminAuth` → `withAdvisorEnabled` (404 when off) → per-admin `advisorLimiter` (20/min) →
   load the advisor agent (503 if not seeded) → assemble context (404 if the version isn't under the
   questionnaire) → `sseResponse(drive())`. Writes the `questionnaire.advisor` admin-audit action.
2. **Context** `loadAdvisorContext()` (`_lib/advisor-context.ts`) reuses `getVersionGraph` (config +
   audience already narrowed) and adds session count, data slots, and scoring. Kept **bounded** —
   per-section counts + a few sample prompts, not every prompt — so prompt cost is predictable.
3. **Orchestrator** `streamAdvisor()` (`lib/app/questionnaire/advisor/stream-advisor.ts`), an async
   generator that **never throws**:
   - Phase 1 — `provider.chatStream` streams the narrative; each chunk → `narrative_delta`, then
     `narrative_done`.
   - Phase 2 — `runStructuredCompletion` (validated by `validateAdvisorAnalysis`) → one `analysis`
     event with `conflicts[]` + `suggestions[]`.
   - `logCost` once for both phases (`metadata: { capability: 'advisor' }`).
   - Any provider/parse failure → a single `error` event (the response is already streaming).
     Event lifecycle: `narrative_delta`\* → `narrative_done` → `analysis` → `done` (the route emits
     `done`), or a terminal `error`. Types in `advisor-events.ts` (pure, shared with the client).
4. **Client** `AdvisorPanel` (`components/admin/questionnaires/advisor/advisor-panel.tsx`):
   fetch → reader → `parseSseBlock` loop; renders the streaming narrative as Markdown, then the
   conflicts + suggestions.

## One-click apply

Suggestions are **field-targeted**. Each `suggestion.patch` is a partial config object whose keys
are drawn only from `ADVISOR_APPLYABLE_CONFIG_FIELDS` (`advisor-schema.ts`) — scalar/enum fields
only; the structured blocks (`tone`, `respondentReport`, `cohortReport`, `intro`,
`profileFields`, `inviteeFields`) may appear in **conflicts** but never in a one-click patch.

**Apply reuses the existing config endpoint** — there is no advisor-specific write path. The panel
posts the `patch` to `PATCH …/versions/:vid/config` via `authoringMutate`, so it inherits the full
`updateConfigSchema` validation (including cross-field rules — co-dependent fields like
`contradictionMode` + `contradictionWindowN` travel together in one patch) and the fork-on-launch
discipline. A launched version forks a new draft on apply; the panel shows the fork notice and
redirects, mirroring `version-settings-panel.tsx`. After any apply the panel marks itself **stale**
and invites a re-run.

## Tests

- `tests/unit/lib/app/questionnaire/advisor/advisor-schema.test.ts` — normalisation (allowlist
  filtering, empty-patch drop, id minting, malformed rejection).
- `tests/unit/lib/app/questionnaire/advisor/stream-advisor.test.ts` — event lifecycle, fatal paths,
  cost-logged-once, never-throws.
- `tests/unit/lib/app/questionnaire/advisor/advisor-prompt.test.ts` — prompt shape + allowlist
  constraint.
- `tests/unit/app/api/v1/app/questionnaires/_lib/advisor-context.test.ts` — snapshot assembly:
  count/required-split/histogram math, scoring + demo-client fallbacks, sample-prompt and data-slot
  bounding, the two not-found paths.
- `tests/unit/app/api/v1/app/questionnaires/advisor-stream.test.ts` — route wiring: rate-limit
  short-circuit, agent-not-seeded 503, context-miss 404, audit payload, terminal `done`, mid-stream
  error suppresses `done`.
- `tests/unit/components/admin/questionnaires/advisor/advisor-panel.test.tsx` — panel behaviour:
  idle-on-mount (no fetch), narrative streaming, conflicts/suggestions render, apply → `authoringMutate`
  with fork redirect, error states.
- `tests/unit/lib/app/questionnaire/feature-flag.test.ts` — the advisor flag's truth table,
  independence, and `ensure*`/`with*` gate wrappers.
- `tests/unit/prisma/seeds/app-questionnaire/advisor-flag.test.ts`,
  `tests/unit/prisma/seeds/app-questionnaire/advisor-agent.test.ts` — seed shape.
