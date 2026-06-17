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
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';

import { QUESTIONNAIRE_SELECTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { parseSelectorOutput } from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';
import { rankDataSlotsByVector } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import { logger } from '@/lib/logging';
import { buildEmbeddingTrace, type RecordAgentCall } from '@/lib/app/questionnaire/inspector';
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
  /** Session id — cost attribution + the selector's entity context. */
  sessionId: string;
  /** The admin/respondent the selector runs on behalf of (budget attribution). */
  userId: string;
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

/** Render the numbered candidate list + transcript + theme-local framing the selector judges. */
export function buildDataSlotSelectorPrompt(
  ctx: DataSlotSelectionContext,
  candidates: DataSlotTarget[]
): string {
  const transcript =
    ctx.recentMessages.length > 0
      ? ctx.recentMessages.map((m) => `- ${m}`).join('\n')
      : '(no prior messages)';

  const list = candidates
    .map(
      (c, i) => `${i + 1}. ${c.name} (theme: ${c.theme})\n   - What it captures: ${c.description}`
    )
    .join('\n');

  const sections: string[] = [];
  if (ctx.goal) sections.push(`Questionnaire goal: ${ctx.goal}`, '');
  sections.push('Recent conversation (oldest first):', transcript, '');
  if (ctx.activeTheme) {
    sections.push(
      `You are currently exploring the area: "${ctx.activeTheme}". Gently prefer to finish this ` +
        'area before moving on — but choose a different one when it clearly flows more naturally ' +
        'from what they just said.',
      ''
    );
  }
  sections.push(
    'Candidate topics to explore next:',
    list,
    '',
    'Pick the topic that follows most naturally from the conversation and best advances the goal — ' +
      'favour continuity over list order, and choose 0 if none fit. Reply with ONLY JSON: ' +
      '{"choice": <1-based number, or 0 if none fits>, "rationale": "<one short sentence>"}.'
  );

  return sections.join('\n');
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
  if (!lastMessage || ctx.unfilled.length < 2) return null;

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
    if (rankedIds.length === 0) return null;

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
    if (candidates.length < 2) return null;

    const result = await drainStreamChat({
      agentSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
      userId: ctx.userId,
      message: buildDataSlotSelectorPrompt(ctx, candidates),
      entityContext: {
        source: 'app_questionnaire_data_slot_selection',
        appQuestionnaireSessionId: ctx.sessionId,
      },
      costLogMetadata: { appQuestionnaireSessionId: ctx.sessionId },
    });
    if (result.errorCode) return null;

    const parsed = parseSelectorOutput(result.assistantText);
    // 0 / out-of-range / unparseable → no confident pick, defer to deterministic.
    if (!parsed || parsed.choice <= 0 || parsed.choice > candidates.length) return null;

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
