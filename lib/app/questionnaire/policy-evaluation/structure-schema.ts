/**
 * Zod mirror of {@link PolicyStructureInput} (F18.8) — the capability's argument boundary.
 *
 * The DTO crosses a dispatch, so it is validated on the way in exactly as the two sibling panels
 * validate theirs. `satisfies z.ZodType<PolicyStructureInput>` pins the two together in both
 * directions: a field added to the interface and not to the schema stops compiling, and vice versa.
 *
 * The caps are the reason this file exists as well as the shape. A questionnaire with 300 questions
 * would otherwise put 300 prompts into a judge's context — see `MAX_POLICY_EVAL_QUESTIONS` and the
 * loader's non-Balanced-first sampling.
 */

import { z } from 'zod';

import {
  FUNNEL_PACES,
  HOUSE_RULE_KINDS,
  INTERVIEWER_APPROACHES,
  INTERVIEWER_OPENING_MODES,
  PRESENTATION_MODES,
  QUESTION_FIDELITY_LEVELS,
  QUESTION_FIDELITY_STOPS,
  QUESTION_TYPES,
  TONE_DIMENSION_KEYS,
} from '@/lib/app/questionnaire/types';
import type { PolicyStructureInput } from '@/lib/app/questionnaire/policy-evaluation/types';

/**
 * Questions shown to a judge. Not a blind head-N: the loader keeps every question whose stored value
 * is not `balanced` (those are exactly what a fidelity finding is about) and fills the rest in
 * document order, then tells the judge what it is not seeing.
 */
export const MAX_POLICY_EVAL_QUESTIONS = 150;
/** The authoring cap, so this can never bind before the editor does. */
export const MAX_POLICY_EVAL_RULES = 20;
export const MAX_POLICY_EVAL_ISSUES = 100;
export const MAX_POLICY_EVAL_TOPICS = 200;

const PROMPT_MAX = 500;
const TEXT_MAX = 2_000;

const levelSchema = z.enum(QUESTION_FIDELITY_LEVELS);
const levelRecord = z.record(levelSchema, z.number());

export const policyStructureSchema = z
  .object({
    meta: z
      .object({
        title: z.string().max(TEXT_MAX),
        goal: z.string().max(TEXT_MAX).nullable(),
        audienceSummary: z.string().max(TEXT_MAX).nullable(),
        sectionCount: z.number().int().min(0),
        questionCount: z.number().int().min(0),
      })
      .strict(),
    context: z
      .object({
        presentationMode: z.enum(PRESENTATION_MODES),
        anonymousMode: z.boolean(),
        sensitivityAwareness: z.boolean(),
        hasSupportMessage: z.boolean(),
        answerConfidenceFloor: z.number().min(0).max(1),
      })
      .strict(),
    tone: z
      .object({
        personaSelectionEnabled: z.boolean(),
        personaText: z.string().max(TEXT_MAX).nullable(),
        dials: z
          .array(
            z
              .object({
                key: z.enum(TONE_DIMENSION_KEYS),
                label: z.string().max(120),
                displayLevel: z.number().int(),
              })
              .strict()
          )
          .max(TONE_DIMENSION_KEYS.length),
      })
      .strict(),
    houseRules: z
      .object({
        enabled: z.boolean(),
        rules: z
          .array(
            z
              .object({
                id: z.string().max(64),
                kind: z.enum(HOUSE_RULE_KINDS),
                enabled: z.boolean(),
                text: z.string().max(TEXT_MAX),
                trigger: z.string().max(TEXT_MAX).nullable(),
              })
              .strict()
          )
          .max(MAX_POLICY_EVAL_RULES),
      })
      .strict(),
    strategy: z
      .object({
        enabled: z.boolean(),
        approach: z.enum(INTERVIEWER_APPROACHES),
        pace: z.enum(FUNNEL_PACES),
        openingMode: z.enum(INTERVIEWER_OPENING_MODES),
        openingExamples: z.array(z.string().max(TEXT_MAX)).max(10),
        probeDepth: z.boolean(),
        reflect: z.boolean(),
        batchRelated: z.boolean(),
        paceProfile: z
          .object({
            openingWindow: z.number(),
            openBelow: z.number(),
            targetedAbove: z.number(),
            openRounds: z.number(),
            targetedRounds: z.number(),
          })
          .strict(),
        guidedOpeningActive: z.boolean(),
      })
      .strict(),
    fidelity: z
      .object({
        enabled: z.boolean(),
        defaultFidelity: z.literal(QUESTION_FIDELITY_STOPS),
        defaultLevel: levelSchema,
        distribution: levelRecord,
        satisfactionFloors: levelRecord,
        questions: z
          .array(
            z
              .object({
                key: z.string().max(200),
                prompt: z.string().max(PROMPT_MAX),
                type: z.enum(QUESTION_TYPES),
                required: z.boolean(),
                weight: z.number(),
                sectionTitle: z.string().max(TEXT_MAX),
                level: levelSchema,
                storedLevel: levelSchema,
                topicKeys: z.array(z.string().max(200)).max(MAX_POLICY_EVAL_TOPICS),
              })
              .strict()
          )
          .max(MAX_POLICY_EVAL_QUESTIONS),
        questionsShown: z.number().int().min(0),
        questionsTotal: z.number().int().min(0),
        truncated: z.boolean(),
      })
      .strict(),
    routing: z
      .object({
        conditionalTopicsEnabled: z.boolean(),
        maxConditionalTopics: z.number().int().min(0),
        limitOpeningProbes: z.boolean(),
        maxOpeningProbes: z.number().int().min(0),
        mustAskByTopic: z
          .array(
            z
              .object({
                topicKey: z.string().max(200),
                label: z.string().max(TEXT_MAX),
                conditional: z.boolean(),
                mustAskCount: z.number().int().min(0),
                closeCount: z.number().int().min(0),
              })
              .strict()
          )
          .max(MAX_POLICY_EVAL_TOPICS),
      })
      .strict(),
    knownIssues: z
      .array(
        z
          .object({
            severity: z.enum(['error', 'warning', 'info']),
            id: z.string().max(120),
            title: z.string().max(TEXT_MAX),
            message: z.string().max(TEXT_MAX),
          })
          .strict()
      )
      .max(MAX_POLICY_EVAL_ISSUES),
  })
  .strict() satisfies z.ZodType<PolicyStructureInput>;
