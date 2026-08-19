/**
 * API-key scope vocabulary.
 *
 * Split out of `lib/auth/api-keys.ts` so it can be read from **both** realms:
 * the route handlers that resolve a key (server) and `createApiKeySchema` in
 * `lib/validations/orchestration.ts`, which is imported by `'use client'`
 * admin forms. `api-keys.ts` itself imports Prisma, so the schema could not
 * have taken the scope list from there without dragging the DB client into a
 * client bundle. Nothing here touches Prisma, `next/*` or the filesystem.
 *
 * `lib/auth/api-keys.ts` re-exports all of this, so existing imports are
 * unchanged.
 *
 * @see lib/app/api-key-scopes.ts — the fork-owned seam this reads
 */

import { logger } from '@/lib/logging';
import { APP_API_KEY_SCOPES } from '@/lib/app/api-key-scopes';

/** Scopes Sunrise itself defines. */
export const CORE_API_KEY_SCOPES = ['chat', 'analytics', 'knowledge', 'webhook', 'admin'] as const;

export type CoreApiKeyScope = (typeof CORE_API_KEY_SCOPES)[number];

/**
 * An API-key scope name: a core one, or one a fork added in
 * `lib/app/api-key-scopes.ts`.
 *
 * `string & {}` keeps autocomplete on the core names while accepting a fork's —
 * the same trick `RateLimitRule.tier` uses. This was a closed union, which is
 * what made least privilege unavailable to forks (#542): a fork could *check* a
 * scope of its own, but no user could ever *mint* one to check.
 */
export type ApiKeyScope = CoreApiKeyScope | (string & {});

/** Lower snake_case, so a scope can never be confused for a path or a header. */
const SCOPE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Every mintable scope: core, plus whatever the fork declared.
 *
 * App entries are validated rather than trusted. A malformed or colliding one
 * is dropped and logged, because this set is the allowlist deciding what
 * `POST /api/v1/user/api-keys` will issue — a junk value silently widening it
 * is the one outcome worse than the fork's scope not working.
 */
function buildValidScopes(): ReadonlySet<string> {
  const valid = new Set<string>(CORE_API_KEY_SCOPES);
  for (const scope of APP_API_KEY_SCOPES) {
    if (!SCOPE_NAME.test(scope)) {
      logger.error('api-keys: ignoring a malformed app scope', { scope });
      continue;
    }
    if (valid.has(scope)) {
      logger.error('api-keys: ignoring an app scope that collides with a core scope', { scope });
      continue;
    }
    valid.add(scope);
  }
  return valid;
}

const VALID_SCOPES = buildValidScopes();

/** Every scope a key may be minted with, core first. Drives validation and the UI. */
export function listValidApiKeyScopes(): string[] {
  return [...VALID_SCOPES];
}

/**
 * Validate that every scope is one this install can mint.
 *
 * Returns a plain boolean rather than a type predicate: `ApiKeyScope` is an
 * open type now, so `scopes is ApiKeyScope[]` would narrow nothing while
 * reading as a guarantee it cannot make. The runtime check is the whole point.
 */
export function validateScopes(scopes: string[]): boolean {
  return scopes.every((s) => VALID_SCOPES.has(s));
}

/**
 * Check if the provided scopes include the required scope.
 *
 * `admin` satisfies everything — unchanged, and the reason an admin-scoped key
 * is the one that requires an ADMIN user to mint.
 */
export function hasScope(scopes: string[], required: ApiKeyScope): boolean {
  return scopes.includes(required) || scopes.includes('admin');
}
