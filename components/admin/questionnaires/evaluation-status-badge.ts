/**
 * Status + severity → badge descriptor for the design-evaluation admin surface (F5.2).
 *
 * Both the runs table and the run detail render statuses/severities through these maps so
 * the colour vocabulary stays consistent. `EVALUATION_RUN_STATUS_BADGE` is keyed by the
 * terminal run statuses; `FINDING_SEVERITY_BADGE` by the `FINDING_SEVERITIES` tuple. An
 * `UNKNOWN_*` fallback keeps an unexpected stored value from throwing in the UI (the run
 * `status` and finding `severity` are plain Strings validated at the seam, not DB enums).
 */

import {
  FINDING_REVIEW_STATUS_LABELS,
  FINDING_SEVERITY_LABELS,
  type FindingSeverity,
  type FindingReviewStatus,
} from '@/lib/app/questionnaire/evaluation';

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

interface BadgeDescriptor {
  label: string;
  variant: BadgeVariant;
}

export const EVALUATION_RUN_STATUS_BADGE: Record<string, BadgeDescriptor> = {
  completed: { label: 'Completed', variant: 'default' },
  partial: { label: 'Partial', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
};

export const UNKNOWN_RUN_STATUS_BADGE: BadgeDescriptor = { label: 'Unknown', variant: 'outline' };

/**
 * Colour per severity. The WORD comes from `FINDING_SEVERITY_LABELS` in `lib/`, not from here:
 * the Questionnaire Pack prints the same values and cannot import a component module, so a second
 * hand-written label map here is the thing that would let the console and a client-facing PDF
 * disagree about what `major` is called.
 */
export const FINDING_SEVERITY_BADGE: Record<FindingSeverity, BadgeDescriptor> = {
  major: { label: FINDING_SEVERITY_LABELS.major, variant: 'destructive' },
  minor: { label: FINDING_SEVERITY_LABELS.minor, variant: 'secondary' },
  info: { label: FINDING_SEVERITY_LABELS.info, variant: 'outline' },
};

export const UNKNOWN_SEVERITY_BADGE: BadgeDescriptor = { label: 'Unknown', variant: 'outline' };

/**
 * Finding review-status badge (F5.3), keyed by `FINDING_REVIEW_STATUSES`. `stale` is NOT here
 * — it's a derived flag rendered as a separate overlay, not a stored status (see the view's
 * `stale`/`applicable`).
 */
export const FINDING_REVIEW_STATUS_BADGE: Record<FindingReviewStatus, BadgeDescriptor> = {
  pending: { label: FINDING_REVIEW_STATUS_LABELS.pending, variant: 'outline' },
  accepted: { label: FINDING_REVIEW_STATUS_LABELS.accepted, variant: 'secondary' },
  declined: { label: FINDING_REVIEW_STATUS_LABELS.declined, variant: 'outline' },
  applied: { label: FINDING_REVIEW_STATUS_LABELS.applied, variant: 'default' },
};

export const UNKNOWN_REVIEW_STATUS_BADGE: BadgeDescriptor = {
  label: 'Unknown',
  variant: 'outline',
};

/** Resolve a run-status badge, falling back to a neutral descriptor for unknown values. */
export function runStatusBadge(status: string): BadgeDescriptor {
  return EVALUATION_RUN_STATUS_BADGE[status] ?? UNKNOWN_RUN_STATUS_BADGE;
}

/**
 * Resolve a finding-severity badge, falling back to a neutral descriptor for an unexpected
 * stored value. `severity` is a plain String column, so a future/anomalous value must not
 * crash the detail render — the same defensive posture as {@link runStatusBadge}.
 */
export function findingSeverityBadge(severity: string): BadgeDescriptor {
  return (
    (FINDING_SEVERITY_BADGE as Record<string, BadgeDescriptor>)[severity] ?? UNKNOWN_SEVERITY_BADGE
  );
}

/** Resolve a finding review-status badge, falling back to a neutral descriptor (F5.3). */
export function findingReviewStatusBadge(status: string): BadgeDescriptor {
  return (
    (FINDING_REVIEW_STATUS_BADGE as Record<string, BadgeDescriptor>)[status] ??
    UNKNOWN_REVIEW_STATUS_BADGE
  );
}
