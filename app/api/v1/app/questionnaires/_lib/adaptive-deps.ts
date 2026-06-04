/**
 * Adaptive-strategy dependency wiring (F4.1 / PR3) — the impure seam.
 *
 * The pure `adaptive` strategy (`lib/app/questionnaire/selection/strategies/
 * adaptive.ts`) takes its side effects as injected {@link StrategyDeps}. This
 * module builds the real ones from platform primitives:
 *   - `embedText`    → the knowledge module's embedder (query mode),
 *   - `rankByVector` → the pgvector ranking in `slot-embeddings.ts`,
 *   - `llmPick`      → the seeded selection agent, driven via `drainStreamChat`
 *                      and parsed as a `{ choice, rationale }` envelope.
 *
 * The strategy already turns any failure here into a `weighted` fallback, so this
 * layer fails soft too: errors come back as a null pick + a reason rather than a
 * throw, and the spend (embedding + completion) is cost-logged by the underlying
 * primitives.
 */

import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

import { QUESTIONNAIRE_SELECTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { LlmPickInput, LlmPickResult, StrategyDeps } from '@/lib/app/questionnaire/selection';
import { rankSlotsByVector } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';

/** The selector agent's pinned output envelope. */
interface SelectorOutput {
  /** 1-based index into the candidate list, or 0 for "none fits". */
  choice: number;
  rationale: string;
}

/** Render the numbered candidate list + transcript the selector agent judges. */
export function buildSelectorPrompt(input: LlmPickInput): string {
  const transcript =
    input.recentMessages.length > 0
      ? input.recentMessages.map((m) => `- ${m}`).join('\n')
      : '(no prior messages)';
  const candidates = input.candidates.map((c, i) => `${i + 1}. ${c.prompt ?? c.key}`).join('\n');

  return [
    'Recent conversation (oldest first):',
    transcript,
    '',
    'Candidate questions to ask next:',
    candidates,
    '',
    'Which candidate follows most naturally from the conversation? Reply with ONLY ' +
      'JSON: {"choice": <1-based number, or 0 if none fits>, "rationale": "<one short sentence>"}.',
  ].join('\n');
}

/** Validate the selector agent's JSON reply into a {@link SelectorOutput}. */
export function parseSelectorOutput(raw: string): SelectorOutput | null {
  return tryParseJson<SelectorOutput>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.choice !== 'number' || !Number.isFinite(obj.choice)) return null;
    const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
    return { choice: Math.trunc(obj.choice), rationale };
  });
}

/**
 * Drive the seeded selection agent to pick among the (already similarity-ranked)
 * candidates. Never throws — a stream error or unparseable reply returns a null
 * pick so the strategy falls back to `weighted`.
 */
async function runSelectorAgent(input: LlmPickInput, userId: string): Promise<LlmPickResult> {
  const result = await drainStreamChat({
    agentSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
    userId,
    message: buildSelectorPrompt(input),
    entityContext: {
      source: 'app_questionnaire_selection',
      appQuestionnaireSessionId: input.sessionId,
    },
    costLogMetadata: { appQuestionnaireSessionId: input.sessionId },
  });

  if (result.errorCode) {
    return {
      questionId: null,
      rationale: `selector error: ${result.errorCode}`,
      costUsd: result.costUsd,
    };
  }

  const parsed = parseSelectorOutput(result.assistantText);
  if (!parsed) {
    return {
      questionId: null,
      rationale: 'selector returned unparseable output',
      costUsd: result.costUsd,
    };
  }
  if (parsed.choice <= 0 || parsed.choice > input.candidates.length) {
    return {
      questionId: null,
      rationale: parsed.rationale || 'selector chose none of the candidates',
      costUsd: result.costUsd,
    };
  }

  const chosen = input.candidates[parsed.choice - 1];
  return {
    questionId: chosen.id,
    rationale: parsed.rationale || `Selector chose candidate ${parsed.choice}.`,
    costUsd: result.costUsd,
  };
}

/**
 * Build the real {@link StrategyDeps} for adaptive selection. `userId` is the
 * admin/respondent on whose behalf the selection agent runs (carries the budget
 * attribution).
 */
export function buildAdaptiveDeps(opts: { userId: string }): StrategyDeps {
  return {
    embedText: async (text) => (await embedText(text, 'query')).embedding,
    rankByVector: (embedding, candidateIds, k) => rankSlotsByVector(embedding, candidateIds, k),
    llmPick: (input) => runSelectorAgent(input, opts.userId),
  };
}
