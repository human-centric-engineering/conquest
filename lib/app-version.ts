import packageJson from '@/package.json';

/**
 * The **fork's app version** — derived from `package.json`.
 *
 * This is the FORK-OWNED counterpart to `SUNRISE_VERSION` in
 * `lib/sunrise-version.ts`. The two are deliberately separate:
 *
 *   - `APP_VERSION` (this file) tracks the **fork's** app version. A fork
 *     edits `package.json.version` on every release; this constant follows.
 *   - `SUNRISE_VERSION` tracks the **Sunrise platform** version. Sunrise
 *     edits it on Sunrise releases; forks merge it through but do NOT edit
 *     `lib/sunrise-version.ts` directly.
 *
 * See `VERSIONING.md` for the public-surface contract and
 * `CUSTOMIZATION.md` §8 for the fork-author perspective.
 *
 * # Why import `package.json` directly?
 *
 * The previous pattern across the codebase was:
 *
 *     const APP_VERSION = process.env.npm_package_version || '1.0.0';
 *
 * That env var is only set when the process is launched by `npm` / `yarn` /
 * `pnpm` running an npm script. It is **not** set when the process is
 * launched by `node` directly — which includes Docker `CMD ["node", ...]`,
 * Next.js standalone builds (`node .next/standalone/server.js`), PM2 direct
 * launch, and several serverless runtimes. In those (common) deployments
 * the fallback literal fired and the reported version was wrong. A direct
 * `package.json` import has none of those failure modes: at build time the
 * version is inlined, and at runtime it cannot disagree with itself.
 *
 * # Conventions
 *
 * - **Server-side use only.** Symmetric with `lib/sunrise-version.ts` — we
 *   do not mark this file `server-only` so it can be imported from
 *   platform-agnostic tiers (e.g. the orchestration MCP code). Render the
 *   fork's version in client components by fetching `/api/health` (where
 *   it appears as the `version` field), not by importing this constant.
 */
export const APP_VERSION: string = packageJson.version;
