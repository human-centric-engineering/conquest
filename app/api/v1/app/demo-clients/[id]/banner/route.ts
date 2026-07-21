/**
 * DEMO-ONLY (F7.2): demo-client header banner image.
 *
 * POST   /api/v1/app/demo-clients/:id/banner — upload (multipart, field `file`)
 * DELETE /api/v1/app/demo-clients/:id/banner — remove
 *
 * A banner REPLACES the respondent session's header band edge-to-edge, so unlike the logo
 * it is dimension-constrained: roughly 4:1, at least 800x200. See BRAND_BANNER_SPEC.
 *
 * See `_lib/brand-upload.ts` for the shared pipeline.
 */

import { brandImageHandlers } from '@/app/api/v1/app/demo-clients/_lib/brand-upload';

export const { POST, DELETE } = brandImageHandlers('banner');
