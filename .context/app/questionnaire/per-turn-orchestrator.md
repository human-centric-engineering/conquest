# Per-turn orchestrator + streaming (F6.1)

The live conversational surface around the P4 engine. A respondent creates a session and
drives a streamed turn loop; each message runs a **deterministic pipeline** over the P4
capabilities and streams the reply back over SSE.

## Why not `streamChat`

Sunrise's `streamChat` / `StreamingChatHandler` is an **LLM-driven tool loop**: one agent,
one system prompt, the model _chooses_ capabilities as tools. F6.1 is the opposite shape —
a fixed-order pipeline where the LLM is called _inside_ each capability via
`runStructuredCompletion`. So F6.1 **reuses the plumbing but not `streamChat`**: it reuses
`sseResponse` (`lib/api/sse.ts`), the `ChatEvent` event shape (`types/orchestration.ts`),
the magic-byte validators, and `logCost`/`calculateCost`, but drives the app-native
orchestrator directly. This matches the P4/P5 app-native dispatch precedent.

## The pure core (`lib/app/questionnaire/orchestrator/`)

`runTurn(state: TurnState, invokers: CapabilityInvokers): Promise<TurnResult>` — Prisma-free
and Next-free, pure relative to its inputs (no clock, no DB, no randomness). The impure
capability calls are injected as `CapabilityInvokers` (real wiring at the route seam,
stubbed in unit tests). Per-step feature flags are resolved by the route and passed in via
`state.flags`, so the core's branching stays synchronous.

Pipeline (a step is **skipped, not failed**, when its flag/config is off):

1. **Extract** (F4.2) — only with a non-empty message → `AnswerSlotIntent[]`.
2. **Merge** — `applyIntents` folds the extracted answer into an _effective_ state so
   completion + selection see it this turn.
3. **Detect contradictions** (F4.3) — only when `config.contradictionMode !== 'off'`.
4. **Refine** (F4.4) — contradiction-driven (the PR2 trigger).
5. **Assess completion** (F4.5, pure `assessCompletion`) — free, always runs.
6. **Respond** — an `offer` (assessment offered + completion flag on), else the next
   question (F4.1 selection), else a terminal `complete`/`none`.

The core returns `{ response, targetedQuestionId, sideEffects, events, toolCalls, costUsd,
contradictions, assessment }`. It does **not** stream — for an offer turn it returns the
composer input and the route streams the prose. A `question` response carries the **verbatim
prompt** as `text`; whether the respondent sees that verbatim or a conversational rendering of
it is the route's decision (see Conversational question phrasing below) — the pure core stays
deterministic and prompt-faithful either way.

## Conversational question phrasing (interviewer)

By default the route streams the question's verbatim `prompt`. With the
`APP_QUESTIONNAIRES_QUESTION_PHRASING_ENABLED` sub-flag on, a `question` turn instead runs an
**interviewer pass** (`_lib/question-stream.ts` → `streamQuestionMessage`) that renders the
targeted question as warm, natural prose — briefly acknowledging the prior answer, calibrating
tone to the version's `goal`/`audience` (role, expertise, sensitivity, locale), offering a
choice/Likert question's options naturally, and **re-asking conversationally** when the prior
answer wasn't captured (`isReask` = this turn re-selected the question the previous turn asked).
Streamed token-by-token off `provider.chatStream` via the seeded `app-questionnaire-interviewer`
agent, exactly like the offer composer. This restores the originally-planned interviewer voice
(`Conversational Questionnaire Phases.md` §Phase 6) that F6.1 dropped when it chose the
deterministic orchestrator over `streamChat`.

**Fail-soft & cost.** A missing agent, no provider, or a mid-stream error before any token drops
back to the **verbatim prompt** (a question is never lost). The phrased message is what's
persisted as the turn's `agentResponse`, so future turns' transcript context reads naturally.
It's an extra LLM call per asked question, hence the opt-in sub-flag (master + live-sessions +
phrasing); when off, there's no extra spend and behaviour is unchanged. The version `goal` +
`audience` reach the route via `buildTurnContext`'s `meta` (the pure core never reads them).

## The route seam

- **Loader** `_lib/turn-context.ts` (`buildTurnContext`) maps the persisted session graph
  (version structure, config, answers, prior turns) onto `TurnState` — coverage vs value
  answer views, oldest→newest transcript, the active question (the prior turn's target),
  monotonic selection round.
- **Invokers** `_lib/turn-invokers.ts` map `TurnState` → each P4 capability's args and
  dispatch via `capabilityDispatcher` with the seeded agent binding, **fail-soft** (a
  failure → empty outcome + diagnostic, never a throw). Selection runs the pure F4.1
  strategy directly (adaptive degrades to weighted when its sub-flag is off).
- **Offer stream** `_lib/offer-stream.ts` (`streamOfferMessage`) is an async generator that
  yields `content` frames off `provider.chatStream` and returns the accumulated message +
  cost; the route delegates with `yield*`.
- **Question stream** `_lib/question-stream.ts` (`streamQuestionMessage`) is the same shape for
  the asked question when phrasing is on (see _Conversational question phrasing_); fail-soft to
  the verbatim prompt.
- **Persistence** `_lib/turn-run.ts` (`persistTurn`) writes answer side-effects through the
  F4.4 slot seam, then `recordTurn` (firing `lastUpdatedTurnId`). A post-response write
  failure is logged, not retro-failed onto the streamed reply. Refinements take the F4.4
  path in full — `loadAnswerSlot` → `applyRefinement` → `persistRefinement` — so a live
  session **appends to `refinementHistory`** (the corrected value plus the pre-change
  value/provenance/source) and **updates the slot's `confidence`** to the refiner's
  certainty, not just the new value. A refinement targeting a slot with no
  captured answer (shouldn't happen) falls back to a plain `refined`-provenance upsert.

## Routes & access

| Route                                                    | Auth        | Purpose                                                             |
| -------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `POST /api/v1/app/questionnaire-sessions`                | `withAuth`  | Create (invitation-bound or logged-in-anonymous), idempotent resume |
| `POST /api/v1/app/questionnaire-sessions/anonymous`      | **public**  | No-login anonymous create → returns a signed `accessToken`          |
| `POST /api/v1/app/questionnaire-sessions/:id/messages`   | per-session | The streaming turn loop                                             |
| `GET /api/v1/app/questionnaire-sessions/:id/transcript`  | per-session | Replayed transcript (prior turns + persisted notices) for resume    |
| `POST /api/v1/app/questionnaire-sessions/:id/transcribe` | per-session | Voice input (F6.2) — audio → `{ text, durationMs, language? }`      |
| `GET /api/v1/app/questionnaire-sessions/:id/status`      | per-session | Lifecycle status (F7.3) — completion-offer + cost tier + anon       |
| `POST /api/v1/app/questionnaire-sessions/:id/lifecycle`  | per-session | Pause/resume (F7.3) — **signed-in respondents only** (403 for anon) |
| `POST /api/v1/app/questionnaire-sessions/:id/submit`     | per-session | Accept→completed (F7.3) — the only respondent completion path       |

The turn route can't use `withAuth` (which hard-requires a session), so `resolveTurnAccess`
branches on the session's `respondentUserId`: **set** → require a logged-in user who matches;
**null** (anonymous) → require a valid `X-Session-Token` bound to this session. Rate-keyed on
the user id, or client IP + session id for anonymous. The transcribe, status, lifecycle, and
submit routes all share this same resolver.

### Session lifecycle (F7.3)

The respondent surface needs three signals the SSE stream doesn't carry, so they're a
read + two mutations rather than stream frames (mirrors F7.2's "read endpoint, not a stream
event" decision):

- **`GET …/status`** returns a respondent-safe `SessionStatusView`: the completion assessment
  (so a Submit affordance can appear when `completion.kind === 'offer'`), a coarse cost
  **tier** (never the raw spend), and the `anonymous` flag. Reuses `buildTurnContext` so the
  assessment is byte-identical to the live turn's; the UI refetches it on the same
  `onTurnSettled` that drives the answer panel. No status gate (paused/completed still report).
- **`POST …/lifecycle` `{ action: 'pause' | 'resume' }`** drives the F4.6 state machine through
  the same `_lib/sessions.ts` seam as the admin `/transition` route, but is **signed-in only** —
  a no-login session has no durable place to resume from (the token is client-only), so an
  anonymous caller is refused with `403 PAUSE_NOT_PERMITTED`. `resume` returns the resume state.
- **`POST …/submit`** is the sole respondent path to `completed`. It re-asserts eligibility via
  the F4.5 `resolveCompletion` (no completion sweep — contradictions already surface live) and
  transitions `active → completed`. A required question can't be outstanding at an offer (the
  required gate is upstream); the lone exception is the existing "a capped session can always
  submit" behaviour. Idempotent on an already-completed session; `409 SUBMIT_NOT_READY` when not
  offerable; `409 SESSION_NOT_ACTIVE` for a paused/abandoned session.

### Voice input (F6.2)

The transcribe route is a thin, transcription-only seam over Sunrise's audio stack — it does
**not** run a turn or stream. It resolves access exactly like the turn route, requires an
`active` session, applies Sunrise's `audioLimiter` (10/min, keyed `audio:qn:<rateKey>`), then
validates the multipart `audio` (+ optional `language`) via the app-side `_lib/audio-upload.ts`
(`validateAudioUpload` — the platform's `validateTranscribeUpload` minus its mandatory `agentId`,
since the session supplies agent context) and reuses the platform size cap / MIME allowlist
**constants**. It calls `getAudioProvider().transcribe()` (OpenAI Whisper) and fire-and-forgets
`logCost({ operation: 'transcription' })` (no `agentId`; `sessionId` in metadata). **Audit
invariant:** no audio bytes or transcript are persisted — the only happy-path write is the cost
row. The client sends the returned transcript through the normal text `/messages` path, so P7 can
wire Sunrise's `<MicButton>` (which expects an endpoint returning `{ text }`) at it verbatim.

### Attachment input

The `/messages` body accepts an optional `attachments` array (the platform `chatAttachmentSchema`
— up to 10 files, ~5 MB each / ~25 MB combined; images + PDF/DOCX/text). When the attachment
sub-flag is on, the route threads them onto `TurnState.attachments`; the extraction invoker forwards
them to the answer-extractor capability, whose prompt builder turns the user turn into multimodal
content parts (`text` + one `image`/`document` part per file — the same conversion as the platform
chat message builder) so the model reads the file alongside the message. Before the LLM call the
capability runs `assertModelSupportsAttachments(provider, model, [vision?|documents?])` and returns a
typed `attachments_not_supported` error if the resolved model lacks the modality (no silent text-only
extraction that would drop the attached answer). The `redactProvenance` row records only an
`attachmentCount`, never the bytes.

### No-login anonymous tokens

`_lib/session-access-token.ts` mints/verifies a stateless HMAC token (`{ sessionId, expiresAt }`
signed with `BETTER_AUTH_SECRET`, constant-time verify, 24h). There is **no better-auth
anonymous plugin**, so the no-login path can't unify under `withAuth`; the token is the only
credential (NOT the bare session cuid, which isn't cryptographically random). The closest
existing precedent is the embed widget (`lib/embed/auth.ts`).

### Resume replay & per-turn notices

A resumed session used to open with only a synthetic "welcome back" greeting — the prior
conversation, and the seriousness / support / contradiction notices it raised, were gone. Those
side-band notices were also transient _within_ a live session: the chat kept one top-level banner
slot that the next send cleared. Both are now persisted and replayed.

- **Persisted on the turn.** Each `warning` frame the core emits is collected from `result.events`
  and written on the turn row (`AppQuestionnaireTurn.warnings` — `{ code, message }[]`, via
  `persistTurn` → `recordTurn`). The chat attaches them to the assistant turn they belong to
  (`QuestionnaireTurn.warnings`) and renders them inline beneath that reply (`<TurnNotices>`), so a
  notice stays pinned as the conversation scrolls on instead of vanishing on the next input.
- **Replayed on resume.** `loadTranscript(sessionId)` (`_lib/transcript.ts`) rebuilds the rendered
  transcript from the ordinal-ordered turn rows — user bubble (skipped for the empty-message
  kickoff turn) + assistant reply + its notices — and seeds it as `initialTurns` (transcript-only;
  the conversation is its own context, so no "welcome back" line). `autoStart` is off on resume, so
  no kickoff re-asks. The authenticated page SSR-seeds it; the no-login surface fetches
  `GET …/transcript` on boot (its token is client-only, so it can't SSR-seed) and falls soft to a
  fresh greeting if that read fails. The `warnings` JSON is validated at the loader boundary and
  degrades to no notices if a row is malformed — a replayed transcript never throws.

## Gating

- Master `APP_QUESTIONNAIRES_ENABLED` + the dark-launch sub-flag
  `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED` (seed 021, off by default). Both off → 404
  before auth, so the respondent surface is invisible until an operator opts in.
- Per-step sub-flags (extraction/contradiction/refinement/completion) gate **individual
  pipeline steps**, not the whole turn — a disabled sub-feature is skipped and the turn
  continues.
- Voice input (F6.2) has its own dark-launch sub-flag `APP_QUESTIONNAIRES_VOICE_INPUT_ENABLED`
  (seed 022, off by default) that opts the paid Whisper path in **on top of** live-sessions —
  `isVoiceInputEnabled` requires master + live-sessions + voice, because a transcript is only
  useful once the respondent can send it through the live `/messages` loop (with live-sessions off
  that route 404s, so transcription would be a dead but still-paid call). Off → the transcribe
  route 404s before auth (`withVoiceInputEnabled`).
- Attachment input has its own dark-launch sub-flag `APP_QUESTIONNAIRES_ATTACHMENT_INPUT_ENABLED`
  (seed 024, off by default), also ANDed with master + live-sessions (`isAttachmentInputEnabled`).
  Unlike voice it doesn't gate a dedicated route — the chat surface hides the affordance and the
  `/messages` route **ignores** any attachments a client sends while it's off, so the paid
  multimodal path stays shut.

## See also

- [`session-state-machine.md`](./session-state-machine.md) — the F4.6 lifecycle this drives.
- [`schema.md`](./schema.md) — the `AppQuestionnaireTurn` model.
- [`completion-logic.md`](./completion-logic.md) — the F4.5 gate the offer turn consumes.
