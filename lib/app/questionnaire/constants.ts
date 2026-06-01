/**
 * Dependency-light constants for the questionnaire app module.
 *
 * Kept import-free so leaf consumers (e.g. the flag seed) can reference a value
 * like the feature-flag name without pulling in the HTTP/DB-bearing helpers in
 * `feature-flag.ts`.
 */

/**
 * Feature-flag name gating every questionnaire surface. DB-backed (seeded
 * disabled by `prisma/seeds/app-questionnaire/001-questionnaires-flag.ts`), so
 * it can be toggled at runtime without a redeploy. See `feature-flag.ts` for the
 * resolver and route gate.
 */
export const APP_QUESTIONNAIRES_FLAG = 'APP_QUESTIONNAIRES_ENABLED';
