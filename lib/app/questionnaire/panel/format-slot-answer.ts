/**
 * Slot-aware answer formatter — renders a captured answer as the human-readable text a
 * respondent actually chose, not its stored key (F7.4).
 *
 * `formatAnswerValue` (components/.../panel) is value-only: it can't know that a
 * single/multi-choice answer is stored as an option `value` (a slug like `option_1`)
 * whose respondent-facing text lives in the slot's `typeConfig.choices[].label`. This
 * helper takes the slot's `type` + `typeConfig` so choice answers render their labels
 * ("Very satisfied") rather than their keys ("option_1"), and booleans use the version's
 * configured true/false labels. Everything else falls back to the plain value formatting.
 *
 * Pure (Zod readers only), so the React-PDF document, the on-screen panel, and the
 * report transcript builder can all share one rendering.
 *
 * `// DEMO-ONLY (F7.4):` questionnaire-domain shape — a fork strips this module.
 */

import type { QuestionType } from '@/lib/app/questionnaire/types';
import {
  readBooleanConfig,
  readChoicesConfig,
  readLikertConfig,
} from '@/lib/app/questionnaire/form/type-config';

/** Plain value → string, mirroring the panel's value-only `formatAnswerValue`. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((v) => formatValue(v)).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value.trim() === '' ? '—' : value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  try {
    return JSON.stringify(value) ?? '—';
  } catch {
    return '—';
  }
}

/**
 * Render a captured answer with knowledge of its slot — choice keys become their labels,
 * booleans honour their custom labels, and a likert point becomes its per-point label
 * ("Neutral") — falling back to {@link formatValue} for free-text, numeric, an unlabelled
 * scale, and any value whose key isn't in the option list (so a stale answer never renders
 * blank).
 */
export function formatSlotAnswer(type: QuestionType, typeConfig: unknown, value: unknown): string {
  if (value === null || value === undefined) return '—';

  if (type === 'single_choice' || type === 'multi_choice') {
    const config = readChoicesConfig(type, typeConfig);
    if (config) {
      const labelByValue = new Map(config.choices.map((c) => [c.value, c.label]));
      const toLabel = (v: unknown): string =>
        typeof v === 'string' && labelByValue.has(v)
          ? (labelByValue.get(v) as string)
          : formatValue(v);
      if (Array.isArray(value)) {
        return value.length === 0 ? '—' : value.map(toLabel).join(', ');
      }
      return toLabel(value);
    }
  }

  if (type === 'boolean' && typeof value === 'boolean') {
    const config = readBooleanConfig(typeConfig);
    return value ? config.trueLabel : config.falseLabel;
  }

  // Likert: a stored value is a scale point (an integer in [min, max]). Render the
  // point's human-readable label ("Neutral") rather than a meaningless number.
  if (type === 'likert' && typeof value === 'number') {
    const config = readLikertConfig(typeConfig);
    if (config) {
      // Fully labelled scale — every point has a word.
      if (config.labels) {
        const label = config.labels[value - config.min];
        if (label) return label;
      }
      // Endpoint-anchored scale — no middle words to invent, so show the point over
      // its range with the anchor wording for context ("4/5 — Not at all → Very much")
      // rather than a bare, meaningless number.
      if (config.minLabel && config.maxLabel && value >= config.min && value <= config.max) {
        return `${value}/${config.max} — ${config.minLabel} → ${config.maxLabel}`;
      }
    }
  }

  return formatValue(value);
}
