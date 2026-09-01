/**
 * Sectioned interviews (P21) — the barrel.
 *
 * Import from here rather than the individual modules, EXCEPT from
 * `lib/app/questionnaire/types.ts`, which must reach `settings.ts` directly: this barrel pulls in
 * `close.ts`, which imports `types.ts` back, and the cycle would be real. Same discipline as the
 * scope module's leaf/barrel split.
 */

export * from '@/lib/app/questionnaire/sections/types';
export * from '@/lib/app/questionnaire/sections/settings';
export * from '@/lib/app/questionnaire/sections/resolve';
export * from '@/lib/app/questionnaire/sections/run';
export * from '@/lib/app/questionnaire/sections/state';
export * from '@/lib/app/questionnaire/sections/view';
export * from '@/lib/app/questionnaire/sections/close';
