/**
 * Grader: pairwise_judge_agent.
 *
 * First built-in `family: 'pairwise'` grader. Shows a judge agent two
 * candidate answers side-by-side and asks it to pick a winner.
 *
 *     QUESTION: <userInput>
 *     ANSWER A: <outputA>
 *     ANSWER B: <outputB>
 *     [optional] EXPECTED ANSWER: <expectedOutput>
 *
 *     Reply with JSON: { "verdict": "A" | "B" | "tie", "reasoning": "..." }
 *
 * Used by the experiment compare view — when both variants of a
 * pairwise metric run produce subject outputs for the same case, the
 * worker invokes this grader with `outputA` and `outputB` set to the
 * two variants' outputs. The verdict surfaces as a "Judge: A/B/tie"
 * badge alongside the statistical winner (Welch + Cohen's d).
 *
 * The judge's response format is intentionally tight — a single token
 * verdict + a short reasoning. Compare with `judge_agent` which scores
 * a single output 0..1 with a multi-step rubric; pairwise is a forced-
 * choice comparison, not an absolute score.
 */

import { z } from 'zod';
import { logger } from '@/lib/logging';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  PairwiseGrader,
  PairwiseGraderInput,
  PairwiseGraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z.object({
  /** Slug of the judge agent (kind='judge'). */
  judgeAgentSlug: z.string().min(1),
});

type Config = z.infer<typeof configSchema>;

interface RawVerdict {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
}

function buildPrompt(input: PairwiseGraderInput): string {
  const lines: string[] = [];
  lines.push(`QUESTION: ${input.userInput}`);
  lines.push('');
  lines.push(`ANSWER A: ${input.outputA}`);
  lines.push('');
  lines.push(`ANSWER B: ${input.outputB}`);
  if (input.expectedOutput) {
    lines.push('');
    lines.push(`EXPECTED ANSWER: ${input.expectedOutput}`);
  }
  lines.push('');
  lines.push(
    'Pick the better answer. Reply with JSON only: { "verdict": "A" | "B" | "tie", "reasoning": "..." }. Use "tie" sparingly — only when the answers are genuinely indistinguishable.'
  );
  return lines.join('\n');
}

function parseVerdict(raw: string): RawVerdict | null {
  return tryParseJson<RawVerdict>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.reasoning !== 'string') return null;
    if (obj.verdict !== 'A' && obj.verdict !== 'B' && obj.verdict !== 'tie') return null;
    return { verdict: obj.verdict, reasoning: obj.reasoning };
  });
}

async function grade(
  input: PairwiseGraderInput & { config: Config }
): Promise<PairwiseGraderResult> {
  if (!input.judge) {
    return {
      verdict: 'tie',
      reasoning: 'pairwise_judge_agent: no judge user context — defaulting to tie',
    };
  }

  const userMessage = buildPrompt(input);
  const result = await drainStreamChat({
    agentSlug: input.config.judgeAgentSlug,
    userId: input.judge.userId,
    message: userMessage,
    entityContext: {
      source: 'evaluation_judge',
      judgeAgentSlug: input.config.judgeAgentSlug,
    },
    ...(input.judge.evaluationRunId
      ? {
          costLogMetadata: {
            evaluationRunId: input.judge.evaluationRunId,
            role: 'judge',
            judgeAgentSlug: input.config.judgeAgentSlug,
          },
        }
      : {}),
  });

  if (result.errorCode) {
    return {
      verdict: 'tie',
      reasoning: `pairwise_judge_agent error: ${result.errorCode}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
      costUsd: result.costUsd,
      tokenUsage: result.tokenUsage,
    };
  }

  const parsed = parseVerdict(result.assistantText);
  if (!parsed) {
    logger.warn('pairwise_judge_agent: malformed JSON from judge', {
      agentSlug: input.config.judgeAgentSlug,
      preview: result.assistantText.slice(0, 200),
    });
    return {
      verdict: 'tie',
      reasoning: 'pairwise_judge_agent: response was not valid {verdict, reasoning} JSON',
      costUsd: result.costUsd,
      tokenUsage: result.tokenUsage,
    };
  }

  return {
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    costUsd: result.costUsd,
    tokenUsage: result.tokenUsage,
  };
}

export const pairwiseJudgeAgentGrader: PairwiseGrader<Config> = {
  slug: 'pairwise_judge_agent',
  family: 'pairwise',
  configSchema,
  defaultConfig: { judgeAgentSlug: '' },
  grade,
  description:
    "Shows a judge agent two candidate answers side-by-side and asks it to pick the better one. Compare with judge_agent (absolute 0..1 score); pairwise is forced-choice A/B/tie. Used by the experiment compare view's judge-verdict badge.",
};

registerGrader(pairwiseJudgeAgentGrader);
