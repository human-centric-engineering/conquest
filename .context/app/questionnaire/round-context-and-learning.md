# Round Additional Context & Learning Mode

Two independently-toggled, **round-level** capabilities that enrich the live interviewer. Both hang
off `AppQuestionnaireRound` (see [cohorts.md](./cohorts.md)) and are **off by default**, each gated
solely by its own per-round toggle.

> **Status:** Both features complete. Additional Context (phases 1–3): foundation, backend (CRUD +
> runtime injection), admin UI with upload + AI suggest. Learning Mode (phases 1, 4–5): foundation,
> backend (digest + injection + adaptive probing), admin UI with the bias warning + rebuild.

## Additional Context (the "interviewer briefing")

Admin-authored facts/figures/background the interviewer draws on when asking — optionally attributed
to a single question. Think of it as briefing an interviewer before they walk into the room.

- **Storage:** `AppRoundContextEntry` (round-level). Each entry carries `versionId` (scopes a
  multi-questionnaire round so one questionnaire's briefing never bleeds into another) and an optional
  `questionSlotId` (`null` = general briefing for the whole version; else attributed to one question).
- **Retrieval (no vector DB):** direct FK lookup. When the interviewer selects the next question, the
  entries for that `questionSlotId` **plus** the round's general entries for that `versionId` are
  injected verbatim into the phrasing prompt. Deterministic, auditable, zero per-turn embedding cost.
- **Gating:** the per-round `contextEnabled` toggle is the only gate — it must be on before anything
  reaches the prompt.

### API

| Method   | Route                                 | Purpose                                         |
| -------- | ------------------------------------- | ----------------------------------------------- |
| `GET`    | `/api/v1/app/rounds/:id/context`      | List entries (optional `?versionId=` filter)    |
| `POST`   | `/api/v1/app/rounds/:id/context`      | Create (general or `questionSlotId`-attributed) |
| `PATCH`  | `/api/v1/app/rounds/:id/context/:eid` | Re-attribute / retitle / rewrite / reorder      |
| `DELETE` | `/api/v1/app/rounds/:id/context/:eid` | Remove an entry                                 |

Plus two AI-authoring routes: `POST …/context/suggest` (the composer agent proposes briefing notes
from a version's questions + optional source material — returns `{ entries }` the admin reviews) and
`POST …/context/parse` (multipart → extracts text from an uploaded doc for the content field). All
admin-only (`withAdminAuth`), audited. Create/PATCH validate that the
`versionId` is one the round bundles and any `questionSlotId` belongs to that version (else 400).

### Admin UI

`components/admin/cohorts/round-context-panel.tsx` on the round detail page: the `contextEnabled`
toggle, a list grouped by bundled questionnaire (title + content preview + a `manual`/`upload`/`AI`
provenance badge + the attached question or "General"), an add/edit form with an attribution picker
(questionnaire → General or a specific question), a per-entry delete, **Upload document** (→ parse →
fills content), and **Suggest with AI** (proposals the admin accepts one at a time). The
`AppSuggestRoundBriefingCapability` (composer-agent-bound, seed `052`) backs the suggest flow; the
section is hidden whenever the per-round `contextEnabled` toggle is off.

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
  ones). The admin UI warns; the per-round toggle and the k-anonymity gate keep it opt-in.
- **Gating:** the per-round `learningEnabled` toggle **AND** the k-anonymity threshold being met —
  there is no platform flag.

### Runtime (backend)

`lib/app/questionnaire/learning/digest.ts`:

- `refreshRoundLearningDigest(roundId, versionId)` — rebuilds the digest. Loads completed, non-preview,
  **non-high-sensitivity** sessions; below `minRespondents` it **clears** the digest (so a shrunk
  corpus can't leave stale rows) and returns. Otherwise it aggregates per slot (data-slot paraphrases
  preferred, else question answers), keeps only slots with ≥ `minRespondents` distinct respondents,
  and runs **one** composer-agent LLM call to produce a generalised `insight` + `divergence` per slot.
  Writes wholesale in a transaction (delete + createMany). Fully **fail-soft**: a transient LLM error
  leaves the existing digest untouched (never wipes on error). Triggered **fire-and-forget** from the
  submit route after a session completes (the LLM call must not block the respondent's submit
  confirmation) — so the next respondent sees the just-finished one folded in; a missed rebuild
  self-heals on the next completion or a manual admin Rebuild. The current respondent is excluded
  structurally (their session is still `active`, not in the corpus).
- `loadRoundPeerDigest(roundId, versionId)` — read for injection; `null` when the round toggle is off.

**Injection.** The live messages route loads the digest once per turn and, at phrasing time, passes
the asked slot's `insight` as `QuestionComposeInput.peerContext` → a `<peer_context>` section in
`buildStreamingQuestionPrompt` with strict framing (aggregate-only, never name/quote/lead, at most
once). **Adaptive probing** (chosen over phrasing-only): per-question-key `divergence` flows through
`buildTurnInvokers` → `SelectionContext.peerDivergenceByKey` → the `adaptive` selector, which surfaces
each candidate's divergence band and nudges the LLM to probe split topics harder — **only** under the
`adaptive` strategy (other strategies stay phrasing-only). When peer context is injected, a one-off
`learning_applied` session event is recorded (`lib/app/questionnaire/learning/events.ts`) as the
precise bias-audit signal.

### Admin UI + bias surfacing

`components/admin/cohorts/round-learning-panel.tsx` on the round detail page: a **prominent, always-on
bias warning**, the `learningEnabled` toggle, the `minRespondents` (k-anonymity) control, a preview of
the current themes (insight + respondent count + a divergence band + last-built time), and a manual
**Rebuild** (`POST …/learning/rebuild`, admin-only, rebuilds every bundled
version). The round header shows a `Learning · biased` pill whenever the round has learning on, so the
caveat travels with any results view. The interviewer's injected peer context is already visible in
the Preview Turn Inspector (it's part of the phrasing prompt the inspector records).

### Erasure

The digest holds **no individual data** (generalised text only). On respondent erasure the row count
shrinks; the digest is rebuilt wholesale on the next completion (and the admin can force a **Rebuild**
immediately). A below-threshold corpus after erasure clears the digest entirely. So erasure needs no
bespoke `eraseUser` hook — the rebuild-on-completion + manual rebuild keep it consistent.

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

| Concern                       | Path                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Round config types + resolver | `lib/app/questionnaire/rounds/types.ts` (`LearningConfigShape`, `resolveLearningConfig`)                      |
| PATCH schema                  | `lib/app/questionnaire/rounds/schemas.ts` (`updateRoundSchema`, `learningConfigSchema`)                       |
| Models                        | `prisma/schema/app-questionnaire.prisma` (`AppRoundContextEntry`, `AppRoundLearningDigest`)                   |
| Feature-flag removal note     | [`./feature-flags.md`](./feature-flags.md) (the old platform sub-flags are gone; both features are always on) |
