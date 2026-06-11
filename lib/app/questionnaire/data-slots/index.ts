/**
 * Data-slots domain module barrel (the semantic abstraction layer over questions).
 * Pure types, Zod schemas, and the generator prompt — no Prisma/Next. Route serializers
 * and client components import from here.
 */

export * from '@/lib/app/questionnaire/data-slots/views';
export * from '@/lib/app/questionnaire/data-slots/schemas';
export * from '@/lib/app/questionnaire/data-slots/generation';
