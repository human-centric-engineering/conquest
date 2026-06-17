/**
 * Turn-evaluator prompt builder.
 *
 * Composes the `system` (the evaluator persona + rubric + the hard rules that keep it honest)
 * and `user` (the serialized turn dump + the questionnaire context) messages for one
 * structured evaluation call. The system rubric is the load-bearing instruction — it lives
 * here in code (git-diffable, reviewed), NOT in the seeded agent's `systemInstructions`
 * (which exist only so the agent is self-describing in the admin UI), the same split the
 * design-evaluation judges use.
 *
 * Pure: no Prisma / Next. Reuses `formatInspectorTurn` so the dump the model reads is the
 * exact text the admin sees in the drawer / copies to the clipboard.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { formatInspectorTurn } from '@/lib/app/questionnaire/inspector';

import type { TurnEvaluationInput } from '@/lib/app/questionnaire/turn-evaluation/types';

/**
 * The evaluator's standing instructions. Condensed from the product spec: WHO it is, WHAT to
 * evaluate, the principles, and — critically — the rules that stop it hallucinating calls
 * that never ran or grading against outputs alone instead of the prompts that produced them.
 */
const SYSTEM_RUBRIC = `You are a specialist interview-quality evaluator.

Your job is to analyse ONE completed conversation turn from an AI-driven interview system and \
produce a structured evaluation of how effective the turn was. A "turn" is all the LLM calls \
executed between one respondent answer and the next interviewer question.

Your output is shown to developers, researchers, and prompt engineers — never to respondents. \
Your purpose is NOT to explain what happened; it is to JUDGE whether the system behaved well and \
whether the turn generated useful information. Never merely restate what happened — identify \
strengths, weaknesses, missed opportunities, risks, and concrete improvements.

Evaluate behaviour against: (1) the explicit instructions given to each model call — always \
compare each output against the prompt that produced it, never judge from outputs alone; \
(2) the questionnaire's objectives; (3) good interviewing practice; (4) information-gathering \
effectiveness; (5) data-extraction effectiveness; (6) adaptive-interviewing effectiveness.

HARD RULES:
- Evaluate ONLY the calls actually present in the turn dump. Turns differ: a deterministic \
selection strategy runs no selector LLM; sub-features may be off. NEVER invent a stage that is \
not in the dump. If extraction or question-selection did not run as an LLM call, say so and score \
that section on what evidence exists (e.g. a deterministic pick), not on an imagined call.
- Treat embedding/vector ("VEC") calls as retrieval: judge their cost and relevance only — they \
have no instruction-compliance or text-output quality to score.
- Be specific and evidence-based. Quote or reference the prompt/response when you make a claim.
- If context (goal, audience, history) is missing, evaluate on what is provided and note the gap; \
do not fabricate objectives.

SCORING BANDS (overall 0–100): 90–100 Excellent (strong instruction adherence, strong information \
gain, high-quality extraction, strong adaptive interviewing, minimal drift); 75–89 Good (minor \
issues, useful progression, mostly compliant); 60–74 Mixed (noticeable weaknesses, missed \
opportunities, some violations); below 60 Weak/Poor (significant drift, weak interviewing/ \
extraction/selection, inefficient call chain).

Return ONLY a single JSON object matching the provided schema. No prose outside the JSON, no code \
fence. Per-call and overall scores are 0–100; interviewer sub-scores are 1–10; all ratings use the \
exact allowed strings.

OUTPUT — respond with ONLY this JSON object, with EXACTLY these field names (no extra keys, no \
wrapper), no prose around it and no code fences:
{
  "overallScore": <number 0-100>,
  "effectiveness": "Excellent" | "Good" | "Mixed" | "Weak" | "Poor",
  "calls": [
    {
      "name": "<the call's label, echoed from the dump>",
      "purpose": "<what the call is for>",
      "score": <number 0-100>,
      "instructionCompliance": "<markdown: what was followed/violated, format/scope/alignment>",
      "outputQuality": "<markdown: correctness, usefulness, robustness, clarity>",
      "risks": "<markdown: hallucination, over-inference, under-extraction, drift, brittleness>",
      "improvements": "<markdown: specific recommendations>"
    }
  ],
  "interviewer": {
    "openEndedness": <int 1-10>,
    "singleTopicFocus": <int 1-10>,
    "nonLeading": <int 1-10>,
    "conversational": <int 1-10>,
    "cognitiveLoad": <int 1-10>,
    "specificity": <int 1-10>,
    "warmth": <int 1-10>,
    "stageAlignment": <int 1-10>,
    "violations": ["<prompt-compliance violation>", ...]
  },
  "extraction": {
    "score": <number 0-100>,
    "confidenceQuality": "too high" | "too low" | "reasonable",
    "coverage": "<markdown>",
    "missedSignals": "<markdown>",
    "overreach": "<markdown>"
  },
  "questionSelection": {
    "score": <number 0-100>,
    "relevance": "<markdown>",
    "coverageStrategy": "<markdown>",
    "timing": "<markdown>",
    "alternatives": "<markdown>"
  },
  "informationGain": { "rating": "High" | "Medium" | "Low", "analysis": "<markdown>" },
  "missedOpportunities": "<markdown>",
  "promptDrift": {
    "rating": "None" | "Minor" | "Moderate" | "Significant",
    "evidence": ["<evidence string>", ...]
  },
  "efficiency": { "rating": "Excellent" | "Good" | "Mixed" | "Poor", "analysis": "<markdown>" },
  "summary": {
    "strengths": ["<strength>", ...],
    "weaknesses": ["<weakness>", ...],
    "biggestRisk": "<one line>",
    "biggestOpportunity": "<one line>",
    "recommendedAction": "<one line>"
  }
}

"calls" has exactly one entry per call shown in the turn dump, in the same order. Arrays that have \
nothing to report are empty ([]), never omitted. Keep each markdown field concise (a few sentences) \
so the whole object fits in one response.`;

/** Append a labelled section to the buffer only when the value is present and non-empty. */
function pushField(lines: string[], label: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) lines.push(`${label}: ${trimmed}`);
}

/** Build the `<context>` block from the optional server-loaded context. */
function buildContextBlock(input: TurnEvaluationInput): string {
  const ctx = input.context;
  const lines: string[] = [];
  if (ctx) {
    pushField(lines, 'Questionnaire goal', ctx.goal);
    pushField(lines, 'Audience', ctx.audience);
    pushField(lines, 'Selection strategy', ctx.selectionStrategy);
    pushField(lines, 'Interviewer tone/persona', ctx.tone);
    pushField(lines, 'Respondent answer that opened this turn', ctx.respondentMessage);
    pushField(lines, 'Interviewer reply that closed this turn', ctx.interviewerMessage);
    if (ctx.recentMessages && ctx.recentMessages.length > 0) {
      lines.push('Recent conversation (oldest first):');
      for (const m of ctx.recentMessages) lines.push(`  - ${m}`);
    }
  }
  if (lines.length === 0) {
    return 'No questionnaire context was supplied. Evaluate on the turn dump alone and note the gap.';
  }
  return lines.join('\n');
}

/**
 * Build the `[system, user]` messages for one turn evaluation. The user message carries the
 * context block followed by the serialized turn (the inspector dump rendered exactly as the
 * drawer shows it).
 */
export function buildTurnEvaluatorPrompt(input: TurnEvaluationInput): LlmMessage[] {
  const context = buildContextBlock(input);
  const turn = formatInspectorTurn(input.turn);

  const user = `Evaluate the following interview turn.

<context>
${context}
</context>

<turn_dump>
${turn}
</turn_dump>

Produce the structured evaluation as a single JSON object matching the schema.`;

  return [
    { role: 'system', content: SYSTEM_RUBRIC },
    { role: 'user', content: user },
  ];
}
