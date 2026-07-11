/**
 * Per-question config "health" (F2.1 / PR2) — does a question's `typeConfig`
 * actually satisfy its type, or is it half-set-up?
 *
 * The authoring boundary ({@link validateTypeConfig}) already pins what a valid
 * config is, but legacy/extracted rows can predate a tightening rule (most
 * commonly a likert with no per-point labels, since label enforcement is newer
 * than the data). This module turns that same pass/fail into a *human* nudge the
 * structure editor can surface, so an admin can spot a question that won't launch
 * before they hit the launch gate.
 *
 * Pure (Zod only, no Prisma / Next) so the client editor and the server share one
 * definition of "not set up properly". The authoritative pass/fail is
 * {@link validateTypeConfig} (the write schema); the per-type branches below only
 * pick the friendliest explanation for the failure.
 */

import { QUESTION_TYPES, type QuestionType } from '@/lib/app/questionnaire/types';

import { validateTypeConfig } from '@/lib/app/questionnaire/authoring/type-config-schema';

/** A concise, admin-facing description of why a question isn't ready. */
export interface QuestionConfigIssue {
  /** Short chip text, e.g. "Add scale labels". */
  label: string;
  /** One sentence for the tooltip / detail line. */
  detail: string;
}

function asRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
}

/**
 * The reason a question is misconfigured, or `null` when its `typeConfig` is
 * fully valid for its type. Reuses {@link validateTypeConfig} for the verdict so
 * the cue can never disagree with what the save/launch path enforces — the
 * branches below only translate a failure into the most specific message.
 */
export function questionConfigIssue(
  type: QuestionType,
  typeConfig: unknown
): QuestionConfigIssue | null {
  // Defensive against schema drift: an unrecognised type (a stored value outside
  // the current QuestionType union) has no config contract to check, and
  // validateTypeConfig would throw on its absent schema. Don't flag it.
  if (!QUESTION_TYPES.includes(type)) return null;
  // The DB stores config-less/optional types as JSON `null`, but
  // `validateTypeConfig` only reads `undefined` as "absent" (so config-optional
  // types like boolean/numeric default cleanly). Normalise nullish → undefined so
  // a boolean with no config doesn't read as misconfigured; required types
  // (choice/likert) still fail on an absent config, which is what we want.
  const config = typeConfig ?? undefined;
  if (validateTypeConfig(type, config).ok) return null;

  switch (type) {
    case 'likert': {
      const { min, max } = asRecord(config);
      const hasRange =
        typeof min === 'number' &&
        Number.isInteger(min) &&
        typeof max === 'number' &&
        Number.isInteger(max) &&
        max > min;
      // Range first: you can't label points you haven't bounded yet.
      if (!hasRange) {
        return {
          label: 'Set scale range',
          detail:
            'This rating scale has no valid range — set a minimum and a maximum (max above min).',
        };
      }
      return {
        label: 'Add scale labels',
        detail:
          'Label every point on this rating scale (e.g. 1 = “Very dissatisfied”), or switch the type to Numeric for an unlabelled rating.',
      };
    }
    case 'matrix': {
      const cfg = asRecord(config);
      const rowCount = Array.isArray(cfg.rows) ? cfg.rows.length : 0;
      // Rows first: you can't label a scale for a grid that has nothing to rate.
      if (rowCount < 1) {
        return {
          label: 'Add rows',
          detail: 'A rating grid needs at least one row item to rate.',
        };
      }
      return {
        label: 'Add scale labels',
        detail:
          'Label the grid’s shared rating scale — every point, or both endpoints (e.g. 1 = “Not important”, 5 = “Essential”).',
      };
    }
    case 'single_choice':
    case 'multi_choice': {
      const choices = asRecord(config).choices;
      const count = Array.isArray(choices) ? choices.length : 0;
      if (count < 2) {
        return {
          label: 'Add options',
          detail: 'A choice question needs at least two options.',
        };
      }
      return {
        label: 'Fix options',
        detail: 'Every option needs a label and a distinct value.',
      };
    }
    case 'numeric': {
      // Numeric can fail on more than the bounds (step ≤ 0, blank unit), so only
      // claim a range problem when min/max are actually inverted.
      const { min, max } = asRecord(config);
      if (typeof min === 'number' && typeof max === 'number' && max < min) {
        return {
          label: 'Fix range',
          detail: 'The maximum must be greater than or equal to the minimum.',
        };
      }
      return {
        label: 'Fix numeric setup',
        detail: 'This numeric question’s setup is invalid — check its bounds, step, and unit.',
      };
    }
    case 'boolean':
      // Custom yes/no labels are optional, but a present-yet-blank one is invalid.
      return {
        label: 'Label answers',
        detail:
          'Give the yes/no options non-empty labels, or remove the custom labels to use the defaults.',
      };
    default:
      // Reached only by a (near-)config-less type — `date`, or a `free_text` whose
      // config carries something other than the allowed `commentAggregation` — that
      // is holding leftover config no longer matching its type.
      return {
        label: 'Check config',
        detail:
          'This question has leftover configuration that doesn’t match its type — clear it or change the type.',
      };
  }
}
