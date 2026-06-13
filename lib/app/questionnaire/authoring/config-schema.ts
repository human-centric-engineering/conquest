/**
 * Request-body schema for the version configuration endpoint (F3.1).
 *
 * `PATCH …/versions/:vid/config` accepts a partial config — every field is
 * optional so the editor can save one section without resending the rest; an
 * omitted key leaves the stored (or default) value unchanged, and at least one key
 * must be present. Enums derive from the `const` tuples in `../types.ts` (single
 * source of truth). Cross-field rules are enforced with `superRefine`, the same
 * discipline as `type-config-schema.ts`:
 *   - contradiction mode/N: `contradictionWindowN` must be > 0 when the mode is
 *     not `off`, and is forced to `0` when it is `off`.
 *   - profile fields: `key`s unique within the array; `select` requires a
 *     non-empty distinct `options` list, every other type forbids `options`.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import {
  ANSWER_SLOT_PANEL_SCOPES,
  CONTRADICTION_MODES,
  PROFILE_FIELD_TYPES,
  SELECTION_STRATEGIES,
} from '@/lib/app/questionnaire/types';

/** A profile-field key: lowercase slug so it's a stable, URL/JSON-safe handle. */
const profileFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9_]+$/, 'Key must be lowercase letters, numbers, or underscores');

/**
 * One session-start profile field. `options` is validated against `type` here so
 * a `select` always carries choices and a non-`select` never does.
 */
export const profileFieldSchema = z
  .object({
    key: profileFieldKeySchema,
    label: z.string().trim().min(1).max(200),
    type: z.enum(PROFILE_FIELD_TYPES),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1)).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select') {
      const options = field.options ?? [];
      if (options.length < 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'A select field needs at least one option',
          path: ['options'],
        });
      }
      if (new Set(options).size !== options.length) {
        ctx.addIssue({ code: 'custom', message: 'Options must be unique', path: ['options'] });
      }
    } else if (field.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only select fields may declare options',
        path: ['options'],
      });
    }
  });

/**
 * PATCH a version's configuration. All fields optional (partial save); at least
 * one required. Numbers are bounded to sane authoring ranges; nullable budget/cap
 * fields use `null` to mean "no cap" (an omitted key leaves the stored value).
 */
export const updateConfigSchema = z
  .object({
    selectionStrategy: z.enum(SELECTION_STRATEGIES).optional(),
    minQuestionsAnswered: z.number().int().nonnegative().optional(),
    coverageThreshold: z.number().min(0).max(1).optional(),
    costBudgetUsd: z.number().positive().nullable().optional(),
    maxQuestionsPerSession: z.number().int().positive().nullable().optional(),
    voiceEnabled: z.boolean().optional(),
    contradictionMode: z.enum(CONTRADICTION_MODES).optional(),
    contradictionWindowN: z.number().int().nonnegative().optional(),
    contradictionEveryNTurns: z.number().int().min(1).optional(),
    anonymousMode: z.boolean().optional(),
    // Seriousness / abuse gate: non-genuine answers tolerated before the session is abandoned.
    // 0 = off; capped to keep the escalation meaningful.
    abuseThreshold: z.number().int().min(0).max(50).optional(),
    profileFields: z.array(profileFieldSchema).optional(),
    answerSlotPanelScope: z.enum(ANSWER_SLOT_PANEL_SCOPES).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Provide at least one field to update',
  })
  .superRefine((cfg, ctx) => {
    // Contradiction mode/N coherence — only checkable when the mode is present in
    // this partial (an omitted mode leaves the stored value, validated on its own save).
    if (cfg.contradictionMode !== undefined) {
      if (cfg.contradictionMode === 'off') {
        if (cfg.contradictionWindowN !== undefined && cfg.contradictionWindowN !== 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'Window N must be 0 when contradiction detection is off',
            path: ['contradictionWindowN'],
          });
        }
      } else if (cfg.contradictionWindowN === undefined || cfg.contradictionWindowN < 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'Window N must be at least 1 when contradiction detection is on',
          path: ['contradictionWindowN'],
        });
      }
    }

    // Profile-field keys unique across the list.
    if (cfg.profileFields) {
      const keys = cfg.profileFields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Profile field keys must be unique',
          path: ['profileFields'],
        });
      }
    }
  });

export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
