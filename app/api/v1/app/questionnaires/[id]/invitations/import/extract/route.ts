/**
 * AI invitee extraction from an uploaded file (invitations Phase D).
 *
 * POST /api/v1/app/questionnaires/:id/invitations/import/extract  (multipart/form-data, `file`)
 *   Admin-only. A PDF is parsed to text then run through the people-extractor; an image is sent to a
 *   vision model. Returns `{ people: ParsedInvitee[], warnings: string[] }` for the verify grid —
 *   nothing is persisted here.
 *
 * Gates: admin → `inviteLimiter` (paid + PII). The extraction itself logs cost and may fail soft
 * (an unconfigured/over-budget provider → 502).
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

import { parsePdf } from '@/lib/orchestration/knowledge/parsers/pdf-parser';
import {
  extractPeopleFromImage,
  extractPeopleFromText,
} from '@/lib/app/questionnaire/invitations/extract/extract-people';
import type { ParsedInvitee } from '@/lib/app/questionnaire/invitations/import/types';

type Params = { id: string };

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const handleExtract = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const rateLimit = inviteLimiter.check(getClientIP(request));
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return errorResponse('A file is required', { code: 'FILE_REQUIRED', status: 400 });
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    return errorResponse('File must be between 1 byte and 10 MB', {
      code: 'FILE_TOO_LARGE',
      status: 400,
    });
  }

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImage = IMAGE_TYPES.includes(file.type);
  if (!isPdf && !isImage) {
    return errorResponse('Upload a PDF or an image (PNG, JPEG, WebP)', {
      code: 'UNSUPPORTED_FILE_TYPE',
      status: 400,
    });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    let people: ParsedInvitee[];
    if (isPdf) {
      const parsed = await parsePdf(buffer, file.name);
      if (!parsed.fullText.trim()) {
        return successResponse({
          people: [],
          warnings: ['No readable text found in the PDF (it may be a scanned image).'],
        });
      }
      people = await extractPeopleFromText(parsed.fullText);
    } else {
      people = await extractPeopleFromImage({
        mediaType: file.type,
        data: buffer.toString('base64'),
      });
    }

    log.info('Invitee extraction complete', {
      questionnaireId: id,
      kind: isPdf ? 'pdf' : 'image',
      found: people.length,
    });
    const warnings = people.length === 0 ? ['No people with email addresses were found.'] : [];
    return successResponse({ people, warnings });
  } catch (err) {
    log.warn('Invitee extraction failed', {
      questionnaireId: id,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return errorResponse(
      'Could not extract people from this file. Try a clearer file or add them manually.',
      {
        code: 'EXTRACTION_FAILED',
        status: 502,
      }
    );
  }
});

export const POST = handleExtract;
