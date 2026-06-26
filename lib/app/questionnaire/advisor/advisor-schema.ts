/**
 * Schema + types for the Config Advisor's structured analysis (conflicts + suggestions).
 *
 * Phase 2 of the advisor run produces this: a list of `conflicts` (settings that fight each other
 * or hurt the experience) and a list of `suggestions` (each a small config `patch` the admin can
 * apply in one click). A suggestion's `patch` only ever targets the **scalar/enum** config fields in
 * {@link ADVISOR_APPLYABLE_CONFIG_FIELDS} — the complex JSON config blocks (tone, reports, intro,
 * profile/invitee fields) have their own structured editors, so the advisor mentions them in prose
 * but never proposes a blind one-click overwrite of them.
 *
 * `proposedValue`s are validated only loosely here (the field must be applyable; the value is opaque
 * JSON) — the authoritative validation happens when the client PATCHes the patch through the version
 * config endpoint, which runs the full `updateConfigSchema` cross-field rules. Pure: Zod only.
 */

import { z } from 'zod';

import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';

/**
 * The config fields the advisor may target with a one-click `patch`. Scalars, enums, numbers,
 * booleans, and short strings only — every one is independently PATCHable via the version config
 * endpoint. Deliberately excludes the structured JSON blocks (`tone`, `respondentReport`,
 * `cohortReport`, `intro`, `profileFields`, `inviteeFields`): those are edited through their own
 * panels, so the advisor surfaces them as prose conflicts rather than blind overwrites.
 *
 * Typed as a tuple of `keyof QuestionnaireConfigShape` so it stays in sync with the config shape —
 * a renamed/removed field is a compile error here.
 */
export const ADVISOR_APPLYABLE_CONFIG_FIELDS = [
  'selectionStrategy',
  'minQuestionsAnswered',
  'coverageThreshold',
  'costBudgetUsd',
  'maxQuestionsPerSession',
  'voiceEnabled',
  'attachmentsEnabled',
  'contradictionMode',
  'contradictionWindowN',
  'contradictionEveryNTurns',
  'answerFitMode',
  'extractionPrefilter',
  'anonymousMode',
  'accessMode',
  'abuseThreshold',
  'maxDataSlotAttempts',
  'sensitivityAwareness',
  'supportMessage',
  'supportResourceUrl',
  'answerSlotPanelScope',
  'presentationMode',
  'inlineCorrectionEnabled',
  'reasoningStreamEnabled',
  'reasoningStreamPlacement',
  'reasoningStreamDwellMs',
  'reasoningStreamPerItemMs',
  'reasoningStreamPersist',
  'previewInspectorEnabled',
] as const satisfies readonly (keyof QuestionnaireConfigShape)[];

export type AdvisorApplyableField = (typeof ADVISOR_APPLYABLE_CONFIG_FIELDS)[number];

const APPLYABLE_SET = new Set<string>(ADVISOR_APPLYABLE_CONFIG_FIELDS);

/** Severity of a conflict / suggestion — drives the badge colour and sort order in the panel. */
export const ADVISOR_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

/** A conflict the advisor found between settings (or a setting that hurts the experience). */
export interface AdvisorConflict {
  title: string;
  detail: string;
  /** The config field names involved (for display + cross-referencing the prose). */
  settings: string[];
  severity: AdvisorSeverity;
}

/**
 * A proposed tweak. `patch` is a partial config object whose keys are all applyable fields; the
 * client posts it straight to the version config PATCH endpoint (which forks a launched version and
 * runs the full cross-field validation). Co-dependent fields (e.g. `contradictionMode` +
 * `contradictionWindowN`) travel together in one `patch` so the apply passes `updateConfigSchema`.
 */
export interface AdvisorSuggestion {
  id: string;
  title: string;
  rationale: string;
  severity: AdvisorSeverity;
  patch: Partial<Record<AdvisorApplyableField, unknown>>;
}

export interface AdvisorAnalysis {
  conflicts: AdvisorConflict[];
  suggestions: AdvisorSuggestion[];
}

const conflictSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(2000),
  settings: z.array(z.string().min(1).max(80)).max(12).default([]),
  severity: z.enum(ADVISOR_SEVERITIES),
});

/**
 * A suggestion as emitted by the model. `patch` is a free record validated structurally here; we
 * filter it to applyable keys in {@link validateAdvisorAnalysis} (a suggestion whose patch has no
 * applyable key is dropped — prose-only advice belongs in `conflicts`).
 */
const rawSuggestionSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(2000),
  severity: z.enum(ADVISOR_SEVERITIES),
  patch: z.record(z.string(), z.unknown()),
});

const rawAnalysisSchema = z.object({
  conflicts: z.array(conflictSchema).max(50).default([]),
  suggestions: z.array(rawSuggestionSchema).max(50).default([]),
});

/**
 * Parse + normalise the model's analysis JSON. Returns `null` on a structural mismatch (so
 * `runStructuredCompletion` retries once), or the cleaned {@link AdvisorAnalysis} on success.
 * Normalisation: drop non-applyable keys from each `patch`, drop suggestions left with an empty
 * patch, and mint a stable `id` for any suggestion the model didn't give one.
 */
export function validateAdvisorAnalysis(parsed: unknown): AdvisorAnalysis | null {
  const result = rawAnalysisSchema.safeParse(parsed);
  if (!result.success) return null;

  const suggestions: AdvisorSuggestion[] = [];
  // The client keys each suggestion (React list key + apply/error state) by `id`, so ids MUST be
  // unique. The model can emit a duplicate id (or omit one, colliding with a minted `suggestion-N`),
  // so mint a guaranteed-unique id: prefer a non-empty, not-yet-seen model id; otherwise fall back to
  // a stable index-based id, bumping the index until it's free.
  const usedIds = new Set<string>();
  result.data.suggestions.forEach((s, index) => {
    const patch = Object.fromEntries(
      Object.entries(s.patch).filter(([key]) => APPLYABLE_SET.has(key))
    ) as Partial<Record<AdvisorApplyableField, unknown>>;
    if (Object.keys(patch).length === 0) return; // prose-only — not an applyable suggestion

    const trimmed = s.id?.trim();
    let id = trimmed && trimmed.length > 0 ? trimmed : `suggestion-${index + 1}`;
    let n = index + 1;
    while (usedIds.has(id)) id = `suggestion-${++n}`;
    usedIds.add(id);

    suggestions.push({
      id,
      title: s.title,
      rationale: s.rationale,
      severity: s.severity,
      patch,
    });
  });

  return { conflicts: result.data.conflicts, suggestions };
}
