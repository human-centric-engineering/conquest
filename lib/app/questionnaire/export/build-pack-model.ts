/**
 * Questionnaire Pack export model.
 *
 * Flattens a {@link VersionGraphView} (plus its data slots, glossary appendix, and latest design
 * evaluation run) into a presentation-ready {@link PackModel} — a branded, shareable artifact that
 * covers everything about how the questionnaire is set up: title/version/goals, the question
 * structure, the semantic data slots (with their linked questions), the definitions/glossary, the
 * experience-setup summary, (opt-in) the F5.1–F5.3 judge panel's findings for this version, and
 * (opt-in) the Adaptive Scope routing logic in plain language. The admin picks which of those seven
 * sections to include via {@link PackInclude}; excluded sections are `null` on the model so every
 * serialiser (PDF/CSV/Markdown) skips them the same way.
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

import type { GlossaryAppendixView } from '@/lib/app/questionnaire/glossary/types';
import type { EvaluationRunDetail, VersionGraphView } from '@/lib/app/questionnaire/views';
import { buildSettingRows, type PackSetupItem } from '@/lib/app/questionnaire/settings-registry';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
import {
  ALWAYS_PHASES,
  SCOPE_RULE_ACTION_LABELS,
  SCOPE_RULE_OPERATOR_LABELS,
  VALUELESS_SCOPE_OPERATORS,
  type AdaptiveScopeSettings,
  type ScopeRule,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
  type FindingReviewStatus,
  type FindingSeverity,
} from '@/lib/app/questionnaire/evaluation';
import {
  groupContextLabel,
  groupFindingsByTarget,
  type SeverityCounts,
} from '@/lib/app/questionnaire/evaluation/group-findings';
import {
  buildInstrumentModel,
  type InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

/**
 * Which of the pack's seven sections to include, plus the one sub-option (`setupTechnical`). All
 * default `true` except `evaluations`, `adaptiveScope`, and `setupTechnical`.
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
   * The routing logic — which topics are always asked, which are conditional (and on what
   * criteria), and the hard rules — explained in plain language for a stakeholder audience. Defaults
   * `false`, like `evaluations`: it is the routing *design*, not the questionnaire content, and not
   * every reader of the pack needs (or should see) how a client's instrument routes respondents
   * before the admin has decided to share that. See {@link file://./build-pack-model.ts}'s
   * `buildAdaptiveScopeSection`.
   */
  adaptiveScope: boolean;
}

/**
 * The export dialog's default checkbox state — every section except `evaluations` and
 * `adaptiveScope`, and the standard settings tier only.
 */
export const DEFAULT_PACK_INCLUDE: PackInclude = {
  meta: true,
  questions: true,
  dataSlots: true,
  definitions: true,
  setup: true,
  setupTechnical: false,
  evaluations: false,
  adaptiveScope: false,
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
 * One topic, resolved for the pack's plain-language Adaptive scope section — a stakeholder reading
 * this has never seen `TopicPhase` or `TopicDepth` and shouldn't need to.
 */
export interface PackAdaptiveScopeTopic {
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
}

/**
 * One hard rule, rendered as a plain sentence — e.g. `Always include "Team & culture" when
 * "employee count" is greater than "50".` — rather than the operator/action enum a stakeholder was
 * never meant to learn.
 */
export interface PackAdaptiveScopeRule {
  sentence: string;
}

/**
 * The Adaptive scope appendix — the routing logic in plain language. `enabled: false` still renders
 * (it is informative in its own right: every respondent gets the full instrument), the same "state
 * a fact rather than omit the section" choice `PackEvaluations.hasRun` makes.
 */
export interface PackAdaptiveScope {
  /** Whether this version has Adaptive scope switched on at all. */
  enabled: boolean;
  /** Opening / core / closing topics, in authored order. */
  alwaysAskedTopics: PackAdaptiveScopeTopic[];
  /** Conditional topics, in authored order. */
  conditionalTopics: PackAdaptiveScopeTopic[];
  rules: PackAdaptiveScopeRule[];
  /** How many conditional topics one interview may cover at most. */
  maxConditionalTopics: number;
  /** Whether one additional, unselected topic is sampled lightly to check for blind spots. */
  includeCheckTopic: boolean;
  /** Seconds; `0` means no time limit was set. */
  sessionBudgetSeconds: number;
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
  adaptiveScope: PackAdaptiveScope | null;
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
      gap: group.gap,
      removed: group.removed,
      counts: group.counts,
      judgeCount: group.dimensions.length,
      judges: group.findings.map((f) => ({
        dimension: f.dimension,
        label: judgeLabel(f.dimension),
        severity: f.severity,
        status: f.status,
        proposedChange: f.proposedChange,
        rationale: f.rationale,
        sourceQuote: f.sourceQuote,
      })),
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
 * Render one hard rule as a plain sentence, resolving its topic/data-slot keys to their authored
 * names so a stakeholder never has to read a key. An unresolved key (a rule pointing at a topic or
 * slot since deleted — silently skipped everywhere else in this feature, per
 * `.context/app/questionnaire/adaptive-scope.md`) falls back to the raw key rather than dropping the
 * rule, so a stale rule is still visible as *something* an admin should clean up.
 */
function describeScopeRule(
  rule: ScopeRule,
  topicLabels: Map<string, string>,
  dataSlotLabels: Map<string, string>
): string {
  const topicLabel = topicLabels.get(rule.topicKey) ?? rule.topicKey;
  const slotLabel = dataSlotLabels.get(rule.dataSlotKey) ?? rule.dataSlotKey;
  const operator = SCOPE_RULE_OPERATOR_LABELS[rule.operator];
  const clause = (VALUELESS_SCOPE_OPERATORS as readonly string[]).includes(rule.operator)
    ? `"${slotLabel}" ${operator}`
    : `"${slotLabel}" ${operator} "${rule.value ?? ''}"`;
  const action = SCOPE_RULE_ACTION_LABELS[rule.action];
  const capitalizedAction = action.charAt(0).toUpperCase() + action.slice(1);
  return `${capitalizedAction} "${topicLabel}" when ${clause}.`;
}

/**
 * Build the Adaptive scope appendix from the version's topics and settings — the routing logic
 * explained in plain language, for a stakeholder who has never seen the authoring surface.
 *
 * Topics split into `alwaysAskedTopics` / `conditionalTopics` up front rather than carrying a raw
 * `phase` for the serialisers to branch on: every serialiser wants exactly this grouping ("what
 * everyone gets" vs "what depends"), and deriving it three times would be the same drift risk the
 * settings registry exists to avoid elsewhere in this file.
 */
function buildAdaptiveScopeSection(
  topics: Topic[],
  settings: AdaptiveScopeSettings,
  dataSlots: DataSlotView[]
): PackAdaptiveScope {
  const topicLabels = new Map(topics.map((topic) => [topic.key, topic.label]));
  const dataSlotLabels = new Map(dataSlots.map((slot) => [slot.key, slot.name]));
  const alwaysAskedPhases = ALWAYS_PHASES as readonly string[];

  const alwaysAskedTopics: PackAdaptiveScopeTopic[] = [];
  const conditionalTopics: PackAdaptiveScopeTopic[] = [];
  for (const topic of topics) {
    const alwaysAsked = alwaysAskedPhases.includes(topic.phase);
    const row: PackAdaptiveScopeTopic = {
      key: topic.key,
      label: topic.label,
      description: topic.description,
      alwaysAsked,
      criteria: alwaysAsked ? null : topic.criteria,
      sampledOnly: topic.depth === 'light',
    };
    (alwaysAsked ? alwaysAskedTopics : conditionalTopics).push(row);
  }

  return {
    enabled: settings.enabled,
    alwaysAskedTopics,
    conditionalTopics,
    rules: settings.rules.map((rule) => ({
      sentence: describeScopeRule(rule, topicLabels, dataSlotLabels),
    })),
    maxConditionalTopics: settings.maxConditionalTopics,
    includeCheckTopic: settings.includeCheckTopic,
    sessionBudgetSeconds: settings.sessionBudgetSeconds,
  };
}

/**
 * The routing data behind the Adaptive scope section — loaded by the route only when
 * `include.adaptiveScope` is set (the same "skip the query when the section is excluded" pattern
 * `evaluationRun` already uses), so the common download pays no extra cost for a section that
 * defaults off.
 */
export interface PackAdaptiveScopeSource {
  topics: Topic[];
  settings: AdaptiveScopeSettings;
}

/** Assemble the Questionnaire Pack model. Pure. */
export function buildPackModel(
  title: string,
  graph: VersionGraphView,
  dataSlots: DataSlotView[],
  glossary: GlossaryAppendixView | null,
  evaluationRun: EvaluationRunDetail | null,
  adaptiveScopeSource: PackAdaptiveScopeSource | null,
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
    adaptiveScope:
      include.adaptiveScope && adaptiveScopeSource
        ? buildAdaptiveScopeSection(
            adaptiveScopeSource.topics,
            adaptiveScopeSource.settings,
            dataSlots
          )
        : null,
  };
}
