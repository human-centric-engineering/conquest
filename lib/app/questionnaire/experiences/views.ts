/**
 * Experiences — API read models.
 *
 * The shapes the Experience endpoints return and the admin UI consumes. Pure and Prisma-free (the
 * `lib/app/questionnaire/**` boundary): the mappers take structural row types, so the query seam
 * lives in `app/api/v1/app/experiences/_lib/read.ts` while the shape and its narrowing live here.
 * That split is what lets a client component import these types without dragging Prisma into the
 * bundle.
 *
 * Every plain `String` column that carries a vocabulary is narrowed through `narrowToEnum` on the
 * way out, so a stray DB value can never escape as an untyped string.
 */

import { ACCESS_MODES, narrowToEnum, type AccessMode } from '@/lib/app/questionnaire/types';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import {
  EXPERIENCE_CONTINUITY_MODES,
  EXPERIENCE_KINDS,
  EXPERIENCE_ROUTING_FALLBACKS,
  EXPERIENCE_STATUSES,
  EXPERIENCE_STEP_KINDS,
  type ExperienceContinuityMode,
  type ExperienceKind,
  type ExperienceRoutingFallback,
  type ExperienceSettingsShape,
  type ExperienceStatus,
  type ExperienceStepKind,
} from '@/lib/app/questionnaire/experiences/types';

/* -------------------------------------------------------------------------- */
/* Row shapes (structural — no Prisma import)                                 */
/* -------------------------------------------------------------------------- */

/** The experience columns every mapper below reads. */
export interface ExperienceRow {
  id: string;
  demoClientId: string;
  title: string;
  description: string | null;
  kind: string;
  status: string;
  continuityMode: string;
  routingFallback: string;
  minRoutingConfidence: number;
  routingInstructions: string | null;
  costBudgetUsd: number | null;
  accessMode: string;
  publicRef: string | null;
  cohortId: string | null;
  createdBy: string | null;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** The step columns every mapper below reads. */
export interface ExperienceStepRow {
  id: string;
  experienceId: string;
  key: string;
  kind: string;
  questionnaireId: string | null;
  versionId: string | null;
  roundId: string | null;
  title: string;
  purpose: string | null;
  selectionCriteria: string | null;
  /** Facilitated-meeting breakout meta (P15.5); absent on rows read before it existed. */
  durationSeconds?: number | null;
  briefing?: string | null;
  synthesisFocus?: string | null;
  ordinal: number;
  createdAt: Date;
  updatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* View models                                                                */
/* -------------------------------------------------------------------------- */

/** One row in the experiences list. Identity plus the counts the table shows. */
export interface ExperienceListView {
  id: string;
  title: string;
  description: string | null;
  kind: ExperienceKind;
  status: ExperienceStatus;
  continuityMode: ExperienceContinuityMode;
  accessMode: AccessMode;
  demoClientId: string;
  /** Resolved client name, so the table needs no second fetch. */
  demoClientName: string | null;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One step, as the journey editor renders it.
 *
 * `questionnaireTitle` is resolved by the read seam rather than the client: the steps list would
 * otherwise fire one request per row, which the repo's no-N+1 rule forbids. Null means the step
 * has no questionnaire attached yet (a legitimate half-authored state), or that the questionnaire
 * it points at has since been deleted — the pointer is deliberately unmodelled (UG-1), so a
 * dangling reference is possible and must render as "missing" rather than crash.
 */
export interface ExperienceStepView {
  id: string;
  key: string;
  kind: ExperienceStepKind;
  title: string;
  purpose: string | null;
  selectionCriteria: string | null;
  ordinal: number;
  questionnaireId: string | null;
  questionnaireTitle: string | null;
  versionId: string | null;
  /** Version number when the step is pinned; null when it resolves newest-launched at run time. */
  versionNumber: number | null;
  roundId: string | null;
  /**
   * Facilitated-meeting breakout meta (P15.5). Null on every other step kind — and on a breakout
   * whose author has not set them, which is legitimate: an untimed breakout is one the facilitator
   * ends by hand.
   */
  durationSeconds: number | null;
  briefing: string | null;
  synthesisFocus: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The full experience, as the workspace renders it. */
export interface ExperienceDetailView extends ExperienceListView {
  routingFallback: ExperienceRoutingFallback;
  minRoutingConfidence: number;
  routingInstructions: string | null;
  costBudgetUsd: number | null;
  publicRef: string | null;
  cohortId: string | null;
  settings: ExperienceSettingsShape;
  steps: readonly ExperienceStepView[];
}

/* -------------------------------------------------------------------------- */
/* Mappers                                                                    */
/* -------------------------------------------------------------------------- */

/** Narrow the vocabulary columns an experience row shares across both views. */
function baseExperienceView(
  row: ExperienceRow,
  demoClientName: string | null,
  stepCount: number
): ExperienceListView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    kind: narrowToEnum(row.kind, EXPERIENCE_KINDS, 'agentic_switcher'),
    status: narrowToEnum(row.status, EXPERIENCE_STATUSES, 'draft'),
    continuityMode: narrowToEnum(row.continuityMode, EXPERIENCE_CONTINUITY_MODES, 'linked'),
    accessMode: narrowToEnum(row.accessMode, ACCESS_MODES, 'invitation_only'),
    demoClientId: row.demoClientId,
    demoClientName,
    stepCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project one row into the list view. */
export function toExperienceListView(
  row: ExperienceRow,
  demoClientName: string | null,
  stepCount: number
): ExperienceListView {
  return baseExperienceView(row, demoClientName, stepCount);
}

/**
 * Project one step row into its view.
 *
 * `questionnaireTitle` and `versionNumber` are supplied by the caller (the read seam resolves them
 * in one batched query) rather than looked up here, keeping this module Prisma-free.
 */
export function toExperienceStepView(
  row: ExperienceStepRow,
  resolved: { questionnaireTitle?: string | null; versionNumber?: number | null } = {}
): ExperienceStepView {
  return {
    id: row.id,
    key: row.key,
    kind: narrowToEnum(row.kind, EXPERIENCE_STEP_KINDS, 'branch'),
    title: row.title,
    purpose: row.purpose,
    selectionCriteria: row.selectionCriteria,
    durationSeconds: row.durationSeconds ?? null,
    briefing: row.briefing ?? null,
    synthesisFocus: row.synthesisFocus ?? null,
    ordinal: row.ordinal,
    questionnaireId: row.questionnaireId,
    questionnaireTitle: resolved.questionnaireTitle ?? null,
    versionId: row.versionId,
    versionNumber: resolved.versionNumber ?? null,
    roundId: row.roundId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a row plus its steps into the detail view. */
export function toExperienceDetailView(
  row: ExperienceRow,
  demoClientName: string | null,
  steps: readonly ExperienceStepView[]
): ExperienceDetailView {
  return {
    ...baseExperienceView(row, demoClientName, steps.length),
    routingFallback: narrowToEnum(row.routingFallback, EXPERIENCE_ROUTING_FALLBACKS, 'conclude'),
    minRoutingConfidence: row.minRoutingConfidence,
    routingInstructions: row.routingInstructions,
    costBudgetUsd: row.costBudgetUsd,
    publicRef: row.publicRef,
    cohortId: row.cohortId,
    settings: narrowExperienceSettings(row.settings),
    steps,
  };
}

/* -------------------------------------------------------------------------- */
/* Authoring helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The candidate steps a routing decision may choose between — `branch` steps with a questionnaire
 * actually attached, in author order.
 *
 * A branch with no questionnaire is a half-authored row, not a candidate: offering it to the
 * selector would let a run route into nothing. Shared by the selector (P15.2) and the admin
 * readiness panel so both agree on what "ready to route" means.
 */
export function routableSteps(steps: readonly ExperienceStepView[]): readonly ExperienceStepView[] {
  return steps
    .filter((step) => step.kind === 'branch' && step.questionnaireId !== null)
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** The entry step, or null when the author has not designated one yet. */
export function entryStep(steps: readonly ExperienceStepView[]): ExperienceStepView | null {
  return steps.find((step) => step.kind === 'entry') ?? null;
}

/**
 * Why this experience cannot run yet, as author-facing sentences. Empty means ready.
 *
 * Deliberately advisory rather than enforced at the schema: an author reorders and retypes
 * mid-edit, and a constraint that fires halfway through authoring is an obstacle, not a guardrail.
 * The launch action reads this; the editor shows it continuously.
 */
export function experienceBlockers(view: ExperienceDetailView): readonly string[] {
  const blockers: string[] = [];
  const entry = entryStep(view.steps);

  if (!entry) {
    blockers.push('Add an entry step — the questionnaire every run begins with.');
  } else if (!entry.questionnaireId) {
    blockers.push('The entry step has no questionnaire attached.');
  }

  const entries = view.steps.filter((step) => step.kind === 'entry');
  if (entries.length > 1) {
    blockers.push(`Only one entry step is allowed — this experience has ${entries.length}.`);
  }

  if (view.kind === 'agentic_switcher') {
    // A switcher with no candidates has nothing to decide between; it would always conclude,
    // which is a plain questionnaire wearing a costlier hat.
    if (routableSteps(view.steps).length === 0) {
      blockers.push(
        'Add at least one branch step with a questionnaire — a switcher needs somewhere to route.'
      );
    }
    if (view.routingFallback === 'default_step' && routableSteps(view.steps).length === 0) {
      blockers.push('The "default step" fallback needs at least one branch step to fall back to.');
    }
  }

  if (view.kind === 'facilitated_meeting') {
    const breakouts = view.steps.filter(
      (step) => step.kind === 'breakout' && step.questionnaireId !== null
    );
    if (breakouts.length === 0) {
      blockers.push('Add at least one breakout step with a questionnaire attached.');
    }
  }

  return blockers;
}
