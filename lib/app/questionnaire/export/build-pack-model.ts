/**
 * Questionnaire Pack export model.
 *
 * Flattens a {@link VersionGraphView} (plus its data slots and glossary appendix) into a
 * presentation-ready {@link PackModel} — a branded, shareable artifact that covers everything about
 * how the questionnaire is set up: title/version/goals, the question structure, the semantic data
 * slots (with their linked questions), the definitions/glossary, and a curated summary of the
 * experience-setup config. The admin picks which of those five sections to include via
 * {@link PackInclude}; excluded sections are `null` on the model so every serialiser (PDF/CSV/
 * Markdown) skips them the same way.
 *
 * Distinct from the brand-free {@link file://./build-instrument-model.ts} (F14.9), which is the
 * design-time reviewer copy of just the questions. This is the external/showcase artifact — it
 * reuses `buildInstrumentModel` for the question-structure section rather than re-deriving it.
 *
 * Pure: no Prisma / Next / clock. The caller stamps `generatedAt` (an ISO string) so the model stays
 * deterministic in its input.
 */

import { ACCESS_MODE_LABELS, type PresentationMode } from '@/lib/app/questionnaire/types';
import type { GlossaryAppendixView } from '@/lib/app/questionnaire/glossary/types';
import type { ConfigView, VersionGraphView } from '@/lib/app/questionnaire/views';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
import {
  buildInstrumentModel,
  type InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

/** Which of the pack's five sections to include. All default to `true` (ticked by default). */
export interface PackInclude {
  /** Title, version, goal, audience. */
  meta: boolean;
  /** The sections/questions structure. */
  questions: boolean;
  /** The semantic data slots, with their linked questions. */
  dataSlots: boolean;
  /** The definitions / glossary appendix. */
  definitions: boolean;
  /** A curated summary of the experience-setup config. */
  setup: boolean;
}

/** Every section included — the default state of the export dialog's checkboxes. */
export const DEFAULT_PACK_INCLUDE: PackInclude = {
  meta: true,
  questions: true,
  dataSlots: true,
  definitions: true,
  setup: true,
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

/** One row of the curated experience-setup summary. */
export interface PackSetupItem {
  label: string;
  value: string;
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
}

const PRESENTATION_MODE_LABELS: Record<PresentationMode, string> = {
  chat: 'Chat',
  form: 'Form',
  both: 'Both (respondent can toggle)',
};

const onOff = (value: boolean): string => (value ? 'Enabled' : 'Disabled');

/**
 * Hand-picked, non-technical subset of {@link ConfigView} — "what we set up to drive the respondent
 * experience", not the full tuning surface (confidence floors, cost budgets, reasoning-trace
 * timings, ...). Extending this list is a deliberate editorial choice, not a mechanical derivation
 * like {@link CONFIG_KEYS} in `config-export.ts`.
 */
function buildSetupSummary(config: ConfigView): PackSetupItem[] {
  return [
    { label: 'Access', value: ACCESS_MODE_LABELS[config.accessMode] },
    { label: 'Anonymous respondents', value: config.anonymousMode ? 'Yes' : 'No' },
    { label: 'Presentation', value: PRESENTATION_MODE_LABELS[config.presentationMode] },
    { label: 'Voice input', value: onOff(config.voiceEnabled) },
    { label: 'File attachments', value: onOff(config.attachmentsEnabled) },
    {
      label: 'Respondent early finish',
      value: config.allowEarlyFinish ? 'Allowed' : 'Not allowed',
    },
    { label: 'Session resume', value: onOff(config.sessionResumeEnabled) },
    { label: 'Respondent report', value: onOff(config.respondentReport.enabled) },
    { label: 'Cohort report', value: onOff(config.cohortReport.enabled) },
    {
      label: 'Definitions shown to respondents',
      value: config.glossaryRespondentHints ? 'Yes' : 'No',
    },
  ];
}

/** Resolve a data slot's `questionKeys` to `{ key, prompt }` pairs against the version graph. */
function resolveDataSlotQuestions(
  graph: VersionGraphView,
  questionKeys: string[]
): { key: string; prompt: string }[] {
  const prompts = new Map<string, string>();
  for (const section of graph.sections) {
    for (const q of section.questions) prompts.set(q.key, q.prompt);
  }
  return questionKeys.map((key) => ({ key, prompt: prompts.get(key) ?? key }));
}

/** Assemble the Questionnaire Pack model. Pure. */
export function buildPackModel(
  title: string,
  graph: VersionGraphView,
  dataSlots: DataSlotView[],
  glossary: GlossaryAppendixView | null,
  include: PackInclude,
  generatedAt: string
): PackModel {
  // Reuse the instrument builder for the question-structure fields — a single place derives
  // goal/audience/section/question flattening so the two exports can never render it differently.
  const instrument = buildInstrumentModel(title, graph, generatedAt, null);

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
          questions: resolveDataSlotQuestions(graph, slot.questionKeys),
        }))
      : null,
    glossary: include.definitions ? glossary : null,
    setup: include.setup ? buildSetupSummary(graph.config) : null,
  };
}
