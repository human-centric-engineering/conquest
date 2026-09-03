/**
 * Re-read the conversation when the interview grows (F17.33, phase B) — the impure half.
 *
 * Called after a turn is persisted, beside {@link import('./plan-scope').maybePlanScope} and
 * {@link import('./amend-plan').maybeAmendPlan}, so the plan those two may have just written is on
 * the row. Its job is one sentence: **a topic that has only just come into scope may already have
 * been answered, and the extractor never had the chance to notice.**
 *
 * Extraction candidates come from the SCOPED lists — `buildTurnContext` filters at one choke point
 * and the route narrows again before the extractor sees them — so a question that was out of scope
 * on the turn it was answered was never a candidate. The opening is designed to make a respondent
 * talk broadly, and the planner seats topics *because of what they said*, so the overlap between
 * the two is the selection criterion rather than a coincidence. Without this pass the interviewer
 * seats a topic and immediately asks something the transcript already answers.
 *
 * ## Where it runs, and why it is not awaited inline
 *
 * Started after the turn persists and awaited only after the `done` frame, the way
 * `extractAndPersistConversationalProfile` already is. It is a multi-second call and the respondent
 * has just waited for the planner; extending the composer lock by that much to fill answers they
 * will not be asked for several turns is a poor trade. The writes still complete before the
 * generator returns, so the next status poll shows them.
 *
 * ## What it may write
 *
 * Gap-fills only, at the opportunistic ceilings, `provenance: 'inferred'`. Nobody asked these
 * questions — the respondent volunteered something that happens to answer one — which is precisely
 * the opportunistic case the confidence floor already exists to handle: the answer does not count
 * toward completion until the interviewer corroborates it, and a `must_ask` question cannot be
 * closed out by it at all. It never overwrites an answer or clears a fill.
 *
 * ## Once per topic
 *
 * `AppQuestionnaireSession.rescannedTopicKeys` is the ledger, and it is what lets one function serve
 * both triggers without either knowing about the other: at plan time every seated conditional topic
 * is absent from it, after an amendment only the amended one is. The ledger is written even when
 * the pass finds nothing — including when there was nothing to look for — because otherwise every
 * subsequent turn would pay to rediscover that.
 *
 * The ledger is also a **lease**, and that is what makes "once" true rather than merely intended.
 * Turns can overlap — the composer lock is a client-side affordance, not a server-side mutex — so
 * two of them could pass the check above, both pay for the read, and both bank it. `claimTopics`
 * takes the lease with a compare-and-set before the paid call and `releaseTopics` gives it back if
 * the call fails, so the rule below still holds end to end while the window a second turn could
 * slip through shrinks from the whole call to nothing.
 *
 * ## No AppAiRun
 *
 * Deliberately not recorded as an `AppAiRun`. This is extraction — the same class of work as the
 * per-turn extractor, which is ephemeral by the same rule — and nothing here changes durable config
 * or asks a human to adjudicate anything. Cost is still logged, so the spend shows up on the
 * session's trend. See `.context/app/questionnaire/ai-run-provenance.md`.
 *
 * ## Fail-soft, always
 *
 * Never throws. A failed re-read leaves the session exactly as it is today: the interviewer asks
 * the question, and the respondent answers it twice. Mildly annoying; a 500 on the turn is not.
 */

import { CostOperation } from '@/types/orchestration';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';

import { QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { normalizeAnswerIntents } from '@/lib/app/questionnaire/extraction/answer-intents';
import {
  answerExtractionSchema,
  type AnswerExtraction,
} from '@/lib/app/questionnaire/extraction/extraction-schema';
import type {
  DataSlotCandidateView,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';
import {
  buildRescanPrompt,
  filterRescanIntents,
  pendingRescanTopics,
  selectRescanTargets,
  trimTranscript,
  RESCAN_TRANSCRIPT_MAX_CHARS,
} from '@/lib/app/questionnaire/scope/rescan';
import { isDataSlotInScope, isQuestionInScope } from '@/lib/app/questionnaire/scope/resolve';
import {
  narrowConditionalTopicsSettings,
  narrowInterviewPlan,
} from '@/lib/app/questionnaire/scope/types';
import { narrowToEnum, QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { loadTopics } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { buildSessionScope } from '@/app/api/v1/app/questionnaires/_lib/session-scope';
import { upsertAnswerSlot } from '@/app/api/v1/app/questionnaires/_lib/answer-slots';
import {
  reconcileChatDataSlotFills,
  upsertDataSlotFill,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-fills';

/** Bounds on one re-read call. Sized for a whole transcript, not a turn. */
const RESCAN_MAX_TOKENS = 2_000;
const RESCAN_TIMEOUT_MS = 30_000;
/**
 * The most candidates one call may carry. A plan seating four `full` topics of thirty questions
 * would otherwise render an unbounded prompt. Ordered by the topic order the plan itself used, so
 * a truncation drops the least-prioritised topic's items rather than an arbitrary slice.
 */
const RESCAN_MAX_CANDIDATES = 60;

/** What the pass did, for the caller's logging. Never an error. */
export type WideningRescanResult =
  | { kind: 'skipped'; reason: string }
  | {
      kind: 'rescanned';
      topicKeys: string[];
      answersWritten: number;
      dataSlotsWritten: number;
      costUsd: number;
    };

/**
 * Re-read the transcript for any topic that has newly come into scope. Never throws.
 *
 * Returns `skipped` for every ordinary session — the feature off, no plan, nothing outstanding —
 * which is the overwhelmingly common case and costs one small query.
 */
export async function maybeRescanAfterWidening(sessionId: string): Promise<WideningRescanResult> {
  try {
    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: {
        versionId: true,
        interviewPlan: true,
        earlySeatedTopics: true,
        rescannedTopicKeys: true,
        version: { select: { config: { select: { conditionalTopics: true } } } },
      },
    });
    if (!session) return { kind: 'skipped', reason: 'session not found' };

    const settings = narrowConditionalTopicsSettings(session.version.config?.conditionalTopics);
    if (!settings.enabled) return { kind: 'skipped', reason: 'conditional topics off' };

    const plan = narrowInterviewPlan(session.interviewPlan);
    if (!plan) return { kind: 'skipped', reason: 'no plan yet' };

    const scanned = parseScannedKeys(session.rescannedTopicKeys);
    const topics = await loadTopics(session.versionId);
    // Cheap gate first: on nearly every turn after the plan is made there is nothing outstanding,
    // and that answer must not cost the question/data-slot loads below.
    if (pendingRescanTopics(plan, topics, scanned).length === 0) {
      return { kind: 'skipped', reason: 'nothing newly in scope' };
    }

    const [questionRows, dataSlotRows] = await Promise.all([
      prisma.appQuestionSlot.findMany({
        where: { versionId: session.versionId },
        select: {
          id: true,
          key: true,
          prompt: true,
          type: true,
          typeConfig: true,
          required: true,
          weight: true,
          guidelines: true,
        },
      }),
      prisma.appDataSlot.findMany({
        where: { versionId: session.versionId },
        select: { id: true, key: true, name: true, description: true, theme: true, weight: true },
      }),
    ]);

    // Weights matter: a `light` topic contributes its two HIGHEST-weight members, and a caller that
    // omitted them would re-read a different two than the interview will ask about.
    const weightByQuestionKey = new Map(questionRows.map((q) => [q.key, q.weight]));
    const weightByDataSlotKey = new Map(dataSlotRows.map((d) => [d.key, d.weight]));
    const targets = selectRescanTargets({
      plan,
      topics,
      scanned,
      weightByQuestionKey,
      weightByDataSlotKey,
    });

    // Belt to that braces: resolve the session's ACTUAL scope and intersect. `selectRescanTargets`
    // and `resolveScope` compute the same thing by the same helper, so this should never remove
    // anything — and that is exactly why it is here. Two surfaces that agreed by construction until
    // one of them was given different inputs is the shape of F17.13, where the form rendered a
    // light topic's top-two-by-weight while the answers guard admitted the first-two-authored and
    // failed a respondent's submission on a question they had just been shown. Writing an answer to
    // a question this interview will never show is the same class of mistake, and it would be
    // invisible: the row simply appears. The topics are handed over, so this costs no extra query.
    const { scope } = await buildSessionScope(prisma, {
      versionId: session.versionId,
      settings,
      interviewPlan: session.interviewPlan,
      earlySeatedTopics: session.earlySeatedTopics,
      topics,
      weightByQuestionKey,
      weightByDataSlotKey,
    });

    // Gap-fill only: whatever already carries an answer or a fill is not this pass's business,
    // whoever wrote it. Loaded before the prompt so an already-answered question is never even
    // offered as a candidate — cheaper than dropping its answer afterwards, and it stops the model
    // spending its attention on ground that is already covered.
    const [answeredRows, filledRows] = await Promise.all([
      prisma.appAnswerSlot.findMany({ where: { sessionId }, select: { questionSlotId: true } }),
      prisma.appDataSlotFill.findMany({ where: { sessionId }, select: { dataSlotId: true } }),
    ]);
    const answeredIds = new Set(answeredRows.map((a) => a.questionSlotId));
    const filledIds = new Set(filledRows.map((f) => f.dataSlotId));

    // Walk `targets.*Keys` rather than the loaded rows, because the TARGET lists are the ones in plan
    // order — the row queries carry no `orderBy`, so filtering them would truncate whatever order
    // Postgres happened to return and silently drop a high-priority topic's questions while keeping a
    // low-priority one's. The ledger banks every seated topic either way, so a dropped question is
    // never re-read again this session; which ones get dropped therefore has to be the deliberate
    // choice the cap's docblock describes.
    const questionRowByKey = new Map(questionRows.map((q) => [q.key, q]));
    const candidateRows = targets.questionKeys
      .map((key) => questionRowByKey.get(key))
      .filter(
        (q): q is (typeof questionRows)[number] =>
          q !== undefined && !answeredIds.has(q.id) && isQuestionInScope(scope, q.key)
      )
      .slice(0, RESCAN_MAX_CANDIDATES);
    const dataSlotRowByKey = new Map(dataSlotRows.map((d) => [d.key, d]));
    const dataSlotCandidateRows = targets.dataSlotKeys
      .map((key) => dataSlotRowByKey.get(key))
      .filter(
        (d): d is (typeof dataSlotRows)[number] =>
          d !== undefined && !filledIds.has(d.id) && isDataSlotInScope(scope, d.key)
      )
      // Capped for the same reason as the questions: both lists are rendered into one prompt, and a
      // data-slot-mode version with many themes would otherwise carry an unbounded one.
      .slice(0, RESCAN_MAX_CANDIDATES);

    if (candidateRows.length === 0 && dataSlotCandidateRows.length === 0) {
      // Nothing to look for — but the topics ARE re-read as far as this session is concerned, and
      // banking that is what stops every later turn paying to rediscover it.
      await markScanned(sessionId, scanned, targets.topicKeys);
      return { kind: 'skipped', reason: 'nothing unanswered in the new topics' };
    }

    const transcript = await loadTranscript(sessionId);
    if (transcript.length === 0) {
      await markScanned(sessionId, scanned, targets.topicKeys);
      return { kind: 'skipped', reason: 'no transcript to re-read' };
    }

    const candidateSlots: ExtractionSlotView[] = candidateRows.map((q) => ({
      id: q.id,
      key: q.key,
      type: narrowToEnum(q.type, QUESTION_TYPES, 'free_text'),
      typeConfig: q.typeConfig,
      prompt: q.prompt,
      required: q.required,
      ...(q.guidelines ? { guidelines: q.guidelines } : {}),
    }));
    const dataSlotCandidates: DataSlotCandidateView[] = dataSlotCandidateRows.map((d) => ({
      key: d.key,
      name: d.name,
      description: d.description ?? '',
      theme: d.theme ?? '',
    }));

    // CLAIM the topics before paying for the read. Two turns can overlap — the composer lock is a
    // client-side affordance, not a server-side mutex — and until this existed both could pass the
    // ledger check above, both run this call, and both bank the result. Nothing corrupted
    // (`upsertAnswerSlot` is idempotent) but the session paid twice for one answer.
    //
    // The claim is a compare-and-set against the EXACT value we read, so the loser is the turn whose
    // ledger is already stale, and it loses before spending anything. Read-modify-write cannot do
    // this: both turns compute the same union from the same stale read and both writes succeed.
    const claimed = await claimTopics(
      sessionId,
      session.rescannedTopicKeys,
      scanned,
      targets.topicKeys
    );
    if (!claimed) {
      // Another turn is re-reading these very topics right now. Skipping is the whole point — its
      // writes land on the same rows this pass would have written.
      return { kind: 'skipped', reason: 'another turn is already re-reading these topics' };
    }

    const read = await askRescan({
      sessionId,
      transcript,
      candidateSlots,
      dataSlotCandidates,
    });
    if (!read) {
      // A failed call banks NOTHING — release the claim. The topic is still un-re-read, and the next
      // widening (or a retry on a later turn) may yet succeed; recording it would turn one bad
      // minute for the provider into a permanently thinner session. Claiming first does not weaken
      // that rule, it just moves where it is enforced: the ledger is a lease for the duration of the
      // call and a record only once the call returns. The one hole left is the process dying
      // mid-call, which is a far smaller window than the whole call was.
      await releaseTopics(sessionId, targets.topicKeys);
      return { kind: 'skipped', reason: 'no usable read' };
    }

    // Validate every value against its slot's real type/config with the extractor's own normaliser
    // — no second implementation of what a valid likert answer is — then apply this pass's own two
    // filters and the opportunistic ceilings.
    const { intents } = normalizeAnswerIntents(read.value.answers, {
      sessionId,
      // No active question and no "this turn's message": the whole transcript is the source, and
      // every candidate is equally unasked. `normalizeAnswerIntents` reads neither — it is being
      // borrowed for its per-type value validation, which is the part that must not be reimplemented.
      activeQuestionKey: null,
      candidateSlots,
      answered: [],
      userMessage: '',
    });
    const keep = filterRescanIntents(intents, {
      candidateKeys: new Set(candidateSlots.map((s) => s.key)),
      answeredKeys: new Set<string>(),
    });

    const idByKey = new Map(candidateRows.map((q) => [q.key, q.id]));
    const writtenQuestionSlotIds: string[] = [];
    for (const intent of keep) {
      const questionSlotId = idByKey.get(intent.slotKey);
      if (!questionSlotId) continue;
      await upsertAnswerSlot(sessionId, questionSlotId, {
        value: intent.value,
        provenance: intent.provenance,
        confidence: intent.confidence,
        rationale: intent.rationale,
        ...(intent.paraphrase !== undefined ? { paraphrase: intent.paraphrase } : {}),
      });
      writtenQuestionSlotIds.push(questionSlotId);
    }

    const dataSlotIdByKey = new Map(dataSlotCandidateRows.map((d) => [d.key, d.id]));
    let dataSlotsWritten = 0;
    for (const fill of read.value.dataSlotFills ?? []) {
      const dataSlotId = dataSlotIdByKey.get(fill.dataSlotKey);
      // `dataSlotIdByKey` holds only UNFILLED candidates, so this is the gap-fill guard as well as
      // the key check: a slot captured during the conversation is never re-derived from a re-read.
      if (!dataSlotId) continue;
      await upsertDataSlotFill(sessionId, dataSlotId, {
        value: fill.value,
        paraphrase: fill.paraphrase,
        // Same ceiling as a free-text opportunistic fill, and for the same reason: this is a
        // position nobody asked them to state.
        confidence: Math.min(fill.confidence, OPPORTUNISTIC_FILL_CEILING),
        provenance: 'inferred',
        ...(fill.rationale ? { rationale: fill.rationale } : {}),
      });
      dataSlotsWritten += 1;
    }

    // The parent data slots of anything we just answered — the same deterministic gap-fill the
    // per-turn path runs, so a re-read answer shows up in the panel as a captured area rather than
    // silently sitting on the form behind it.
    if (writtenQuestionSlotIds.length > 0) {
      const reconciled = await reconcileChatDataSlotFills({
        sessionId,
        answeredQuestionSlotIds: writtenQuestionSlotIds,
      });
      dataSlotsWritten += reconciled.length;
    }

    // No `markScanned` here: the claim above already banked these topics, and re-writing them would
    // clobber whatever a concurrent turn banked in the meantime.

    return {
      kind: 'rescanned',
      topicKeys: targets.topicKeys,
      answersWritten: writtenQuestionSlotIds.length,
      dataSlotsWritten,
      costUsd: read.costUsd,
    };
  } catch (err) {
    logger.error('widening rescan: failed; the interview simply asks the questions', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'skipped', reason: 'error' };
  }
}

/**
 * The free-text opportunistic ceiling, applied to a re-read data-slot fill.
 *
 * Hard-coded rather than imported from `opportunistic-fill.ts` alongside `capOpportunisticConfidence`
 * only because that module caps ANSWER intents (which carry a question type to branch on) and a
 * data-slot fill has no type to branch on — it is prose, so it gets the prose ceiling.
 */
const OPPORTUNISTIC_FILL_CEILING = 0.45;

/** The one model call. Returns `null` on every failure — the caller degrades to doing nothing. */
async function askRescan(params: {
  sessionId: string;
  transcript: string[];
  candidateSlots: ExtractionSlotView[];
  dataSlotCandidates: DataSlotCandidateView[];
}): Promise<{ value: AnswerExtraction; costUsd: number } | null> {
  let agent: {
    id: string;
    provider: string;
    model: string;
    fallbackProviders: string[];
  } | null = null;
  try {
    agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
  } catch (err) {
    logger.error('widening rescan: agent lookup failed', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!agent) {
    logger.warn('widening rescan: extractor agent not configured', { sessionId: params.sessionId });
    return null;
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'chat');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.warn('widening rescan: no provider resolved', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const { system, user } = buildRescanPrompt({
    transcript: params.transcript,
    candidateSlots: params.candidateSlots,
    ...(params.dataSlotCandidates.length > 0
      ? { dataSlotCandidates: params.dataSlotCandidates }
      : {}),
  });

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<AnswerExtraction>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxTokens: RESCAN_MAX_TOKENS,
      timeoutMs: RESCAN_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = answerExtractionSchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"answers":[...]} — an empty array is fine.',
      onFinalFailure: () => new Error('Rescan response was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_widening_rescan', sessionId: params.sessionId },
    }).catch((err: unknown) => {
      logger.error('widening rescan: logCost rejected', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { value: completion.value, costUsd: completion.costUsd ?? 0 };
  } catch (err) {
    logger.warn('widening rescan: call failed', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The whole session's transcript, oldest → newest, trimmed to a character budget.
 *
 * Deliberately every turn rather than the recency window the live loop uses: the answer this pass
 * hunts was most often given in the OPENING, which is exactly what a recency window drops.
 */
async function loadTranscript(sessionId: string): Promise<string[]> {
  const turns = await prisma.appQuestionnaireTurn.findMany({
    where: { sessionId },
    // `ordinal` is the session's 1-based turn index and is what every other turn reader orders by.
    orderBy: { ordinal: 'asc' },
    select: { userMessage: true, agentResponse: true },
  });

  // Respondent BEFORE interviewer within a turn: one row is "what they said" plus "what we replied",
  // in that order. Emitting the reply first pairs every answer with the question that came AFTER it,
  // which is precisely the mis-attribution rule 1 of the prompt asks the model to avoid. Same order
  // and same blank-side filter as `evaluate-saved-turn.ts` — the message value is what is tested for
  // emptiness, not the prefixed line, whose prefix is never zero-length.
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.userMessage.trim()) lines.push(`Respondent: ${turn.userMessage}`);
    if (turn.agentResponse.trim()) lines.push(`Interviewer: ${turn.agentResponse}`);
  }
  return trimTranscript(lines, RESCAN_TRANSCRIPT_MAX_CHARS);
}

/** Add these topics to the session's re-read ledger. Always the full list (overwrites the column). */
async function markScanned(
  sessionId: string,
  scanned: readonly string[],
  added: readonly string[]
): Promise<void> {
  const next = [...new Set([...scanned, ...added])];
  await prisma.appQuestionnaireSession.update({
    where: { id: sessionId },
    data: { rescannedTopicKeys: jsonInput(next) },
  });
}

/**
 * Take the ledger lease on `added`, or report that another turn already holds it.
 *
 * A compare-and-set: the update applies only while the column still holds `expected` — the exact
 * value this pass read at the top. Two overlapping turns read the same `expected`, so the first
 * write moves the column off it and the second matches no rows and returns `false`.
 *
 * `expected` is the RAW column value, not `parseScannedKeys`'s cleaned copy: the comparison has to
 * be against what is actually stored, and the cleaned copy differs from it for any row holding a
 * non-string. Comparing against the cleaned copy would make the claim never match on exactly those
 * rows, which is the silent-no-op failure mode — the pass would skip forever rather than run twice.
 */
async function claimTopics(
  sessionId: string,
  expected: unknown,
  scanned: readonly string[],
  added: readonly string[]
): Promise<boolean> {
  const next = [...new Set([...scanned, ...added])];
  const { count } = await prisma.appQuestionnaireSession.updateMany({
    where: { id: sessionId, rescannedTopicKeys: { equals: jsonInput(expected) } },
    data: { rescannedTopicKeys: jsonInput(next) },
  });
  return count > 0;
}

/**
 * Give the lease back after a failed read, so "a failed read banks nothing" still holds.
 *
 * Removes only the keys THIS pass added, read-modify-write rather than a restore-to-`expected`
 * write: a concurrent turn may legitimately have banked other topics while the call was in flight,
 * and rewinding the whole column would drop those too.
 *
 * Best-effort by construction. It runs on the failure path, and a failure to un-bank is the same
 * outcome the ledger had before it was a lease — a topic that is not re-read. Throwing here would
 * convert a degraded re-read into a caught error with a worse log line and no better result.
 */
async function releaseTopics(sessionId: string, added: readonly string[]): Promise<void> {
  try {
    const row = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { rescannedTopicKeys: true },
    });
    if (!row) return;
    const drop = new Set(added);
    const kept = parseScannedKeys(row.rescannedTopicKeys).filter((key) => !drop.has(key));
    await prisma.appQuestionnaireSession.update({
      where: { id: sessionId },
      data: { rescannedTopicKeys: jsonInput(kept) },
    });
  } catch (err) {
    logger.warn('widening rescan: could not release the ledger claim after a failed read', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Defensive parse of the ledger column: anything non-string is dropped rather than crashing. */
function parseScannedKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}
