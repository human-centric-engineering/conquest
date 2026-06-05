/**
 * Status + severity → badge descriptor for the design-evaluation admin surface (F5.2).
 *
 * Both the runs table and the run detail render statuses/severities through these maps so
 * the colour vocabulary stays consistent. `EVALUATION_RUN_STATUS_BADGE` is keyed by the
 * terminal run statuses; `FINDING_SEVERITY_BADGE` by the `FINDING_SEVERITIES` tuple. An
 * `UNKNOWN_*` fallback keeps an unexpected stored value from throwing in the UI (the run
 * `status` and finding `severity` are plain Strings validated at the seam, not DB enums).
 */

import type { FindingSeverity } from '@/lib/app/questionnaire/evaluation';

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

export const FINDING_SEVERITY_BADGE: Record<FindingSeverity, BadgeDescriptor> = {
  major: { label: 'Major', variant: 'destructive' },
  minor: { label: 'Minor', variant: 'secondary' },
  info: { label: 'Info', variant: 'outline' },
};

export const UNKNOWN_SEVERITY_BADGE: BadgeDescriptor = { label: 'Unknown', variant: 'outline' };

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
