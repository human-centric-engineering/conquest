/**
 * Shared builders for per-turn orchestrator unit tests (F6.1). Not a test file (no
 * `.test.ts` suffix). Reuses the selection `q` builder so the `QuestionView` fixtures
 * can't drift, and provides stub {@link CapabilityInvokers} that record the (effective)
 * state each step is handed — so tests can assert the pipeline's merging and ordering
 * without any real capability or DB.
 */

import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  type QuestionnaireConfigShape,
} from '@/lib/app/questionnaire/types';
import type { AnsweredView } from '@/lib/app/questionnaire/selection/types';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type { ContradictionFinding } from '@/lib/app/questionnaire/contradiction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type {
  CapabilityInvokers,
  DetectOutcome,
  ExistingAnswerView,
  ExtractOutcome,
  RefineOutcome,
  RefinementTrigger,
  SelectOutcome,
  TurnFlags,
  TurnState,
} from '@/lib/app/questionnaire/orchestrator';
import { q } from '@/tests/unit/lib/app/questionnaire/selection/_fixtures';

export { q };

/** All sub-features on by default; override per case. */
export function flags(partial: Partial<TurnFlags> = {}): TurnFlags {
  return { extraction: true, contradiction: true, refinement: true, completion: true, ...partial };
}

/** Build a `TurnState`, merging config over the resolved defaults. */
export function state(input: {
  userMessage?: string;
  questions: TurnState['questions'];
  answered?: AnsweredView[];
  existingAnswers?: ExistingAnswerView[];
  config?: Partial<QuestionnaireConfigShape>;
  recentMessages?: string[];
  selectionRound?: number;
  flags?: Partial<TurnFlags>;
  sessionId?: string;
}): TurnState {
  return {
    sessionId: input.sessionId ?? 'sess-1',
    userMessage: input.userMessage ?? '',
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...input.config },
    questions: input.questions,
    answered: input.answered ?? [],
    existingAnswers: input.existingAnswers ?? [],
    recentMessages: input.recentMessages ?? [],
    selectionRound: input.selectionRound ?? 0,
    flags: flags(input.flags),
  };
}

/** Build an `AnswerSlotIntent`, defaulting everything but `slotKey`. */
export function intent(partial: Partial<AnswerSlotIntent> & { slotKey: string }): AnswerSlotIntent {
  return {
    slotKey: partial.slotKey,
    questionType: partial.questionType ?? 'free_text',
    value: partial.value ?? 'an answer',
    confidence: partial.confidence ?? 0.9,
    provenance: partial.provenance ?? 'direct',
    rationale: partial.rationale ?? 'said so',
    isActiveQuestion: partial.isActiveQuestion ?? true,
    ...(partial.sourceQuote !== undefined ? { sourceQuote: partial.sourceQuote } : {}),
  };
}

/** Build a `ContradictionFinding`. */
export function finding(partial: Partial<ContradictionFinding> = {}): ContradictionFinding {
  return {
    slotKeys: partial.slotKeys ?? ['a', 'b'],
    explanation: partial.explanation ?? 'a and b conflict',
    severity: partial.severity ?? 'medium',
    confidence: partial.confidence ?? 0.8,
    ...(partial.suggestedProbe !== undefined ? { suggestedProbe: partial.suggestedProbe } : {}),
  };
}

/** Build a `RefinementDecision`. */
export function decision(
  partial: Partial<RefinementDecision> & { slotKey: string }
): RefinementDecision {
  return {
    slotKey: partial.slotKey,
    action: partial.action ?? 'refine',
    questionType: partial.questionType ?? 'free_text',
    newValue: partial.newValue ?? 'refined',
    rationale: partial.rationale ?? 'reconciled',
    source: partial.source ?? 'contradiction',
    confidence: partial.confidence ?? 0.85,
  };
}

/** What each invoker should return, plus a record of the state it was handed. */
export interface StubConfig {
  extract?: Partial<ExtractOutcome>;
  detect?: Partial<DetectOutcome>;
  refine?: Partial<RefineOutcome>;
  select?: Partial<SelectOutcome>;
}

export interface StubCalls {
  extract: TurnState[];
  detect: TurnState[];
  refine: Array<{ state: TurnState; trigger: RefinementTrigger }>;
  select: TurnState[];
}

/** Stub invokers that record calls and return configured outcomes. */
export function stubInvokers(cfg: StubConfig = {}): {
  invokers: CapabilityInvokers;
  calls: StubCalls;
} {
  const calls: StubCalls = { extract: [], detect: [], refine: [], select: [] };
  const invokers: CapabilityInvokers = {
    async extractAnswers(s) {
      calls.extract.push(s);
      return { intents: [], costUsd: 0, ...cfg.extract };
    },
    async detectContradictions(s) {
      calls.detect.push(s);
      return { findings: [], costUsd: 0, ...cfg.detect };
    },
    async refineAnswer(s, trigger) {
      calls.refine.push({ state: s, trigger });
      return { decisions: [], costUsd: 0, ...cfg.refine };
    },
    async selectNext(s) {
      calls.select.push(s);
      return {
        decision: {
          kind: 'ask',
          questionId: s.questions[0]?.id ?? 'q1',
          rationale: 'next',
          costUsd: 0,
        },
        ...cfg.select,
      };
    },
  };
  return { invokers, calls };
}
