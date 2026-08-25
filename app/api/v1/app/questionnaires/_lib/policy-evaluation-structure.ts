/**
 * Build the interviewer-policy structure DTO for the judge panel (F18.8).
 *
 * The DB seam: everything Prisma-shaped lives here so `lib/app/questionnaire/policy-evaluation/**`
 * stays pure. Same split as `buildEvaluationStructure` and `buildScopeEvaluationStructure`.
 *
 * **Everything a judge must not re-derive is computed here and handed over:** the resolved pace
 * profile, the satisfaction floor each fidelity level imposes against *this* version's own
 * confidence floor, the complete level distribution, the per-topic must-ask counts, and the
 * mechanical conflict checker's findings *with their stable ids*.
 */

import { prisma } from '@/lib/db/client';
import {
  DEFAULT_QUESTION_FIDELITY_VALUE,
  QUESTION_FIDELITY_LEVELS,
  QUESTION_FIDELITY_STOP_BY_LEVEL,
  TONE_DIMENSION_KEYS,
  questionFidelityLevel,
  resolveQuestionFidelity,
  toDisplayLevel,
  type QuestionFidelityLevel,
} from '@/lib/app/questionnaire/types';
import { paceProfile, usesGuidedOpening } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import { questionSatisfactionFloor } from '@/lib/app/questionnaire/selection/context';
import {
  configConflictInputFromConfig,
  detectConfigConflicts,
} from '@/lib/app/questionnaire/authoring/config-conflicts';
import { MAX_POLICY_EVAL_QUESTIONS } from '@/lib/app/questionnaire/policy-evaluation';
import type {
  PolicyStructureInput,
  PolicyStructureQuestion,
} from '@/lib/app/questionnaire/policy-evaluation';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { loadTopics } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

/** Admin free text is a prompt line, not a document. */
function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

const TONE_LABELS: Record<string, string> = {
  warmth: 'Warmth',
  empathy: 'Empathy',
  humour: 'Humour',
  formality: 'Formality',
  directness: 'Directness',
  curiosity: 'Curiosity',
  encouragement: 'Encouragement',
  verbosity: 'Verbosity',
  mirroring: 'Mirroring',
};

/**
 * Choose which questions the judge sees when there are more than the cap.
 *
 * **Not a blind head-N.** Every question whose stored value is not `balanced` is kept — those are
 * exactly what a fidelity finding is about — and the remainder is filled in document order so the
 * sample reads contiguously. The caller then tells the judge what it is not seeing; a judge told the
 * truth about its sample stops inventing findings about the part it cannot see.
 */
function selectQuestions(all: PolicyStructureQuestion[]): PolicyStructureQuestion[] {
  if (all.length <= MAX_POLICY_EVAL_QUESTIONS) return all;
  const deviating = all.filter((q) => q.storedLevel !== 'balanced');
  if (deviating.length >= MAX_POLICY_EVAL_QUESTIONS) {
    return deviating.slice(0, MAX_POLICY_EVAL_QUESTIONS);
  }
  const keys = new Set(deviating.map((q) => q.key));
  const filler = all
    .filter((q) => !keys.has(q.key))
    .slice(0, MAX_POLICY_EVAL_QUESTIONS - deviating.length);
  // Restore document order so the sample reads as a run of the instrument, not two concatenated lists.
  const chosen = new Set([...keys, ...filler.map((q) => q.key)]);
  return all.filter((q) => chosen.has(q.key));
}

/**
 * Assemble the DTO, or `null` when the version does not exist.
 *
 * Note what is NOT here: live session data, and the behavioural findings in
 * `analytics/interviewer-policy.ts`. The judges are structural in v1 and the DTO has no field for
 * either, so that boundary cannot be crossed by accident.
 */
export async function buildPolicyEvaluationStructure(
  questionnaireId: string,
  versionId: string
): Promise<PolicyStructureInput | null> {
  const graph = await getVersionGraph(questionnaireId, versionId);
  if (!graph) return null;

  const config = graph.config;
  const topics = config.conditionalTopics.enabled ? await loadTopics(versionId) : [];

  const [questionnaire, sectionQuestions] = [
    await prisma.appQuestionnaire.findUnique({
      where: { id: questionnaireId },
      select: { title: true },
    }),
    graph.sections.flatMap((section) => section.questions.map((q) => ({ section, question: q }))),
  ];

  // Topic membership by question key, so a fidelity finding can say "and routing may never seat it".
  const topicsByQuestionKey = new Map<string, string[]>();
  for (const topic of topics) {
    for (const key of topic.members.questionKeys) {
      topicsByQuestionKey.set(key, [...(topicsByQuestionKey.get(key) ?? []), topic.key]);
    }
  }

  const allQuestions: PolicyStructureQuestion[] = sectionQuestions.map(({ section, question }) => ({
    key: question.key,
    prompt: clip(question.prompt, 300),
    type: question.type,
    required: question.required,
    weight: question.weight,
    sectionTitle: section.title,
    level: resolveQuestionFidelity(question.fidelity, config.questionFidelity),
    // The raw level, gate ignored — the "gate off, sliders set" finding needs both.
    storedLevel: questionFidelityLevel(question.fidelity),
    topicKeys: topicsByQuestionKey.get(question.key) ?? [],
  }));

  // Counted over EVERY question, so the distribution stays complete even when the sample is cut.
  const distribution = Object.fromEntries(
    QUESTION_FIDELITY_LEVELS.map((level) => [
      level,
      allQuestions.filter((q) => q.storedLevel === level).length,
    ])
  ) as Record<QuestionFidelityLevel, number>;

  // The real bar each level imposes on THIS version, not the bare constant.
  // The floor each level WOULD impose on this version, so the gate is forced on here regardless of
  // the version's own setting — the judge needs the bar to reason about, and with the gate off every
  // level would collapse to the same number and say nothing. `QUESTION_FIDELITY_STOP_BY_LEVEL` is
  // the shared level→stop map; a local copy here would be a second definition of the five stops.
  const satisfactionFloors = Object.fromEntries(
    QUESTION_FIDELITY_LEVELS.map((level) => [
      level,
      questionSatisfactionFloor(
        { fidelity: QUESTION_FIDELITY_STOP_BY_LEVEL[level] },
        {
          answerConfidenceFloor: config.answerConfidenceFloor,
          questionFidelity: { enabled: true, defaultFidelity: DEFAULT_QUESTION_FIDELITY_VALUE },
        }
      ),
    ])
  ) as Record<QuestionFidelityLevel, number>;

  const shown = selectQuestions(allQuestions);

  const mustAskByTopic = topics.map((topic) => {
    const members = topic.members.questionKeys;
    const levels = members.map(
      (key) => allQuestions.find((q) => q.key === key)?.level ?? 'balanced'
    );
    return {
      topicKey: topic.key,
      label: topic.label,
      conditional: topic.phase === 'conditional',
      mustAskCount: levels.filter((l) => l === 'must_ask').length,
      closeCount: levels.filter((l) => l === 'close').length,
    };
  });

  const conflicts = detectConfigConflicts(
    configConflictInputFromConfig(config, allQuestions.length)
  );

  return {
    meta: {
      title: questionnaire?.title ?? 'Untitled questionnaire',
      goal: graph.goal,
      audienceSummary: graph.audience ? clip(JSON.stringify(graph.audience), 1_000) : null,
      sectionCount: graph.sections.length,
      questionCount: allQuestions.length,
    },
    context: {
      presentationMode: config.presentationMode,
      anonymousMode: config.anonymousMode,
      sensitivityAwareness: config.sensitivityAwareness,
      hasSupportMessage: config.supportMessage.trim().length > 0,
      answerConfidenceFloor: config.answerConfidenceFloor,
    },
    tone: {
      personaSelectionEnabled: config.personaSelection.enabled,
      personaText:
        config.tone.persona.enabled && config.tone.persona.text.trim()
          ? clip(config.tone.persona.text, 600)
          : null,
      // The SIGNED display scale (−2…+2), never the stored 1–5: "Humour 3" reads as high to a model
      // where "Humour 0" reads correctly as neutral.
      dials: TONE_DIMENSION_KEYS.filter((key) => config.tone[key].enabled).map((key) => ({
        key,
        label: TONE_LABELS[key] ?? key,
        displayLevel: toDisplayLevel(config.tone[key].level),
      })),
    },
    houseRules: {
      enabled: config.houseRules.enabled,
      rules: config.houseRules.rules.map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        enabled: rule.enabled,
        text: clip(rule.text, 1_000),
        trigger: rule.trigger ? clip(rule.trigger, 400) : null,
      })),
    },
    strategy: {
      enabled: config.interviewerStrategy.enabled,
      approach: config.interviewerStrategy.approach,
      pace: config.interviewerStrategy.pace,
      openingMode: config.interviewerStrategy.openingMode,
      openingExamples: config.interviewerStrategy.openingExamples.map((e) => clip(e, 500)),
      probeDepth: config.interviewerStrategy.probeDepth,
      reflect: config.interviewerStrategy.reflect,
      batchRelated: config.interviewerStrategy.batchRelated,
      // Pre-computed, and it honours the funnel-only rule — so this never describes a pace the
      // runtime ignores.
      paceProfile: paceProfile(config.interviewerStrategy),
      guidedOpeningActive: usesGuidedOpening(config.interviewerStrategy),
    },
    fidelity: {
      enabled: config.questionFidelity.enabled,
      defaultFidelity: config.questionFidelity.defaultFidelity,
      defaultLevel: questionFidelityLevel(config.questionFidelity.defaultFidelity),
      distribution,
      satisfactionFloors,
      questions: shown,
      questionsShown: shown.length,
      questionsTotal: allQuestions.length,
      truncated: shown.length < allQuestions.length,
    },
    routing: {
      conditionalTopicsEnabled: config.conditionalTopics.enabled,
      maxConditionalTopics: config.conditionalTopics.maxConditionalTopics,
      limitOpeningProbes: config.conditionalTopics.limitOpeningProbes,
      maxOpeningProbes: config.conditionalTopics.maxOpeningProbes,
      mustAskByTopic,
    },
    knownIssues: conflicts.map((c) => ({
      severity: c.severity,
      // The id is the point: each rubric's ignore clause names ids, so a judge matches id to id
      // rather than paraphrase to paraphrase.
      id: c.id,
      title: c.title,
      message: c.message,
    })),
  };
}
