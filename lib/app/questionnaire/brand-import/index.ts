/**
 * Brand import — public surface.
 *
 * Mirrors `theming/index.ts`: one import path for the route, the admin dialog and the tests, so a
 * module can be split or renamed without a sweep across call sites.
 *
 * The pure modules (`result`, `color`, `contrast`) are safe in a `'use client'` component; `palette`
 * (sharp), `assign-roles` (Prisma + provider) and `analyse` are server-only, so the dialog imports
 * the types from `result` directly rather than through this barrel.
 */

export {
  IMPORTABLE_FIELDS,
  IMPORTABLE_COLOR_FIELDS,
  isImportableColorField,
  analysedResult,
  blockedResult,
  type BrandImportNextStep,
  type BrandImportOutcome,
  type BrandImportResult,
  type BrandImportSource,
  type ColorCandidate,
  type ImportConfidence,
  type ImportableColorField,
  type ImportableField,
  type ProposedField,
} from '@/lib/app/questionnaire/brand-import/result';

export {
  NEUTRAL_CHROMA_THRESHOLD,
  chroma,
  distance,
  isNeutral,
  parseHex,
  toHex,
  type Rgb,
} from '@/lib/app/questionnaire/brand-import/color';

export { extractPalette, mergePalettes } from '@/lib/app/questionnaire/brand-import/palette';
export {
  assignRoles,
  narrowAssignments,
  type AssignRolesInput,
  type AssignRolesResult,
  type RoleAssignment,
} from '@/lib/app/questionnaire/brand-import/assign-roles';
export { annotateContrast } from '@/lib/app/questionnaire/brand-import/contrast';
export {
  analyseScreenshot,
  analyseUrl,
  assignmentsToFields,
} from '@/lib/app/questionnaire/brand-import/analyse';

export {
  extractColorFrequency,
  extractDeclaredBrandColors,
  parseCssColor,
} from '@/lib/app/questionnaire/brand-import/css-color';

export {
  DEFAULT_BUDGET,
  HarvestBudget,
  fetchResource,
  type BudgetLimits,
  type FetchOutcome,
} from '@/lib/app/questionnaire/brand-import/fetch';

export {
  discoverFonts,
  discoverImages,
  harvestSite,
  normaliseUrl,
  type DiscoveredImage,
  type HarvestOutcome,
  type HarvestedBrand,
  type ImageProvenance,
} from '@/lib/app/questionnaire/brand-import/harvest';

export { matchFontPairing, type FontMatch } from '@/lib/app/questionnaire/brand-import/font-match';
