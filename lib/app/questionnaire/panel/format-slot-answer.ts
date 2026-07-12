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
  readMatrixConfig,
} from '@/lib/app/questionnaire/form/type-config';

/** A scale (likert or a matrix row) narrowed to what point-formatting needs. */
interface ScaleLabels {
  min: number;
  max: number;
  labels: string[] | null;
  minLabel: string | null;
  maxLabel: string | null;
}

/**
 * Render a scale point as its human-readable text: a per-point word when the scale is
 * fully labelled ("Neutral"), the point over its anchored range otherwise
 * ("4/5 — Not at all → Very much"), or the bare number as a last resort. Shared by the
 * likert and matrix-row branches so a rating always reads the same way.
 */
function formatScalePoint(point: number, scale: ScaleLabels): string {
  if (scale.labels) {
    const label = scale.labels[point - scale.min];
    if (label) return label;
  }
  if (scale.minLabel && scale.maxLabel && point >= scale.min && point <= scale.max) {
    return `${point}/${scale.max} — ${scale.minLabel} → ${scale.maxLabel}`;
  }
  return `${point}`;
}

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
    if (config) return formatScalePoint(value, config);
  }

  // Matrix: a stored value is a `{ rowKey: point }` map. Render each rated row as
  // "Row label: <scale point text>", so a grid reads as prose rather than raw JSON.
  if (type === 'matrix' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const config = readMatrixConfig(typeConfig);
    if (config) {
      const entries = value as Record<string, unknown>;
      const parts = config.rows
        .filter((row) => typeof entries[row.key] === 'number')
        .map((row) => `${row.label}: ${formatScalePoint(entries[row.key] as number, config)}`);
      return parts.length > 0 ? parts.join('; ') : '—';
    }
  }

  return formatValue(value);
}
