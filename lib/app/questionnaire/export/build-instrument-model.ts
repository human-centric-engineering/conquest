/**
 * Blank-instrument export model (F14.9).
 *
 * Flattens a {@link VersionGraphView} into a presentation-ready {@link InstrumentModel} — the
 * questionnaire's *questions* (numbered, typed, with their answer options/scale and guidelines) and
 * no respondent data. The three instrument serialisers (text, CSV, React-PDF) all consume this one
 * model, so a change to how a question renders happens in one place. Sibling to the respondent-facing
 * {@link file://./build-session-export-model.ts}, but design-time: it's the empty form, for review or
 * paper distribution.
 *
 * Pure: no Prisma / Next / clock. The caller stamps `generatedAt` (an ISO string) so the model stays
 * deterministic in its input.
 */

import { QUESTION_TYPE_LABELS, type QuestionType } from '@/lib/app/questionnaire/types';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import { summariseAudience } from '@/lib/app/questionnaire/export/build-session-export-model';

/** One question rendered for the blank instrument. */
export interface InstrumentQuestion {
  /** Display number within the instrument, e.g. `"2.3"` (section 2, question 3). */
  number: string;
  key: string;
  prompt: string;
  type: QuestionType;
  typeLabel: string;
  required: boolean;
  weight: number;
  guidelines: string | null;
  tags: string[];
  /** Selectable options (choice labels, or per-point likert labels). Empty for non-option types. */
  options: string[];
  /** A short one-line constraint (numeric bounds/unit, boolean labels, likert range). Else null. */
  constraint: string | null;
}

/** One section (with its questions) in the instrument. */
export interface InstrumentSection {
  /** 1-based display number. */
  number: number;
  title: string;
  description: string | null;
  questions: InstrumentQuestion[];
}

/** The full blank-instrument model the serialisers render. */
export interface InstrumentModel {
  title: string;
  versionNumber: number;
  goal: string | null;
  audienceSummary: string | null;
  generatedAt: string;
  sectionCount: number;
  questionCount: number;
  sections: InstrumentSection[];
}

/** Safely read a property off an opaque `typeConfig` JSON value. */
function field(config: unknown, key: string): unknown {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    return (config as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Render the selectable options for choice / likert types from the opaque `typeConfig`. */
function readOptions(type: QuestionType, config: unknown): string[] {
  if (type === 'single_choice' || type === 'multi_choice') {
    const choices = field(config, 'choices');
    if (!Array.isArray(choices)) return [];
    const labels = choices
      .map((c) => {
        const label = field(c, 'label');
        const value = field(c, 'value');
        return typeof label === 'string' ? label : typeof value === 'string' ? value : null;
      })
      .filter((l): l is string => l !== null);
    if (field(config, 'allowOther') === true) labels.push('Other (please specify)');
    return labels;
  }

  if (type === 'likert') {
    const labels = field(config, 'labels');
    const min = field(config, 'min');
    if (Array.isArray(labels) && typeof min === 'number') {
      return labels.map((l, i) => `${min + i} — ${typeof l === 'string' ? l : ''}`.trimEnd());
    }
    return [];
  }

  return [];
}

/** Render a one-line constraint summary (numeric bounds, boolean labels, likert range). */
function readConstraint(type: QuestionType, config: unknown): string | null {
  if (type === 'likert') {
    const min = field(config, 'min');
    const max = field(config, 'max');
    if (typeof min === 'number' && typeof max === 'number') {
      const minLabel = field(config, 'minLabel');
      const maxLabel = field(config, 'maxLabel');
      const lo = typeof minLabel === 'string' ? `${min} (${minLabel})` : String(min);
      const hi = typeof maxLabel === 'string' ? `${max} (${maxLabel})` : String(max);
      return `Scale ${lo} to ${hi}`;
    }
    return null;
  }

  if (type === 'numeric') {
    const min = field(config, 'min');
    const max = field(config, 'max');
    const unit = field(config, 'unit');
    const parts: string[] = [];
    if (typeof min === 'number') parts.push(`min ${min}`);
    if (typeof max === 'number') parts.push(`max ${max}`);
    if (typeof unit === 'string') parts.push(`unit ${unit}`);
    return parts.length > 0 ? `Numeric (${parts.join(', ')})` : null;
  }

  if (type === 'boolean') {
    const trueLabel = field(config, 'trueLabel');
    const falseLabel = field(config, 'falseLabel');
    const yes = typeof trueLabel === 'string' ? trueLabel : 'Yes';
    const no = typeof falseLabel === 'string' ? falseLabel : 'No';
    return `${yes} / ${no}`;
  }

  return null;
}

/** Assemble the instrument model from a version graph. Pure. */
export function buildInstrumentModel(
  title: string,
  graph: VersionGraphView,
  generatedAt: string
): InstrumentModel {
  let questionCount = 0;

  const sections: InstrumentSection[] = graph.sections.map((section, sIndex) => ({
    number: sIndex + 1,
    title: section.title,
    description: section.description,
    questions: section.questions.map((q, qIndex) => {
      questionCount += 1;
      return {
        number: `${sIndex + 1}.${qIndex + 1}`,
        key: q.key,
        prompt: q.prompt,
        type: q.type,
        typeLabel: QUESTION_TYPE_LABELS[q.type],
        required: q.required,
        weight: q.weight,
        guidelines: q.guidelines,
        tags: q.tags.map((t) => t.label),
        options: readOptions(q.type, q.typeConfig),
        constraint: readConstraint(q.type, q.typeConfig),
      };
    }),
  }));

  return {
    title,
    versionNumber: graph.versionNumber,
    goal: graph.goal,
    audienceSummary: summariseAudience(graph.audience),
    generatedAt,
    sectionCount: graph.sections.length,
    questionCount,
    sections,
  };
}
