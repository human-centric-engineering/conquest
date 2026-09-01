/**
 * Questionnaire Pack export model.
 *
 * Flattens a {@link VersionGraphView} (plus its data slots, glossary appendix, and latest design
 * evaluation run) into a presentation-ready {@link PackModel} — a branded, shareable artifact that
 * covers everything about how the questionnaire is set up: title/version/goals, the question
 * structure, the semantic data slots (with their linked questions), the definitions/glossary, the
 * experience-setup summary, (opt-in) the F5.1–F5.3 judge panel's findings for this version, and
 * (opt-in) the Conditional Topics routing logic in plain language — nesting the F17.21 scope-evaluation
 * judge panel's verdict on that routing design as {@link PackConditionalTopics.evaluation}, rather than
 * an eighth top-level section, since it is a judgement ABOUT the section above it, not a separate
 * subject. The admin picks which of those seven top-level sections to include via
 * {@link PackInclude}; excluded sections are `null` on the model so every serialiser
 * (PDF/CSV/Markdown) skips them the same way.
 *
 * The setup summary is DERIVED from `lib/app/questionnaire/settings-registry.ts`, not hand-listed —
 * a new config field appears in the pack automatically (and cannot compile until it is classified).
 *
 * Distinct from the brand-free {@link file://./build-instrument-model.ts} (F14.9), which is the
 * design-time reviewer copy of just the questions. This is the external/showcase artifact — it
 * reuses `buildInstrumentModel` for the question-structure section rather than re-deriving it.
 *
 * Pure: no Prisma / Next / clock. The caller stamps `generatedAt` (an ISO string) so the model stays
 * deterministic in its input.
 */

import {
  QUESTION_FIDELITY_LABELS,
  QUESTION_FIDELITY_LEVELS,
  resolveQuestionFidelity,
  type QuestionFidelityLevel,
} from '@/lib/app/questionnaire/types';
import type {
  EvaluationFindingView,
  EvaluationRunDetail,
  ScopeEvaluationRunDetail,
  ScopeFindingTargetKind,
  PolicyFindingTargetKind,
  PolicyEvaluationRunDetail,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';
import type { GlossaryAppendixView } from '@/lib/app/questionnaire/glossary/types';
// The pure chat leaf — `paceProfile` reads `FUNNEL_PACE_PROFILES`, the same table the runtime uses,
// so the pack's arc bands cannot drift from the arc the interviewer actually runs.
import { paceProfile } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import {
  buildRoutingSettingRows,
  buildSettingRows,
  type PackSetupItem,
  type RoutingSettingItem,
} from '@/lib/app/questionnaire/settings-registry';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
import {
  ALWAYS_PHASES,
  type ConditionalTopicsSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { describeScopeRule } from '@/lib/app/questionnaire/scope/rule-format';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
  type FindingReviewStatus,
  type FindingSeverity,
} from '@/lib/app/questionnaire/evaluation';
import {
  effectiveOp,
  groupContextLabel,
  groupFindingsByTarget,
  type FindingGroup,
  type SeverityCounts,
} from '@/lib/app/questionnaire/evaluation/group-findings';
import {
  ACTION_NOUNS,
  backing,
  judgeNames,
  summariseGroupActions,
  wordingHost,
} from '@/lib/app/questionnaire/evaluation/group-actions';
import {
  describeProposedEdit,
  destinationSentence,
} from '@/lib/app/questionnaire/evaluation/describe-edit';
import {
  SCOPE_EVALUATION_DIMENSIONS,
  SCOPE_EVALUATION_DIMENSION_SPECS,
  describeScopeProposedEdit,
  groupScopeFindingsByTarget,
  type ScopeEvaluationDimension,
  type ScopeSeverityCounts,
} from '@/lib/app/questionnaire/scope-evaluation';
import {
  POLICY_EVALUATION_DIMENSIONS,
  POLICY_EVALUATION_DIMENSION_SPECS,
  describePolicyProposedEdit,
  groupPolicyFindingsByTarget,
  type PolicyEvaluationDimension,
  type PolicySeverityCounts,
} from '@/lib/app/questionnaire/policy-evaluation';
import {
  buildInstrumentModel,
  type InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

/**
 * Which of the pack's seven sections to include, plus the one sub-option (`setupTechnical`). All
 * default `true` except `evaluations`, `conditionalTopics`, and `setupTechnical`.
 */
export interface PackInclude {
  /** Title, version, goal, audience. */
  meta: boolean;
  /** The sections/questions structure. */
  questions: boolean;
  /** The semantic data slots, with their linked questions. */
  dataSlots: boolean;
  /** The definitions / glossary appendix. */
  definitions: boolean;
  /** The experience-setup summary — every setting in the standard tier. */
  setup: boolean;
  /**
   * Sub-option of {@link setup}: also list the technical tier — numeric tuning, prompt/instruction
   * presence, cost and abuse thresholds, admin-only debugging toggles. Defaults `false` because the
   * pack is the external/showcase artifact; the classification per setting lives in
   * `lib/app/questionnaire/settings-registry.ts`. Ignored when `setup` is off.
   */
  setupTechnical: boolean;
  /**
   * The latest F5.1–F5.3 design-evaluation run's judge scores and findings — including findings
   * still `pending` review. Defaults `false`, unlike every other section: this is unreviewed AI
   * critique of the questionnaire, and the pack is the external/showcase artifact, not the admin
   * console — an admin opts in deliberately rather than shipping it by accident.
   */
  evaluations: boolean;
  /**
   * Sub-option of {@link evaluations}: the panel's verdict per flagged subject — what it wants done,
   * how many judges are behind it, and where they disagreed. Defaults **`true`**: it is the
   * shortest and most useful thing the appendix can say, and the console has led with it since the
   * by-question view landed.
   */
  evaluationVerdicts: boolean;
  /**
   * Sub-option of {@link evaluations}: every judge's own suggestion and reasoning, beneath the
   * subject it is about.
   *
   * Defaults **`false`**, which is a deliberate change to what this section used to produce. Full
   * reasoning is the bulk of the appendix — a contested question runs to about a page — and with the
   * verdict now printed above it, most readers of a pack want the conclusion rather than four
   * near-identical arguments for it. An admin who wants the arguments ticks this.
   */
  evaluationJudgeDetail: boolean;
  /**
   * Sub-option of {@link evaluations}: the cross-judge reconciled phrasings, and the judges no
   * phrasing satisfies. Defaults `true` — a proposed wording is the most actionable line in the
   * appendix, and it is one or two lines per contested question.
   */
  evaluationRewordings: boolean;
  /**
   * Sub-option of {@link evaluations}: the span of the questionnaire each judge cited as evidence.
   * Defaults `false` — judges routinely quote the prompt the finding already sits under, so it is
   * mostly the same sentence printed twice. The console suppresses a quote that merely restates its
   * target; the pack makes it an opt-in instead, since it has no card to compare against.
   */
  evaluationEvidence: boolean;
  /**
   * The routing logic — which topics are always asked, which are conditional (and on what
   * criteria), and the hard rules — explained in plain language for a stakeholder audience. Defaults
   * `false`, like `evaluations`: it is the routing *design*, not the questionnaire content, and not
   * every reader of the pack needs (or should see) how a client's instrument routes respondents
   * before the admin has decided to share that. See {@link file://./build-pack-model.ts}'s
   * `buildConditionalTopicsSection`.
   */
  conditionalTopics: boolean;
  /**
   * Sub-option of {@link conditionalTopics}: which questions each topic actually covers.
   *
   * Defaults `false` because it is the longest part of the section — every question of every topic,
   * a second pass over the instrument the pack has usually already printed in full. Worth ticking
   * when the reader's question is "if this area is not selected for me, what am I not asked?",
   * which the topic list alone cannot answer.
   */
  conditionalTopicsMembers: boolean;
  /**
   * Sub-option of {@link conditionalTopics}: the judge panel's review of the routing design.
   * Defaults `true` — it is short, and a routing design shared without the review of it invites
   * the reader to assume nobody looked.
   */
  conditionalTopicsEvaluation: boolean;
  /**
   * Sub-option of {@link conditionalTopics}: the technical tier of the routing settings — the
   * confidence floor, the per-type time costs, whether extra guidance is set. Defaults `false`, the
   * same split and the same reasoning as `setupTechnical`.
   */
  conditionalTopicsTechnical: boolean;
  /**
   * The interviewer policy — the client's house rules, the questioning arc, and which questions are
   * asked as written — plus the F18.8 judge panel's verdict on it.
   *
   * Its own top-level flag rather than a nest under `setup`, for two reasons. `setup` is a flat list
   * across ~15 setting groups, so nesting a verdict about three of them there would attach a
   * judgement to twelve things it never read. And `setup` defaults **true**, which would ship
   * unreviewed AI critique into every default download the moment this landed. Defaults `false`,
   * like `evaluations` and `conditionalTopics`, for that second reason.
   */
  interviewerPolicy: boolean;
}

/**
 * The export dialog's default checkbox state.
 *
 * Every top-level section except the three opt-in appendices, the standard settings tier only, and
 * each appendix's sub-options set to the shape that reads best when someone does tick it: the
 * conclusions, not the arguments for them.
 */
export const DEFAULT_PACK_INCLUDE: PackInclude = {
  meta: true,
  questions: true,
  dataSlots: true,
  definitions: true,
  setup: true,
  setupTechnical: false,
  evaluations: false,
  evaluationVerdicts: true,
  evaluationJudgeDetail: false,
  evaluationRewordings: true,
  evaluationEvidence: false,
  conditionalTopics: false,
  conditionalTopicsMembers: false,
  conditionalTopicsEvaluation: true,
  conditionalTopicsTechnical: false,
  interviewerPolicy: false,
};

/** One data slot, resolved for the pack — its linked questions carry their prompt, not just a key. */
export interface PackDataSlot {
  key: string;
  name: string;
  description: string;
  theme: string;
  weight: number;
  questions: { key: string; prompt: string }[];
}

/** One row of the experience-setup summary — re-exported so the serialisers have one import site. */
export type { PackSetupItem };

/**
 * What ONE judge said about ONE target. The subject it addresses is not repeated here — it is the
 * enclosing {@link PackEvaluationTarget}, named once.
 */
export interface PackEvaluationJudgeView {
  dimension: EvaluationDimension;
  /** The judge's display name ("Clarity Judge"), so a reader needn't know the dimension keys. */
  label: string;
  severity: FindingSeverity;
  /** Review lifecycle: `pending` | `accepted` | `declined` | `applied` — shown so a reader can tell
   *  a raw suggestion apart from one the admin has already acted on. */
  status: FindingReviewStatus;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  /**
   * Plain-English rendering of the structured edit, from the shared `describeProposedEdit` — the
   * same sentence the console prints under the button that performs it.
   *
   * `null` for a prose-only finding. The design panel was the only one of the three without this,
   * so a drafted question reached the pack as the judge's prose description of it while the console
   * showed the drafted prompt, its answer type and where it would land.
   */
  proposedEditSummary: string | null;
  /**
   * Where an `add_question` would put its drafted question, as a sentence. `null` for every other
   * op, for a run that predates destination resolution, and for a terminal finding whose section
   * was never explicitly chosen — see `destinationSentence`, which returns `null` rather than
   * naming whichever section happens to be last today.
   */
  destination: string | null;
  /**
   * The reviewer's own instruction for how this change should be made, when they wrote one.
   *
   * The one thing on a finding written by a person rather than by a model, and the pack was
   * dropping it: a reader saw the judge's suggestion with no sign that a human had already said
   * "keep it under fifteen words" about it.
   */
  applyInstruction: string | null;
}

/**
 * One proposed course of action and the judges behind it, resolved for printing.
 *
 * Fully resolved on purpose — heading, backing and judge names are strings here, not a
 * `GroupAction` for each serialiser to phrase for itself. Three serialisers phrasing "2 of 3
 * judges" independently is three chances to disagree with the console about what the panel said.
 */
export interface PackEvaluationVerdictBlock {
  /** "A reword" — the action as a noun, for use as a heading over the block. */
  heading: string;
  /** "2 of 3 judges" / "all 3 judges" / "1 judge". Denominator is the judges that flagged THIS
   *  target, never the seven on the panel: the others had nothing to say about it. */
  backing: string;
  /** The judges proposing it, by display name without the " Judge" noun. */
  judges: string;
  /** This block holds the reconciled wordings — see `wordingHost` for why it is not always first. */
  holdsWording: boolean;
  /**
   * The one-line suggestions behind this action, deduplicated.
   *
   * Without them a block reading "A deletion, as proposed by 1 of 3 judges — Duplicates" gives a
   * reader no reason at all, and the default download has judge reasoning switched off, so there is
   * no tab to open the way there is in the console. One line per distinct suggestion keeps the
   * verdict actionable without pulling the whole argument in behind it.
   */
  suggestions: string[];
}

/**
 * What the panel is actually asking be done about one target.
 *
 * The pack printed severity tallies and a list of judges and left the reader to work out, from
 * three or four prose paragraphs, that all of them were asking for the same thing. The console has
 * led with this since the by-question view landed; it is built here by the same
 * `summariseGroupActions`, so the document and the screen cannot reach different verdicts.
 *
 * `null` only when the group has no findings, which cannot happen for a target that exists.
 */
export interface PackEvaluationVerdict {
  /** Every proposed action, best-supported first. More than one means the panel did not agree. */
  blocks: PackEvaluationVerdictBlock[];
  /** The panel proposed more than one course of action, and the reader is being asked to arbitrate. */
  contested: boolean;
}

/**
 * One flagged subject — a question, a section, the goal, the audience, or the coverage-gap group —
 * with every judge's view of it gathered underneath.
 *
 * This is the pack's unit of reading, and the reason is the same one that made **by question** the
 * default in the admin run-detail view: grouped by judge, a question that three judges flagged is
 * printed three times, pages apart, with nothing tying the three verdicts together — and a printed
 * document has no toggle to fix that. Grouped by target, the strongest signal in a run (several
 * judges converging on one question) is the thing the layout makes obvious.
 */
export interface PackEvaluationTarget {
  /** `target.key` when resolved, else the raw `targetKey`; `gap:new-questions` for drafted questions. */
  key: string;
  /** Short positional chip — "Q3 · Background", "Section 2", "Goal"; `null` when there is none. */
  context: string | null;
  /** The question prompt / section title / "Questionnaire goal" — the subject, printed once. */
  label: string;
  /** The answer type for a question target; `null` otherwise (and for gap groups). */
  questionType: string | null;
  /**
   * Who is actually asked this question, in the product's words — "Always asked", "Asked when it
   * fits", "Never asked — in no topic". `null` whenever Conditional Topics is off for the version,
   * so a questionnaire that does not route says nothing about routing.
   *
   * This is the one line that connects the pack's two opt-in appendices. Without it the document
   * describes a routing design in one section and critiques questions in another, and a reader
   * weighing "delete this question" cannot see that only some respondents are ever asked it. The
   * console has carried it on the finding card for exactly that reason.
   */
  routingReach: string | null;
  /** The owning topic(s), joined. `null` exactly when {@link routingReach} is. */
  topicLabel: string | null;
  /** What the panel wants done, and whether it agreed — see {@link PackEvaluationVerdict}. */
  verdict: PackEvaluationVerdict | null;
  /** Drafted new questions rather than judgements about something that exists — see `group-findings`. */
  gap: boolean;
  /** The target is gone from the live structure (named from the run's snapshot). */
  removed: boolean;
  /** Severity tallies across the judges below — the "how contested is this" number. */
  counts: SeverityCounts;
  /**
   * Every verdict on this target, in `(dimension, ordinal)` order — one entry per *finding*, so a
   * judge that raised two points about the same question appears twice. Render them all; count
   * judges with `judgeCount`, never with `judges.length`.
   */
  judges: PackEvaluationJudgeView[];
  /**
   * How many *distinct* judges flagged this target — the "how contested is this" headline.
   *
   * Separate from `judges.length` because that is a finding count: one judge raising two points is
   * one perspective, and printing "3 judge(s)" over two judges overstates the consensus a reader
   * is being asked to act on. Same distinction `selectContestedTargets` draws before it decides a
   * question is worth reconciling at all.
   */
  judgeCount: number;
  /**
   * Alternative phrasings that try to satisfy every judge above at once — the reconcile step that
   * runs after the panel. Empty when the question was flagged by only one judge (there is nothing
   * to reconcile), when the reconcile call failed, or when the run predates the step: in each case
   * the judges' own suggestions above stand alone, exactly as they did before.
   */
  alternatives: PackEvaluationAlternative[];
  /**
   * Concerns no proposed phrasing resolves, by judge label — nearly always because the fix is
   * structural (split the question, change its answer type) rather than a matter of wording.
   * Printed, not swallowed: an alternative that silently drops a judge's point reads as consensus.
   */
  unresolvedBy: string[];
}

/** One reconciled phrasing, resolved for the pack — judge labels, not dimension keys. */
export interface PackEvaluationAlternative {
  /** The rewritten question, ready to drop into the structure. */
  prompt: string;
  /** The judges this phrasing satisfies, by display name. */
  addresses: string[];
  /** Why this wording, or what it trades away. */
  note: string;
}

/** One judge's scoreboard line — the score without its findings, which live under the targets. */
export interface PackEvaluationScore {
  dimension: EvaluationDimension;
  label: string;
  /** Score in [0, 1]; `null` when the judge failed (see `diagnostic`). */
  score: number | null;
  diagnostic: string | null;
  /** How many findings this judge contributed across all targets. */
  findingCount: number;
}

/** The design-evaluation appendix — the latest run for this version, if one has ever been made. */
export interface PackEvaluations {
  /** `false` when the version has never been evaluated — every other field is then empty/null. */
  hasRun: boolean;
  /** ISO timestamp the run finished (or started, if still incomplete); `null` when `!hasRun`. */
  runAt: string | null;
  totalFindings: number;
  /** All seven judges' scores, in `EVALUATION_DIMENSIONS` order; `[]` when `!hasRun`. */
  scores: PackEvaluationScore[];
  /** One entry per flagged subject, in questionnaire order; `[]` when `!hasRun` or nothing flagged. */
  targets: PackEvaluationTarget[];
}

/**
 * One topic, resolved for the pack's plain-language Conditional topics section — a stakeholder reading
 * this has never seen `TopicPhase` or `TopicDepth` and shouldn't need to.
 */
export interface PackConditionalTopicsTopic {
  key: string;
  label: string;
  description: string | null;
  /**
   * `true` for `opening` / `core` / `closing` — always run, never chosen between. `false` for
   * `conditional`, the only phase the planner ever selects among.
   */
  alwaysAsked: boolean;
  /** The admin's own plain-English criteria for a conditional topic; `null` on an always-asked one
   *  (there is nothing to decide). */
  criteria: string | null;
  /** `true` when only the topic's highest-weight members are ever asked, not the whole thing. */
  sampledOnly: boolean;
  /**
   * The questions this topic actually covers, resolved against the version graph.
   *
   * Behind `include.conditionalTopicsMembers`, and empty when it is off. Without it the pack lists
   * topics in one section and questions in another with nothing tying them, and a reader cannot
   * answer the obvious question: if this area is not selected for me, what am I not asked?
   *
   * A key that no longer resolves keeps the raw key rather than being dropped — the same choice the
   * hard rules make, so a stale membership stays visible as something to clean up.
   */
  questions: { key: string; prompt: string }[];
  /**
   * What the source document asked to be watched for DURING the conversation, when it wanted this
   * topic added on something said rather than on how the opening went.
   *
   * Recorded, not acted on: the topic is still selected by its `criteria` above, exactly as every
   * other one is. Printed because the alternative is a document that shows the approximation as
   * though it were the intent — the gap is recorded on the topic precisely so a reviewer sees it.
   */
  trigger: { condition: string; cues: string[] } | null;
}

/**
 * One hard rule, rendered as a plain sentence — e.g. `Always include "Team & culture" when
 * "employee count" is greater than "50".` — rather than the operator/action enum a stakeholder was
 * never meant to learn.
 */
export interface PackConditionalTopicsRule {
  sentence: string;
}

/**
 * What ONE scope judge said about ONE flagged topic/rule/settings target — the scope-evaluation
 * sibling of {@link PackEvaluationJudgeView}.
 */
export interface PackScopeEvaluationJudgeView {
  dimension: ScopeEvaluationDimension;
  /** The judge's display name ("Criteria-Quality Judge"), so a reader needn't know the slug. */
  label: string;
  severity: FindingSeverity;
  status: FindingReviewStatus;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  /** Plain-English rendering of the structured edit this finding proposes; `null` when prose-only. */
  proposedEditSummary: string | null;
}

/**
 * One flagged scope target — a topic, a rule, or the settings as a whole — with every judge's
 * view of it gathered underneath. The scope-evaluation sibling of {@link PackEvaluationTarget};
 * simpler, because the panel has no reconcile step (see `run-panel.ts`'s module doc) so there is
 * no `alternatives`/`unresolvedBy` to carry.
 */
export interface PackScopeEvaluationTarget {
  /** `topic:<key>` / `rule:<id>` / `settings`, resolved when possible, else the raw `targetKey`. */
  key: string;
  kind: ScopeFindingTargetKind;
  /** The topic's label, the rule's rendered sentence, or "Conditional topics settings". */
  label: string;
  /** The target is gone from the live structure (named from the run's snapshot). */
  removed: boolean;
  counts: ScopeSeverityCounts;
  /** Every verdict on this target, in `(dimension, ordinal)` order. */
  judges: PackScopeEvaluationJudgeView[];
}

/** One scope judge's scoreboard line — the score without its findings, which live under the targets. */
export interface PackScopeEvaluationScore {
  dimension: ScopeEvaluationDimension;
  label: string;
  /** Score in [0, 1]; `null` when the judge failed (see `diagnostic`). */
  score: number | null;
  diagnostic: string | null;
  /** How many findings this judge contributed across all targets. */
  findingCount: number;
}

/**
 * The scope-evaluation appendix — the latest F17.21 run for this version, if one has ever been
 * made. Nested under {@link PackConditionalTopics} (not a sibling pack section) because it is a
 * judgement ABOUT the routing design directly above it, not a separate subject — see the module
 * doc's "extends the existing `conditionalTopics` section" note.
 */
export interface PackScopeEvaluation {
  /** `false` when the version has never been scope-evaluated — every other field is empty/null. */
  hasRun: boolean;
  /** ISO timestamp the run finished (or started, if still incomplete); `null` when `!hasRun`. */
  runAt: string | null;
  totalFindings: number;
  /** All four judges' scores, in `SCOPE_EVALUATION_DIMENSIONS` order; `[]` when `!hasRun`. */
  scores: PackScopeEvaluationScore[];
  /** One entry per flagged topic/rule/settings, settings-then-topics-then-rules order. */
  targets: PackScopeEvaluationTarget[];
}

/**
 * The Conditional topics appendix — the routing logic in plain language. `enabled: false` still renders
 * (it is informative in its own right: every respondent gets the full instrument), the same "state
 * a fact rather than omit the section" choice `PackEvaluations.hasRun` makes.
 */
export interface PackConditionalTopics {
  /** Whether this version has Conditional topics switched on at all. */
  enabled: boolean;
  /** Opening / core / closing topics, in authored order. */
  alwaysAsked: PackConditionalTopicsTopic[];
  /** Conditional topics, in authored order. */
  conditional: PackConditionalTopicsTopic[];
  rules: PackConditionalTopicsRule[];
  /**
   * Every routing setting, presented — derived from `ROUTING_SETTING_DESCRIPTORS`, not hand-listed.
   *
   * The section used to name four of the fifteen fields on `ConditionalTopicsSettings`, missing
   * (among others) whether the respondent is told which areas were chosen and whether they may ask
   * for one that was not: two facts about what the respondent EXPERIENCES, absent from the section
   * whose whole subject is how the questionnaire adapts to them. Same registry pattern and same
   * reasoning as the experience-setup summary, which was written after the same bug.
   */
  settings: RoutingSettingItem[];
  /**
   * The F17.21 judge panel's verdict on this routing design — see {@link PackScopeEvaluation}.
   *
   * **`null` means the admin excluded it**, and every serialiser skips the subsection entirely,
   * exactly as they skip a `null` top-level section. It must NOT be conflated with
   * `hasRun: false`, which means "this routing has never been reviewed" — a sentence the pack
   * prints in so many words. Emitting the excluded case as `hasRun: false` would have a
   * client-facing document assert that a reviewed routing was never looked at.
   */
  evaluation: PackScopeEvaluation | null;
}

/** One policy judge's verdict on one target, for the pack. */
export interface PackPolicyEvaluationJudgeView {
  dimension: PolicyEvaluationDimension;
  /** The judge's display name, so a reader needn't know the slug. */
  label: string;
  severity: FindingSeverity;
  status: FindingReviewStatus;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  /** Plain-English rendering of the structured edit; `null` when prose-only. */
  proposedEditSummary: string | null;
}

/** One flagged policy target with every judge's view of it gathered underneath. */
export interface PackPolicyEvaluationTarget {
  key: string;
  kind: PolicyFindingTargetKind;
  /** The rule's text, the question's prompt (prefixed "Fidelity — "), or the block's name. */
  label: string;
  removed: boolean;
  counts: PolicySeverityCounts;
  judges: PackPolicyEvaluationJudgeView[];
}

/** One policy judge's scoreboard line. */
export interface PackPolicyEvaluationScore {
  dimension: PolicyEvaluationDimension;
  label: string;
  score: number | null;
  diagnostic: string | null;
  findingCount: number;
}

/** The policy-evaluation appendix — the latest F18.8 run, if one has ever been made. */
export interface PackPolicyEvaluation {
  hasRun: boolean;
  runAt: string | null;
  totalFindings: number;
  scores: PackPolicyEvaluationScore[];
  targets: PackPolicyEvaluationTarget[];
}

/** One house rule, for the pack. */
export interface PackHouseRule {
  kind: string;
  /** What the interviewer must do, never do, or say. */
  text: string;
  /** What the respondent asks about, for an if-asked rule; `null` otherwise. */
  trigger: string | null;
}

/**
 * The interviewer-policy appendix — how this questionnaire's interviewer is set up, in plain
 * language, with the judge panel's verdict nested inside it.
 *
 * Duplicates the one-line `setup` rows deliberately, exactly as `PackConditionalTopics` does: the setup
 * row is the summary, this is the appendix.
 */
export interface PackInterviewerPolicy {
  /** False when the questionnaire is filled in as a form — there is no interviewer at all. */
  conversational: boolean;
  houseRulesEnabled: boolean;
  /** Only the rules actually in force. A parked rule is a draft and is not printed. */
  houseRules: PackHouseRule[];
  approachLabel: string;
  /** `null` under Open or Targeted, where the pace is not read. */
  paceLabel: string | null;
  openingSource: string;
  tacticLabels: string[];
  /**
   * The arc's bands, derived from the SAME `FUNNEL_PACE_PROFILES` the runtime reads — the
   * `FunnelArcExplainer` trick applied to the pack. A hard-coded table that drifted would be worse
   * than none, because the reader has no reason to doubt it. Empty when no funnel is running.
   */
  arcBands: { label: string; detail: string }[];
  fidelityEnabled: boolean;
  /** Counts per level over every question; empty when the gate is off. */
  fidelityDistribution: { level: string; label: string; count: number }[];
  /** The questions held to their exact wording. */
  mustAskQuestions: { key: string; prompt: string }[];
  evaluation: PackPolicyEvaluation;
}

/** The full Questionnaire Pack model the serialisers render. */
export interface PackModel {
  title: string;
  versionNumber: number;
  generatedAt: string;
  include: PackInclude;
  meta: { goal: string | null; audienceSummary: string | null } | null;
  sections: InstrumentSection[] | null;
  sectionCount: number;
  questionCount: number;
  dataSlots: PackDataSlot[] | null;
  glossary: GlossaryAppendixView | null;
  setup: PackSetupItem[] | null;
  evaluations: PackEvaluations | null;
  conditionalTopics: PackConditionalTopics | null;
  interviewerPolicy: PackInterviewerPolicy | null;
}

/** Resolve a data slot's `questionKeys` to `{ key, prompt }` pairs against a pre-built prompt map. */
function resolveDataSlotQuestions(
  prompts: Map<string, string>,
  questionKeys: string[]
): { key: string; prompt: string }[] {
  return questionKeys.map((key) => ({ key, prompt: prompts.get(key) ?? key }));
}

/** Build a `key -> prompt` lookup once for every question in the graph, shared across all data slots. */
function buildQuestionPromptMap(graph: VersionGraphView): Map<string, string> {
  const prompts = new Map<string, string>();
  for (const section of graph.sections) {
    for (const q of section.questions) prompts.set(q.key, q.prompt);
  }
  return prompts;
}

/**
 * Build the evaluation appendix from the latest run for this version. `run` is `null` when the
 * version has never been evaluated — the caller (the route) doesn't distinguish "no run" from
 * "excluded"; that's `buildPackModel`'s job via `include.evaluations`. Deliberately carries every
 * finding regardless of `status` (`pending` included) — the appendix is a record of what the panel
 * said, not a curated review outcome.
 *
 * Two shapes come out, and the split is the point: `scores` is the per-judge scoreboard (how each
 * dimension rated the version) and `targets` is the work (what was said, gathered under the thing it
 * was said about). Findings appear ONLY under `targets`, so a question flagged by four judges is
 * printed once with four verdicts beneath it, not four times across four judge sections.
 *
 * Each target also carries the run's reconciled `alternatives` for that question — the phrasings the
 * post-panel reconcile step proposed to satisfy several judges at once — with dimension keys mapped
 * to judge labels, because a pack is read by people who never learn the enum. A target with one
 * judge, a failed reconcile call, or a run older than the step simply carries none.
 *
 * Grouping is `groupFindingsByTarget` — the same pure function behind the admin run-detail view's
 * default "By question" mode, in questionnaire order. Sharing it is deliberate: the pack and the
 * console must not disagree about what counts as one subject (drafted questions splitting into
 * their own gap group is exactly the kind of rule that would drift if written twice).
 */
/**
 * Who is asked this target's question, in the product's vocabulary rather than the code's.
 *
 * The same three phrasings the console's finding card uses. "Never asked" is the case with no topic
 * to name and the one a reader most needs: a question in no topic is one nobody will ever see, and
 * a judge's opinion of its wording is beside the point until that is fixed.
 *
 * `null` when Conditional Topics is off (the resolver leaves `routingReach` null), so a
 * questionnaire that does not route says nothing about routing.
 */
function routingReachOf(findings: readonly EvaluationFindingView[]): string | null {
  const target = findings[0]?.target;
  if (!target?.routingReach) return null;
  switch (target.routingReach) {
    case 'always':
      return 'Always asked';
    case 'conditional':
      return 'Asked when it fits';
    case 'never':
      return 'Never asked — in no topic';
    default:
      return null;
  }
}

/**
 * The panel's verdict on one target, fully resolved for printing.
 *
 * `summariseGroupActions` is the console's own function, deliberately: a pack that reached a
 * different verdict from the screen would be worse than one that reached none. What is added here
 * is only the phrasing — the heading noun, the backing, the judge names, and which block the
 * reconciled wordings belong under — so a serialiser writes strings and makes no judgements.
 */
function buildVerdict(group: FindingGroup): PackEvaluationVerdict | null {
  const summary = summariseGroupActions(group);
  if (!summary.primary) return null;

  const actions = [summary.primary, ...summary.others];
  const host = wordingHost(actions);
  return {
    contested: summary.contested,
    blocks: actions.map((action) => ({
      heading: ACTION_NOUNS[action.kind],
      backing: backing(action, summary.judgeCount),
      judges: judgeNames(action.judges),
      holdsWording: action === host,
      // Deduplicated: two judges proposing the same action often word it identically, and printing
      // the same sentence twice under one heading reads as two separate points.
      suggestions: [...new Set(action.findings.map((f) => f.proposedChange.trim()))],
    })),
  };
}

function buildEvaluationsSection(run: EvaluationRunDetail | null): PackEvaluations {
  if (!run) return { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] };

  const scores: PackEvaluationScore[] = EVALUATION_DIMENSIONS.map((dimension) => {
    const summary = run.dimensionSummary.find((s) => s.dimension === dimension) ?? null;
    return {
      dimension,
      label: EVALUATION_DIMENSION_SPECS[dimension].label,
      score: summary?.score ?? null,
      diagnostic: summary?.diagnostic ?? null,
      findingCount: run.findings.filter((f) => f.dimension === dimension).length,
    };
  });

  // Reconciled alternatives are addressed at a target key; index once rather than scanning per group.
  const reconciledByKey = new Map(run.reconciled.map((r) => [r.targetKey, r]));
  const judgeLabel = (dimension: EvaluationDimension): string =>
    EVALUATION_DIMENSION_SPECS[dimension].label;

  const targets: PackEvaluationTarget[] = groupFindingsByTarget(run.findings, 'natural').map(
    (group) => ({
      key: group.key,
      context: groupContextLabel(group),
      label: group.label,
      questionType: group.questionType,
      // Off the group's own findings, which all address the same target and so all carry the same
      // resolved reach. A gap group is the exception: its findings target `goal` and describe
      // questions that do not exist yet, so there is no reach to report.
      routingReach: group.gap ? null : routingReachOf(group.findings),
      topicLabel: group.gap ? null : (group.findings[0]?.target?.topicLabel ?? null),
      verdict: buildVerdict(group),
      gap: group.gap,
      removed: group.removed,
      counts: group.counts,
      judgeCount: group.dimensions.length,
      judges: group.findings.map((f) => {
        // The shared `effectiveOp`, not an inline re-implementation of the same rule. Its whole
        // reason for being exported is that the reviewer-facing verb and the op that actually runs
        // must not be able to diverge — and this file's premise is single-sourcing exactly that.
        const op = effectiveOp(f);
        return {
          dimension: f.dimension,
          label: judgeLabel(f.dimension),
          severity: f.severity,
          status: f.status,
          proposedChange: f.proposedChange,
          rationale: f.rationale,
          sourceQuote: f.sourceQuote,
          // The EFFECTIVE op, as at apply — an admin-edited override wins over the judge's draft,
          // so a pack describing the judge's version would describe a change that will not happen.
          proposedEditSummary: op ? describeProposedEdit(op, f.destination) : null,
          destination: f.destination
            ? destinationSentence(f.destination, f.status === 'applied' || f.status === 'declined')
            : null,
          applyInstruction: f.applyInstruction,
        };
      }),
      alternatives: (reconciledByKey.get(group.key)?.alternatives ?? []).map((alt) => ({
        prompt: alt.prompt,
        addresses: alt.addresses.map(judgeLabel),
        note: alt.note,
      })),
      unresolvedBy: (reconciledByKey.get(group.key)?.unresolved ?? []).map(judgeLabel),
    })
  );

  return {
    hasRun: true,
    runAt: run.completedAt ?? run.startedAt,
    totalFindings: run.totalFindings,
    scores,
    targets,
  };
}

/**
 * Build the scope-evaluation appendix from the latest F17.21 run for this version. `run` is
 * `null` when the version has never been scope-evaluated. Mirrors `buildEvaluationsSection`'s
 * shape split (`scores` vs `targets`) without a reconcile step: the panel has none (see
 * `run-panel.ts`'s module doc), so every finding renders where the judge put it, with no
 * alternatives to fold in.
 *
 * Grouping is `groupScopeFindingsByTarget`, the same pure function the admin run-detail view uses
 * — the pack and the console must not disagree about what counts as one target.
 */
function buildScopeEvaluationSection(run: ScopeEvaluationRunDetail | null): PackScopeEvaluation {
  if (!run) return { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] };

  const scores: PackScopeEvaluationScore[] = SCOPE_EVALUATION_DIMENSIONS.map((dimension) => {
    const summary = run.dimensionSummary.find((s) => s.dimension === dimension) ?? null;
    return {
      dimension,
      label: SCOPE_EVALUATION_DIMENSION_SPECS[dimension].label,
      score: summary?.score ?? null,
      diagnostic: summary?.diagnostic ?? null,
      findingCount: run.findings.filter((f) => f.dimension === dimension).length,
    };
  });

  const targets: PackScopeEvaluationTarget[] = groupScopeFindingsByTarget(
    run.findings,
    'natural'
  ).map((group) => ({
    key: group.key,
    kind: group.kind,
    label: group.label,
    removed: group.removed,
    counts: group.counts,
    judges: group.findings.map((f) => {
      const op = f.editedOverride ?? f.proposedEdit;
      return {
        dimension: f.dimension,
        label: SCOPE_EVALUATION_DIMENSION_SPECS[f.dimension].label,
        severity: f.severity,
        status: f.status,
        proposedChange: f.proposedChange,
        rationale: f.rationale,
        sourceQuote: f.sourceQuote,
        proposedEditSummary: op ? describeScopeProposedEdit(op) : null,
      };
    }),
  }));

  return {
    hasRun: true,
    runAt: run.completedAt ?? run.startedAt,
    totalFindings: run.totalFindings,
    scores,
    targets,
  };
}

/**
 * Build the Conditional topics appendix from the version's topics and settings — the routing logic
 * explained in plain language, for a stakeholder who has never seen the authoring surface.
 *
 * Topics split into `alwaysAsked` / `conditionalTopics` up front rather than carrying a raw
 * `phase` for the serialisers to branch on: every serialiser wants exactly this grouping ("what
 * everyone gets" vs "what depends"), and deriving it three times would be the same drift risk the
 * settings registry exists to avoid elsewhere in this file.
 */
function buildConditionalTopicsSection(
  topics: Topic[],
  settings: ConditionalTopicsSettings,
  dataSlots: DataSlotView[],
  scopeEvaluationRun: ScopeEvaluationRunDetail | null,
  questionPrompts: Map<string, string>,
  include: PackInclude
): PackConditionalTopics {
  const topicLabels = new Map(topics.map((topic) => [topic.key, topic.label]));
  const dataSlotLabels = new Map(dataSlots.map((slot) => [slot.key, slot.name]));
  const alwaysAskedPhases = ALWAYS_PHASES as readonly string[];
  // Falls back to the raw key so a setting or membership naming a since-deleted topic stays
  // visible as something to clean up, rather than silently vanishing from the document.
  const topicLabel = (key: string): string => topicLabels.get(key) ?? key;

  const alwaysAsked: PackConditionalTopicsTopic[] = [];
  const conditional: PackConditionalTopicsTopic[] = [];
  for (const topic of topics) {
    const isAlwaysAsked = alwaysAskedPhases.includes(topic.phase);
    const row: PackConditionalTopicsTopic = {
      key: topic.key,
      label: topic.label,
      description: topic.description,
      alwaysAsked: isAlwaysAsked,
      criteria: isAlwaysAsked ? null : topic.criteria,
      sampledOnly: topic.depth === 'light',
      questions: include.conditionalTopicsMembers
        ? resolveDataSlotQuestions(questionPrompts, topic.members.questionKeys)
        : [],
      trigger: topic.trigger
        ? {
            // Trimmed of a trailing full stop: the serialisers continue the sentence ("... Today
            // it is decided from the opening instead"), and an authored condition that already
            // ends in one otherwise renders as "a grievance.. Today".
            condition: topic.trigger.condition.trim().replace(/\.$/, ''),
            cues: topic.trigger.cues,
          }
        : null,
    };
    (isAlwaysAsked ? alwaysAsked : conditional).push(row);
  }

  return {
    enabled: settings.enabled,
    alwaysAsked,
    conditional,
    rules: settings.rules.map((rule) => ({
      sentence: describeScopeRule(rule, topicLabels, dataSlotLabels),
    })),
    settings: buildRoutingSettingRows(settings, topicLabel, include.conditionalTopicsTechnical),
    // `null` when excluded, never `hasRun: false` — the serialisers render the latter as the
    // sentence "This routing has not been reviewed", which about a version whose routing WAS
    // reviewed is simply false. `null` is how every other excluded part of the model is expressed.
    evaluation: include.conditionalTopicsEvaluation
      ? buildScopeEvaluationSection(scopeEvaluationRun)
      : null,
  };
}

/**
 * The routing data behind the Conditional topics section — loaded by the route only when
 * `include.conditionalTopics` is set (the same "skip the query when the section is excluded" pattern
 * `evaluationRun` already uses), so the common download pays no extra cost for a section that
 * defaults off. `scopeEvaluationRun` is `null` both when the section is excluded and when the
 * version has never been scope-evaluated — `buildScopeEvaluationSection` folds both into
 * `hasRun: false`.
 */
export interface PackConditionalTopicsSource {
  topics: Topic[];
  settings: ConditionalTopicsSettings;
  scopeEvaluationRun: ScopeEvaluationRunDetail | null;
}

/** Assemble the Questionnaire Pack model. Pure. */

/** The policy-evaluation appendix — the latest run, or a stated absence. */
function buildPolicyEvaluationSection(run: PolicyEvaluationRunDetail | null): PackPolicyEvaluation {
  if (!run) return { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] };

  const scores: PackPolicyEvaluationScore[] = POLICY_EVALUATION_DIMENSIONS.map((dimension) => {
    const summary = run.dimensionSummary.find((sm) => sm.dimension === dimension) ?? null;
    return {
      dimension,
      label: POLICY_EVALUATION_DIMENSION_SPECS[dimension].label,
      score: summary?.score ?? null,
      diagnostic: summary?.diagnostic ?? null,
      findingCount: run.findings.filter((f) => f.dimension === dimension).length,
    };
  });

  // The SAME pure grouping the admin run-detail view uses, so the console and the pack can never
  // disagree about what counts as one subject.
  const targets: PackPolicyEvaluationTarget[] = groupPolicyFindingsByTarget(
    run.findings,
    'natural'
  ).map((group) => ({
    key: group.key,
    kind: group.kind,
    label: group.label,
    removed: group.removed,
    counts: group.counts,
    judges: group.findings.map((f) => {
      const op = f.editedOverride ?? f.proposedEdit;
      return {
        dimension: f.dimension,
        label: POLICY_EVALUATION_DIMENSION_SPECS[f.dimension].label,
        severity: f.severity,
        status: f.status,
        proposedChange: f.proposedChange,
        rationale: f.rationale,
        sourceQuote: f.sourceQuote,
        proposedEditSummary: op ? describePolicyProposedEdit(op) : null,
      };
    }),
  }));

  return {
    hasRun: true,
    runAt: run.completedAt ?? run.startedAt,
    totalFindings: run.totalFindings,
    scores,
    targets,
  };
}

const POLICY_APPROACH_LABELS: Record<string, string> = {
  funnel: 'Funnel — open questions first, narrowing to specifics',
  open: 'Open throughout',
  targeted: 'Targeted from the first question',
};

const POLICY_PACE_LABELS: Record<string, string> = {
  gradual: 'Stay open longer',
  balanced: 'Balanced',
  brisk: 'Narrow quickly',
};

const POLICY_RULE_KIND_LABELS: Record<string, string> = {
  always: 'Always',
  never: 'Never',
  if_asked: 'If asked',
};

/**
 * The interviewer-policy appendix — how this questionnaire's interviewer is set up, in plain
 * language, with the judge panel's verdict nested inside it.
 */
function buildInterviewerPolicySection(
  graph: VersionGraphView,
  run: PolicyEvaluationRunDetail | null
): PackInterviewerPolicy {
  const config = graph.config;
  const strategy = config.interviewerStrategy;
  const questions = graph.sections.flatMap((section) => section.questions);
  const gateOn = config.questionFidelity.enabled;

  const levelCounts = new Map<QuestionFidelityLevel, number>();
  const mustAskQuestions: { key: string; prompt: string }[] = [];
  for (const q of questions) {
    const level = resolveQuestionFidelity(q.fidelity, config.questionFidelity);
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
    if (level === 'must_ask') mustAskQuestions.push({ key: q.key, prompt: q.prompt });
  }

  // Derived from the same FUNNEL_PACE_PROFILES the runtime reads, never hard-coded — a table that
  // drifted would be worse than none, because a reader has no reason to doubt it.
  const profile = paceProfile(strategy);
  const arcBands =
    strategy.enabled && strategy.approach === 'funnel'
      ? [
          {
            label: 'Opening',
            detail: `The first ${profile.openingWindow} question${profile.openingWindow === 1 ? '' : 's'} are broad and unhurried`,
          },
          {
            label: 'Broad',
            detail: `While less than ${Math.round(profile.openBelow * 100)}% of the questionnaire is covered`,
          },
          {
            label: 'Specific',
            detail: `Once more than ${Math.round(profile.targetedAbove * 100)}% is covered`,
          },
        ]
      : [];

  const tacticLabels = [
    strategy.probeDepth && 'Probes shallow answers',
    strategy.reflect && 'Reflects answers back',
    strategy.batchRelated && 'Invites related gaps together',
  ].filter((t): t is string => typeof t === 'string');

  return {
    conversational: config.presentationMode !== 'form',
    houseRulesEnabled: config.houseRules.enabled,
    // Only the rules actually in force — a parked rule is a draft, not policy.
    houseRules: config.houseRules.enabled
      ? config.houseRules.rules
          .filter((r) => r.enabled && r.text.trim() !== '')
          .map((r) => ({
            kind: POLICY_RULE_KIND_LABELS[r.kind] ?? r.kind,
            text: r.text,
            trigger: r.trigger ?? null,
          }))
      : [],
    approachLabel: strategy.enabled
      ? (POLICY_APPROACH_LABELS[strategy.approach] ?? strategy.approach)
      : 'Default',
    // The pace is read for the funnel only, so naming one elsewhere would describe an arc that is
    // not running.
    paceLabel:
      strategy.enabled && strategy.approach === 'funnel'
        ? (POLICY_PACE_LABELS[strategy.pace] ?? strategy.pace)
        : null,
    openingSource:
      strategy.enabled && strategy.openingMode === 'examples'
        ? 'Guided by the examples you wrote'
        : "The interviewer's own framings",
    tacticLabels,
    arcBands,
    fidelityEnabled: gateOn,
    fidelityDistribution: gateOn
      ? QUESTION_FIDELITY_LEVELS.map((level) => ({
          level,
          label: QUESTION_FIDELITY_LABELS[level],
          count: levelCounts.get(level) ?? 0,
        }))
      : [],
    mustAskQuestions: gateOn ? mustAskQuestions : [],
    evaluation: buildPolicyEvaluationSection(run),
  };
}

export function buildPackModel(
  title: string,
  graph: VersionGraphView,
  dataSlots: DataSlotView[],
  glossary: GlossaryAppendixView | null,
  evaluationRun: EvaluationRunDetail | null,
  conditionalTopicsSource: PackConditionalTopicsSource | null,
  policyEvaluationRun: PolicyEvaluationRunDetail | null,
  include: PackInclude,
  generatedAt: string
): PackModel {
  // Reuse the instrument builder for the question-structure fields — a single place derives
  // goal/audience/section/question flattening so the two exports can never render it differently.
  const instrument = buildInstrumentModel(title, graph, generatedAt, null);
  // Built once and shared across every data slot below — walking the graph per-slot was O(N·M)
  // for N data slots and M total questions.
  const questionPrompts = buildQuestionPromptMap(graph);

  return {
    title,
    versionNumber: graph.versionNumber,
    generatedAt,
    include,
    meta: include.meta
      ? { goal: instrument.goal, audienceSummary: instrument.audienceSummary }
      : null,
    sections: include.questions ? instrument.sections : null,
    sectionCount: instrument.sectionCount,
    questionCount: instrument.questionCount,
    dataSlots: include.dataSlots
      ? dataSlots.map((slot) => ({
          key: slot.key,
          name: slot.name,
          description: slot.description,
          theme: slot.theme,
          weight: slot.weight,
          questions: resolveDataSlotQuestions(questionPrompts, slot.questionKeys),
        }))
      : null,
    glossary: include.definitions ? glossary : null,
    setup: include.setup ? buildSettingRows(graph.config, include.setupTechnical) : null,
    evaluations: include.evaluations ? buildEvaluationsSection(evaluationRun) : null,
    interviewerPolicy: include.interviewerPolicy
      ? buildInterviewerPolicySection(graph, policyEvaluationRun)
      : null,
    conditionalTopics:
      include.conditionalTopics && conditionalTopicsSource
        ? buildConditionalTopicsSection(
            conditionalTopicsSource.topics,
            conditionalTopicsSource.settings,
            dataSlots,
            conditionalTopicsSource.scopeEvaluationRun,
            questionPrompts,
            include
          )
        : null,
  };
}
