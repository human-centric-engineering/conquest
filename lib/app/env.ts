import { z } from 'zod';

/**
 * App-extension environment schema (fork-readiness seam 11).
 *
 * Downstream apps/forks declare their OWN server-side environment variables
 * here instead of editing the closed core schema in `lib/env.ts`. The core
 * validator merges this object into the single fail-fast startup parse, so an
 * app-declared variable that is missing or invalid aborts boot exactly like a
 * core variable would — and the validated value is available, typed, on the
 * exported `env` object (`import { env } from '@/lib/env'`).
 *
 * **Scope: server-side only.** `NEXT_PUBLIC_*` (client) variables are out of
 * scope for this seam — those are statically inlined by Next.js at build time;
 * access them directly via `process.env.NEXT_PUBLIC_*` in client code, per the
 * guidance in `lib/env.ts`.
 *
 * This file is the first inhabitant of the `lib/app/**` extension surface
 * (seam 5): it must stay framework-agnostic — Zod only, no runtime `next/*`
 * imports. ESLint enforces that boundary.
 *
 * Default: empty (the template ships no app vars). Apps extend it, e.g.
 *
 * ```ts
 * export const appEnvSchema = z.object({
 *   STRIPE_SECRET_KEY: z.string().min(1),
 *   FEATURE_X_WEBHOOK_URL: z.string().url().optional(),
 * });
 * ```
 *
 * @see lib/env.ts — where this is merged into the startup parse
 */
export const appEnvSchema = z.object({});
