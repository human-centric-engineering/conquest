/**
 * Launch / preview readiness — the single source of the criteria a version must meet before it
 * can be launched OR previewed.
 *
 * Pure (no Prisma / Next): given the version's resolved facts, it returns the per-check results.
 * Consumed by the launch checklist (UI), the status route's launch gate (server), the
 * "Preview as respondent" gate (server), and the overview page (to decide whether to offer the
 * preview before launch). One definition so the four can't drift.
 */

export interface LaunchReadinessInput {
  goal: string | null;
  /**
   * The version's `audience` JSON — `unknown` because callers pass either the typed
   * `AudienceShape | null` (UI / overview page) or raw Prisma JSON (the server seam). An empty
   * `{}` does NOT count as described — see {@link hasAudience}.
   */
  audience: unknown;
  sectionCount: number;
  questionCount: number;
  /** True once a config row exists (the launch gate's deliberate "opt-in" signal). */
  configSaved: boolean;
  /** When the data-slots feature is on, readiness also requires generated data slots. */
  dataSlotsRequired: boolean;
  /** True when the version has ≥1 saved data slot (only checked when required). */
  dataSlotsReady: boolean;
  /**
   * When the version uses the `adaptive` strategy (and the adaptive sub-flag is on), launch
   * requires the question slots to be embedded — adaptive ranks candidates by vector similarity,
   * so an un-embedded version would silently fall back to `weighted`. Optional/defaults off: only
   * the *launch* gate sets this. The preview gate leaves it off so a draft can still be rehearsed
   * (the live turn loop embeds lazily as a backstop). See [[adaptive selection]].
   */
  embeddingsRequired?: boolean;
  /** True when every question slot is embedded (only checked when required). */
  embeddingsReady?: boolean;
  /**
   * When adaptive data-slot selection is on AND the version has data slots, launch requires the
   * data slots to be embedded (the data-slot analogue of `embeddingsRequired`). Launch-only; the
   * preview gate leaves it off (the live loop embeds lazily as a backstop). See [[data slots]].
   */
  dataSlotEmbeddingsRequired?: boolean;
  /** True when every data slot is embedded (only checked when required). */
  dataSlotEmbeddingsReady?: boolean;
}

/** Stable identifier for each check — maps to the server `missing` detail and a UI configure link. */
export type LaunchCheckKey =
  | 'goal'
  | 'audience'
  | 'sections'
  | 'questions'
  | 'config'
  | 'embeddings'
  | 'dataSlots'
  | 'dataSlotEmbeddings';

export interface LaunchReadinessCheck {
  key: LaunchCheckKey;
  ok: boolean;
  /** Short, admin-facing label (e.g. "A goal is set"). */
  label: string;
}

/**
 * An audience JSON counts only when it carries at least one defined field — the editor may persist
 * an empty `{}`, which isn't a described audience.
 */
export function hasAudience(audience: unknown): boolean {
  return (
    typeof audience === 'object' &&
    audience !== null &&
    !Array.isArray(audience) &&
    Object.values(audience as Record<string, unknown>).some((v) => v !== undefined && v !== null)
  );
}

/** The ordered readiness checks for a version. The data-slots row appears only when required. */
export function launchReadinessChecks(input: LaunchReadinessInput): LaunchReadinessCheck[] {
  return [
    {
      key: 'goal',
      ok: Boolean(input.goal && input.goal.trim().length > 0),
      label: 'A goal is set',
    },
    { key: 'audience', ok: hasAudience(input.audience), label: 'An audience is described' },
    { key: 'sections', ok: input.sectionCount >= 1, label: 'At least one section' },
    { key: 'questions', ok: input.questionCount >= 1, label: 'At least one question' },
    { key: 'config', ok: input.configSaved, label: 'Configuration saved' },
    ...(input.embeddingsRequired
      ? [
          {
            key: 'embeddings' as const,
            ok: input.embeddingsReady === true,
            label: 'Questions embedded for adaptive selection',
          },
        ]
      : []),
    ...(input.dataSlotsRequired
      ? [{ key: 'dataSlots' as const, ok: input.dataSlotsReady, label: 'Data slots generated' }]
      : []),
    ...(input.dataSlotEmbeddingsRequired
      ? [
          {
            key: 'dataSlotEmbeddings' as const,
            ok: input.dataSlotEmbeddingsReady === true,
            label: 'Data slots embedded for adaptive selection',
          },
        ]
      : []),
  ];
}

/** True when every readiness check passes — the bar for launch AND for a pre-launch preview. */
export function isLaunchReady(input: LaunchReadinessInput): boolean {
  return launchReadinessChecks(input).every((c) => c.ok);
}

/**
 * Whether "Preview as respondent" can be offered for a version — the single rule the overview page
 * and the workspace header button share (so the header CTA and the overview section can't disagree).
 * Available for a launched version, or a draft that passes the launch-readiness bar, and only when
 * the live-sessions surface is on and the version graph resolved. The server `createPreviewSession`
 * enforces the same rule; archived versions are never previewable.
 */
export function isPreviewAvailable(input: {
  status: string;
  liveSessions: boolean;
  graphPresent: boolean;
  /** Required only for the draft case (a launched version is always previewable when live-sessions is on). */
  readiness?: LaunchReadinessInput;
}): boolean {
  if (!input.liveSessions || !input.graphPresent) return false;
  if (input.status === 'launched') return true;
  if (input.status === 'draft') return input.readiness ? isLaunchReady(input.readiness) : false;
  return false;
}
