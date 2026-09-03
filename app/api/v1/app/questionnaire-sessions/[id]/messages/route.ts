/**
 * Live respondent turn — streaming (SSE) (F6.1, PR4).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/messages
 *   body: { message: string }
 *
 * The streaming turn loop. Mirrors the consumer chat route's outer shape but drives the
 * deterministic per-turn orchestrator (NOT `streamChat`): build the turn state from the
 * session, run the pipeline (extract → detect → refine → assess → respond) with the real
 * capability invokers, stream the reply, and persist the answers + turn record. The
 * completion-offer prose is composed via the F4.5 capability and emitted as chunked
 * `content` here; PR5 upgrades it to true token streaming.
 *
 * Gate order: load session → access (authenticated owner OR a valid anonymous session token)
 * → status must be `active` → per-turn sub-cap → body validation. Capability failures are
 * fail-soft (a `warning` frame, never a 5xx once streaming).
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { sseResponse } from '@/lib/api/sse';
import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError, APIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { chatAttachmentsArraySchema } from '@/lib/validations/orchestration';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { resolveSessionTone } from '@/lib/app/questionnaire/persona/settings';
import { selectBriefingLines } from '@/lib/app/questionnaire/rounds/briefing';
import { selectGlossaryLines } from '@/lib/app/questionnaire/glossary/injection';
import { resolveGlossaryForPrompts } from '@/lib/app/questionnaire/glossary/resolve';
import { loadRoundPeerDigest } from '@/lib/app/questionnaire/learning/digest';
import { recordLearningApplied } from '@/lib/app/questionnaire/learning/events';
import {
  buildProfileCaptureInstructions,
  extractAndPersistConversationalProfile,
  readProfileSnapshotValues,
} from '@/lib/app/questionnaire/profile/conversational-capture';
import {
  conversationalCaptureActive,
  conversationalCaptureFieldsForConfig,
} from '@/lib/app/questionnaire/profile/capture-placement';
import {
  buildReasoningTrace,
  type ReasoningStep,
  type ScopeDecisionNote,
} from '@/lib/app/questionnaire/reasoning';
import type { AgentCallTrace } from '@/lib/app/questionnaire/inspector';
import { totalInspectorTokensIn, totalInspectorTokensOut } from '@/lib/app/questionnaire/inspector';
import { recordQuestionnaireError } from '@/lib/app/questionnaire/diagnostics';
import type { SessionWarning } from '@/lib/app/questionnaire/chat/types';
import { buildHouseRulesInstructions } from '@/lib/app/questionnaire/chat/house-rules';
import { funnelPhase, paceProfile } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import { classifyCostCap } from '@/lib/app/questionnaire/session';
import {
  ABUSE_ABANDON_REASON,
  TONE_DIMENSION_KEYS,
  narrowQuestionFidelity,
  resolveQuestionFidelity,
} from '@/lib/app/questionnaire/types';
import {
  buildQuestionCard,
  shouldShowQuestionCard,
  type QuestionCardPayload,
} from '@/lib/app/questionnaire/chat/question-card';
import {
  runTurn,
  runDataSlotTurn,
  createStageChannel,
  streamStageStatus,
  TURN_STAGE_LABELS,
  DATA_SLOT_FILLED_THRESHOLD,
  type TurnState,
} from '@/lib/app/questionnaire/orchestrator';
import type { ChatEvent } from '@/types/orchestration';
import { turnLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import {
  openSection,
  reconcileSectionRun,
  recordTurnInSection,
} from '@/lib/app/questionnaire/sections/run';
import { INERT_SECTION_STATE } from '@/lib/app/questionnaire/sections/state';
import { ensureVersionSlotsEmbedded } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { ensureVersionDataSlotsEmbedded } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import { narrowExtractionCandidates } from '@/app/api/v1/app/questionnaire-sessions/_lib/extraction-candidates';
import { sumSessionTurnCost } from '@/app/api/v1/app/questionnaires/_lib/turns';
import {
  abortSession,
  hasCostCapReachedEvent,
  pauseSession,
  persistAbuseStrikes,
  persistSensitivity,
  recordCostCapReached,
  recordSensitivityFlagged,
} from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { buildTurnInvokers } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-invokers';
import { persistTurn } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-run';
import { maybePlanScope } from '@/app/api/v1/app/questionnaire-sessions/_lib/plan-scope';
import { maybeSeatEarlyTopics } from '@/app/api/v1/app/questionnaire-sessions/_lib/seat-early-topics';
import { maybeRescanAfterWidening } from '@/app/api/v1/app/questionnaire-sessions/_lib/widening-rescan';
import { maybeAmendPlan } from '@/app/api/v1/app/questionnaire-sessions/_lib/amend-plan';
import { amendmentBriefingLine } from '@/lib/app/questionnaire/scope/amendment';
import { earlySeatingBriefingLine } from '@/lib/app/questionnaire/scope/early-seating';
import { plannedMembers } from '@/lib/app/questionnaire/scope/resolve';
import { probesRemaining } from '@/lib/app/questionnaire/scope/probe';
import { streamOfferMessage } from '@/app/api/v1/app/questionnaire-sessions/_lib/offer-stream';
import { streamQuestionMessage } from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';
import { loadRoundBriefing } from '@/app/api/v1/app/questionnaire-sessions/_lib/round-briefing';
import { buildPriorAnswersDigest } from '@/app/api/v1/app/questionnaire-sessions/_lib/prior-answers';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import {
  VERSION_ARCHIVED_CODE,
  VERSION_ARCHIVED_MESSAGE,
} from '@/lib/app/questionnaire/version-archived';
import { assertRoundAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/round-access';
import { findTurnByIdempotencyKey } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';

const bodySchema = z
  .object({
    /** Omitted (or empty) only on a kickoff turn — the proactive opening (see `kickoff`). */
    message: z.string().max(10_000).optional(),
    /**
     * Proactive-opening turn: the surface fires this once on a fresh session so the agent
     * streams the first question without the respondent typing first. Carries no respondent
     * answer — extraction no-ops (no active question yet), selection picks the opening question.
     */
    kickoff: z.boolean().optional(),
    /** Optional files attached to this turn (images/documents) — read by the extractor. */
    attachments: chatAttachmentsArraySchema.optional(),
    /**
     * Question fidelity (P18): the respondent just answered this question through its in-chat answer
     * control, and the answer is ALREADY persisted (the card writes through `PUT …/answers`). This
     * turn exists only so the interviewer acknowledges it and moves on, so it carries no respondent
     * message — passing the answer as a fake user message would leak form values into the transcript
     * and re-run extraction over text the respondent never typed.
     */
    answeredQuestionKey: z.string().max(200).optional(),
    /**
     * Idempotency key for this send attempt (F7.x retry). The surface mints one per logical send and
     * reuses it across that send's retries, so a retry re-running a turn the server already persisted
     * is replayed from that row rather than duplicated. Optional: a send without one is never deduped.
     */
    idempotencyKey: z.string().uuid().optional(),
  })
  .refine(
    (b) =>
      b.kickoff === true ||
      b.answeredQuestionKey !== undefined ||
      (b.message?.trim().length ?? 0) > 0,
    {
      message: 'message is required',
      path: ['message'],
    }
  );

/** Chunk text into small pieces for a streamed feel (true token streaming is PR5). */
function chunkText(text: string, size = 48): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

async function handleMessage(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Diagnostics: end-to-end turn wall-clock starts the moment the request lands, so the persisted
  // `durationMs` reflects the full time the respondent waited for this turn's reply.
  const turnStartedAt = Date.now();
  // Hoisted so the top-level catch can attribute an unexpected fault to this session.
  const { id: sessionId } = await context.params;
  try {
    const log = await getRouteLogger(request);

    const loaded = await buildTurnContext(sessionId);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }
    const userId = access.userId;

    if (loaded.session.status !== 'active') {
      return errorResponse(`Session is ${loaded.session.status}, not active`, {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    // Respondent-facing archive gate: a version archived mid-session stops serving turns, so an
    // in-flight respondent is refused with a distinct code the surface turns into the "archived"
    // notice. Preview sessions are exempt — an admin may still rehearse an archived version.
    if (loaded.versionArchivedAt && !loaded.session.isPreview) {
      return errorResponse(VERSION_ARCHIVED_MESSAGE, {
        code: VERSION_ARCHIVED_CODE,
        status: 410,
      });
    }

    // Cohorts & Rounds: re-gate a round-scoped session every turn. A round that has closed or
    // fallen outside its window mid-session is PAUSED first (mirroring the cost-cap precedent —
    // the status gate above then 409s every later turn), so the time-bound is enforced even for
    // an in-flight respondent; a removed member is refused (403) WITHOUT pausing, so re-adding
    // them lets the session resume. A since-deleted round no longer gates (onMissingRound:allow).
    if (loaded.session.roundId) {
      const verdict = await assertRoundAccess({
        roundId: loaded.session.roundId,
        cohortMemberId: loaded.session.cohortMemberId,
        versionId: loaded.session.versionId,
        onMissingRound: 'allow',
      });
      if (!verdict.ok) {
        if (verdict.code === 'ROUND_NOT_OPEN' || verdict.code === 'ROUND_WINDOW_CLOSED') {
          await pauseSession(sessionId, { reason: 'round_closed' });
        }
        log.info('Live turn refused: round access', { sessionId, code: verdict.code });
        // Diagnostics: a round-gate refusal isn't a fault — record it as an `info` boundary so the
        // timeline explains why an in-flight respondent was stopped (window closed / member removed).
        void recordQuestionnaireError({
          versionId: loaded.session.versionId,
          sessionId,
          scope: 'round_gate',
          severity: 'info',
          code: verdict.code,
          error: verdict.message,
          metadata: { roundId: loaded.session.roundId, status: verdict.status },
        });
        return errorResponse(verdict.message, { code: verdict.code, status: verdict.status });
      }
    }

    const limit = turnLimiter.check(access.rateKey);
    if (!limit.success) return createRateLimitResponse(limit);

    const body = await validateRequestBody(request, bodySchema);
    // A kickoff carries no respondent answer — the opening question is selected, not extracted.
    // An empty `userMessage` is skipped by `recentMessages` and ignored by the opening phraser.
    const userMessage = body.kickoff ? '' : (body.message ?? '');
    // Retry dedup key (F7.x): null when the send carried none. A retry re-sends the same key, so a
    // turn already persisted under it is replayed below (not re-run); see `drive`'s replay branch.
    const idempotencyKey = body.idempotencyKey ?? null;

    // Cost cap (F6.3): grade the session's spend so far against its budget at the turn
    // boundary, before any per-turn work. Hard (≥100%) refuses this turn with 402 and
    // auto-pauses the session (the `paused` event + a `cost_cap_reached` marker); the status
    // gate above then rejects every later turn. Soft (≥90%) lets the turn run but flags
    // `costPressure` so the core offers completion early + the offer prose nudges a wrap-up,
    // and writes the soft marker once. Runs only when a budget is configured.
    const capUsd = loaded.base.config.costBudgetUsd;
    let costPressure: 'soft' | undefined;
    if (capUsd !== null) {
      const spentUsd = await sumSessionTurnCost(sessionId);
      const tier = classifyCostCap(spentUsd, capUsd);
      if (tier === 'hard') {
        // Pause FIRST — the pause is the enforcement (the status gate then 409s every later
        // turn); the audit event is secondary. Doing it first means a failed event write can't
        // leave the session active-but-recorded (which a retry would then double-record).
        await pauseSession(sessionId, { reason: 'cost_cap' });
        try {
          await recordCostCapReached(sessionId, { spentUsd, capUsd, tier: 'hard' });
        } catch (err) {
          log.error('Cost cap: hard event write failed (session already paused)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        log.info('Live turn refused: cost cap reached', { sessionId, spentUsd, capUsd });
        // Diagnostics: a hard cost-cap stop is a clean refusal (the session paused as designed), so
        // record it as a `warning` rather than an `error` — it explains why the session went quiet.
        void recordQuestionnaireError({
          versionId: loaded.session.versionId,
          sessionId,
          scope: 'cost_cap',
          severity: 'warning',
          code: 'COST_CAP_REACHED',
          error: 'Session cost budget exhausted',
          metadata: { spentUsd, capUsd },
        });
        return errorResponse('Session cost budget exhausted', {
          code: 'COST_CAP_REACHED',
          status: 402,
          details: { spentUsd, capUsd },
        });
      }
      if (tier === 'soft') {
        costPressure = 'soft';
        // Best-effort: the soft cap is an advisory nudge, so a bookkeeping failure must not
        // fail a turn that should run. (The hard cap above fails closed; soft fails open.)
        try {
          if (!(await hasCostCapReachedEvent(sessionId, 'soft'))) {
            await recordCostCapReached(sessionId, { spentUsd, capUsd, tier: 'soft' });
          }
        } catch (err) {
          log.error('Cost cap: soft event write failed (continuing turn)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Adaptive selection ranks unanswered questions by vector similarity, which needs each slot's
    // embedding — and nothing in the authoring flow generates them, so an `adaptive` version would
    // otherwise rank against an empty set and silently degrade to `weighted` (sequential-looking)
    // forever. Generate them the first time an adaptive session runs: a cheap no-op once embedded
    // (a single COUNT short-circuits), so only the first session of a fresh/edited version pays.
    // Fail-soft: a missing/misconfigured embedder must never break a turn — adaptive already falls
    // back to weighted without embeddings, so we log and carry on.
    if (loaded.base.config.selectionStrategy === 'adaptive') {
      try {
        await ensureVersionSlotsEmbedded(loaded.session.versionId);
      } catch (err) {
        log.warn(
          'Adaptive: slot embedding failed; selection will fall back to weighted this turn',
          {
            sessionId,
            versionId: loaded.session.versionId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }

    // Sensitivity awareness runs only when the version author opted in via config.
    const sensitivityAware = loaded.base.config.sensitivityAwareness;

    // Data Slots feature: run in data-slot mode when the version actually has data slots (the
    // conversation targets data slots; questions fill in the background).
    const dataSlots = loaded.base.dataSlots ?? [];
    const dataSlotMode = dataSlots.length > 0;

    // Conditional Topics (P17): the plan's handover line, on the ONE turn that follows the decision.
    //
    // Delivered as a briefing line rather than a prepended string so the interviewer weaves it in
    // its own voice — "based on what you've said I want to go deeper on pipeline and forecasting"
    // reads as the same person still talking, where a bolted-on paragraph reads as a system notice.
    //
    // `decidedAtTurn` was stamped with the completed-turn count, so it equals this turn's
    // `selectionRound` exactly once: the turn immediately after planning. That is the announcement's
    // only outing, which is what stops it repeating for the rest of the interview.
    const scopePlan = loaded.scope.plan;
    const planAnnouncementDue =
      scopePlan !== null &&
      scopePlan.respondentMessage !== '' &&
      scopePlan.decidedAtTurn === loaded.base.selectionRound;
    const scopeAnnouncement: string[] =
      scopePlan && planAnnouncementDue
        ? [
            'Before your next question, tell the respondent — warmly, in your own words, in one or ' +
              `two sentences — what you now want to go deeper on: "${scopePlan.respondentMessage}" ` +
              'Name the areas in their language. Never mention that a decision was made about them.',
          ]
        : [];
    // The SAME announcement, as prose rather than as an instruction, for the one reply that is not
    // phrased: a part covered. That reply is composed deterministically, so the briefing above never
    // reaches it — and the announcement has exactly one outing, so a respondent whose plan landed on
    // the turn that finished a part was simply never told the interview had changed shape.
    //
    // `respondentMessage` is written to be SPOKEN (the planner's prompt says so), which is what
    // makes carrying it verbatim honest here rather than a paraphrase of an instruction.
    const spokenPlanAnnouncement =
      scopePlan && planAnnouncementDue ? scopePlan.respondentMessage : null;

    // Question fidelity (P18): the respondent just answered a question through its in-chat answer
    // control. Their answer is already persisted, and there is no respondent message this turn, so
    // without this the interviewer would open the next question cold — as if nothing had happened.
    // Deliberately does NOT restate the value: the respondent picked it themselves and can see it,
    // and reading a form value back is exactly the register the product avoids.
    const cardAnswerNotice: string[] = body.answeredQuestionKey
      ? [
          'The respondent has just answered the previous question directly, using the answer ' +
            'options shown to them. Acknowledge that briefly and naturally — a few words, not a ' +
            'summary — and do NOT repeat their answer back or ask it again. Then move on to the ' +
            'next question.',
        ]
      : [];

    // Conditional Topics (P17.6): the acknowledgement for a topic the respondent asked for on the
    // PREVIOUS turn. Same one-outing mechanic as the announcement above — `atTurn` was stamped with
    // that turn's `selectionRound`, so this matches exactly once and never repeats.
    const scopeAmendmentNotice: string[] = (scopePlan?.amendments ?? [])
      .filter((a) => a.atTurn === loaded.base.selectionRound)
      .map((amendment) => {
        // F17.33: how much of the area there is, so the acknowledgement sets an expectation the
        // interview will actually keep. Counted from what the plan will ASK — depth and any explicit
        // subset applied — not from everything the topic holds.
        //
        // Data slots first when the topic has them, because in data-slot mode THEY are what the
        // conversation asks about; the questions behind them are filled in the background, and
        // counting eight of those for a two-slot area would promise a much longer detour than the
        // respondent is about to get. Weights are not loaded: they only decide which two members a
        // `light` topic contains, and an amendment is always seated at `full` depth.
        //
        // Omitted when the topic no longer resolves (an author may delete one a live plan names):
        // a missing size means no size claim, never a wrong one.
        const topic = loaded.scope.topics.find((t) => t.key === amendment.key);
        const planned = scopePlan?.topics.find((t) => t.key === amendment.key);
        const itemCount =
          topic && planned
            ? plannedMembers(
                topic.members.dataSlotKeys.length > 0
                  ? topic.members.dataSlotKeys
                  : topic.members.questionKeys,
                topic.members.dataSlotKeys.length > 0
                  ? planned.members?.dataSlotKeys
                  : planned.members?.questionKeys,
                planned.depth,
                undefined
              ).length
            : undefined;
        return amendmentBriefingLine({
          amendment,
          ...(itemCount !== undefined ? { itemCount } : {}),
        });
      });

    // Conditional Topics (F17.36 phase 5): an area chosen DURING the opening, said out loud on the
    // one turn that follows. Same `atTurn === selectionRound` mechanic as the two above, and the
    // seat's turn is re-stamped when a deferred pick is finally taken, so an area announces itself
    // on the turn it actually came into scope rather than the turn it was judged.
    //
    // Coalesced into ONE line covering everything this turn seated, which is what makes a per-turn
    // cap above 1 read naturally: "I'd like to go deeper on hiring and on capacity" is one sentence.
    //
    // Silent once a plan exists. The plan absorbs every early seat as a pre-seated topic and its own
    // handover is the statement of what the interview covers, so announcing a seat as well would
    // tell the respondent twice about the same area, in the same message, on the turn a session
    // both seated and sealed.
    const earlySeatingNotice: string[] = [];
    /** The same seats, as bare labels, for the reasoning trace. */
    const earlySeatedLabels: string[] = [];
    if (
      scopePlan === null &&
      loaded.scope.settings.earlyTopicSeating &&
      loaded.scope.settings.announceEarlySeating
    ) {
      const seatedThisTurn = (loaded.scope.earlySeated?.seated ?? []).filter(
        (seat) => seat.atTurn === loaded.base.selectionRound
      );
      const line = earlySeatingBriefingLine(
        seatedThisTurn.map((seat) => {
          // Sized exactly the way the amendment acknowledgement sizes an area, and for the same
          // reason: several new questions arriving is something the respondent was told about
          // rather than something that happened to them. Data slots first when the topic has them,
          // because in data-slot mode THEY are what the conversation asks about.
          //
          // Omitted when the topic no longer resolves (an author may delete one a live session
          // seated): a missing size means no size claim, never a wrong one.
          const topic = loaded.scope.topics.find((t) => t.key === seat.key);
          const itemCount = topic
            ? plannedMembers(
                topic.members.dataSlotKeys.length > 0
                  ? topic.members.dataSlotKeys
                  : topic.members.questionKeys,
                undefined,
                seat.depth,
                undefined
              ).length
            : undefined;
          return {
            label: topic?.label ?? '',
            respondentReason: seat.respondentReason,
            ...(itemCount !== undefined ? { itemCount } : {}),
          };
        })
      );
      if (line) earlySeatingNotice.push(line);
      earlySeatedLabels.push(
        ...seatedThisTurn.map(
          (seat) => loaded.scope.topics.find((t) => t.key === seat.key)?.label ?? ''
        )
      );
    }

    // Conditional Topics: what the "watch it think" trace says about the same moment. The chat is
    // told in the interviewer's voice; this is the reasoning panel's account of it, and both fire on
    // the one turn the announcement is due so the two never disagree about when the respondent
    // learned. Labels only — the trace obeys the same vocabulary ban the announcement does.
    const scopeDecisionNote: ScopeDecisionNote | null = planAnnouncementDue
      ? {
          kind: 'planned',
          labels: (scopePlan?.topics ?? [])
            .map((t) => loaded.scope.topics.find((topic) => topic.key === t.key)?.label ?? '')
            .filter((label) => label.length > 0),
        }
      : earlySeatedLabels.length > 0
        ? { kind: 'seated', labels: earlySeatedLabels.filter((label) => label.length > 0) }
        : null;

    // Round Additional Context ("interviewer briefing"): load this round's entries for the running
    // version once per turn. `null` when the session isn't round-scoped or the round's per-round
    // `contextEnabled` toggle is off — in every case nothing is injected. The entries are filtered
    // down to the asked question by `selectBriefingLines` at phrasing time.
    const briefingEntries = loaded.session.roundId
      ? await loadRoundBriefing(loaded.session.roundId, loaded.session.versionId)
      : null;

    // Definitions / glossary (P16): the version's accepted terms, loaded once per turn and threaded
    // into every agent that asks, interprets or reconciles an answer. `[]` when the version has no
    // accepted terms or `glossaryPromptInjection` is off — in both cases nothing is injected. Each
    // seam relevance-filters this set to the terms actually in play, using the same matcher the
    // respondent hints use, so the agents are briefed on exactly what the respondent can see.
    const glossaryEntries = await resolveGlossaryForPrompts(loaded.session.versionId);

    // Learning Mode: load this round's peer-theme digest once per turn (null when the session isn't
    // round-scoped or the round's learningEnabled toggle is off). Indexed by `${kind}:${key}` for the
    // phraser, plus a question-key → divergence map for adaptive probing.
    const peerInsights = loaded.session.roundId
      ? await loadRoundPeerDigest(loaded.session.roundId, loaded.session.versionId)
      : null;
    const peerInsightByKey = new Map(
      (peerInsights ?? []).map((p) => [`${p.slotKind}:${p.slotKey}`, p])
    );

    // Conversational profile capture (F-capture): the interviewer gathers the CONVERSATIONAL subset of
    // the profile fields in-chat and a best-effort post-turn pass (below) persists them. The subset is
    // the fields whose effective placement is `conversational` (their own `captureVia`, else the
    // version-wide `captureMode` default) — so this fires for a pure-conversational version AND for the
    // conversational half of a hybrid one, while the `form` half rides the carousel gate. Resolved once
    // per turn. Never for an anonymous version (PII-free).
    const captureFields = conversationalCaptureFieldsForConfig(loaded.base.config);
    // Read the already-persisted values (a hybrid form pass may have written the `form` subset first),
    // so "still gathering?" is decided on the conversational fields specifically — not mere existence.
    const captureValues =
      captureFields.length > 0 ? await readProfileSnapshotValues(sessionId) : {};
    const captureActive = conversationalCaptureActive(captureFields, captureValues);
    // Captured here (where `loaded` is narrowed non-null) for the post-turn extraction inside the
    // stream generator, which loses the narrowing across the closure boundary.
    const captureRespondentUserId = loaded.session.respondentUserId;
    // Directive spliced into the phraser's system prompt while the snapshot is still incomplete.
    const profileCapturePhraserInput = captureActive
      ? { profileCapture: buildProfileCaptureInstructions(captureFields) }
      : {};
    // Adaptive probing: peers' divergence per QUESTION key — leans the adaptive selector toward
    // topics where earlier respondents split. Only question-kind insights drive selection.
    const peerDivergenceByKey: Record<string, number> = {};
    for (const p of peerInsights ?? []) {
      if (p.slotKind === 'question' && typeof p.divergence === 'number') {
        peerDivergenceByKey[p.slotKey] = p.divergence;
      }
    }

    // Adaptive data-slot selection (50+-slot scale): when we're in data-slot mode, the
    // orchestrator ranks unfilled slots by embedding similarity + an LLM pick. Like the
    // question-slot path, ensure the data slots are embedded the first time such a session runs — a
    // cheap no-op once embedded. Fail-soft: a missing embedder degrades to the deterministic
    // topic-local pick, so a failure here must never break a turn.
    const dataSlotAdaptiveActive = dataSlotMode;
    if (dataSlotAdaptiveActive) {
      try {
        await ensureVersionDataSlotsEmbedded(loaded.session.versionId);
      } catch (err) {
        log.warn(
          'Adaptive data-slot: embedding failed; selection falls back to deterministic this turn',
          {
            sessionId,
            versionId: loaded.session.versionId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }

    // Extraction candidate pre-filter (50+-slot scale): when on, narrow the combined extractor's
    // candidate set to the relevant + top-K similar slots, cutting per-turn prompt cost. Only useful
    // when extraction actually runs (a kickoff forces it off). The pre-filter needs BOTH question and
    // data-slot embeddings regardless of selection strategy — ensure them here (cheap no-op once
    // embedded; fail-soft, since the pre-filter degrades to the full set without embeddings).
    // Per-questionnaire Settings toggle — recommended for large surveys.
    const prefilterActive = loaded.base.config.extractionPrefilter && !body.kickoff;
    const activeDataSlotKey = loaded.base.activeDataSlotKey ?? null;
    const activeTheme = activeDataSlotKey
      ? (dataSlots.find((s) => s.key === activeDataSlotKey)?.theme ?? null)
      : null;
    if (prefilterActive) {
      try {
        await Promise.all([
          ensureVersionSlotsEmbedded(loaded.session.versionId),
          ...(dataSlotMode ? [ensureVersionDataSlotsEmbedded(loaded.session.versionId)] : []),
        ]);
      } catch (err) {
        log.warn(
          'Extraction pre-filter: embedding failed; will send full candidate set this turn',
          {
            sessionId,
            versionId: loaded.session.versionId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }

    // Live "watch it think" reasoning stream (demo feature): the per-version config toggle.
    // `persist` additionally requires the version opt-in — when off the trace streams live but
    // isn't saved, so resumed turns show nothing.
    const reasoningStreamOn = loaded.base.config.reasoningStreamEnabled;
    const reasoningPersist = reasoningStreamOn && loaded.base.config.reasoningStreamPersist;

    // Turn Inspector traces. We now capture the per-turn agent-call traces for EVERY session and
    // persist them on the turn row (recordTurn below), so a chat looked up by its `publicRef` can
    // later be re-evaluated by the turn evaluator against the exact calls it ran. The cost is small
    // (the traces are built from data already in hand). SSE *emission* of the live `inspector` frame
    // to the admin drawer stays gated to a preview session with the `previewInspectorEnabled` toggle
    // (`inspectorOn`) — a real respondent never receives the frame, only the persisted record.
    const inspectorOn = loaded.session.isPreview && loaded.base.config.previewInspectorEnabled;
    const inspectorCalls: AgentCallTrace[] = [];
    const recordInspectorCall = (trace: AgentCallTrace) => {
      inspectorCalls.push(trace);
    };

    // Selectable interviewer persona (F-persona): the governing tone with the full persona gate applied
    // (the per-version toggle AND — for honouring the respondent's own choice — allowRespondentSwitch).
    // When persona mode isn't active the version's own tone prevails unchanged (byte-for-byte the F-tone
    // behaviour below). See `resolveSessionTone`.
    const toneConfig = resolveSessionTone({
      toneConfig: loaded.base.config.tone,
      personas: loaded.base.config.personas,
      personaSelection: loaded.base.config.personaSelection,
      selectedPersonaKey: loaded.session.selectedPersonaKey,
    });

    // Interviewer tone & persona (F-tone): tone shapes the turn only when the resolved tone has the
    // persona or at least one dimension enabled — so a tone with nothing enabled (the all-off default)
    // keeps today's voice and we omit `tone` from the phraser input.
    const toneActive =
      toneConfig.persona.enabled || TONE_DIMENSION_KEYS.some((key) => toneConfig[key].enabled);
    const tonePhraserInput = toneActive ? { tone: toneConfig } : {};

    // Interviewer strategy (questioning approach): per-questionnaire, gated only on its own
    // `enabled` (off by default). When on, the phraser receives the settings plus the live
    // progress signals the funnel arc reads (coverage so far + whether the respondent's been terse).
    const strategyConfig = loaded.base.config.interviewerStrategy;
    const strategyActive = strategyConfig.enabled;

    // Interviewer house rules: the client's behaviour policy for this questionnaire, rendered once
    // per turn and shared by the phraser and the wrap-up composer so the two can never disagree.
    // The renderer applies its own gate (block off, no rules, or every rule individually off all
    // yield ''), so an untouched version contributes nothing and its prompt is unchanged.
    const houseRulesInstructions = buildHouseRulesInstructions(loaded.base.config.houseRules);
    const houseRulesPhraserInput = houseRulesInstructions
      ? { houseRules: houseRulesInstructions }
      : {};

    // Attachments only flow when this questionnaire opted in via config: with it off, a client that
    // sends attachments anyway gets a text-only turn — the paid multimodal path stays shut. This
    // server gate mirrors the composer hiding the paperclip, so a crafted request can't bypass an
    // author's "attachments off".
    const attachmentsAllowed = loaded.base.config.attachmentsEnabled;
    const attachments =
      attachmentsAllowed && body.attachments && body.attachments.length > 0
        ? body.attachments
        : undefined;

    // A kickoff carries no respondent message (`userMessage` is `''`), so the core's `hasMessage`
    // guard already skips extraction / seriousness / sensitivity — no per-step disabling needed here.
    // A card-answer turn is message-less too, but for the opposite reason: the answer is already
    // persisted, so `answeredQuestionKey` is what tells the core an answer arrived. Contradiction
    // checking reads it to tell the two apart — see `TurnState.answeredQuestionKey`.
    const state: TurnState = {
      ...loaded.base,
      userMessage,
      ...(body.answeredQuestionKey !== undefined
        ? { answeredQuestionKey: body.answeredQuestionKey }
        : {}),
      ...(attachments ? { attachments } : {}),
      ...(costPressure ? { costPressure } : {}),
    };

    // ── Sectioned interviews (P21) ───────────────────────────────────────────────────────────
    // The phraser input for the section boundary, computed once and spread into whichever phrasing
    // call site fires — the same shape and the same reasoning as `strategyPhraserInput` below.
    //
    // Empty object on every unsectioned interview, so the prompt carries no section block at all
    // and a version that never opted in is byte-identical to how it ran before P21.
    // `?? INERT_SECTION_STATE` rather than a bare read: the field is required by the type and
    // always present from `buildTurnContext`, but a turn must never break over a DERIVED field
    // whose absence simply means "not sectioned". Same direction `narrowSectionRun` takes.
    const sectionState = loaded.sectionState ?? INERT_SECTION_STATE;
    const activeSection = sectionState.activeSection;
    const nextSection = activeSection
      ? sectionState.sections[activeSection.ordinal + 1]
      : undefined;
    const sectionPhraserInput =
      sectionState.active && activeSection
        ? {
            section: {
              label: activeSection.label,
              position: activeSection.ordinal + 1,
              total: sectionState.sections.length,
              isOpening: sectionState.isSectionOpening,
              // The section that follows, when there is one. `ordinal` is a contiguous index over
              // the resolved list, so this is simply the next entry.
              ...(nextSection ? { nextLabel: nextSection.label } : {}),
            },
          }
        : {};

    // Interviewer strategy phraser input — computed once per turn (state/userMessage are turn
    // constants) and spread into whichever phrasing call site fires. Coverage is a simple
    // answered/total ratio (enough to phase the funnel); `respondentTerse` flags a short latest
    // reply, which biases the funnel toward targeted sooner. Empty object when the strategy is off.
    //
    // Coverage and terseness are computed UNCONDITIONALLY, not only when the strategy is on: they
    // are cheap, and both are persisted on the turn so the arc can be reported on across sessions.
    // Gating the write on `strategyActive` would make a null ambiguous between "the arc was off"
    // and "this turn predates the column".
    const turnCoverage =
      state.questions.length > 0 ? state.answered.length / state.questions.length : null;
    const respondentTerse =
      userMessage.trim().length > 0 && userMessage.trim().split(/\s+/).length < 12;
    const strategyPhraserInput = strategyActive
      ? {
          interviewerStrategy: strategyConfig,
          coverage: turnCoverage,
          respondentTerse,
        }
      : {};
    // The arc phase this turn fell in, from the same pure helper the phraser uses — so the recorded
    // phase is the one the interviewer actually behaved as, never a re-derivation that could drift.
    const turnFunnelPhase = funnelPhase(
      {
        coverage: turnCoverage,
        questionsAsked: state.answered.length,
        respondentTerse,
      },
      paceProfile(strategyConfig)
    );

    // Data Slots feature: the current fill per data slot id, so the extractor sees what's already
    // recorded (to update/correct it across turns), keyed for the candidate build below.
    const dataSlotFillByDataSlotId = new Map(
      (loaded.base.dataSlotAnswered ?? []).map((f) => [f.dataSlotId, f])
    );

    // Build the FULL data-slot candidate set (the extractor's shape) once. Each carries its `current`
    // fill (when any) so a correction merges/updates rather than re-derives, plus a move-on
    // `parkPending` flag when the slot has hit the re-ask cap and still isn't confidently filled.
    //
    // Conditional Topics (G03): a spent allowance ends the slot's follow-ups too, and earlier than the
    // per-slot cap does. Reading only the cap left the extractor un-asked for a best-effort reading
    // on exactly the turns the allowance parks, so those slots recorded the floor placeholder
    // instead of what the respondent actually said. Only the DETERMINISTIC half is knowable here —
    // a park caused by the routability verdict happens inside the orchestrator, after this.
    const openingProbeSpent =
      loaded.base.openingProbe !== undefined && probesRemaining(loaded.base.openingProbe) <= 0;
    const dataSlotCandidatesFull = dataSlots.map((s) => {
      const fill = dataSlotFillByDataSlotId.get(s.id);
      const attempts = loaded.base.dataSlotAttempts?.[s.id] ?? 0;
      const effectiveAttemptCap =
        openingProbeSpent && loaded.base.openingProbe?.slotIds.includes(s.id)
          ? 1
          : loaded.base.config.maxDataSlotAttempts;
      const parkPending =
        attempts >= effectiveAttemptCap && (fill?.confidence ?? 0) < DATA_SLOT_FILLED_THRESHOLD;
      return {
        key: s.key,
        name: s.name,
        description: s.description,
        theme: s.theme,
        // Forward propagation: the question(s) this slot captures, so filling it in chat ALSO
        // answers the underlying form questions (the schema-documented contract).
        ...(s.mappedQuestionKeys && s.mappedQuestionKeys.length > 0
          ? { mappedQuestionKeys: s.mappedQuestionKeys }
          : {}),
        ...(fill
          ? {
              current: {
                value: fill.value,
                paraphrase: fill.paraphrase ?? null,
                confidence: fill.confidence,
              },
            }
          : {}),
        ...(parkPending ? { parkPending: true, attempts } : {}),
      };
    });

    // Extraction pre-filter: narrow what the EXTRACTOR sees (question slots + data slots) to the
    // relevant + top-K similar. Behaviour-preserving (safety rails keep every slot the answer could
    // inform) and fail-soft (an un-narrowed result keeps the full set). The full `loaded.slots` still
    // flows to the detector/refiner below — only the extractor's candidate set shrinks.
    let extractionQuestionSlots = loaded.slots;
    let extractionDataCandidates = dataSlotCandidatesFull;
    if (prefilterActive) {
      const narrowed = await narrowExtractionCandidates({
        questionSlots: loaded.slots,
        dataSlots: dataSlots.map((s) => ({
          id: s.id,
          key: s.key,
          name: s.name,
          description: s.description,
          theme: s.theme,
          ...(s.mappedQuestionKeys ? { mappedQuestionKeys: s.mappedQuestionKeys } : {}),
          hasCurrentFill: dataSlotFillByDataSlotId.has(s.id),
        })),
        activeQuestionKey: loaded.activeQuestionKey,
        activeDataSlotKey,
        activeTheme,
        // The pre-filter ranks candidates by similarity to the respondent's CURRENT answer, but
        // `loaded.base.recentMessages` (persisted) ends with the interviewer's previous question.
        // Append the current message so the ranking query is what they just said — otherwise
        // answer-relevant questions (e.g. a "pipeline" question for "our pipeline is very poor")
        // get ranked out and the extractor never sees them.
        recentMessages: userMessage.trim().length
          ? [...loaded.base.recentMessages, userMessage]
          : loaded.base.recentMessages,
        sessionId,
        recordInspectorCall,
      });
      if (narrowed.applied) {
        const keptQuestionKeys = new Set(narrowed.questionSlots.map((s) => s.key));
        const keptDataKeys = new Set(narrowed.dataSlots.map((s) => s.key));
        extractionQuestionSlots = loaded.slots.filter((s) => keptQuestionKeys.has(s.key));
        extractionDataCandidates = dataSlotCandidatesFull.filter((c) => keptDataKeys.has(c.key));
      }
      log.info('Extraction pre-filter', {
        sessionId,
        applied: narrowed.applied,
        reason: narrowed.reason,
        questionsIn: narrowed.questionsIn,
        questionsOut: narrowed.questionsOut,
        dataSlotsIn: narrowed.dataSlotsIn,
        dataSlotsOut: narrowed.dataSlotsOut,
      });
    }

    const invokers = await buildTurnInvokers({
      glossaryEntries,
      userId,
      slots: loaded.slots,
      // Extraction pre-filter: the extractor sees the narrowed question slots (when active); the
      // detector + refiner keep the full `slots` above so their coverage is unchanged.
      ...(prefilterActive ? { extractionCandidateSlots: extractionQuestionSlots } : {}),
      activeQuestionKey: loaded.activeQuestionKey,
      // Learning Mode (adaptive probing): per-question-key peer divergence, so the adaptive selector
      // can lean toward topics where earlier respondents split. Empty unless learning is active.
      ...(Object.keys(peerDivergenceByKey).length > 0 ? { peerDivergenceByKey } : {}),
      // Adaptive data-slot selection: wire the embedding-ranked LLM selector only in data-slot mode;
      // otherwise the orchestrator keeps its deterministic topic-local pick.
      dataSlotAdaptiveEnabled: dataSlotAdaptiveActive,
      // Adaptive-selector framing: the version goal, so the LLM picks the question that advances it.
      ...(loaded.meta.goal ? { goal: loaded.meta.goal } : {}),
      // Preview Turn Inspector (admin-only): capture each capability/judge call's trace (undefined off).
      recordInspectorCall,
      // Sensitivity awareness: ask the extractor to also flag a sensitive disclosure (kickoff off).
      sensitivityAware: body.kickoff ? false : sensitivityAware,
      // Answer-fit resolver: per-questionnaire mode for the focused free-form → choice/likert pass.
      answerFitMode: loaded.base.config.answerFitMode,
      // Confirmation floor: the configured line below which an opportunistic fill stays tentative —
      // governs when the refresh pass stops strengthening a corroborated mapped answer.
      answerConfidenceFloor: loaded.base.config.answerConfidenceFloor,
      // Data Slots feature: feed the data slots so the SAME extraction call fills them too (narrowed
      // by the pre-filter when active).
      ...(dataSlotMode ? { dataSlotCandidates: extractionDataCandidates } : {}),
      // Anonymous (no-login) session: the adaptive selectors skip the LLM pick (its `streamChat`
      // would FK-violate on the synthetic `anon:<sessionId>` user) and fall back to deterministic.
      ...(access.anonymous ? { anonymous: true } : {}),
      // Conditional Topics (G03): the criteria a follow-up would have to make decidable. Supplied only
      // when the opening's allowance governs this turn — `openingProbe` is itself present only
      // before the plan is decided on a version that opted in — so the invoker is omitted, and the
      // check never runs, for everyone else.
      ...(loaded.base.openingProbe
        ? {
            routabilityCandidates: loaded.scope.topics
              .filter((t) => t.phase === 'conditional')
              .map((t) => ({ key: t.key, label: t.label, criteria: t.criteria })),
          }
        : {}),
    });

    const keyToSlotId = new Map(loaded.slots.map((s) => [s.key, s.id]));
    // Hoist the conversational-phraser inputs out of `loaded` (narrowed non-null here) so the
    // async generator below — where TS loses the narrowing — closes over plain values.
    const slotById = new Map(loaded.slots.map((s) => [s.id, s]));
    const dataSlotKeyToId = new Map(dataSlots.map((s) => [s.key, s.id]));
    const { byId, activeQuestionKey, meta } = loaded;
    // Interviewer continuity: `question key → prompt` (a human label for a captured answer in
    // the question-mode prior-answers digest) and the captured state the digest reads from.
    const questionPromptByKey = new Map(loaded.slots.map((s) => [s.key, s.prompt]));
    const dataSlotAnswered = loaded.base.dataSlotAnswered ?? [];
    const existingAnswers = loaded.base.existingAnswers;
    // Data Slots feature: hoisted for the generator (loses `loaded`'s narrowing) — the per-slot
    // re-ask counts + the configured cap, used to frame a sharper/final re-ask.
    const dataSlotAttempts = loaded.base.dataSlotAttempts ?? {};
    const maxDataSlotAttempts = loaded.base.config.maxDataSlotAttempts;
    // Conditional Topics (G03): the opening's shared follow-up allowance, so the phraser can tell that
    // a follow-up is the last one this interview will ask about the slot.
    const openingProbe = loaded.base.openingProbe;

    // Diagnostics: hoisted so the streaming generator (where TS loses `loaded`'s narrowing) can
    // attribute any captured error to this version without re-reading the session.
    const turnVersionId = loaded.session.versionId;
    // P21: whether the interviewer drives the move between parts. Hoisted for the same reason, and
    // read only to decide whether this turn emits a `section_covered` frame.
    const agentDrivesSectionMove = loaded.base.config.sections.agentOffersClose;

    log.info('Live turn started', { sessionId, versionId: loaded.session.versionId, userId });

    async function* drive(): AsyncGenerator<
      | ChatEvent
      | { type: 'reasoning'; steps: ReasoningStep[] }
      | { type: 'warning'; code: string; message: string; detail?: string }
      | { type: 'inspector'; turnIndex: number; calls: AgentCallTrace[] }
      | { type: 'question_card'; card: QuestionCardPayload }
      | { type: 'section_covered'; sectionKey: string; nextLabel: string }
    > {
      yield { type: 'start', conversationId: sessionId, messageId: sessionId };

      // Retry dedup-and-replay (F7.x): if this attempt's key already produced a persisted turn — the
      // narrow case where the first attempt's reply streamed AND persisted but the connection dropped
      // before the client saw the close, so the respondent retried — re-emit that saved reply instead
      // of re-running the turn. No duplicate row, no second LLM spend. Frame order mirrors a live turn
      // (warnings → reasoning → content → done) so the surface renders it identically. The common
      // retry (first attempt failed before persisting) finds nothing here and falls through to a fresh
      // run. Inspector frames are intentionally not replayed — they are preview-only telemetry and a
      // resumed preview re-hydrates them from the persisted rows.
      if (idempotencyKey) {
        const replay = await findTurnByIdempotencyKey(sessionId, idempotencyKey);
        if (replay) {
          for (const w of replay.warnings) {
            yield {
              type: 'warning',
              code: w.code,
              message: w.message,
              ...(w.detail ? { detail: w.detail } : {}),
            };
          }
          if (replay.reasoning.length > 0) yield { type: 'reasoning', steps: replay.reasoning };
          for (const delta of chunkText(replay.agentResponse)) yield { type: 'content', delta };
          log.info('Live turn replayed (idempotent retry)', { sessionId, idempotencyKey });
          yield {
            type: 'done',
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            costUsd: 0,
          };
          return;
        }
      }

      // Data Slots feature: data-slot mode runs the parallel orchestrator (targets data slots,
      // fills questions in the background); otherwise the question-mode pipeline.
      //
      // P20 Phase 2: the pipeline is handed a stage reporter and its promise is DRAINED rather than
      // plainly awaited, so each stage becomes a `status` frame the moment it is reached. Before
      // this the respondent watched one static "Thinking…" across four to six sequential model
      // calls. `streamStageStatus` re-throws the pipeline's own rejection unchanged, so the catch
      // below — the path that persists the failure and unlocks the surface — is untouched.
      const stages = createStageChannel();
      const runPipeline = () =>
        dataSlotMode
          ? runDataSlotTurn(state, invokers, stages.emit)
          : runTurn(state, invokers, stages.emit);
      let result: Awaited<ReturnType<typeof runPipeline>>;
      try {
        result = yield* streamStageStatus(stages, runPipeline());
      } catch (err) {
        // Diagnostics: the deterministic orchestrator threw — the one path that otherwise leaves a
        // respondent with a dead stream and no record. Persist the error, then emit a graceful
        // `error` frame (respondent-safe text) + a terminal `done` so the surface unlocks for a
        // retry rather than hanging.
        log.error('Live turn pipeline failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        void recordQuestionnaireError({
          versionId: turnVersionId,
          sessionId,
          turnOrdinal: state.selectionRound,
          scope: 'pipeline',
          stage: dataSlotMode ? 'data_slot_turn' : 'run_turn',
          error: err,
          metadata: { dataSlotMode, kickoff: body.kickoff ?? false },
        });
        yield {
          type: 'error',
          code: 'TURN_FAILED',
          message: 'Something went wrong while processing your message. Please try again.',
        };
        yield {
          type: 'done',
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
        return;
      }

      // Side-band frames the core determined (contradiction / seriousness / support / fail-soft
      // notices). Enrich the seriousness warning with the judge's reason so the surface can offer a
      // "Why?" disclosure. Contradiction notices carry their explanation AS the message (the phase
      // already combines multiple conflicts into one box), so there is no separate detail to attach.
      // Streamed now AND captured into `turnWarnings` for inline replay on resume.
      const turnWarnings: SessionWarning[] = [];
      for (const ev of result.events) {
        if (ev.type !== 'warning') {
          yield ev;
          continue;
        }
        const detail =
          ev.code === 'seriousness' || ev.code === 'seriousness_final'
            ? result.abuse?.reason
            : undefined;
        const warning: SessionWarning = {
          code: ev.code,
          message: ev.message,
          ...(detail ? { detail } : {}),
        };
        turnWarnings.push(warning);
        yield { type: 'warning', ...warning };
      }

      // Live "watch it think" reasoning trace (demo feature): a respondent-safe account of the work
      // the turn just did (answers captured, contradictions spotted, why the next question follows),
      // derived from the result — no extra LLM cost. Emitted as one frame BEFORE the reply streams;
      // the client reveals the steps staggered. Persisted below (when the version opts in) so it
      // replays on resume. Empty on an abuse-abandoned turn (the builder returns nothing).
      let reasoning: ReasoningStep[] = [];
      if (reasoningStreamOn) {
        reasoning = buildReasoningTrace(result, {
          questions: state.questions,
          ...(dataSlotMode ? { dataSlots } : {}),
          isOpening: state.selectionRound === 0,
          ...(scopeDecisionNote ? { scopeDecision: scopeDecisionNote } : {}),
        });
        if (reasoning.length > 0) yield { type: 'reasoning', steps: reasoning };
      }

      // Sensitivity awareness: the gentle-tone memory threaded into the phraser this turn. Fold the
      // JUST-detected disclosure in (the route persists it only after the run) so the disclosure
      // turn's OWN reply already treads carefully; later turns inherit it from session memory.
      const sensitivityLevelForPhraser =
        result.sensitivity?.newLevel ?? state.sensitivityLevel ?? null;
      const sensitivityNotesForPhraser = [
        ...(state.sensitivityNotes ?? []),
        ...(result.sensitivity?.detected ? [result.sensitivity.summary] : []),
      ];
      const sensitivityPhraserInput = {
        ...(sensitivityLevelForPhraser ? { sensitivityLevel: sensitivityLevelForPhraser } : {}),
        ...(sensitivityNotesForPhraser.length > 0
          ? { sensitivityNotes: sensitivityNotesForPhraser }
          : {}),
      };

      // Render the reply: an offer turn streams its prose token-by-token off the provider (the
      // offer composer); a question turn streams a conversational rendering of the prompt when
      // phrasing is on (fail-soft to verbatim inside the helper), else carries deterministic text
      // emitted as chunked content; terminal turns are always deterministic. Track any extra
      // (offer/phrasing) spend to fold into the turn's cost.
      let agentResponse: string;
      let extraCostUsd = 0;
      // The generic `targetedQuestionId` column holds a QUESTION id (question/sweep turns) or a
      // DATA-SLOT id (data-slot turns) — the loader resolves whichever matches next turn.
      let persistedTargetedId: string | null = result.targetedQuestionId;
      // Question fidelity (P18): set on a typed must-ask / last-resort question turn; the frame is
      // emitted after the lead-in prose and the key is persisted so the card replays on resume.
      let questionCard: QuestionCardPayload | null = null;
      // Data Slots feature: the data-slot id this turn targeted (set in the data_slot branch),
      // persisted separately so the per-slot re-ask/park counter is unambiguous.
      let targetedDataSlotId: string | null = null;
      // P20 Phase 2, the last stage: the pipeline has decided, and what remains is the phrasing call
      // whose FIRST TOKEN ends the wait. Emitted here rather than from the orchestrator because
      // composing is the route's own work, and it covers every branch below — including the two
      // deterministic ones, which resolve fast enough that the frame is simply overtaken by content.
      yield { type: 'status', message: TURN_STAGE_LABELS.composing };
      if (result.response.kind === 'offer') {
        const offer = yield* streamOfferMessage({
          // House rules govern the wrap-up too — the orchestrator core builds the offer input from
          // turn state and knows nothing about config, so the policy is layered on here.
          input: { ...result.response.input, ...houseRulesPhraserInput },
          userId,
          sessionId,
          recordInspectorCall,
        });
        agentResponse = offer.message;
        extraCostUsd = offer.costUsd;
      } else if (result.response.kind === 'data_slot') {
        // Data Slots feature: phrase the targeted data slot as a natural interview question
        // (acknowledge prior answer · deepen vs bridge to a new area · re-ask when uncaptured).
        const r = result.response;
        // Move-on: on a re-ask, hand the phraser our current (weak) understanding so it asks a
        // SHARPER, narrower follow-up instead of repeating the same open question; flag the final
        // allowed attempt so it stays pressure-free before we move on.
        const currentUnderstanding = dataSlotFillByDataSlotId.get(r.dataSlotId)?.paraphrase ?? null;
        const attemptsForTarget = dataSlotAttempts[r.dataSlotId] ?? 0;
        // Conditional Topics (G03): the opening's shared allowance ends a slot's follow-ups just as
        // firmly as the per-slot cap, and one turn sooner. Reading only the cap let the phraser ask
        // "let me try once more" and then move on regardless — the abrupt hand-off `isFinalAttempt`
        // exists to prevent. This follow-up spends the last probe when only one remains.
        const openingProbeFinal =
          openingProbe !== undefined &&
          openingProbe.slotIds.includes(r.dataSlotId) &&
          probesRemaining(openingProbe) <= 1;
        const isFinalAttempt =
          r.isReask && (attemptsForTarget + 1 >= maxDataSlotAttempts || openingProbeFinal);
        // Continuity: what they've already shared (other slots), minus the one we're asking now.
        const priorAnswers = buildPriorAnswersDigest({
          dataSlots,
          dataSlotAnswered,
          existingAnswers,
          questionPromptByKey,
          excludeDataSlotId: r.dataSlotId,
        });
        // Briefing: a data slot abstracts one or more questions — gather their slot ids (via key→id)
        // so entries attributed to any of them, plus the round's general entries, inform this ask.
        const dsRelevantIds = new Set(
          (dataSlots.find((s) => s.id === r.dataSlotId)?.mappedQuestionKeys ?? [])
            .map((k) => keyToSlotId.get(k))
            .filter((sid): sid is string => typeof sid === 'string')
        );
        const dsBriefing = briefingEntries
          ? selectBriefingLines(briefingEntries, dsRelevantIds)
          : [];
        // Glossary terms in play for this data slot: its name/description plus the recent turns.
        const dsGlossary = selectGlossaryLines(glossaryEntries, [
          r.name,
          r.description,
          ...state.recentMessages,
        ]);
        // Learning Mode: peer theme for this data slot (if any), threaded as peer context + audited.
        const dsSlotKey = dataSlots.find((s) => s.id === r.dataSlotId)?.key;
        const dsPeer = dsSlotKey ? peerInsightByKey.get(`data_slot:${dsSlotKey}`) : undefined;
        if (dsPeer) void recordLearningApplied(sessionId);
        const phrased = yield* streamQuestionMessage({
          input: {
            prompt: `${r.name} — ${r.description}`,
            type: 'free_text',
            ...(meta.goal ? { goal: meta.goal } : {}),
            ...(meta.audience ? { audience: meta.audience } : {}),
            recentMessages: state.recentMessages,
            lastUserMessage: userMessage,
            isReask: r.isReask,
            isOpening: state.selectionRound === 0,
            ...sectionPhraserInput,
            questionsAsked: state.selectionRound,
            isTransition: r.isTransition,
            // Seriousness gate: last message was a non-serious heckle (set aside) → phraser parries it.
            ...(result.abuse?.flagged ? { heckled: true } : {}),
            ...(priorAnswers.length > 0 ? { priorAnswers } : {}),
            ...(dsBriefing.length > 0 ||
            scopeAnnouncement.length > 0 ||
            scopeAmendmentNotice.length > 0 ||
            earlySeatingNotice.length > 0 ||
            cardAnswerNotice.length > 0
              ? {
                  briefing: [
                    ...cardAnswerNotice,
                    ...scopeAnnouncement,
                    ...scopeAmendmentNotice,
                    ...earlySeatingNotice,
                    ...dsBriefing,
                  ],
                }
              : {}),
            ...(dsGlossary.length > 0 ? { glossary: dsGlossary } : {}),
            ...(dsPeer ? { peerContext: [dsPeer.insight] } : {}),
            ...(r.isReask && currentUnderstanding ? { currentUnderstanding } : {}),
            ...(isFinalAttempt ? { isFinalAttempt: true } : {}),
            ...sensitivityPhraserInput,
            ...tonePhraserInput,
            ...strategyPhraserInput,
            ...houseRulesPhraserInput,
            ...profileCapturePhraserInput,
            // Open approach/phase broadens to the slot's THEME instead of this one specific slot.
            ...(strategyActive && r.theme ? { topicArea: r.theme } : {}),
          },
          userId,
          sessionId,
          recordInspectorCall,
        });
        agentResponse = phrased.message;
        extraCostUsd = phrased.costUsd;
        persistedTargetedId = r.dataSlotId;
        targetedDataSlotId = r.dataSlotId;
      } else if (result.response.kind === 'question') {
        // Conversational interviewer pass: acknowledge the prior answer + ask the targeted
        // question naturally. Re-ask = this turn re-selected the question the previous turn
        // asked (its answer wasn't captured); opening = the first turn of the session.
        const targetedKey = result.targetedQuestionId
          ? (byId.get(result.targetedQuestionId)?.key ?? null)
          : null;
        const slot = result.targetedQuestionId
          ? slotById.get(result.targetedQuestionId)
          : undefined;
        // Question fidelity (P18): how faithfully this one must be put. Resolved through the read
        // seam so the version-level gate is honoured — `balanced` (and so no prompt section at all)
        // whenever the feature is off. Read off the QuestionView, which carries the stored dial.
        const fidelityLevel = resolveQuestionFidelity(
          result.targetedQuestionId
            ? state.questions.find((q) => q.id === result.targetedQuestionId)?.fidelity
            : undefined,
          state.config.questionFidelity
        );
        // Question fidelity (P18): for a TYPED must-ask question (or a last-resort re-ask) the
        // respondent answers the real control rather than having its options read out in prose.
        // Decided here so the phraser can be told the control is shown and skip reciting them.
        const cardReason = slot
          ? shouldShowQuestionCard({
              fidelityEnabled: narrowQuestionFidelity(state.config.questionFidelity).enabled,
              level: fidelityLevel,
              type: slot.type,
              typeConfig: slot.typeConfig,
              isReask: targetedKey !== null && targetedKey === activeQuestionKey,
            })
          : null;
        questionCard =
          slot && cardReason
            ? buildQuestionCard({
                questionKey: slot.key,
                // Verbatim: the stored prompt, never the phrased rendering.
                prompt: slot.prompt,
                type: slot.type,
                typeConfig: slot.typeConfig,
                required: slot.required,
                reason: cardReason,
              })
            : null;
        // Continuity: what they've already shared, minus the question we're asking now.
        const priorAnswers = buildPriorAnswersDigest({
          dataSlots,
          dataSlotAnswered,
          existingAnswers,
          questionPromptByKey,
          excludeQuestionKey: targetedKey,
        });
        // Briefing: entries attributed to the asked question (its id) plus the round's general
        // entries inform this ask. Empty set on the rare turn with no targeted id → general only.
        const qBriefing = briefingEntries
          ? selectBriefingLines(
              briefingEntries,
              new Set(result.targetedQuestionId ? [result.targetedQuestionId] : [])
            )
          : [];
        // Glossary terms in play for this question: the text being asked, its guidance, and the
        // recent turns (a term the respondent themselves raised is as worth defining as one we did).
        const qGlossary = selectGlossaryLines(glossaryEntries, [
          result.response.text,
          slot?.guidelines ?? '',
          ...state.recentMessages,
        ]);
        // Learning Mode: peer theme for the asked question (if any), threaded as peer context + audited.
        const qPeer = targetedKey ? peerInsightByKey.get(`question:${targetedKey}`) : undefined;
        if (qPeer) void recordLearningApplied(sessionId);
        const phrased = yield* streamQuestionMessage({
          input: {
            prompt: result.response.text,
            type: slot?.type ?? 'free_text',
            ...(slot?.typeConfig !== undefined ? { typeConfig: slot.typeConfig } : {}),
            ...(slot?.guidelines ? { guidelines: slot.guidelines } : {}),
            ...(meta.goal ? { goal: meta.goal } : {}),
            ...(meta.audience ? { audience: meta.audience } : {}),
            recentMessages: state.recentMessages,
            lastUserMessage: userMessage,
            isReask: targetedKey !== null && targetedKey === activeQuestionKey,
            isOpening: state.selectionRound === 0,
            ...sectionPhraserInput,
            questionsAsked: state.selectionRound,
            fidelity: fidelityLevel,
            ...(questionCard ? { answerControlShown: true } : {}),
            // Seriousness gate: last message was a non-serious heckle (set aside) → phraser parries it.
            ...(result.abuse?.flagged ? { heckled: true } : {}),
            ...(priorAnswers.length > 0 ? { priorAnswers } : {}),
            ...(qBriefing.length > 0 ||
            scopeAnnouncement.length > 0 ||
            scopeAmendmentNotice.length > 0 ||
            earlySeatingNotice.length > 0 ||
            cardAnswerNotice.length > 0
              ? {
                  briefing: [
                    ...cardAnswerNotice,
                    ...scopeAnnouncement,
                    ...scopeAmendmentNotice,
                    ...earlySeatingNotice,
                    ...qBriefing,
                  ],
                }
              : {}),
            ...(qGlossary.length > 0 ? { glossary: qGlossary } : {}),
            ...(qPeer ? { peerContext: [qPeer.insight] } : {}),
            ...sensitivityPhraserInput,
            ...tonePhraserInput,
            ...strategyPhraserInput,
            ...houseRulesPhraserInput,
            ...profileCapturePhraserInput,
          },
          userId,
          sessionId,
          recordInspectorCall,
        });
        agentResponse = phrased.message;
        extraCostUsd = phrased.costUsd;
        // After the prose, so the card reads as the thing the message just handed over to.
        if (questionCard) yield { type: 'question_card', card: questionCard };
      } else {
        // The deterministic replies: a part covered, the interview complete, no questions left, a
        // contradiction probe. No phraser runs, so anything the briefing would have woven in is
        // simply not said.
        //
        // One thing has to survive that, and only one: the plan's handover line. Conditional Topics
        // seals the plan at the end of the turn that finishes the opening — which, in a sectioned
        // interview, is routinely the turn that also finishes the opening PART. The announcement has
        // exactly one outing, so those respondents watched the interview change shape and were told
        // nothing at all about it.
        //
        // Only onto `section_covered`. On `complete` / `none` the interview is over and announcing
        // what it now wants to go deeper on would be a promise it is not going to keep; a
        // contradiction probe is a question about one answer, and is the wrong place to put it.
        agentResponse =
          result.response.kind === 'section_covered' && spokenPlanAnnouncement
            ? `${result.response.text} ${spokenPlanAnnouncement}`
            : result.response.text;
        for (const delta of chunkText(agentResponse)) yield { type: 'content', delta };
      }
      const costUsd = result.costUsd + extraCostUsd;

      // Diagnostics telemetry rollup for this turn: end-to-end wall-clock since the request landed,
      // plus the token totals summed from the inspector calls captured during the run. Denormalized
      // onto the turn row so the Diagnostics surface aggregates without parsing the call blob.
      const durationMs = Date.now() - turnStartedAt;
      const promptTokens = totalInspectorTokensIn(inspectorCalls);
      const completionTokens = totalInspectorTokensOut(inspectorCalls);

      // Persist after the reply is composed — a write failure is logged, not retro-failed
      // onto an already-streamed response (the cost rows are logged by the capabilities).
      try {
        await persistTurn({
          sessionId,
          userMessage,
          agentResponse,
          targetedQuestionId: persistedTargetedId,
          durationMs,
          promptTokens,
          completionTokens,
          funnelPhase: turnFunnelPhase,
          coverage: turnCoverage,
          toolCalls: result.toolCalls,
          ...(turnWarnings.length > 0 ? { warnings: turnWarnings } : {}),
          // Question fidelity (P18): remember which control this turn rendered, so it replays.
          ...(questionCard ? { questionCardKey: questionCard.questionKey } : {}),
          // Persist the reasoning trace only when the version opted into persistence — otherwise it
          // was live-only this turn (streamed above, not saved), so resumed turns show none.
          ...(reasoningPersist && reasoning.length > 0 ? { reasoning } : {}),
          // Persist the inspector dump for EVERY session (captured unconditionally above), so the
          // turn can be re-evaluated later by `publicRef`. SSE emission stays preview-gated.
          ...(inspectorCalls.length > 0 ? { inspectorCalls } : {}),
          costUsd,
          upserts: result.sideEffects.answerUpserts,
          refinements: result.sideEffects.answerRefinements,
          // Probe-confirm flow: park a raised probe / clear a resolved one (undefined = leave as-is).
          ...(result.sideEffects.pendingContradiction !== undefined
            ? { pendingContradiction: result.sideEffects.pendingContradiction }
            : {}),
          // "Don't nag" ledger: persist the updated raised-contradiction list (undefined = unchanged).
          ...(result.sideEffects.raisedContradictions !== undefined
            ? { raisedContradictions: result.sideEffects.raisedContradictions }
            : {}),
          // "Don't nag" ledger: persist the updated raised-milestone list (undefined = unchanged).
          ...(result.sideEffects.raisedMilestones !== undefined
            ? { raisedMilestones: result.sideEffects.raisedMilestones }
            : {}),
          // F17.33: persist a risen progress floor so the bar cannot reverse when scope widens
          // (undefined = it did not move this turn).
          ...(result.sideEffects.progressFloorPct !== undefined
            ? { progressFloorPct: result.sideEffects.progressFloorPct }
            : {}),
          keyToSlotId,
          // Retry dedup (F7.x): stamp this attempt's key so a later retry re-sending it replays
          // this turn instead of minting a duplicate.
          ...(idempotencyKey ? { idempotencyKey } : {}),
          // Data Slots feature: persist the respondent-facing fills captured this turn + which
          // data slot this turn targeted (the re-ask/park counter source).
          ...(dataSlotMode
            ? {
                dataSlotFills: result.sideEffects.dataSlotFills ?? [],
                dataSlotKeyToId,
                targetedDataSlotId,
              }
            : {}),
          // Sectioned interviews (P21): tag the turn with the section it was spent in, and bank the
          // run with that turn charged to the section's budget. Both omitted when unsectioned, so
          // the columns stay null and every reader falls back to the flat view.
          ...(sectionState.active && activeSection
            ? {
                sectionKey: activeSection.key,
                // The fallback seeds a real entry per resolved section rather than an empty run:
                // `openSection` and `recordTurnInSection` both map over EXISTING entries, so an
                // empty one would leave the turn uncharged and the per-section turn cap unable to
                // ever release a stuck respondent.
                sectionRun: recordTurnInSection(
                  openSection(
                    sectionState.run ?? reconcileSectionRun(null, sectionState.sections),
                    activeSection.key,
                    state.selectionRound
                  ),
                  activeSection.key
                ),
              }
            : {}),
        });
      } catch (err) {
        log.error('Turn persistence failed (response already streamed)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Diagnostics: the reply streamed but the turn (answers + telemetry) didn't persist — a
        // silent data-loss path worth surfacing. Record it so the gap is visible after the fact.
        void recordQuestionnaireError({
          versionId: turnVersionId,
          sessionId,
          turnOrdinal: state.selectionRound,
          scope: 'persist',
          stage: 'persist_turn',
          error: err,
        });
      }

      // Conditional Topics (F17.36): before the plan is sealed, seat any area the opening has
      // already made unmistakable. FIRST of the four, because it is the only one that acts while
      // `interviewPlan` is still null and it stands down the moment one exists — and because
      // `maybePlanScope` below then absorbs whatever it seated as pre-seated keys, so the two never
      // decide the same interview twice. Never throws; a failure means the interview decides at the
      // end of the opening, exactly as it always did.
      const seatedEarly = await maybeSeatEarlyTopics(sessionId);
      if (seatedEarly.kind === 'seated') {
        log.info('Conditional topics seated early', {
          sessionId,
          topicKeys: seatedEarly.seated.map((t) => t.key),
          fromDeferred: seatedEarly.fromDeferred,
        });
      }

      // Conditional Topics (P17): once the turn's fills are on the row, decide the interview plan if the
      // opening has just completed. Runs here — after persistence, before the next turn — so the
      // plan exists by the time `buildTurnContext` next resolves scope, and the announcement lands
      // immediately before the first deeper question rather than trailing the opening answer.
      // Fail-soft by construction: `maybePlanScope` never throws, and an unplanned session simply
      // runs the always-run topics.
      const planned = await maybePlanScope(sessionId);
      if (planned.kind === 'planned') {
        log.info('Conditional topics planned', {
          sessionId,
          source: planned.plan.source,
          topicKeys: planned.plan.topics.map((t) => t.key),
        });
      }

      // Conditional Topics (P17.6): "actually, ask me about talent". Runs only when a plan already
      // exists, so it can never race the decision it amends — and after `maybePlanScope`, so a turn
      // that both completes the opening AND asks for something is planned before it is amended.
      // Never throws; an unhonoured request is the same outcome as the feature being off.
      const amended = await maybeAmendPlan({
        sessionId,
        message: body.message ?? '',
        // Stamped with the turn count AFTER this turn persists — the same convention
        // `decidedAtTurn` uses — so it equals the NEXT turn's `selectionRound` exactly once, which
        // is what gives the acknowledgement its single outing.
        atTurn: state.selectionRound + 1,
        // Decides which gate runs: the English cue list, or the label match that works in any
        // language. Read off the meta this turn already loaded, so the English path stays free.
        ...(meta.audience?.locale ? { locale: meta.audience.locale } : {}),
      });
      if (amended.kind === 'amended') {
        log.info('Conditional topics amended by the respondent', {
          sessionId,
          topicKey: amended.amendment.key,
        });
      }

      // F17.33: a topic that has only just come into scope may already have been answered — the
      // extractor never saw the question, because it was not a candidate on the turn the respondent
      // answered it. Re-read the transcript for whatever this widening (the plan above, or the
      // amendment above that) just brought in. STARTED here, AWAITED after `done`, for the same
      // reason as the capture extraction below: a multi-second call must not extend the composer
      // lock on a respondent who has already waited for the planner. Never throws, and skips at one
      // small query on every session that is not conditional-topics or has nothing outstanding.
      const wideningRescan = maybeRescanAfterWidening(sessionId);

      // Conversational profile capture (F-capture): once the turn is persisted, best-effort extract
      // the gathered profile details from the transcript and persist them once complete. Fully
      // non-fatal (own try/catch) and only runs while the snapshot is still absent, so it stops itself
      // once a complete profile lands. STARTED here (concurrent with the fast post-turn work + the
      // `done` frame) but AWAITED only after `done` is yielded — the extraction is an up-to-8s LLM call,
      // so awaiting it before `done` would keep the composer locked that whole time every turn. Starting
      // it now and awaiting at the end still guarantees the write completes before the generator returns.
      const captureExtraction = captureActive
        ? extractAndPersistConversationalProfile({
            sessionId,
            respondentUserId: captureRespondentUserId,
            fields: captureFields,
          })
        : null;

      // Seriousness / abuse gate: persist the new strike count and, at the threshold, ABORT the
      // session (status → `aborted`, reason `abuse_threshold_exceeded` + metadata for analytics).
      // `aborted` is distinct from admin `abandoned` so the outcome reads as "Aborted" and analytics
      // can separate the two. Best-effort: a bookkeeping failure here must not retro-fail an
      // already-streamed reply. Once aborted, the status gate 409s every later turn and the lifecycle
      // poll locks the composer.
      if (result.abuse?.flagged) {
        try {
          await persistAbuseStrikes(sessionId, result.abuse.newStrikeCount);
          if (result.abuse.abandon) {
            await abortSession(sessionId, {
              reason: ABUSE_ABANDON_REASON,
              metadata: {
                strikes: result.abuse.newStrikeCount,
                threshold: state.config.abuseThreshold,
                judgeReason: result.abuse.reason,
              },
            });
            log.info('Live turn: session aborted by abuse gate', {
              sessionId,
              strikes: result.abuse.newStrikeCount,
              threshold: state.config.abuseThreshold,
            });
            // The polite final message already streamed as the agent's reply; the session is now
            // `aborted`, so the lifecycle status poll locks the composer and every later turn
            // 409s (status gate). No extra terminal frame needed.
          }
        } catch (err) {
          log.error('Abuse gate: strike/abort write failed (reply already streamed)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          void recordQuestionnaireError({
            versionId: turnVersionId,
            sessionId,
            turnOrdinal: state.selectionRound,
            scope: 'turn',
            stage: 'abuse_gate',
            error: err,
          });
        }
      }

      // Sensitivity awareness / safeguarding: remember a disclosure flagged this turn — persist the
      // running-max level + a careful note, and write a `sensitivity_flagged` event ({ severity,
      // category } only — never the summary). Best-effort: a bookkeeping failure must not retro-fail
      // an already-streamed reply (the support signpost, if any, already streamed as an event).
      if (result.sensitivity?.detected) {
        const s = result.sensitivity;
        try {
          await persistSensitivity(sessionId, s.newLevel, {
            severity: s.severity,
            category: s.category,
            summary: s.summary,
            turnOrdinal: state.selectionRound,
            createdAt: new Date().toISOString(),
          });
          await recordSensitivityFlagged(sessionId, {
            severity: s.severity,
            category: s.category,
          });
          log.info('Live turn: sensitive disclosure flagged', {
            sessionId,
            severity: s.severity,
            level: s.newLevel,
            signposted: s.signpost,
          });
        } catch (err) {
          log.error('Sensitivity awareness: persist/event write failed (reply already streamed)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          void recordQuestionnaireError({
            versionId: turnVersionId,
            sessionId,
            turnOrdinal: state.selectionRound,
            scope: 'turn',
            stage: 'sensitivity',
            error: err,
          });
        }
      }

      // Preview Turn Inspector (admin-only): emit the captured agent-call sequence for this turn,
      // AFTER the reply streamed (so the interviewer/offer calls are included). The traces are
      // captured for every session (and persisted above), but EMISSION of this live frame is gated
      // to a preview session with the toggle on, so it never reaches a real respondent.
      if (inspectorOn && inspectorCalls.length > 0) {
        yield { type: 'inspector', turnIndex: state.selectionRound, calls: inspectorCalls };
      }

      // Sectioned interviews (P21): this part is covered and the interviewer has just said it is
      // taking the respondent on to the next one. The frame is what lets the surface KEEP that
      // promise — it holds a "Moving on to X" cue for a beat and then performs the move.
      //
      // Emitted only when the reply actually made the promise: `agentOffersClose` off leaves the
      // move to the respondent's own control, and the last part has nowhere to go. It carries no
      // gate of its own — whether the part may actually be finished is re-asserted by `/sections`
      // on the move, and the surface reads its own refreshed strip before starting the beat. This
      // frame says what the interviewer SAID, not what the server will permit.
      if (
        result.response.kind === 'section_covered' &&
        result.response.nextLabel !== null &&
        agentDrivesSectionMove
      ) {
        yield {
          type: 'section_covered',
          sectionKey: result.response.sectionKey,
          nextLabel: result.response.nextLabel,
        };
      }

      yield {
        type: 'done',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd,
      };

      // Await the conversational-capture extraction AFTER `done` (started above): the client has
      // already unlocked, but the generator keeps running until it returns, so the snapshot write still
      // completes within this request. Non-fatal — it can never reject.
      if (captureExtraction) await captureExtraction;

      // F17.33: likewise the transcript re-read (started above). Its answers land before the
      // generator returns, so the next status poll shows them.
      const rescanned = await wideningRescan;
      if (rescanned.kind === 'rescanned') {
        log.info('Re-read the conversation for newly in-scope topics', {
          sessionId,
          topicKeys: rescanned.topicKeys,
          answersWritten: rescanned.answersWritten,
          dataSlotsWritten: rescanned.dataSlotsWritten,
        });
      }
    }

    return sseResponse(drive(), { signal: request.signal });
  } catch (err) {
    // Diagnostics: record only genuine faults (5xx). Expected client errors — validation (400),
    // access (401/403), wrong status (409), cost cap (402) — are not faults and would be noise;
    // the cost-cap/round-gate refusals already record their own (warning/info) rows above. The
    // helper resolves this session's version (and invitation) from `sessionId`.
    const status = err instanceof APIError ? err.status : 500;
    if (status >= 500) {
      void recordQuestionnaireError({
        sessionId,
        scope: 'turn',
        stage: 'route',
        error: err,
      });
    }
    return handleAPIError(err);
  }
}

export const POST = handleMessage;
