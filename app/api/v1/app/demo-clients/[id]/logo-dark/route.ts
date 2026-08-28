/**
 * DEMO-ONLY (brand kit): demo-client light-on-dark lockup.
 *
 * POST   /api/v1/app/demo-clients/:id/logo-dark — upload (multipart, field `file`)
 * DELETE /api/v1/app/demo-clients/:id/logo-dark — remove
 *
 * The same artwork as the logo, drawn in light ink for a dark ground. It exists because a
 * client can now choose a dark canvas or a dark band, and a lockup drawn in the brand's own
 * ink disappears on one — a backdrop chip hides the problem rather than solving it.
 * `resolveTheme()` picks between this and `logoUrl` per ground; see `bandLogoUrl`.
 *
 * Same spec as the logo (any shape, same slot). See `_lib/brand-upload.ts`.
 */

import { brandImageHandlers } from '@/app/api/v1/app/demo-clients/_lib/brand-upload';

export const { POST, DELETE } = brandImageHandlers('logo-dark');
