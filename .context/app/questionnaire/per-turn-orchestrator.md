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
stubbed in unit tests).

Pipeline (a step is **skipped, not failed**, when its per-version config leaves it off —
e.g. contradiction mode `off`):

1. **Extract** (F4.2) — only with a non-empty message → `AnswerSlotIntent[]`.
2. **Merge** — `applyIntents` folds the extracted answer into an _effective_ state so
   completion + selection see it this turn.
3. **Contradiction phase** (F4.3 detect + F4.4 refine + the probe-confirm flow), shared with
   data-slot mode in `orchestrator/contradiction-phase.ts`. Resolves a `PendingContradiction` parked
   on a prior turn (run the refiner, clear it), OR detects afresh (gated by mode/cadence + a floor of
   ≥1 stored answer when there's a latest message, else ≥2; detection runs over the PRE-merge answers;
   the invoker feeds the detector the respondent's **latest message** so a _same-slot reversal_ is
   caught even when extraction didn't overwrite the prior answer). On a hit: `flag` mode refines
   immediately; `probe` mode **defers** — it asks a reconciliation question (a `contradiction_probe`
   response), suppresses this turn's writes, and parks the finding. See
   [`contradiction-detection.md`](./contradiction-detection.md#probe-confirm-flow-probe-mode).
4. **Assess completion** (F4.5, pure `assessCompletion`) — free, always runs.
5. **Respond** — a `contradiction_probe` (probe-confirm flow) else an `offer` (assessment offered +
   completion flag on), else the next question (F4.1 selection), else a terminal `complete`/`none`.

The core returns `{ response, targetedQuestionId, sideEffects, events, toolCalls, costUsd,
contradictions, assessment }`. It does **not** stream — for an offer turn it returns the
composer input and the route streams the prose. A `question` response carries the **verbatim
prompt** as `text`; whether the respondent sees that verbatim or a conversational rendering of
it is the route's decision (see Conversational question phrasing below) — the pure core stays
deterministic and prompt-faithful either way.

## Conversational question phrasing (interviewer)

Rather than stream the question's verbatim `prompt`, a `question` turn runs an
**interviewer pass** (`_lib/question-stream.ts` → `streamQuestionMessage`) that renders the
targeted question as warm, natural prose — briefly acknowledging the prior answer, calibrating
tone to the version's `goal`/`audience` (role, expertise, sensitivity, locale), and **re-asking
conversationally** when the prior answer wasn't captured (`isReask` = this turn re-selected the
question the previous turn asked).

**Prompt structure (XML sections).** The interviewer prompt — and the other capability prompts
(the two adaptive selectors, the answer extractor, refiner, and completion-offer composer) — are
assembled with the shared formatter `lib/app/questionnaire/prompt/format.ts`
(`section`/`joinSections`/`bulletList`/`numberedList`/`titledBlock`/`jsonOutputContract`). It frames
each prompt as XML-tagged sections (`<role>`, `<rules>`, `<this_turn>`, `<context>`, `<tone>`,
`<output_format>`, `<message_shape>`, …) — chosen over Markdown headers because the interviewer may emit Markdown in its
reply, so tags can't collide with output. Empty input collapses to `''`, so optional sections (tone,
prior answers) stay free. The instructional text is unchanged; the structure just makes section
boundaries legible to the model, the admin Prompt Library, and the Turn Inspector. Notably, the
admin-configured **tone & persona** clauses (`buildToneInstructions`) render inside an explicit
`<tone>` section, so it's obvious in the inspector when a version's voice is actually applied.

**Message shape (readable, single-ask, adaptive).** A `<message_shape>` section governs the prose
structure so replies don't arrive as one dense block. It asks for up to three short blank-line-separated
paragraphs — a brief opener, the question on its own, and an optional closing line — with no printed
labels or headings. Three behaviours fall out of it: (1) the **opener stays light by default** (a nod,
a thanks, or a topic-change note; skipped on the opening question) and only reflects the whole answer
back when a **Mirroring** tone clause says to — so full mirroring is opt-in via the `mirroring` slider,
not a default; (2) the **question is a single clean ask** ending in one question mark — no stacked
second/third question; (3) the **closing line is optional and value-gated** — used only to explain an
unobvious "why" or to coax a concrete example when recent answers have been thin, and omitted entirely
when the respondent is already answering openly and at length, so it never reads as repetitive coaxing.

**Continuity from prior answers.** The phraser also receives a short `priorAnswers` digest —
"what they've already shared this session" — built by `_lib/prior-answers.ts`
(`buildPriorAnswersDigest`): the confidently-filled, non-provisional data slots rendered as
`name: paraphrase` (or, in question mode, captured answers as `prompt: value`), excluding the
slot/question being asked this turn and capped to keep the prompt lean. It's passed as
**background only** — the interviewer may glance back at one point when it genuinely helps the
next question land, but the prompt forbids recapping the list or re-asking anything in it. Absent
when nothing is captured yet → the block is omitted (no behaviour change).

**Infer scales/choices; only spell them out as a last resort.** A choice or Likert question is
asked **openly** on the first ask — the interviewer asks about the underlying feeling/choice in
plain language and the extractor (+ the answer-fit resolver, see
[`answer-extraction.md`](./answer-extraction.md)) maps the natural reply to the option slug or
scale point. The phraser does **not** read out the option list or a numeric scale up front. Only on
a struggling **re-ask** (`isReask`) does the user message authorise offering the choices explicitly
(`extractOptionLabels`) or the simple `min–max` scale (`extractLikertScale`) as a clarifying aid —
the "last resort" the respondent never needs when their words already map.
Streamed token-by-token off `provider.chatStream` via the seeded `app-questionnaire-interviewer`
agent, exactly like the offer composer. This restores the originally-planned interviewer voice
(`Conversational Questionnaire Phases.md` §Phase 6) that F6.1 dropped when it chose the
deterministic orchestrator over `streamChat`.

**Fail-soft & cost.** A missing agent, no provider, or a mid-stream error before any token drops
back to the **verbatim prompt** (a question is never lost). The phrased message is what's
persisted as the turn's `agentResponse`, so future turns' transcript context reads naturally.
It's an extra LLM call per asked question, always run. The version `goal` +
`audience` reach the route via `buildTurnContext`'s `meta` (the pure core never reads them).

## The route seam

- **Loader** `_lib/turn-context.ts` (`buildTurnContext`) maps the persisted session graph
  (version structure, config, answers, prior turns) onto `TurnState` — coverage vs value
  answer views, oldest→newest transcript, the active question (the prior turn's target),
  monotonic selection round.
- **Invokers** `_lib/turn-invokers.ts` map `TurnState` → each P4 capability's args and
  dispatch via `capabilityDispatcher` with the seeded agent binding, **fail-soft** (a
  failure → empty outcome + diagnostic, never a throw). Selection runs the pure F4.1
  strategy directly (whichever the version's `selectionStrategy` config selects).
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

### Retry & idempotency (F7.x)

A transport failure mid-turn used to be a dead end: the post stream isn't replayable, and a
naïve re-send would mint a **duplicate turn** (no idempotency), so the surface only told the
respondent to "try again" by retyping. Both halves are now fixed:

- **Surface** — `useQuestionnaireSessionStream` mints one `idempotencyKey`
  (`crypto.randomUUID()`) per logical send and **reuses it across that send's retries**. It
  keeps the failed attempt (body + key + whether a respondent bubble was shown) and exposes
  `retry()`, wired to the error banner's **"Try again"**. A retry re-sends the same body + key
  and does **not** re-add the dangling user bubble. The attempt is dropped on a clean settle or
  a dismiss. Retry is offered only for the transient (`status === 'error'`) bucket — never the
  terminal cost-cap / not-active / expired panels (a re-send there would just re-fail).
- **Route** — the turn body carries an optional `idempotencyKey` (validated as a UUID). At the
  top of the stream the route calls `findTurnByIdempotencyKey(sessionId, key)`
  (`_lib/transcript.ts`): if a turn was already persisted under it — the narrow case where the
  first attempt's reply streamed **and** persisted but the connection dropped before the client
  saw the close — it **replays** that saved reply (warnings → reasoning → content → done, the
  live frame order) and returns, with **no second LLM spend and no duplicate row**. The common
  retry (first attempt failed before persisting) finds nothing and runs fresh. The key is
  stamped on the turn via `persistTurn` → `recordTurn`, guarded by a
  `@@unique([sessionId, idempotencyKey])`; a concurrent double-submit that loses the unique race
  resolves to the winner's row rather than throwing (NULLs stay distinct, so key-less turns are
  unaffected).

## Routes & access

| Route                                                    | Auth        | Purpose                                                             |
| -------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `POST /api/v1/app/questionnaire-sessions`                | `withAuth`  | Create (invitation-bound or logged-in-anonymous), idempotent resume |
| `POST /api/v1/app/questionnaire-sessions/anonymous`      | **public**  | No-login anonymous create → returns a signed `accessToken`          |
| `POST /api/v1/app/questionnaire-sessions/:id/messages`   | per-session | The streaming turn loop (replays on a repeated `idempotencyKey`)    |
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
— up to 10 files, ~5 MB each / ~25 MB combined; images + PDF/DOCX/text). The route threads them
onto `TurnState.attachments`; the extraction invoker forwards
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

- The respondent surface — the turn loop, live sessions, voice input, and attachment input —
  is **always on**. There is no flag to check and no 404-when-off path.
- Individual pipeline steps (extraction/contradiction/refinement/completion) are still governed
  by their own per-version config (e.g. contradiction mode `off`) — a step whose config leaves
  it off is skipped and the turn continues.
- Voice input (F6.2) runs the paid Whisper path whenever the respondent submits audio; the
  transcript then flows through the live `/messages` loop like any text.
- Attachment input runs whenever a client sends attachments on the `/messages` body — the chat
  surface always offers the affordance and the route always threads any attachments through the
  multimodal extraction path.

## Preview Turn Inspector (admin only)

A debugging console for the **"preview as respondent"** mode: per turn, the sequence of agent/LLM
calls the conversation made, each with its model, latency, estimated cost, token counts, and the
raw prompt + response. **Two gates, both required** — so it can never reach a real respondent:

1. `AppQuestionnaireSession.isPreview` — set **only** by the admin-gated `/preview` route, loaded by
   `buildTurnContext` and read in the `/messages` route.
2. The per-version config toggle `previewInspectorEnabled` (Settings tab; default off).

When both hold, the route passes a `recordInspectorCall` sink into `buildTurnInvokers` and the two
streamed phrasers (`streamQuestionMessage`/`streamOfferMessage`); each app-owned call site pushes an
`AgentCallTrace` (`lib/app/questionnaire/inspector`). After the reply streams, the route emits one
`{ type: 'inspector', turnIndex, calls }` SSE frame (parsed by `parse-session-event.ts`); the chat
hook accumulates them and `TurnInspectorDrawer` renders the right-edge console. **Live-only** —
never persisted, and capture is a no-op (zero overhead) for any non-preview session.

The drawer **starts closed** — it's opt-in via the right-edge tab (whose badge shows the captured
call count), so it never covers the preview chat unless the admin opens it. When open it leads with a
**summary header** (turns, calls, total cost, total latency, tokens in/out) rolled up across the
session. It can export its contents to the clipboard at three granularities, all backed by the pure
`formatInspector{Call,Turn,Turns}` serializers in `lib/app/questionnaire/inspector/serialize.ts`
(readable plaintext — metrics, then raw prompt roles + response): **Copy all** in the header (every
turn under a session banner), a per-turn copy button on each turn header, and a per-call copy button
inside each expanded call. Clipboard failures (insecure context / denied) are a silent no-op.

Coverage: the answer extractor, contradiction detector, answer refiner (capability dispatches —
request shown as the dispatched structured args), the seriousness + sensitivity judges (full LLM
messages + tokens), the interviewer + completion-offer phrasers, the **answer-fit resolver** second
pass (when it runs — surfaced on the capability's `answerFitCall` and recorded as its own trace by
the extractor invoker), and **both adaptive selectors' LLM pick** ("Question selector" /
"Data-slot selector", captured in `runSelectorAgent` / `selectNextDataSlot`). The deterministic
selection strategies make no LLM call, so they produce no trace.

**Embedding calls** are captured too (`kind: 'embedding'` traces, built by `buildEmbeddingTrace` in
`lib/app/questionnaire/inspector/embedding-trace.ts`): the extraction candidate pre-filter, adaptive
data-slot ranking, and adaptive question ranking each record one trace per turn carrying the embedder
model/provider, input tokens, cost, vector dimensions, the embedded message, and a one-line ranking
summary. They render distinctly (a "VEC" chip, a "Dimensions" metric, the output shown as the
**Ranking** rather than a completion). Recording is on the embed's success path only — a fail-soft
embed (no message, below threshold, un-embedded version, embed error) degrades the turn and produces
no trace. The one-time bulk `ensureVersion{Questions,DataSlots}Embedded` backfill is **not** captured
(it's not a per-turn call and `embedBatch` doesn't surface per-call cost).

## See also

- [`session-state-machine.md`](./session-state-machine.md) — the F4.6 lifecycle this drives.
- [`schema.md`](./schema.md) — the `AppQuestionnaireTurn` model.
- [`completion-logic.md`](./completion-logic.md) — the F4.5 gate the offer turn consumes.
