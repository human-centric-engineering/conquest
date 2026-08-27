/**
 * DEMO-ONLY (brand kit): demo-client square brand mark.
 *
 * POST   /api/v1/app/demo-clients/:id/mark — upload (multipart, field `file`)
 * DELETE /api/v1/app/demo-clients/:id/mark — remove
 *
 * The mark is the device a layout can set on a corner or a stage without reserving a
 * lockup's width for it. Complements the `logoMarkUrl` field on PATCH
 * /api/v1/app/demo-clients/:id: an admin can either link an external https image or upload
 * one, and both land in the same column.
 *
 * See `_lib/brand-upload.ts` for the shared pipeline and BRAND_MARK_SPEC for the rules —
 * squareness is enforced here, unlike the logo.
 */

import { brandImageHandlers } from '@/app/api/v1/app/demo-clients/_lib/brand-upload';

export const { POST, DELETE } = brandImageHandlers('mark');
