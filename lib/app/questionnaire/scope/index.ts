/**
 * Conditional Topics (P17) — barrel.
 *
 * Re-exports the pure surface: the vocabulary + narrowers (`types`) and the resolver (`resolve`).
 * Server-only members (the planner, the analyst, the Prisma loaders) are deliberately NOT re-exported
 * here — this barrel stays importable from client components, the same discipline
 * `lib/app/questionnaire/selection/index.ts` keeps.
 */

export * from '@/lib/app/questionnaire/scope/types';
export * from '@/lib/app/questionnaire/scope/resolve';
