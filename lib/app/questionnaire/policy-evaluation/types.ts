/**
 * Interviewer-policy evaluation contract and in-memory shapes (F18.8).
 *
 * A third panel of judges, sibling to the design-evaluation panel (`evaluation/**`, F5.1–F5.3) and
 * the Adaptive Scope panel (`scope-evaluation/**`, F17.21). Those score the questions and the
 * routing; this one scores the **interviewer policy** — the client's house rules, the questioning
 * arc, and the per-question fidelity dial — which together decide how every question is actually
 * put to a respondent.
 *
 * The implicit objective these judges score toward, read off the three domain docs: the interviewer
 * should behave the way the client's policy says, and the policy should say something an interviewer
 * can act on — specific enough to change a turn, coherent with itself, and coherent with the tone
 * dials and routing it sits beside.
 *
 * **Structural only, v1**, exactly as the scope panel is. The judges read authored config as an
 * admin would see it. They do NOT read live session data or the behavioural findings in
 * `analytics/interviewer-policy.ts` (F18.7). The DTO has no field for it, so the boundary cannot be
 * crossed by accident.
 *
 * **What is NOT re-derived.** `authoring/config-conflicts.ts` already runs 20 mechanical checks over
 * this same config. Every one of its findings is handed to the judges as
 * {@link PolicyStructureInput.knownIssues} **with its stable id**, and each dimension's rubric names
 * the ids it must not repeat — so a judge matches id to id rather than paraphrase to paraphrase.
 *
 * **A fourth sibling module, not an extension.** `EVALUATION_DIMENSIONS` and
 * `SCOPE_EVALUATION_DIMENSIONS` are closed tuples compile-time-locked to their own edit-op unions
 * (question/section vocabulary; topic/rule vocabulary). Neither generalises to rules/arc/fidelity
 * without forcing a structurally unrelated union onto a shipped surface. What IS reused — never
 * re-declared — is genuinely generic across all three panels: {@link FindingSeverity} and its
 * siblings from `evaluation/types`.
 *
 * Pure, DB-free: no Prisma, no Next.js. The dispatch capability and the route-local loader
 * (`_lib/policy-evaluation-structure.ts`) supply the I/O.
 */

import type {
  FunnelPace,
  HouseRuleKind,
  InterviewerApproach,
  InterviewerOpeningMode,
  PresentationMode,
  QuestionFidelityLevel,
  QuestionFidelityStop,
  QuestionType,
  ToneDimensionKey,
} from '@/lib/app/questionnaire/types';
import type { FunnelPaceProfile } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import type { ConflictSeverity } from '@/lib/app/questionnaire/authoring/config-conflicts';
import type { FindingSeverity } from '@/lib/app/questionnaire/evaluation/types';

/**
 * The four dimensions, as a `const` tuple — the single source of truth.
 *
 * Each targets a different object, and that separation is what keeps the rubrics clean:
 * `rule_coherence` reads the rules array as prose, `arc_fit` reads the strategy blob against the
 * instrument's shape, `fidelity_calibration` reads N question rows, and `cross_layer_conflict` is
 * the **only** one permitted to reason across blocks. Without that fourth one, each of the other
 * three would have to carry the whole interaction table and you would get one finding three times
 * with three different fixes.
 */
export const POLICY_EVALUATION_DIMENSIONS = [
  'rule_coherence',
  'arc_fit',
  'fidelity_calibration',
  'cross_layer_conflict',
] as const;
export type PolicyEvaluationDimension = (typeof POLICY_EVALUATION_DIMENSIONS)[number];

/**
 * The op vocabulary for a {@link PolicyProposedEdit} — same `const`-tuple discipline as the two
 * sibling panels: the apply engine switches on it and the judge prompt names it.
 *
 * **Every op writes exactly one field that already exists.** Deliberate omissions, each for a
 * reason worth keeping:
 *
 * - No question-content ops (`replace_prompt`, `change_type`, …) — the design-evaluation panel owns
 *   question wording, and two panels proposing different prompts for one question is a queue an
 *   admin cannot reconcile.
 * - No `edit_opening_examples` — `opening-examples/suggest.ts` is a shipped assistant whose whole
 *   job is drafting those. A judge that rewrites them competes with it.
 * - No persona swap — a persona is a whole `ToneSettings`, not a one-field write.
 * - **No `houseRules.enabled` / `interviewerStrategy.enabled` master switches.** Turning either off
 *   silently voids a client's entire authored policy, which is too much blast radius for a one-click
 *   apply. A judge that thinks the whole block should go says so in prose.
 * - **`set_fidelity_enabled` IS allowed, in both directions**, and the asymmetry is the point: that
 *   gate is the one switch whose flip destroys nothing (per-question values persist either way —
 *   the entire reason for the two-layer no-op design), and "you set forty sliders and never turned
 *   the feature on" is the single most valuable finding this panel can produce. Leaving it
 *   prose-only would leave the best result unactionable.
 */
export const POLICY_PROPOSED_EDIT_OPS = [
  'edit_house_rule',
  'set_house_rule_enabled',
  'delete_house_rule',
  'add_house_rule',
  'set_approach',
  'set_pace',
  'set_opening_mode',
  'set_tactics',
  'set_fidelity_enabled',
  'set_default_fidelity',
  'set_question_fidelity',
  'set_tone_dimension',
] as const;
export type PolicyProposedEditOp = (typeof POLICY_PROPOSED_EDIT_OPS)[number];

/**
 * A machine-applicable edit. Hand-written union, mirrored by `policyProposedEditSchema` in
 * `judge-schema.ts` and pinned to it by a compile-time parity check — if the two drift, the module
 * stops compiling.
 */
export type PolicyProposedEdit =
  // `id` and `enabled` are preserved from the live rule; only the authored fields are replaced.
  | { op: 'edit_house_rule'; kind: HouseRuleKind; text: string; trigger?: string }
  | { op: 'set_house_rule_enabled'; enabled: boolean }
  | { op: 'delete_house_rule' }
  // `id` is minted server-side; a judge never chooses one.
  | { op: 'add_house_rule'; kind: HouseRuleKind; text: string; trigger?: string }
  | { op: 'set_approach'; approach: InterviewerApproach }
  | { op: 'set_pace'; pace: FunnelPace }
  | { op: 'set_opening_mode'; openingMode: InterviewerOpeningMode }
  | { op: 'set_tactics'; probeDepth?: boolean; reflect?: boolean; batchRelated?: boolean }
  | { op: 'set_fidelity_enabled'; enabled: boolean }
  | { op: 'set_default_fidelity'; defaultFidelity: QuestionFidelityStop }
  // The only op writing outside the config JSON — it touches `AppQuestionSlot.fidelity`.
  | { op: 'set_question_fidelity'; fidelity: QuestionFidelityStop }
  | { op: 'set_tone_dimension'; dimension: ToneDimensionKey; enabled: boolean; level?: number };

/**
 * One actionable suggestion from a policy judge.
 *
 * `targetKey` addresses what the finding is about: `house_rule:<id>` | `house_rules` | `strategy` |
 * `fidelity` | `tone` | `question:<key>`. A free string, not validated against the live config here
 * — the pure core has no graph; the apply engine reconciles it at apply time, fail-cleanly.
 *
 * `house_rule:` rather than `rule:` is deliberate: the scope panel already owns `rule:<id>` for a
 * hard routing rule, and a pack printing both appendices must never mis-resolve one as the other.
 */
export interface PolicyJudgeFinding {
  targetKey: string;
  severity: FindingSeverity;
  /** The concrete change the judge proposes. */
  proposedChange: string;
  /** Why it is warranted, in one or two sentences. */
  rationale: string;
  /** The offending text quoted from the config, when the finding points at one. */
  sourceQuote?: string;
  /** Optional structured edit the review queue can apply in one click. */
  proposedEdit?: PolicyProposedEdit;
}

/**
 * One judge's verdict for one dimension. `score` is continuous in [0, 1] (1 = in great shape).
 * `dimension` is stamped by the caller, never the LLM — a judge cannot mislabel its own verdict.
 */
export interface PolicyJudgeVerdict {
  dimension: PolicyEvaluationDimension;
  score: number;
  findings: PolicyJudgeFinding[];
}

/* ── The structure DTO ──────────────────────────────────────────────────── */

/** What the questionnaire is for — the standard `arc_fit` measures the arc against. */
export interface PolicyStructureMeta {
  title: string;
  goal: string | null;
  audienceSummary: string | null;
  sectionCount: number;
  questionCount: number;
}

/** Surrounding config that changes whether a policy can take effect at all. */
export interface PolicyStructureContext {
  presentationMode: PresentationMode;
  anonymousMode: boolean;
  sensitivityAwareness: boolean;
  hasSupportMessage: boolean;
  answerConfidenceFloor: number;
}

/** The voice dials, on the signed admin-facing scale. */
export interface PolicyStructureTone {
  personaSelectionEnabled: boolean;
  /** The version's free-text persona, clipped. Null when unset or replaced by a chosen persona. */
  personaText: string | null;
  /**
   * Enabled dials only, at their **display** level (−2…+2), never the stored 1–5. "Humour 3" reads
   * as a high setting to a model; "Humour 0" reads correctly as neutral.
   */
  dials: { key: ToneDimensionKey; label: string; displayLevel: number }[];
}

/** The house rules, as authored. */
export interface PolicyStructureHouseRules {
  enabled: boolean;
  rules: {
    id: string;
    kind: HouseRuleKind;
    enabled: boolean;
    text: string;
    trigger: string | null;
  }[];
}

/** The questioning arc, with its resolved profile so no judge re-derives the bands. */
export interface PolicyStructureStrategy {
  enabled: boolean;
  approach: InterviewerApproach;
  pace: FunnelPace;
  openingMode: InterviewerOpeningMode;
  openingExamples: string[];
  probeDepth: boolean;
  reflect: boolean;
  batchRelated: boolean;
  /**
   * Pre-computed via `paceProfile()`. The direct analogue of the scope panel's `costs`: `arc_fit`
   * reasons about "3 opening asks, targeted above 85% coverage", and a judge inventing those numbers
   * is a judge inventing the feature. `paceProfile` also honours the funnel-only rule, so this never
   * describes a pace the runtime ignores.
   */
  paceProfile: FunnelPaceProfile;
  /** `usesGuidedOpening()` — whether the examples actually replace the interviewer's own framings. */
  guidedOpeningActive: boolean;
}

/** One question, for the fidelity judge. */
export interface PolicyStructureQuestion {
  key: string;
  /** Clipped — the judge needs to recognise the question, not read the whole instrument. */
  prompt: string;
  type: QuestionType;
  required: boolean;
  weight: number;
  sectionTitle: string;
  /** Gate-honoured, via `resolveQuestionFidelity` — what the interviewer actually does. */
  level: QuestionFidelityLevel;
  /** The raw stored value's level, gate ignored. The "gate off, sliders set" finding needs both. */
  storedLevel: QuestionFidelityLevel;
  /** Adaptive Scope topics claiming this question; empty when routing is off. */
  topicKeys: string[];
}

/** The fidelity picture — the gate, the distribution, and a bounded sample of questions. */
export interface PolicyStructureFidelity {
  enabled: boolean;
  defaultFidelity: QuestionFidelityStop;
  defaultLevel: QuestionFidelityLevel;
  /** Counts over EVERY question, complete even when {@link questions} is truncated. */
  distribution: Record<QuestionFidelityLevel, number>;
  /**
   * The satisfaction floor each level imposes, pre-computed against this version's own
   * `answerConfidenceFloor` — so the judge sees the real bar rather than the constant.
   */
  satisfactionFloors: Record<QuestionFidelityLevel, number>;
  questions: PolicyStructureQuestion[];
  questionsShown: number;
  questionsTotal: number;
  truncated: boolean;
}

/** What routing does to the policy — empty/false when Adaptive Scope is off. */
export interface PolicyStructureRouting {
  adaptiveScopeEnabled: boolean;
  maxConditionalTopics: number;
  limitOpeningProbes: boolean;
  maxOpeningProbes: number;
  /**
   * Pre-computed: per topic, how many of its questions are must-ask or close. This is what makes
   * "must-asks concentrated in a topic most respondents never reach" checkable in one line rather
   * than a 200-row join a model does badly.
   */
  mustAskByTopic: {
    topicKey: string;
    label: string;
    conditional: boolean;
    mustAskCount: number;
    closeCount: number;
  }[];
}

/** One finding `detectConfigConflicts` already raised — context, never a target to repeat. */
export interface PolicyStructureIssue {
  severity: ConflictSeverity;
  /** The stable check id, so a rubric's ignore clause can name it exactly. */
  id: string;
  title: string;
  message: string;
}

/**
 * The pure DTO the route assembles and hands to the prompt builder. Keeps `lib/app/**` Prisma-free:
 * the selects live in `_lib/policy-evaluation-structure.ts`, the same seam split the two sibling
 * panels use.
 */
export interface PolicyStructureInput {
  meta: PolicyStructureMeta;
  context: PolicyStructureContext;
  tone: PolicyStructureTone;
  houseRules: PolicyStructureHouseRules;
  strategy: PolicyStructureStrategy;
  fidelity: PolicyStructureFidelity;
  routing: PolicyStructureRouting;
  knownIssues: PolicyStructureIssue[];
}
