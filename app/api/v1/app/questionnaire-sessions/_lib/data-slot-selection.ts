/**
 * Adaptive data-slot selection — the impure seam behind the orchestrator's `selectDataSlot`
 * invoker (Data Slots feature, 50+-slot scale).
 *
 * The deterministic `pickNextDataSlot` (data-slot-orchestrator) walks slots topic-local then by
 * ordinal — fine for a handful of slots, but at 50+ it can't tell which unfilled slot flows most
 * naturally from what the respondent just said. This ranks the unfilled slots by embedding
 * similarity to their last message (pgvector, the same model as adaptive question selection),
 * narrows to a small candidate set that ALWAYS keeps a couple of same-theme slots so the
 * theme-local "linger" rhythm stays available, then asks the seeded selector agent which to pursue.
 *
 * Fail-soft, always: no last message, <2 candidates, un-embedded slots, an LLM/budget error, or an
 * off-pool pick all return `null`, and the orchestrator falls back to the deterministic pick. The
 * sub-flag gate is enforced upstream (the route only wires this invoker when the feature is on).
 */

import { embedText } from '@/lib/orchestration/knowledge/embedder';

import { runSelectorCompletion } from '@/app/api/v1/app/questionnaires/_lib/selector-completion';
import { rankDataSlotsByVector } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import { logger } from '@/lib/logging';
import { buildEmbeddingTrace, type RecordAgentCall } from '@/lib/app/questionnaire/inspector';
import {
  bulletList,
  joinSections,
  jsonOutputContract,
  numberedList,
  section,
  titledBlock,
} from '@/lib/app/questionnaire/prompt/format';
import type {
  DataSlotSelectOutcome,
  DataSlotTarget,
} from '@/lib/app/questionnaire/orchestrator/types';

/** How many similarity-ranked candidates to hand the selector agent. */
export const DATA_SLOT_CANDIDATE_K = 8;
/** How many same-theme slots to force into the candidate set so lingering stays possible. */
const SAME_THEME_KEEP = 3;

/** Everything the selection needs from the turn — assembled by the route invoker. */
export interface DataSlotSelectionContext {
  /** The unfilled candidate slots (the orchestrator's `unfilled`). */
  unfilled: DataSlotTarget[];
  /** Recent transcript, oldest → newest — the last entry seeds the similarity query. */
  recentMessages: string[];
  /** Theme the previous turn was exploring (linger anchor); `null` on a fresh start. */
  activeTheme: string | null;
  /** When a slot was just parked, the theme to bridge AWAY from; `null` otherwise. */
  parkedTheme: string | null;
  /** Version goal — frames the selector so it advances the questionnaire's intent. */
  goal?: string;
  /** Session id — cost attribution for the selector completion. */
  sessionId: string;
  /**
   * Retained for caller compatibility; no longer used. The selector now runs as a direct structured
   * completion ({@link runSelectorCompletion}) with no persisted conversation, so it needs no real
   * `user` — it runs for authenticated, anonymous (no-login), AND admin-preview sessions alike.
   */
  userId?: string;
  anonymous?: boolean;
  /** Inspector sink (admin preview only); when present, a successful embed records one trace. */
  recordInspectorCall?: RecordAgentCall;
}

/** Dedupe slots by id, preserving first-seen order. */
function dedupeById(slots: DataSlotTarget[]): DataSlotTarget[] {
  const seen = new Set<string>();
  const out: DataSlotTarget[] = [];
  for (const s of slots) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/**
 * Render the numbered candidate list + transcript + theme-local framing the selector judges, as
 * XML-tagged sections (see `prompt/format.ts`). The output contract shape is kept verbatim —
 * `parseSelectorOutput` reads `{ choice, rationale }`.
 */
export function buildDataSlotSelectorPrompt(
  ctx: DataSlotSelectionContext,
  candidates: DataSlotTarget[]
): string {
  const transcript =
    ctx.recentMessages.length > 0 ? bulletList(ctx.recentMessages) : '(no prior messages)';

  const list = numberedList(
    candidates.map((c) => `${c.name} (theme: ${c.theme})\n   - What it captures: ${c.description}`)
  );

  const lingerNote = ctx.activeTheme
    ? `You are currently exploring the area: "${ctx.activeTheme}". All else equal, prefer to finish ` +
      'this area before moving on — BUT if the respondent has clearly steered toward, volunteered, ' +
      'or voiced a strong opinion about a topic in another area, switch to it now. Following what ' +
      'they just raised matters more than finishing the current area.'
    : '';

  return joinSections(
    ctx.goal ? section('goal', `Questionnaire goal: ${ctx.goal}`) : '',
    section('conversation', titledBlock('Recent conversation (oldest first)', transcript)),
    lingerNote ? section('active_area', lingerNote) : '',
    section('candidates', titledBlock('Candidate topics to explore next', list)),
    section(
      'task',
      'Pick the topic that follows most naturally from the conversation and best advances the goal — ' +
        'favour continuity over list order, and choose 0 if none fit.\n' +
        jsonOutputContract(
          '{"choice": <1-based number, or 0 if none fits>, "rationale": "<one short sentence>"}',
          { preface: 'Reply with ONLY this JSON' }
        )
    )
  );
}

/**
 * Choose the next data slot to pursue. Returns the chosen `dataSlotKey` (always one of `unfilled`)
 * + a short rationale + spend, or `null` to defer to the deterministic pick. Never throws.
 */
export async function selectNextDataSlot(
  ctx: DataSlotSelectionContext
): Promise<DataSlotSelectOutcome | null> {
  const lastMessage = ctx.recentMessages[ctx.recentMessages.length - 1]?.trim();
  // No conversation yet, or only one option — nothing to rank/choose, let the deterministic pick run.
  if (!lastMessage || ctx.unfilled.length < 2) {
    return null;
  }

  try {
    const startedAt = Date.now();
    const embedResult = await embedText(lastMessage, 'query');
    const embedLatencyMs = Date.now() - startedAt;
    const rankedIds = await rankDataSlotsByVector(
      embedResult.embedding,
      ctx.unfilled.map((s) => s.id),
      DATA_SLOT_CANDIDATE_K
    );
    // No embeddings to rank against (version never embedded) → defer to deterministic.
    if (rankedIds.length === 0) {
      return null;
    }

    ctx.recordInspectorCall?.(
      buildEmbeddingTrace({
        label: 'Adaptive data-slot ranking',
        embedded: lastMessage,
        rankingSummary: `Ranked ${ctx.unfilled.length} unfilled data slots → top ${rankedIds.length} candidates for the selector.`,
        model: embedResult.model,
        provider: embedResult.provider,
        dimensions: embedResult.dimensions,
        inputTokens: embedResult.inputTokens,
        costUsd: embedResult.costUsd,
        latencyMs: embedLatencyMs,
      })
    );

    const byId = new Map(ctx.unfilled.map((s) => [s.id, s]));
    const ranked = rankedIds
      .map((id) => byId.get(id))
      .filter((s): s is DataSlotTarget => s !== undefined);

    // Keep the theme-local rhythm available: surface a couple of same-theme slots even if
    // similarity ranked them lower — UNLESS we just parked a slot, when we want to bridge away.
    const stayTheme = ctx.parkedTheme ? null : ctx.activeTheme;
    const sameTheme = stayTheme
      ? ctx.unfilled.filter((s) => s.theme === stayTheme).slice(0, SAME_THEME_KEEP)
      : [];

    let pool = dedupeById([...sameTheme, ...ranked]);
    // Bias away from the just-parked theme when we can still offer something else.
    if (ctx.parkedTheme) {
      const bridged = pool.filter((s) => s.theme !== ctx.parkedTheme);
      if (bridged.length > 0) pool = bridged;
    }
    const candidates = pool.slice(0, DATA_SLOT_CANDIDATE_K);
    if (candidates.length < 2) {
      return null;
    }

    const selectorMessage = buildDataSlotSelectorPrompt(ctx, candidates);
    // Direct structured completion (no persisted conversation) — runs for anonymous + preview sessions.
    const result = await runSelectorCompletion({
      userMessage: selectorMessage,
      sessionId: ctx.sessionId,
    });
    // Surface the LLM pick in the inspector (admin preview only) — the embedding ranking was already
    // traced; this is the agent that actually chooses among the ranked candidates.
    ctx.recordInspectorCall?.({
      label: 'Data-slot selector',
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      prompt: [{ role: 'user', content: selectorMessage }],
      response: result.errorCode
        ? `(selector error: ${result.errorCode})`
        : JSON.stringify(result.parsed),
    });
    if (result.errorCode || !result.parsed) {
      return null;
    }

    const parsed = result.parsed;
    // 0 / out-of-range → no confident pick, defer to deterministic.
    if (parsed.choice <= 0 || parsed.choice > candidates.length) {
      return null;
    }

    const chosen = candidates[parsed.choice - 1];
    return {
      dataSlotKey: chosen.key,
      rationale: parsed.rationale || `Selector chose ${chosen.name}.`,
      costUsd: result.costUsd,
    };
  } catch (err) {
    logger.warn('Adaptive data-slot selection failed; falling back to deterministic pick', {
      sessionId: ctx.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
