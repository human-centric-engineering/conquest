/**
 * The whole-questionnaire snapshot the Config Advisor reasons over.
 *
 * Pure types only (no Prisma, no Next) so the assembler (`_lib/advisor-context.ts`, which builds it
 * from the database), the orchestrator (`stream-advisor.ts`, which serialises it into the prompt),
 * and the tests can all share one contract. The assembler keeps this BOUNDED — section titles +
 * counts + a handful of sample prompts, not every prompt — so the prompt cost stays predictable on
 * large questionnaires.
 */

import type {
  AppQuestionnaireStatus,
  AudienceShape,
  QuestionType,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';

/** A bounded per-section summary — counts plus a few representative prompts. */
export interface AdvisorSectionSummary {
  title: string;
  questionCount: number;
  /** A small sample of question prompts from this section (capped by the assembler). */
  samplePrompts: string[];
}

export interface AdvisorContext {
  questionnaire: {
    title: string;
    status: AppQuestionnaireStatus;
    /** Attributed demo client brand, or null for the generic demo. */
    demoClientName: string | null;
  };
  version: {
    versionNumber: number;
    status: AppQuestionnaireStatus;
    goal: string | null;
    audience: AudienceShape | null;
    /** How many respondent sessions exist on this version (in-flight + completed). */
    sessionCount: number;
  };
  structure: {
    sectionCount: number;
    questionCount: number;
    requiredCount: number;
    optionalCount: number;
    /** Count of questions by answer type (e.g. `{ free_text: 5, single_choice: 3 }`). */
    typeHistogram: Partial<Record<QuestionType, number>>;
    sections: AdvisorSectionSummary[];
  };
  /** The resolved run-time configuration (defaults when never saved; `saved` says which). */
  config: ConfigView;
  dataSlots: {
    count: number;
    /** A small sample of data-slot names + themes (capped by the assembler). */
    samples: { name: string; theme: string }[];
  };
  scoring: {
    present: boolean;
    name: string | null;
  };
}
