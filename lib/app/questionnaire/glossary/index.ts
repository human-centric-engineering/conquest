/**
 * Definitions / glossary domain module barrel (P16).
 *
 * Pure types, normalisation, Zod schemas, the matcher, the prompt-injection formatter, and the
 * report-appendix builder — no Prisma, no Next. Routes, the capability, and client components all
 * import from here.
 *
 * DELIBERATELY NOT EXPORTED: `glossary/resolve.ts`. It imports `@/lib/db/client`, and a client
 * component importing the matcher through this barrel would drag server code into the browser
 * bundle. Server callers import that module by its own path. (Same trap documented on
 * `authoring/definition-export.ts`.)
 */

export * from '@/lib/app/questionnaire/glossary/types';
export * from '@/lib/app/questionnaire/glossary/normalize';
export * from '@/lib/app/questionnaire/glossary/schemas';
export * from '@/lib/app/questionnaire/glossary/matcher';
export * from '@/lib/app/questionnaire/glossary/injection';
export * from '@/lib/app/questionnaire/glossary/analysis-schema';
export * from '@/lib/app/questionnaire/glossary/analysis-events';
export * from '@/lib/app/questionnaire/glossary/report-appendix';
