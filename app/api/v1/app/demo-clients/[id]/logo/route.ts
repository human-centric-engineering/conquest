/**
 * DEMO-ONLY (F7.2): demo-client logo image.
 *
 * POST   /api/v1/app/demo-clients/:id/logo — upload (multipart, field `file`)
 * DELETE /api/v1/app/demo-clients/:id/logo — remove
 *
 * Complements the `logoUrl` field on PATCH /api/v1/app/demo-clients/:id: an admin can
 * either link an external https image or upload one. Both land in the same column.
 *
 * See `_lib/brand-upload.ts` for the shared pipeline and BRAND_LOGO_SPEC for the rules.
 */

import { brandImageHandlers } from '@/app/api/v1/app/demo-clients/_lib/brand-upload';

export const { POST, DELETE } = brandImageHandlers('logo');
