/**
 * App database drift-probe registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: `scripts/db/check-drift.ts` (run by `npm run db:drift-check`, in
 * CI, and by `/pre-pr`) calls this once, then probes everything you register
 * here alongside Sunrise's own A-series objects.
 *
 * Register the Prisma-*unmodelled* objects your app adds — most commonly the
 * hand-written FK constraint behind a satellite `User` table (see
 * CUSTOMIZATION.md §5). Prisma can't see those, so without a probe a future
 * `migrate dev` can silently drop one and CI won't notice.
 *
 * Example (the satellite-FK recipe from CUSTOMIZATION.md §5):
 *
 *   import {
 *     registerAppDriftProbe,
 *     constraintExists,
 *   } from '@/lib/db/drift-probes';
 *
 *   export function registerAppDriftProbes(): void {
 *     registerAppDriftProbe({
 *       name: 'AppUserProfile_userId_fkey (hand-written FK → User)',
 *       kind: 'FK constraint',
 *       table: 'AppUserProfile',
 *       // 2nd arg asserts the constraint definition text — pin the ON DELETE
 *       // action so a fork can't quietly drop the GDPR cascade.
 *       probe: constraintExists('AppUserProfile_userId_fkey', 'ON DELETE CASCADE'),
 *     });
 *   }
 *
 * Available probe factories from `@/lib/db/drift-probes`: `indexExists`,
 * `constraintExists` (optional definition-substring assertion), `columnExists`.
 *
 * Full guide: CUSTOMIZATION.md §5 · .context/database/prisma-unmodelled-objects.md
 */
import { indexExists, registerAppDriftProbe } from '@/lib/db/drift-probes';

export function registerAppDriftProbes(): void {
  // F4.1 adaptive selection: the HNSW ANN index on the Prisma-Unsupported
  // `AppQuestionSlot.embedding` pgvector column. Prisma can't model it, so a
  // future `migrate dev` schema-diff would silently emit a DROP — this probe
  // makes that drop fail the drift check instead. See the drift warning on
  // AppQuestionSlot in prisma/schema/app-questionnaire.prisma.
  registerAppDriftProbe({
    name: 'idx_app_question_slot_embedding (HNSW vector index)',
    kind: 'HNSW index',
    table: 'app_question_slot',
    probe: indexExists('idx_app_question_slot_embedding'),
  });
}
