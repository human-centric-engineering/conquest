/**
 * Respondent chat-banner header module barrel.
 *
 * The pure contract (`types`) + schedule derivation (`schedule`) and the DB resolution seam
 * (`resolve`). The band component consumes the types + `buildScheduleView`; the respondent page
 * surfaces consume the resolvers. See .context/app/questionnaire/chat-banner.md.
 */

export type { BandHeader, BandRound } from '@/lib/app/questionnaire/header/types';
export {
  buildScheduleView,
  formatDateRange,
  type ScheduleStatus,
  type ScheduleView,
} from '@/lib/app/questionnaire/header/schedule';
export { resolveSessionHeader, resolveVersionHeader } from '@/lib/app/questionnaire/header/resolve';
