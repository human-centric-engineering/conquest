/**
 * Sentinel select values for the alpha admin session browser filters.
 *
 * Prisma-free on purpose: both the server read model (`admin-session-list.ts`) and the client filter
 * bar (`session-filters.tsx`) import these, so they must live in a module that never pulls the DB
 * client into the browser bundle. Real ids are cuids, so these string sentinels can never collide.
 */

/** Client filter: questionnaires with no attributed demo client. */
export const CLIENT_UNASSIGNED = 'unassigned';

/** Round filter: sessions started outside any round (open-ended). */
export const ROUND_NONE = 'none';
