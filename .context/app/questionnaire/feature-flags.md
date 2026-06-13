# Feature-flag inventory — the questionnaire gate matrix (F9.1)

The questionnaire product dark-launches behind **one master flag and ten sub-flags**. This
is the authoritative inventory: every flag, what it gates, what it depends on, and exactly
what a respondent or admin sees when it is **off**. It is the reference the F9.1 hardening
pass verifies (`tests/unit/lib/app/questionnaire/feature-flag.test.ts`) and the runbook
(F9.2) toggles against.

The flag resolvers live in [`lib/app/questionnaire/feature-flag.ts`](../../../lib/app/questionnaire/feature-flag.ts);
the canonical flag-name constants live in the dependency-light
[`constants.ts`](../../../lib/app/questionnaire/constants.ts) (so the seed can import a name
without the resolver's HTTP/DB deps).

## They are DB rows, not env vars

> ⚠️ **`APP_QUESTIONNAIRES_*_ENABLED` are `feature_flag` table rows, not environment
> variables.** The name _looks_ like an env var; it is not. Every resolver is a thin
> wrapper over Sunrise's `isFeatureEnabled(name)`, which reads the `feature_flag` table.

Toggle a flag by writing its row (admin feature-flag surface / seed / a direct DB update),
**not** by setting a shell variable. A flag with no row resolves to its seeded default. This
matters for the runbook and for any "turn X off and confirm the surface disappears" check —
you are flipping a row, and the change is live without a redeploy.

## The two design rules

1. **A disabled surface 404s — it does not 401.** Every route-level gate runs **before**
   auth (`withQuestionnairesEnabled` / `withLiveSessionsEnabled` / `withVoiceInputEnabled`
   wrap the handler so the gate fires first). A switched-off feature is therefore
   indistinguishable from a route that was never built — no information leaks about a
   feature that exists but is dark. Never place a gate after `withAdminAuth`/`withAuth`.

2. **A sub-flag requires its parents.** Every sub-flag resolver `AND`s the master flag (and,
   for the live-dependent trio, the live-sessions flag) — so turning a parent off
   transitively closes every child, and no child can run with its parent dark.

## The matrix

`is*Enabled()` returns `true` only when **all** the flags in its "Requires" column are on.

| #   | Flag (`feature_flag` name)                           | Resolver                                                  | Requires                   | Gates                                                                                                | Off-behaviour                                                                                                                                                                                   |
| --- | ---------------------------------------------------- | --------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `APP_QUESTIONNAIRES_ENABLED`                         | `isQuestionnairesEnabled` / `ensureQuestionnairesEnabled` | — (master)                 | **the entire app** — every `/api/v1/app/**` route, every admin + respondent surface                  | every questionnaire route **404s**; the whole product is invisible                                                                                                                              |
| 1   | `APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED`       | `isAdaptiveSelectionEnabled`                              | master                     | F4.1 adaptive (embedding + LLM) next-question selection                                              | a version set to `adaptive` **degrades to `weighted`** (no 404 — selection still runs, just cheaper)                                                                                            |
| 2   | `APP_QUESTIONNAIRES_ANSWER_EXTRACTION_ENABLED`       | `isAnswerExtractionEnabled`                               | master                     | F4.2 answer-extraction preview route                                                                 | route **404s**                                                                                                                                                                                  |
| 3   | `APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_ENABLED` | `isContradictionDetectionEnabled`                         | master                     | F4.3 contradiction-detection preview route                                                           | route **404s**                                                                                                                                                                                  |
| 4   | `APP_QUESTIONNAIRES_ANSWER_REFINEMENT_ENABLED`       | `isAnswerRefinementEnabled`                               | master                     | F4.4 answer-refinement preview route                                                                 | route **404s**                                                                                                                                                                                  |
| 5   | `APP_QUESTIONNAIRES_COMPLETION_ENABLED`              | `isCompletionEnabled`                                     | master                     | F4.5 completion-offer **phrasing** (the LLM prose)                                                   | the completion-status route returns the deterministic **assessment with no composed offer** (no 404 — the free assessment is always available under the master flag)                            |
| 6   | `APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED`       | `isDesignEvaluationEnabled`                               | master                     | F5.1 seven-judge design-evaluation preview route                                                     | route **404s** (the whole route is paid LLM work — no free fallback)                                                                                                                            |
| 7   | `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED`           | `isLiveSessionsEnabled` / `ensureLiveSessionsEnabled`     | master                     | F6.1 respondent surface — session-create + `/messages` turn loop (incl. the no-login anonymous path) | session-create and messages routes **404**; the respondent surface disappears                                                                                                                   |
| 8   | `APP_QUESTIONNAIRES_VOICE_INPUT_ENABLED`             | `isVoiceInputEnabled` / `ensureVoiceInputEnabled`         | master **+ live-sessions** | F6.2 voice transcribe route                                                                          | route **404s** (a transcript is useless without the live turn loop, so voice is gated behind live-sessions, not merely beside it)                                                               |
| 9   | `APP_QUESTIONNAIRES_ATTACHMENT_INPUT_ENABLED`        | `isAttachmentInputEnabled`                                | master **+ live-sessions** | respondent image/document attachments on a `/messages` turn                                          | the chat hides the attach affordance and the `/messages` route **ignores any attachments** a client sends (no 404 — it gates a behaviour inside an already-gated route)                         |
| 10  | `APP_QUESTIONNAIRES_COST_CAP_ENABLED`                | `isCostCapEnforcementEnabled`                             | master **+ live-sessions** | F6.3 per-session USD budget check at the turn boundary                                               | turns run with **no budget check** even when a version sets `costBudgetUsd` (no 404 — it gates a behaviour inside the messages route)                                                           |
| 11  | `APP_QUESTIONNAIRES_SERIOUSNESS_GATE_ENABLED`        | `isSeriousnessGateEnabled`                                | master **+ live-sessions** | F9.5 seriousness / abuse gate — judge + disregard + strike/abandon on the `/messages` turn loop      | turns run with **no seriousness judging** even when a version sets `abuseThreshold` (no 404 — it gates a behaviour inside the messages route). See [seriousness-gate.md](./seriousness-gate.md) |

## The three off-behaviour shapes

Reading the table, every sub-flag falls into one of three shapes — know which one you are
verifying:

- **Route 404** (flags 2, 3, 4, 6, 7, 8) — the gated route is paid LLM work or a whole
  surface; off ⇒ the route returns 404 via its `ensure*`/`with*` wrapper.
- **Degrade** (flags 1, 5) — a cheaper deterministic result stands in: adaptive → weighted;
  composed offer → bare assessment. The route still responds.
- **Behaviour-inside-route** (flags 9, 10) — there is no route to 404; the flag toggles a
  branch inside an already-gated route (attachments ignored; budget check skipped).

When verifying "with each off, the gated surface is suppressed and the rest is unaffected",
assert against the shape: a 404 for the first group, the fallback result for the second, the
absent side-effect for the third.

## Verification

- **Resolver truth tables** — `tests/unit/lib/app/questionnaire/feature-flag.test.ts` pins,
  for every resolver, that it is `true` only when all required flags are on and `false` when
  the master, the sub-flag, or (for the live trio) live-sessions is off.
- **Independence** — the same suite asserts a representative route behind each gate is
  suppressed when its flag is off while a sibling behind a different (still-on) flag keeps
  responding, so flags gate their own surface and nothing else.
- **Concurrency / happy path** — `npm run smoke:concurrent-sessions` exercises the live
  respondent surface (flag 7) end-to-end against the real DB.
