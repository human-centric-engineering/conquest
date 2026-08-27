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
   * When the version uses the `adaptive` strategy, launch requires the question slots to be
   * embedded — adaptive ranks candidates by vector similarity,
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
  /**
   * The number of `likert` question slots in the version. The "every scale is labelled" check is
   * only shown when this is ≥1 — a questionnaire with no rating scales never sees it.
   */
  likertCount?: number;
  /**
   * How many of those likert slots lack complete per-point labels. Launch requires this to be 0:
   * a labelled scale renders words (not bare numbers) in the report, and a purely numeric rating
   * should use the `numeric` type instead. See [[hasCompleteLikertLabels]].
   */
  unlabelledLikertCount?: number;
  /**
   * The number of `matrix` (rating-grid) question slots. Matrices are rating scales too, so they
   * share the "every rating scale is labelled" check — it appears when likert OR matrix count ≥1.
   */
  matrixCount?: number;
  /**
   * How many matrix slots are misconfigured (no rows, or an unlabelled/unanchored shared scale).
   * Launch requires this to be 0, for the same reason as {@link unlabelledLikertCount}. See
   * [[isMatrixLabelled]].
   */
  misconfiguredMatrixCount?: number;
  /**
   * True when this version has `conditionalTopics.enabled`. The Conditional Topics row appears ONLY then:
   * a version that never opted in has nothing to check, and showing a passing row for a feature
   * nobody turned on is noise on every other questionnaire in the system.
   */
  conditionalTopicsEnabled?: boolean;
  /**
   * How many `error`-severity findings `validateConditionalTopics` returns. Launch requires 0 —
   * an orphaned question under active scope is a question that can never be asked, and nothing
   * else in the system would report it. Warnings never block.
   */
  conditionalTopicsErrorCount?: number;
  /**
   * How many `conditional` topics the version has. Read only while conditional topics is OFF, to raise
   * the warning row below: conditional topics that nothing ever chooses between are asked to every
   * respondent, and until F17.22 nothing outside the Conditional topics tab said so. Never blocks —
   * "every topic is asked" is a legitimate way to run a questionnaire, just rarely the intended one
   * once someone has authored conditions for it.
   */
  conditionalTopicsConditionalCount?: number;
  /**
   * How many topics the Routing Analyst's PENDING proposal contains — `AppQuestionnaireTopicDraft`,
   * which is explicitly not live. Above zero, launch is blocked until the admin accepts or discards
   * it: the document described routing, a paid model call turned that into a concrete proposal, and
   * nothing between the draft and the respondent reads it. Before this check the whole chain was
   * invisible from here, so a version whose Topics tab was never opened launched looking clean.
   *
   * The exit is *look at it*, not *agree with it* — discarding the proposal clears the row just as
   * accepting does. That is what makes it a legitimate blocker rather than a nudge with teeth.
   */
  conditionalTopicsDraftTopicCount?: number;
  /**
   * True when the ingestion-time candidacy check said this document describes routing and the
   * analyst has still not produced a proposal from it (the Topics tab's auto-trigger is pending).
   *
   * The non-streaming ingest path leaves exactly this state: the verdict is cached on the version
   * and the analyst runs on the first Topics-tab visit, so an admin who never opens that tab had no
   * draft AND no signal.
   *
   * Self-clearing, but not by itself: the flag goes false as soon as a run succeeds (there is then
   * a draft to review) or the bounded retries are spent — and retries are only spent by the
   * dispatcher, so an analyst that never reaches it never spends one. `detectedButUnreviewed`
   * (`launchability.ts`) carries the other half of the contract by refusing to raise this at all
   * when the Routing Analyst agent is unseeded. Read the two together before changing either: on
   * its own, "the bounded retries are spent" is not enough to promise this row fails open.
   */
  conditionalTopicsDetectedUnreviewed?: boolean;
}

/** Stable identifier for each check — maps to the server `missing` detail and a UI configure link. */
export type LaunchCheckKey =
  | 'goal'
  | 'audience'
  | 'sections'
  | 'questions'
  | 'config'
  | 'scaleLabels'
  | 'embeddings'
  | 'dataSlots'
  | 'dataSlotEmbeddings'
  | 'conditionalTopics'
  | 'conditionalTopicsOff'
  | 'conditionalTopicsReview';

/**
 * Whether a failed check stops a launch.
 *
 * `blocker` is every check that predates F17.22 and the default posture for a new one: launch is
 * refused until it passes. `warning` describes a version that CAN launch but probably should not
 * be launched as it stands — it renders on the checklist and is deliberately ignored by every
 * readiness verdict. Explicit on every check rather than optional-with-a-default, so a future
 * check cannot become non-blocking by omission.
 */
export type LaunchCheckSeverity = 'blocker' | 'warning';

export interface LaunchReadinessCheck {
  key: LaunchCheckKey;
  ok: boolean;
  /** Short, admin-facing label (e.g. "A goal is set"). */
  label: string;
  severity: LaunchCheckSeverity;
}

/**
 * The one predicate that decides whether a check stands between a version and launch.
 *
 * Four surfaces compute readiness from the same check list — {@link isLaunchReady}, the server
 * `loadLaunchReadiness`, the status route's launch gate, and the checklist UI. Before warnings
 * existed each did it with its own `!c.ok`, which is exactly how a non-blocking row would have
 * silently become a blocker in three of the four.
 */
export function blocksLaunch(check: LaunchReadinessCheck): boolean {
  return check.severity === 'blocker' && !check.ok;
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
      severity: 'blocker',
    },
    {
      key: 'audience',
      ok: hasAudience(input.audience),
      label: 'An audience is described',
      severity: 'blocker',
    },
    {
      key: 'sections',
      ok: input.sectionCount >= 1,
      label: 'At least one section',
      severity: 'blocker',
    },
    {
      key: 'questions',
      ok: input.questionCount >= 1,
      label: 'At least one question',
      severity: 'blocker',
    },
    { key: 'config', ok: input.configSaved, label: 'Configuration saved', severity: 'blocker' },
    ...((input.likertCount ?? 0) >= 1 || (input.matrixCount ?? 0) >= 1
      ? [
          {
            key: 'scaleLabels' as const,
            ok:
              (input.unlabelledLikertCount ?? 0) === 0 &&
              (input.misconfiguredMatrixCount ?? 0) === 0,
            label: 'Every rating scale is labelled',
            severity: 'blocker' as const,
          },
        ]
      : []),
    ...(input.embeddingsRequired
      ? [
          {
            key: 'embeddings' as const,
            ok: input.embeddingsReady === true,
            label: 'Questions embedded for adaptive selection',
            severity: 'blocker' as const,
          },
        ]
      : []),
    ...(input.dataSlotsRequired
      ? [
          {
            key: 'dataSlots' as const,
            ok: input.dataSlotsReady,
            label: 'Data slots generated',
            severity: 'blocker' as const,
          },
        ]
      : []),
    ...(input.dataSlotEmbeddingsRequired
      ? [
          {
            key: 'dataSlotEmbeddings' as const,
            ok: input.dataSlotEmbeddingsReady === true,
            label: 'Data slots embedded for adaptive selection',
            severity: 'blocker' as const,
          },
        ]
      : []),
    // Before either conditional-topics row, because reviewing the proposal is what decides what the
    // other two describe: accepting it may add the conditional topics the "off" warning counts, and
    // the coherence row can only judge a topic set once it is live.
    ...(conditionalTopicsReviewPending(input)
      ? [
          {
            key: 'conditionalTopicsReview' as const,
            ok: false,
            label: conditionalTopicsReviewLabel(input),
            severity: 'blocker' as const,
          },
        ]
      : []),
    ...(input.conditionalTopicsEnabled
      ? [
          {
            key: 'conditionalTopics' as const,
            ok: (input.conditionalTopicsErrorCount ?? 0) === 0,
            label: 'Conditional topics topics are coherent',
            severity: 'blocker' as const,
          },
        ]
      : []),
    // The mirror image of the row above, and the only warning on the list: conditional topics with
    // the feature off. The AI proposes them, an admin accepts them, and every one of them is then
    // asked to everybody — a state the Conditional topics tab reports plainly and nothing else did.
    ...(!input.conditionalTopicsEnabled && (input.conditionalTopicsConditionalCount ?? 0) > 0
      ? [
          {
            key: 'conditionalTopicsOff' as const,
            ok: false,
            label: conditionalTopicsOffLabel(input.conditionalTopicsConditionalCount ?? 0),
            severity: 'warning' as const,
          },
        ]
      : []),
  ];
}

/**
 * Is there Conditional Topics work this document asked for that nobody has looked at yet?
 *
 * Two states, one row: a proposal is waiting (`draftTopicCount`), or the document was flagged and
 * the proposal has not been produced yet (`detectedUnreviewed`). They are mutually exclusive in
 * practice — the auto-trigger flag goes false the moment a draft lands — and the draft wins when
 * both are somehow set, because a proposal on screen is the more actionable of the two.
 */
function conditionalTopicsReviewPending(input: LaunchReadinessInput): boolean {
  return (
    (input.conditionalTopicsDraftTopicCount ?? 0) > 0 ||
    input.conditionalTopicsDetectedUnreviewed === true
  );
}

/** "4 suggested topics are waiting for review." */
function conditionalTopicsReviewLabel(input: LaunchReadinessInput): string {
  const count = input.conditionalTopicsDraftTopicCount ?? 0;
  if (count === 1) return '1 suggested topic is waiting for review';
  if (count > 1) return `${count} suggested topics are waiting for review`;
  return 'This document describes who should be asked what — the suggested topics are not reviewed yet';
}

/** "Conditional topics is off, so all 4 conditional topics are asked to everyone." */
function conditionalTopicsOffLabel(conditionalCount: number): string {
  return conditionalCount === 1
    ? 'Conditional topics is off, so its 1 conditional topic is asked to everyone'
    : `Conditional topics is off, so all ${conditionalCount} conditional topics are asked to everyone`;
}

/**
 * True when every BLOCKING readiness check passes — the bar for launch AND for a pre-launch
 * preview. Warnings are reported, never enforced (see {@link blocksLaunch}).
 */
export function isLaunchReady(input: LaunchReadinessInput): boolean {
  return !launchReadinessChecks(input).some(blocksLaunch);
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
