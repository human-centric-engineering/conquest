/**
 * Curated advisory recommendations for the ConQuest questionnaire agents.
 *
 * This is the deterministic baseline behind the Agent Settings surface: a
 * hand-maintained table of the right model tier, temperature, maxTokens and
 * reasoning effort for each app agent, plus the rationale shown in the UI.
 *
 * **Selection rule: pick the model whose strengths match what the task actually
 * has to do, then optimise cost within that choice.** Two questions decide it —
 * how much thinking the task needs, and whether a person is waiting on the
 * answer:
 *
 *   - reasoning tier  → `gpt-5.4` — work whose quality depends on multi-step
 *     analysis over a lot of material: reading a document into structure,
 *     judging a design against a rubric, planning a session, writing a report
 *     across many answers. Nobody is watching a cursor blink, so depth beats
 *     latency.
 *   - chat tier       → `gpt-4o` — the per-turn path a respondent is waiting on,
 *     and short well-specified jobs (phrasing a question, pulling a typed value
 *     out of a reply, formatting prose, reading a screenshot). Here responsiveness
 *     and natural language are the quality bar: a slow, deliberative model makes
 *     the conversation worse, not better.
 *   - routing tier    → `gpt-4.1-nano` — mechanical, high-frequency chores
 *     (history summarisation, ingestion triage) where any competent small model
 *     is indistinguishable and cost dominates.
 *
 * Recommendations apply at the **task-tier** level (agents ship with an empty
 * `model` and inherit the tier default — see `agent-resolver`), so a tier
 * recommendation moves every agent on that tier together. Per-agent model
 * overrides are reserved for agents whose job genuinely differs from the rest of
 * their tier; today only the Conditional Topics candidacy check carries one.
 *
 * Temperature, maxTokens and reasoningEffort are per-agent: temperature follows
 * how much latitude the task should have (near-deterministic for extraction and
 * judging, warmer for prose a person reads), maxTokens follows the largest
 * realistic output, and reasoningEffort follows how much deliberation the task
 * rewards. Which parameters a given model happens to honour is a property of the
 * model, not a reason to choose it — parameter support never drives a
 * recommendation here.
 *
 * Pure data + types — no Prisma, no IO. Safe to import anywhere.
 */

import {
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
  QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
  QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
  QUESTIONNAIRE_EDIT_AGENT_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
  QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG,
  QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
  QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
  QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG,
  QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG,
  QUESTIONNAIRE_STEER_AGENT_SLUG,
  RECONCILER_AGENT_SLUG,
  RESPONDENT_REPORT_AGENT_SLUG,
  RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG,
  REPORT_RESEARCHER_AGENT_SLUG,
  REPORT_FORMATTER_AGENT_SLUG,
  REPORT_METHOD_EXPLAINER_AGENT_SLUG,
  COHORT_REPORT_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
  QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
  BRAND_IMPORT_AGENT_SLUG,
  BRAND_CONTRAST_AGENT_SLUG,
  TURN_EVALUATOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  EXPERIENCE_ROUTER_AGENT_SLUG,
  EXPERIENCE_HANDOFF_AGENT_SLUG,
  MEETING_SYNTHESIS_AGENT_SLUG,
  EXPERIENCE_SYNTHESIS_AGENT_SLUG,
} from '@/lib/app/questionnaire/experiences/constants';
import { SCOPE_PLANNER_AGENT_SLUG } from '@/lib/app/questionnaire/scope/constants';
import { AGENT_SETTINGS_ADVISOR_SLUG } from '@/lib/app/questionnaire/agent-advisory/explain-schema';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { SCOPE_EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/scope-evaluation/dimensions';
import { POLICY_EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/policy-evaluation/dimensions';

/**
 * The turn-evaluator judge slug. Canonically defined in `constants.ts` (the single home for
 * questionnaire agent slugs, which the workflow-diagram integrity test pins against); re-exported
 * here for the advisory recommendations that reference it.
 */
export { TURN_EVALUATOR_AGENT_SLUG };

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
      'Work whose quality depends on sustained analysis over a lot of material — reading a document into questionnaire structure, judging a design against a rubric, planning a session, writing a report across many answers. These run in the background where depth matters more than speed, so a frontier model earns its price. GPT-5.4 is the balance point: the same class of analysis as GPT-5.5 at roughly half the cost.',
  },
  chat: {
    tier: 'chat',
    label: 'Chat (per-turn)',
    recommendedModel: 'gpt-4o',
    rationale:
      'The path a respondent is actively waiting on — phrasing the next question, reading their reply into a typed answer, spotting a conflict, closing the session — plus short, well-specified jobs like formatting prose or reading a brand screenshot. Each call is small and well-scoped, and responsiveness is part of the quality: a fast, fluent, multimodal model is the right fit, and a deliberative one would only add latency to work it cannot do better.',
  },
  routing: {
    tier: 'routing',
    label: 'Routing',
    recommendedModel: 'gpt-4.1-nano',
    rationale:
      'Mechanical, high-frequency chores — summarising conversation history, triaging a fresh upload. Any competent small model does these indistinguishably well, so cost is the deciding factor and GPT-4.1 Nano is the cheapest OpenAI text model.',
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
   * override of the tier default) — reserved for agents whose job differs from
   * the rest of their tier. `null` = inherit the tier default.
   */
  overrideModel: string | null;
  /**
   * Evaluation panel this agent belongs to, when it is one of a uniform judge
   * set. Panel members render in their own section rather than among the
   * general tier agents. `null` for ordinary agents.
   */
  panel: string | null;
  rationale: string;
}

/** Panel labels for the three design-time judge sets. */
export const DESIGN_JUDGE_PANEL = 'Questionnaire design panel';
export const TOPICS_JUDGE_PANEL = 'Conditional Topics panel';
export const POLICY_JUDGE_PANEL = 'Interviewer policy panel';

/**
 * Build recommendations for one judge panel from its dimension registry — the
 * single source of truth the seeds and prompt builders already read, so a new
 * dimension appears here automatically (registry order = dimension order).
 *
 * Every judge in a panel does the same shape of work (score one dimension of an
 * authored design against a rubric, emit findings), so they share settings:
 * near-deterministic temperature so the same design scores the same twice, a cap
 * that fits a full findings list, and mid deliberation — enough to weigh a rubric,
 * not so much that a pre-launch review becomes slow and expensive across a panel.
 */
function judgePanelRecommendations(
  panel: string,
  subject: string,
  specs: readonly { slug: string; label: string; summary: string }[]
): AgentRecommendation[] {
  return specs.map((spec) => ({
    slug: spec.slug,
    label: spec.label,
    role: spec.summary,
    taskTier: 'reasoning' as const,
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium' as const,
    overrideModel: null,
    panel,
    rationale: `Scores one dimension of ${subject} against a rubric and proposes concrete edits — real judgement over the authored design, so it belongs on the reasoning tier, but it is a pre-launch pass rather than a per-turn cost, so medium effort is the right depth. Near-deterministic so the same design scores the same twice.`,
  }));
}

/** The design-time evaluation judges (one per `EvaluationDimension`). */
const DESIGN_JUDGE_RECOMMENDATIONS = judgePanelRecommendations(
  DESIGN_JUDGE_PANEL,
  "a questionnaire's authored structure",
  Object.values(EVALUATION_DIMENSION_SPECS)
);

/** The Conditional Topics judges (one per `ScopeEvaluationDimension`). */
const TOPICS_JUDGE_RECOMMENDATIONS = judgePanelRecommendations(
  TOPICS_JUDGE_PANEL,
  'a Conditional Topics configuration',
  Object.values(SCOPE_EVALUATION_DIMENSION_SPECS)
);

/** The interviewer-policy judges (one per `PolicyEvaluationDimension`). */
const POLICY_JUDGE_RECOMMENDATIONS = judgePanelRecommendations(
  POLICY_JUDGE_PANEL,
  'an interviewer policy — house rules, questioning arc, question fidelity',
  Object.values(POLICY_EVALUATION_DIMENSION_SPECS)
);

/**
 * The ConQuest questionnaire agents covered by the advisor: every app agent that
 * resolves a generative model, ordered by tier (reasoning first) then by role
 * prominence, with the three judge panels appended at the end.
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
    panel: null,
    rationale:
      'Reading a whole instrument into structure is the deepest one-off task in the product, and every later stage inherits its mistakes — high effort, and near-deterministic so the structure is faithful to the document rather than invented.',
  },
  {
    slug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
    label: 'Extraction Verifier',
    role: 'Critiques an extraction against the source document',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 4096,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    panel: null,
    rationale:
      'A critic is only worth running if it catches what the extractor missed, which means comparing a long document against a long structure — the same depth as the extractor itself, at low temperature so it reports rather than speculates.',
  },
  {
    slug: QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
    label: 'Scales & Matrix Repair Specialist',
    role: 'Rebuilds mis-extracted scales and matrix questions',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 8192,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    panel: null,
    rationale:
      'Reconstructing a matrix into per-row scales means holding the table, its endpoints and every row in view at once — deep, exacting work, and the output is large enough to need a generous cap.',
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
    panel: null,
    rationale:
      'Designing a whole instrument from a brief — coverage, ordering and phrasing all at once. High effort for the design work, mild latitude so the questions read like a person wrote them.',
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
    panel: null,
    rationale:
      'Advice worth reading has to connect fields that sit on different tabs — the value is in the cross-field reasoning, so high effort pays for itself.',
  },
  {
    slug: QUESTIONNAIRE_EDIT_AGENT_SLUG,
    label: 'Structure Edit Agent',
    role: 'Turns a plain-English instruction into structural edits',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 4096,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'The edits execute deterministically in code, so the model only has to interpret an instruction faithfully — medium effort is enough, and low temperature keeps it to what the admin actually asked for.',
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
    panel: null,
    rationale:
      'Naming the fields a question should fill is structured generation of moderate difficulty — medium effort, with enough latitude to word a slot in natural language.',
  },
  {
    slug: QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG,
    label: 'Glossary Analyst',
    role: 'Proposes ambiguous terms and their candidate definitions',
    taskTier: 'reasoning',
    // Warmer than the critics: deciding which words are genuinely contested, and phrasing a
    // definition a respondent will read, are both partly editorial judgements.
    recommendedTemperature: 0.3,
    // Up to 40 terms x 4 definitions plus a rationale each. A truncated response fails schema
    // validation outright rather than degrading, so the cap is generous relative to real output.
    recommendedMaxTokens: 8192,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Judging which terms are genuinely contested in this context is real analysis, but it is a one-off authoring pass rather than a per-turn cost — medium effort on the reasoning tier.',
  },
  {
    slug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
    label: 'Routing Analyst',
    role: "Reads an instrument's own routing guidance into topics and hard rules",
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    // Up to 40 topics with criteria, rationale and a quoted span each, plus the rules.
    recommendedMaxTokens: 12288,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    panel: null,
    rationale:
      'Turning scattered ASK-IF notes into a coherent topic set means tracing each rule back to the span it came from across a long document — high effort, and near-deterministic so the same instrument yields the same topics twice.',
  },
  {
    slug: SCOPE_PLANNER_AGENT_SLUG,
    label: 'Scope Planner',
    role: 'Decides which conditional topics apply to this respondent',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Weighs the opening conversation against every topic criterion and the hard rules — a judgement call that shapes the rest of the session, so it belongs on the reasoning tier. It runs once per respondent, not per turn, but a respondent is waiting on it, so medium effort balances quality against that wait.',
  },
  {
    slug: RECONCILER_AGENT_SLUG,
    label: 'Suggestion Reconciler',
    role: 'Merges overlapping review suggestions into one coherent set',
    taskTier: 'reasoning',
    recommendedTemperature: 0.3,
    recommendedMaxTokens: 8192,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Spotting that two judges asked for the same edit in different words is comparison across a large set — reasoning tier, medium effort, with a cap that fits the whole reconciled list.',
  },
  {
    slug: QUESTIONNAIRE_STEER_AGENT_SLUG,
    label: 'Suggestion Steer',
    role: 'Re-aims a review suggestion from the admin’s steer',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Rewrites an existing proposed edit to follow the admin’s correction — bounded work against material already in hand, so medium effort, and low temperature so the steer is obeyed rather than re-interpreted.',
  },
  {
    slug: QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG,
    label: 'House Rules Assistant',
    role: 'Drafts interviewer house rules from a plain-English ask',
    taskTier: 'reasoning',
    recommendedTemperature: 0.4,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Turning "never give medical advice" into rules that will not collide with the questionnaire’s own instructions takes judgement about precedence, not just phrasing — medium effort, with enough latitude to word a rule naturally.',
  },
  {
    slug: QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG,
    label: 'Opening Questions Assistant',
    role: 'Suggests example opening questions for the interviewer',
    taskTier: 'reasoning',
    // Deliberately the warmest agent in the table: the whole point is a spread of
    // different openings for an author to choose between.
    recommendedTemperature: 0.7,
    recommendedMaxTokens: 1024,
    recommendedReasoningEffort: 'low',
    overrideModel: null,
    panel: null,
    rationale:
      'A short ideation task where variety is the product — the author picks from what it offers, so breadth beats deliberation: low effort, high temperature, small cap.',
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
    panel: null,
    rationale:
      'A judge is only useful if its scores are stable and defensible — high effort for the rubric reasoning, near-deterministic so the same turn grades the same twice. Runs offline, so the depth costs a respondent nothing.',
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
    panel: null,
    rationale:
      'Long-form prose that has to stay grounded in what the respondent actually said — the deliverable a client reads, so frontier quality is visible in the output. Mild latitude for readable writing.',
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
    panel: null,
    rationale:
      'Draws a report brief out of an admin a few questions at a time — needs to understand the report machinery it is configuring, but each turn is short: medium effort, warm enough to hold a conversation.',
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
    panel: null,
    rationale:
      'Finding themes that hold across many respondents is the hardest analysis in the product — high effort, and restrained temperature so a theme is evidenced rather than asserted.',
  },
  {
    slug: REPORT_RESEARCHER_AGENT_SLUG,
    label: 'Report Research Agent',
    role: 'Runs web-search rounds to gather external context for reports',
    taskTier: 'reasoning',
    recommendedTemperature: 0.3,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Decides what to search for next after reading what came back — a bounded tool loop rather than deep analysis, so medium effort. Low temperature keeps queries focused; the small cap suits short queries and a brief synthesis note.',
  },
  {
    slug: EXPERIENCE_ROUTER_AGENT_SLUG,
    label: 'Experience Router',
    role: 'Chooses which questionnaire a respondent goes to next',
    taskTier: 'reasoning',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Reads a completed leg against the routing rules to pick the next one — a decision the respondent cannot undo, so it needs real reasoning, but it is one call at a hand-off: medium effort, near-deterministic.',
  },
  {
    slug: EXPERIENCE_HANDOFF_AGENT_SLUG,
    label: 'Experience Handoff Briefing',
    role: 'Writes the carry-over briefing between legs',
    taskTier: 'reasoning',
    recommendedTemperature: 0.5,
    recommendedMaxTokens: 2048,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Summarises what the next leg needs to know so the respondent is not asked twice — selection judgement plus prose a person reads, so medium effort with a warmer setting for the writing.',
  },
  {
    slug: MEETING_SYNTHESIS_AGENT_SLUG,
    label: 'Meeting Breakout Synthesiser',
    role: 'Synthesises a facilitated breakout into shared findings',
    taskTier: 'reasoning',
    recommendedTemperature: 0.3,
    recommendedMaxTokens: 4096,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    panel: null,
    rationale:
      'Condenses several parallel conversations into one account that must stay faithful to each room and preserve anonymity — deep synthesis, restrained temperature so nothing is attributed that was not said.',
  },
  {
    slug: EXPERIENCE_SYNTHESIS_AGENT_SLUG,
    label: 'Experience Synthesiser',
    role: 'Synthesises a whole experience across legs and participants',
    taskTier: 'reasoning',
    recommendedTemperature: 0.25,
    recommendedMaxTokens: 6144,
    recommendedReasoningEffort: 'high',
    overrideModel: null,
    panel: null,
    rationale:
      'The widest read in the product — every leg, every participant, one narrative. High effort, tight temperature, and a cap sized for the full synthesis.',
  },
  {
    slug: AGENT_SETTINGS_ADVISOR_SLUG,
    label: 'Agent Settings Advisor',
    role: 'The AI second opinion behind this page',
    taskTier: 'reasoning',
    recommendedTemperature: 0.3,
    recommendedMaxTokens: 3072,
    recommendedReasoningEffort: 'medium',
    overrideModel: null,
    panel: null,
    rationale:
      'Argues about model fit for one agent at a time against a baseline it is told to distrust — that needs genuine reasoning, but the answer is a short verdict, so medium effort and a modest cap.',
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
    panel: null,
    rationale:
      'A short, well-specified pick from a supplied list, made while the respondent waits — speed is the quality bar, and the output is a few tokens of JSON, so a tight cap is fine.',
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
    panel: null,
    rationale:
      'Pulling a typed value out of one reply is comprehension, not analysis — it runs on every turn, so it belongs on the fast tier, at low temperature for faithful extraction.',
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
    panel: null,
    rationale:
      'Compares the new answer against earlier ones every turn. Precision matters — a false positive interrupts the respondent to confirm a conflict that is not there — so keep it on the chat default rather than downgrading it, at low temperature.',
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
    panel: null,
    rationale:
      'Folds a clarification into an answer already on file — small, in-conversation work at low temperature so the stored answer tracks what the respondent said.',
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
    panel: null,
    rationale:
      'The last thing a respondent reads — short, warm prose delivered while they wait, which is exactly what the conversational tier is for.',
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
    panel: null,
    rationale:
      'This is the voice the respondent hears, on every single turn. The job is natural phrasing delivered without a pause — fluency and speed, not deliberation — with the warmest setting on the chat tier.',
  },
  {
    slug: REPORT_FORMATTER_AGENT_SLUG,
    label: 'Report Formatter',
    role: 'Formats finished report content into clean Markdown',
    taskTier: 'chat',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 8192,
    recommendedReasoningEffort: null,
    overrideModel: null,
    panel: null,
    rationale:
      'Presentation work over content that has already been reasoned about — no analysis left to do, so the fast tier is right. Low temperature so it formats rather than rewrites; the large cap carries a whole report.',
  },
  {
    slug: REPORT_METHOD_EXPLAINER_AGENT_SLUG,
    label: 'Report Method Explainer',
    role: 'Explains in plain English how a report was produced',
    taskTier: 'chat',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 1024,
    recommendedReasoningEffort: null,
    overrideModel: null,
    panel: null,
    rationale:
      'A short plain-English note describing a pipeline it is handed — small, well-specified writing, so the fast tier at low temperature keeps the account accurate.',
  },
  {
    slug: BRAND_IMPORT_AGENT_SLUG,
    label: 'Brand Import Analyst',
    role: 'Assigns measured screenshot colours to theme roles',
    taskTier: 'chat',
    // The colours are measured in code; the model only names roles for them.
    recommendedTemperature: 0.1,
    recommendedMaxTokens: 700,
    recommendedReasoningEffort: null,
    overrideModel: null,
    panel: null,
    rationale:
      'Needs to see a screenshot, so it needs a multimodal model — the chat tier is the one that has vision. The arithmetic is done in code and the model only assigns roles to measured colours, so the task is small and the temperature is the lowest in the table.',
  },
  {
    slug: BRAND_CONTRAST_AGENT_SLUG,
    label: 'Brand Contrast Adviser',
    role: 'Picks legible steps from a generated tint/shade ramp',
    taskTier: 'chat',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 900,
    recommendedReasoningEffort: null,
    overrideModel: null,
    panel: null,
    rationale:
      'Chooses an index from a ramp built and contrast-checked in code — a constrained pick, not a colour invention, so a fast model at low temperature with a small cap is the right fit.',
  },

  // ---- routing tier (inherit defaultModels.routing) ----------------------
  {
    slug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
    label: 'Conditional Topics Candidacy Check',
    role: 'Flags whether a fresh upload describes conditional routing',
    taskTier: 'routing',
    recommendedTemperature: 0.2,
    recommendedMaxTokens: 1024,
    recommendedReasoningEffort: null,
    // The one deliberate per-agent pin: a yes/no triage read over a document is
    // more than the routing default is meant for, but far less than the analyst
    // that follows it — so a small model of its own rather than moving the tier.
    overrideModel: 'gpt-5.4-mini',
    panel: null,
    rationale:
      'A yes/no triage read on every fresh upload: cheap enough to run always, but it still has to understand a document, so it is pinned to a small model of its own rather than sharing the summarisation default or paying for the full analyst.',
  },

  // ---- design-time judge panels (reasoning tier) --------------------------
  ...DESIGN_JUDGE_RECOMMENDATIONS,
  ...TOPICS_JUDGE_RECOMMENDATIONS,
  ...POLICY_JUDGE_RECOMMENDATIONS,
] as const;

/** Map of slug → recommendation for O(1) lookup. */
export const AGENT_RECOMMENDATION_BY_SLUG: ReadonlyMap<string, AgentRecommendation> = new Map(
  AGENT_RECOMMENDATIONS.map((r) => [r.slug, r])
);
