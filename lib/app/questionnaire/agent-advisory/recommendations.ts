/**
 * Curated advisory recommendations for the ConQuest questionnaire agents.
 *
 * This is the deterministic baseline behind the Agent Settings Evaluation
 * surface: a hand-maintained table of the "right" model tier, temperature,
 * maxTokens and reasoning effort for each app agent, plus the rationale shown in
 * the UI.
 *
 * **Selection rule: match model _category_ to the task first, then optimise cost
 * within the category.** Model choice is two axes, not one price ladder:
 *
 *   - reasoning tier  → gpt-5.4   (reasoning family) — heavy, one-off,
 *     accuracy-critical work: document extraction, turn evaluation, respondent
 *     and cohort reports, config advice. Frontier reasoning is justified because
 *     these never run on the per-turn path.
 *   - chat tier       → gpt-4o    (conversational family) — the per-turn hot path
 *     the respondent actually reads: interviewer phrasing, answer extraction,
 *     contradiction detection, completion. This MUST be a conversational,
 *     temperature-honouring model. A reasoning model here is a category error:
 *     the gpt-5 family ignores `temperature` (so tuned warmth is silently
 *     dropped) and its token cap is shared with hidden reasoning tokens (so short
 *     replies get clipped). In testing, a reasoning model on this tier produced
 *     tone-deaf, contradiction-spamming chat (session QXDNENKN) — never do it.
 *   - routing tier    → gpt-4.1-nano (conversational family, cheapest) — history
 *     summarisation only; no reasoning needed; honours temperature.
 *
 * Recommendations apply at the **task-tier** level (agents ship with an empty
 * `model` and inherit the tier default — see `agent-resolver`), so a tier
 * recommendation moves every agent on that tier together. We deliberately carry
 * **no per-agent model overrides**: the conversational hot-path agents inherit
 * the chat tier rather than being pinned to a cheaper reasoning nano.
 *
 * Temperature / maxTokens / reasoningEffort are per-agent. `reasoningEffort` only
 * applies to reasoning-tier agents (gpt-5 family); conversational-tier agents
 * carry `null` because gpt-4o ignores it. Conversely the gpt-5 family ignores
 * `temperature`; the evaluation engine flags that, so a reasoning-tier agent's
 * recommended temperature is the value to use whenever a temperature-honouring
 * model is selected for it.
 *
 * Pure data + types — no Prisma, no IO. Safe to import anywhere.
 */

import {
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
  QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
  RESPONDENT_REPORT_AGENT_SLUG,
  RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG,
  COHORT_REPORT_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
  QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * The turn-evaluator judge slug. Defined in its seed
 * (`prisma/seeds/app-questionnaire/043-turn-evaluator-agent.ts`) but not
 * exported from `constants.ts`, so it's mirrored here with this comment.
 */
export const TURN_EVALUATOR_AGENT_SLUG = 'turn-evaluator';

/** The three generative task tiers the questionnaire agents resolve under. */
export type AdvisoryTaskTier = 'reasoning' | 'chat' | 'routing';

/** Reasoning-effort levels supported by `AiAgent.reasoningEffort`. */
export type AdvisoryReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface TaskTierRecommendation {
  tier: AdvisoryTaskTier;
  label: string;
  /** Recommended OpenAI model id for this tier's shared default. */
  recommendedModel: string;
  rationale: string;
}

/**
 * Recommended shared default model per task tier. Accepting one of these writes
 * `AiOrchestrationSettings.defaultModels[tier]` (every inheriting agent moves).
 */
export const TASK_TIER_RECOMMENDATIONS: Record<AdvisoryTaskTier, TaskTierRecommendation> = {
  reasoning: {
    tier: 'reasoning',
    label: 'Reasoning',
    recommendedModel: 'gpt-5.4',
    rationale:
      'Hard, one-off, quality-sensitive work — document extraction, turn evaluation, respondent and cohort reports, config advice. Frontier quality is justified because these do not run on every turn. GPT-5.4 gives balanced reasoning at half the price of GPT-5.5.',
  },
  chat: {
    tier: 'chat',
    label: 'Chat (per-turn)',
    recommendedModel: 'gpt-4o',
    rationale:
      'The per-turn hot path the respondent actually reads — interviewer phrasing, answer extraction, contradiction detection and completion fire on every message. This must be a conversational, temperature-honouring model. A reasoning model (gpt-5 family) here is a category error: it ignores temperature and spends its token cap on hidden reasoning, which produced tone-deaf, contradiction-spamming chat in testing. GPT-4o keeps phrasing warm and contradiction detection accurate.',
  },
  routing: {
    tier: 'routing',
    label: 'Routing',
    recommendedModel: 'gpt-4.1-nano',
    rationale:
      'Conversation-history summarisation only. No reasoning needed — GPT-4.1 Nano is the cheapest OpenAI text model and honours temperature.',
  },
};

/** Recommended infra-tier defaults (no per-agent overrides). */
export const INFRA_DEFAULT_RECOMMENDATIONS = {
  embeddings: {
    recommendedModel: 'text-embedding-3-small',
    rationale:
      '1536-dim, schema-compatible, low cost. Move to -3-large only if retrieval recall is visibly poor.',
  },
  audio: {
    recommendedModel: 'gpt-4o-transcribe',
    rationale:
      'More accurate per dollar than whisper-1 for the streaming-chat mic; whisper-1 remains the fallback.',
  },
} as const;

export interface AgentRecommendation {
  slug: string;
  /** Display name for the card. */
  label: string;
  /** One-line role description. */
  role: string;
  taskTier: AdvisoryTaskTier;
  recommendedTemperature: number;
  recommendedMaxTokens: number;
  recommendedReasoningEffort: AdvisoryReasoningEffort | null;
  /**
   * When set, recommend pinning THIS model on the agent itself (a per-agent
   * override of the tier default) — reserved for trivial hot-path agents where
   * the cheaper nano is indistinguishable. `null` = inherit the tier default.
   */
  overrideModel: string | null;
  rationale: string;
}

/**
 * The 14 ConQuest questionnaire agents covered by the advisor, ordered by tier
 * (reasoning first) then by role prominence.
 */
export const AGENT_RECOMMENDATIONS: readonly AgentRecommendation[] = [
  // ---- reasoning tier (inherit defaultModels.reasoning) -------------------
  {
    slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
    label: 'Questionnaire Extractor',
    role: 'Parses an uploaded document into questionnaire structure',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 16384,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    rationale:
      'Accuracy-critical one-off ingestion — frontier reasoning at high effort, low temperature for faithful structure.',
  },
  {
    slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
    label: 'Questionnaire Composer',
    role: 'Generative authoring from a plain-English brief',
    taskTier: 'reasoning',
    recommendedTemperature: 0.4,
    recommendedMaxTokens: 16384,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    rationale:
      'Open-ended generation that benefits from frontier reasoning; mild temperature for natural phrasing.',
  },
  {
    slug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
    label: 'Questionnaire Config Advisor',
    role: 'Evaluates a whole questionnaire configuration',
    taskTier: 'reasoning',
    recommendedTemperature: 0.4,
    recommendedMaxTokens: 8192,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    rationale: 'Holistic cross-field reasoning over the config — high effort pays off.',
  },
  {
    slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
    label: 'Data Slots Generator',
    role: 'Generates structured data slots for questions',
    taskTier: 'reasoning',
    recommendedTemperature: 0.4,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    rationale: 'Structured generation of moderate difficulty — medium effort is sufficient.',
  },
  {
    slug: TURN_EVALUATOR_AGENT_SLUG,
    label: 'Turn Evaluator',
    role: 'Grades a single interview turn (judge)',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 4096,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    rationale:
      'Rubric judging needs reliable reasoning and determinism — high effort, low temperature.',
  },
  {
    slug: RESPONDENT_REPORT_AGENT_SLUG,
    label: 'Respondent Report Writer',
    role: 'Writes per-respondent narrative insights',
    taskTier: 'reasoning',
    recommendedTemperature: 0.4,
    recommendedMaxTokens: 8192,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    rationale: 'Long-form grounded prose — frontier quality is visible in the output.',
  },
  {
    slug: RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG,
    label: 'Report Config Assistant',
    role: 'Interviews the admin to configure a report',
    taskTier: 'reasoning',
    recommendedTemperature: 0.5,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    rationale: 'Conversational config crafting — medium effort, warmer temperature.',
  },
  {
    slug: COHORT_REPORT_AGENT_SLUG,
    label: 'Cohort Report Analyst',
    role: 'Cross-respondent thematic analysis',
    taskTier: 'reasoning',
    recommendedTemperature: 0.3,
    recommendedMaxTokens: 8192,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    rationale:
      'Aggregated analysis across many respondents — the hardest reasoning task; high effort.',
  },

  // ---- chat tier (inherit defaultModels.chat) ----------------------------
  {
    slug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
    label: 'Question Selector',
    role: 'Picks the next question (adaptive, JSON)',
    taskTier: 'chat',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 256,
    recommendedReasoningEffort: null,
    overrideModel: null,
    rationale:
      'A compact structured decision on the hottest path — inherit the conversational chat tier at low temperature. A tight 256-token cap is fine here because the output is a short JSON pick (it is only dangerous on a reasoning model, where the cap also funds hidden reasoning).',
  },
  {
    slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
    label: 'Answer Extractor',
    role: 'Extracts typed answer values each turn',
    taskTier: 'chat',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 4096,
    recommendedReasoningEffort: null,
    overrideModel: null,
    rationale:
      'Extraction quality matters — keep on the conversational chat default at low temperature for faithful, deterministic extraction.',
  },
  {
    slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
    label: 'Contradiction Detector',
    role: 'Detects logical conflicts across answers',
    taskTier: 'chat',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 4096,
    recommendedReasoningEffort: null,
    overrideModel: null,
    rationale:
      'Needs reliable, precise comparison — keep on the conversational chat default. Contradiction precision is the failure mode that spams respondents with false "confirm the newer view" prompts, so do not downgrade this agent.',
  },
  {
    slug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
    label: 'Answer Refiner',
    role: 'Refines answers on clarification',
    taskTier: 'chat',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 4096,
    recommendedReasoningEffort: null,
    overrideModel: null,
    rationale: 'Answer evolution tracking — conversational chat default at low temperature.',
  },
  {
    slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
    label: 'Completion Agent',
    role: 'Phrases the offer-to-submit and recap',
    taskTier: 'chat',
    recommendedTemperature: 0.4,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: null,
    overrideModel: null,
    rationale:
      'Warm close-out prose — inherit the conversational chat tier so the recap honours its temperature and reads naturally.',
  },
  {
    slug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
    label: 'Interviewer',
    role: 'Rewords questions conversationally',
    taskTier: 'chat',
    recommendedTemperature: 0.5,
    recommendedMaxTokens: 512,
    recommendedReasoningEffort: null,
    overrideModel: null,
    rationale:
      'Pure rephrasing on every turn — this is the voice the respondent hears, so it must inherit the conversational chat tier and honour its warmer temperature. A reasoning nano here produced tone-deaf openings ("Good to hear" to "I hate my job") in testing.',
  },
] as const;

/** Map of slug → recommendation for O(1) lookup. */
export const AGENT_RECOMMENDATION_BY_SLUG: ReadonlyMap<string, AgentRecommendation> = new Map(
  AGENT_RECOMMENDATIONS.map((r) => [r.slug, r])
);
