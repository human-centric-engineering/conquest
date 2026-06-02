/**
 * Shared status → badge descriptor for the questionnaire admin surface (P2 / F2.1).
 *
 * Keyed by `AppQuestionnaireStatus` so it is **exhaustive**: adding a status to the
 * single-source `APP_QUESTIONNAIRE_STATUSES` tuple forces a compile error here
 * until its label + variant are declared. Both the list table and the detail
 * header render through this, so a new status can't silently fall through to a
 * wrong default variant.
 */

import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';

export const QUESTIONNAIRE_STATUS_BADGE: Record<
  AppQuestionnaireStatus,
  { label: string; variant: 'secondary' | 'default' | 'outline' }
> = {
  draft: { label: 'Draft', variant: 'secondary' },
  launched: { label: 'Launched', variant: 'default' },
  archived: { label: 'Archived', variant: 'outline' },
};
