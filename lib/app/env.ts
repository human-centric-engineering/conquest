import { z } from 'zod';

/**
 * App-defined server environment variables.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly when you pull an upstream
 * version (the stable contract is this file's export, not its body). Treat it
 * like the landing page: a starting point you're expected to modify.
 *
 * `lib/env.ts` merges this into the same fail-fast startup parse as the core
 * vars; server-side only. Extend, e.g.:
 *   `export const appEnvSchema = z.object({ STRIPE_SECRET_KEY: z.string().min(1) });`
 *
 * ## Framework tiers: the dynamic-import rule does NOT apply here (#535)
 *
 * §4 tells you to import your framework tier **dynamically** from the boot seam
 * (`await import('@/lib/framework')`), because a static framework specifier is
 * resolved at `next build` and breaks the build in vanilla Sunrise or any fork
 * without that folder.
 *
 * **That rule cannot be honoured at this file, and you should not try.**
 * `lib/env.ts` merges this schema during a synchronous module-load parse — the
 * schema has to exist at module-evaluation time, and `lib/env.ts` is imported by
 * essentially everything. There is no await to hang a dynamic import on. So a
 * framework tier declaring its own variables has exactly one option:
 *
 *   import { myFrameworkEnvSchema } from '@/lib/framework/env';   // necessarily static
 *   export const appEnvSchema = myFrameworkEnvSchema;
 *
 * This is safe **in your fork** for the same reason it is unsafe in core: the
 * specifier only has to resolve in a tree that actually has `lib/framework/`.
 * Yours does. Vanilla Sunrise ships `z.object({})` here and references no
 * framework vocabulary anywhere, which is the property the rule protects — and
 * it stays protected, because this file is fork-owned and Sunrise never edits it
 * after release.
 *
 * A mechanism to make this dynamic (lazy env, a registration callback) was
 * considered and rejected upstream: it would make the fail-fast startup parse
 * conditional, which is the one property the whole module exists for. Recorded
 * so nobody re-derives it.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/environment/overview.md
 */
export const appEnvSchema = z.object({});
