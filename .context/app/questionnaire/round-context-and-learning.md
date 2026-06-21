# Round Additional Context & Learning Mode

Two independently-flagged, **round-level** capabilities that enrich the live interviewer. Both hang
off `AppQuestionnaireRound` (see [cohorts.md](./cohorts.md)) and are **off by default** at every level.

> **Status:** Phases 1–2 shipped — foundation + Additional Context backend (CRUD API + runtime
> injection). The admin UI / AI authoring and all of Learning Mode land in later phases. This doc
> grows with them.

## Additional Context (the "interviewer briefing")

Admin-authored facts/figures/background the interviewer draws on when asking — optionally attributed
to a single question. Think of it as briefing an interviewer before they walk into the room.

- **Storage:** `AppRoundContextEntry` (round-level). Each entry carries `versionId` (scopes a
  multi-questionnaire round so one questionnaire's briefing never bleeds into another) and an optional
  `questionSlotId` (`null` = general briefing for the whole version; else attributed to one question).
- **Retrieval (no vector DB):** direct FK lookup. When the interviewer selects the next question, the
  entries for that `questionSlotId` **plus** the round's general entries for that `versionId` are
  injected verbatim into the phrasing prompt. Deterministic, auditable, zero per-turn embedding cost.
- **Gating:** the platform flag `APP_QUESTIONNAIRES_ROUND_CONTEXT_ENABLED`
  (`isRoundContextEnabled()` — master AND cohorts AND this sub-flag) **AND** the per-round
  `contextEnabled` toggle. Both must be on before anything reaches the prompt.

### API

| Method   | Route                                 | Purpose                                         |
| -------- | ------------------------------------- | ----------------------------------------------- |
| `GET`    | `/api/v1/app/rounds/:id/context`      | List entries (optional `?versionId=` filter)    |
| `POST`   | `/api/v1/app/rounds/:id/context`      | Create (general or `questionSlotId`-attributed) |
| `PATCH`  | `/api/v1/app/rounds/:id/context/:eid` | Re-attribute / retitle / rewrite / reorder      |
| `DELETE` | `/api/v1/app/rounds/:id/context/:eid` | Remove an entry                                 |

All gated by `withRoundContextEnabled` + `withAdminAuth`, audited. Create/PATCH validate that the
`versionId` is one the round bundles and any `questionSlotId` belongs to that version (else 400).

### Runtime injection

The live turn route (`questionnaire-sessions/[id]/messages`) loads the round's entries once per turn
(`loadRoundBriefing`, returns `null` when off), then at phrasing time `selectBriefingLines` keeps the
general entries plus those attributed to the asked question — for a data-slot turn, the slot's
`mappedQuestionKeys` resolve to question slot ids. The result lands in `QuestionComposeInput.briefing`
→ a `<briefing>` section in `buildStreamingQuestionPrompt`, framed strictly as the interviewer's own
briefing (never read aloud, quoted, or attributed to the respondent). Capped to
`BRIEFING_MAX_ENTRIES` entries / `BRIEFING_MAX_CONTENT_CHARS` chars each.

## Learning Mode

The interviewer is given **generalised, anonymised** themes from prior respondents _in the same round_
and uses them subtly — colouring phrasing ("some respondents mentioned X — how do you feel about
that?") and, under the `adaptive` strategy, probing divergent topics harder.

- **Storage:** `AppRoundLearningDigest` — a cached, per-slot, generalised theme rebuilt when a session
  completes (one batched LLM call per refresh), then read cheaply each turn. Holds **no individual
  data**: `insight` is generalised text only (no names, no verbatim quotes); `respondentCount` is the
  k-anonymity count; `divergence` (0–1) feeds the adaptive probe-harder weighting.
- **Scope:** completed, non-preview sessions in the **same round** on the **same version**, excluding
  the current respondent.
- **k-anonymity:** `learningConfig.minRespondents` (default 3, floor 2 — see `resolveLearningConfig`)
  suppresses every theme until enough respondents have completed, at both round and per-slot level.
- **Bias:** Learning Mode **introduces bias by design** (later answers are influenced by earlier
  ones). The admin UI warns; the flag, the per-round toggle, and the k-anonymity gate keep it opt-in.
- **Gating:** the platform flag `APP_QUESTIONNAIRES_LEARNING_MODE_ENABLED` (`isLearningModeEnabled()`
  — master AND cohorts AND this sub-flag) **AND** the per-round `learningEnabled` toggle **AND** the
  k-anonymity threshold being met.

## Round config

`AppQuestionnaireRound` gains three columns (migration `…_app_round_context_and_learning`):

| Column            | Type              | Meaning                                                  |
| ----------------- | ----------------- | -------------------------------------------------------- |
| `contextEnabled`  | `Boolean` (false) | Additional Context on/off for this round                 |
| `learningEnabled` | `Boolean` (false) | Learning Mode on/off for this round                      |
| `learningConfig`  | `Json` (`{}`)     | `LearningConfigShape`; resolves to defaults at read time |

`learningConfig` follows `AppQuestionnaireConfig`'s lazy-defaults pattern: stored as `{}`, resolved
through `resolveLearningConfig()` (clamps `minRespondents` to its floor — the read path never trusts a
sub-floor stored value). All three are edited via the round PATCH (`PATCH /api/v1/app/rounds/:id`);
the partial `learningConfig` is merged onto the stored JSON.

## Key files

| Concern                       | Path                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Flag constants                | `lib/app/questionnaire/constants.ts`                                                                                  |
| Flag resolvers / gates        | `lib/app/questionnaire/feature-flag.ts` (`isRoundContextEnabled`, `isLearningModeEnabled`, `withRoundContextEnabled`) |
| Round config types + resolver | `lib/app/questionnaire/rounds/types.ts` (`LearningConfigShape`, `resolveLearningConfig`)                              |
| PATCH schema                  | `lib/app/questionnaire/rounds/schemas.ts` (`updateRoundSchema`, `learningConfigSchema`)                               |
| Models                        | `prisma/schema/app-questionnaire.prisma` (`AppRoundContextEntry`, `AppRoundLearningDigest`)                           |
| Flag seeds                    | `prisma/seeds/app-questionnaire/050-round-context-flag.ts`, `051-learning-mode-flag.ts`                               |
