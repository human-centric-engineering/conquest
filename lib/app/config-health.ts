/**
 * App-defined config-health checks (fork-owned scaffold).
 *
 * **Fork-owned** — Sunrise ships this empty and doesn't change it after release, so your edits merge
 * cleanly on upstream pulls (the stable contract is this file's export, not its body). The runner
 * (`lib/config-health/run.ts`) merges these with the platform checks in `lib/config-health/checks.ts`.
 *
 * Add app-specific operationally-critical settings here, e.g.:
 *   export const appConfigHealthChecks: ConfigHealthCheck[] = [
 *     { key: 'STRIPE_SECRET_KEY', label: 'Stripe', severity: 'critical',
 *       description: 'Billing is disabled without it.', remediation: 'Set STRIPE_SECRET_KEY.',
 *       detect: () => !!process.env.STRIPE_SECRET_KEY },
 *   ];
 *
 * Every `detect` must report presence only — never a secret value.
 */

import type { ConfigHealthCheck } from '@/lib/config-health/types';

export const appConfigHealthChecks: ConfigHealthCheck[] = [];
