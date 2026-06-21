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

import { runSelectorCompletion } from '@/app/api/v1/app/questionnaires/_lib/selector-completion';
import type { LlmPickInput, LlmPickResult, StrategyDeps } from '@/lib/app/questionnaire/selection';
import { rankSlotsByVector } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { buildEmbeddingTrace, type RecordAgentCall } from '@/lib/app/questionnaire/inspector';
import {
  bulletList,
  joinSections,
  jsonOutputContract,
  numberedList,
  section,
  titledBlock,
} from '@/lib/app/questionnaire/prompt/format';

/**
 * Render the numbered candidate list + transcript + framing the selector agent judges, as XML-tagged
 * sections (see `prompt/format.ts`). The system prompt lives in the seeded selector agent; this is
 * the per-turn user message. The output contract shape is kept verbatim — `parseSelectorOutput`
 * reads `{ choice, rationale }`.
 */
export function buildSelectorPrompt(input: LlmPickInput): string {
  const transcript =
    input.recentMessages.length > 0 ? bulletList(input.recentMessages) : '(no prior messages)';

  // Each candidate: its prompt, then any guidelines / rationale on indented sub-lines
  // so the model judges on intent, not just wording. Absent fields are simply omitted.
  // Learning Mode (adaptive probing): does any candidate carry a peer-divergence signal?
  const hasPeerDivergence = input.candidates.some((c) => typeof c.peerDivergence === 'number');

  const candidates = numberedList(
    input.candidates.map((c) => {
      const lines = [c.prompt ?? c.key];
      if (c.guidelines) lines.push(`   - Looking for: ${c.guidelines}`);
      if (c.rationale) lines.push(`   - Why it matters: ${c.rationale}`);
      // Surface earlier respondents' divergence so the selector can probe split topics harder.
      if (typeof c.peerDivergence === 'number') {
        const band = c.peerDivergence >= 0.66 ? 'high' : c.peerDivergence >= 0.33 ? 'some' : 'low';
        lines.push(`   - Earlier respondents diverged: ${band} (${c.peerDivergence.toFixed(2)})`);
      }
      return lines.join('\n');
    })
  );

  const answered =
    input.answeredQuestions && input.answeredQuestions.length > 0
      ? titledBlock('Already answered (do not re-tread these)', bulletList(input.answeredQuestions))
      : '';

  return joinSections(
    input.goal ? section('goal', `Questionnaire goal: ${input.goal}`) : '',
    section('conversation', titledBlock('Recent conversation (oldest first)', transcript)),
    answered ? section('already_answered', answered) : '',
    section('candidates', titledBlock('Candidate questions to ask next', candidates)),
    section(
      'task',
      'Pick the candidate that follows most naturally from the conversation and best advances ' +
        'the goal — favour continuity over list order, and choose 0 if none fit.' +
        (hasPeerDivergence
          ? ' All else close, lean toward a topic where earlier respondents diverged more (richer ' +
            'follow-up territory) — but never at the cost of conversational flow.'
          : '') +
        '\n' +
        jsonOutputContract(
          '{"choice": <1-based number, or 0 if none fits>, "rationale": "<one short sentence>"}',
          { preface: 'Reply with ONLY this JSON' }
        )
    )
  );
}

/**
 * Drive the seeded selection agent to pick among the (already similarity-ranked) candidates, via a
 * DIRECT structured completion (see {@link runSelectorCompletion}) — no persisted conversation, so it
 * runs for authenticated, anonymous, AND admin-preview sessions alike. Never throws — a provider/
 * completion failure or unparseable reply returns a null pick so the strategy falls back to `weighted`.
 */
async function runSelectorAgent(
  input: LlmPickInput,
  recordInspectorCall?: RecordAgentCall
): Promise<LlmPickResult> {
  const selectorMessage = buildSelectorPrompt(input);
  const result = await runSelectorCompletion({
    userMessage: selectorMessage,
    sessionId: input.sessionId,
  });
  // Surface the LLM pick in the inspector (admin preview only) — the embedding ranking was already
  // traced; this is the agent that actually chooses among the ranked candidates.
  recordInspectorCall?.({
    label: 'Question selector',
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
    return {
      questionId: null,
      rationale: result.errorCode
        ? `selector error: ${result.errorCode}`
        : 'selector returned unparseable output',
      costUsd: result.costUsd,
    };
  }

  const parsed = result.parsed;
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
 * attribution). `recordInspectorCall` (admin preview only) captures the query
 * embedding as an inspector trace — the embedder wrapper is the only place the
 * provenance (model/cost/tokens) is visible before it's discarded down to the
 * vector the pure strategy consumes.
 */
export function buildAdaptiveDeps(opts: {
  /**
   * Retained for caller compatibility; no longer gates selection. The selector now runs as a direct
   * structured completion ({@link runSelectorCompletion}) with no persisted conversation, so it works
   * for anonymous (no-login) and admin-preview sessions too — there is no user FK to violate.
   */
  userId?: string;
  anonymous?: boolean;
  recordInspectorCall?: RecordAgentCall;
}): StrategyDeps {
  return {
    embedText: async (text) => {
      const startedAt = Date.now();
      const result = await embedText(text, 'query');
      opts.recordInspectorCall?.(
        buildEmbeddingTrace({
          label: 'Adaptive question ranking',
          embedded: text,
          rankingSummary: 'Embedded the respondent message to rank question slots by similarity.',
          model: result.model,
          provider: result.provider,
          dimensions: result.dimensions,
          inputTokens: result.inputTokens,
          costUsd: result.costUsd,
          latencyMs: Date.now() - startedAt,
        })
      );
      return result.embedding;
    },
    rankByVector: (embedding, candidateIds, k) => rankSlotsByVector(embedding, candidateIds, k),
    llmPick: (input) => runSelectorAgent(input, opts.recordInspectorCall),
  };
}
