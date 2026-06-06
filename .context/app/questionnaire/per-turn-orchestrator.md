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
composer input and the route streams the prose (the offer is the only LLM-streamed text;
question prompts are deterministic).

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
- **Persistence** `_lib/turn-run.ts` (`persistTurn`) writes answer side-effects through the
  F4.4 slot seam, then `recordTurn` (firing `lastUpdatedTurnId`). A post-response write
  failure is logged, not retro-failed onto the streamed reply.

## Routes & access

| Route                                                    | Auth        | Purpose                                                             |
| -------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `POST /api/v1/app/questionnaire-sessions`                | `withAuth`  | Create (invitation-bound or logged-in-anonymous), idempotent resume |
| `POST /api/v1/app/questionnaire-sessions/anonymous`      | **public**  | No-login anonymous create → returns a signed `accessToken`          |
| `POST /api/v1/app/questionnaire-sessions/:id/messages`   | per-session | The streaming turn loop                                             |
| `POST /api/v1/app/questionnaire-sessions/:id/transcribe` | per-session | Voice input (F6.2) — audio → `{ text, durationMs, language? }`      |

The turn route can't use `withAuth` (which hard-requires a session), so `resolveTurnAccess`
branches on the session's `respondentUserId`: **set** → require a logged-in user who matches;
**null** (anonymous) → require a valid `X-Session-Token` bound to this session. Rate-keyed on
the user id, or client IP + session id for anonymous. The transcribe route shares this same
resolver.

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

### No-login anonymous tokens

`_lib/session-access-token.ts` mints/verifies a stateless HMAC token (`{ sessionId, expiresAt }`
signed with `BETTER_AUTH_SECRET`, constant-time verify, 24h). There is **no better-auth
anonymous plugin**, so the no-login path can't unify under `withAuth`; the token is the only
credential (NOT the bare session cuid, which isn't cryptographically random). The closest
existing precedent is the embed widget (`lib/embed/auth.ts`).

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

## See also

- [`session-state-machine.md`](./session-state-machine.md) — the F4.6 lifecycle this drives.
- [`schema.md`](./schema.md) — the `AppQuestionnaireTurn` model.
- [`completion-logic.md`](./completion-logic.md) — the F4.5 gate the offer turn consumes.
