/**
 * Request schemas + guards for the respondent intro-background authoring routes (F12.2).
 *
 * `authorIntroBackgroundSchema` validates the AI author body (generate / refine); `parseUploadGuard`
 * pulls the file off a multipart request and enforces size + extension before `parseDocument`. Pure
 * Zod + a small guard — the routes own the LLM dispatch and the parse call.
 */

import { z } from 'zod';

import { errorResponse } from '@/lib/api/responses';
import { INTRO_BACKGROUND_MAX_LENGTH } from '@/lib/app/questionnaire/types';
import {
  ALLOWED_EXTENSIONS,
  hasAllowedExtension,
} from '@/app/api/v1/app/questionnaires/_lib/upload-input';

/** Max upload size for an intro-background source document (bytes). Mirrors the ingest cap. */
export const INTRO_BACKGROUND_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * AI author body. `generate` needs a brief; `refine` needs the current text + an instruction.
 * `brief` / `currentText` are bounded generously (a brief may be longer than the output); the
 * instruction is a short directive (reuse the button-label bound's spirit but allow a sentence or two).
 */
export const authorIntroBackgroundSchema = z
  .object({
    mode: z.enum(['generate', 'refine']),
    brief: z.string().trim().min(1).max(4000).optional(),
    currentText: z.string().trim().min(1).max(INTRO_BACKGROUND_MAX_LENGTH).optional(),
    instruction: z.string().trim().min(1).max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'generate' && !v.brief) {
      ctx.addIssue({ code: 'custom', message: 'A brief is required to generate', path: ['brief'] });
    }
    if (v.mode === 'refine' && !v.currentText) {
      ctx.addIssue({
        code: 'custom',
        message: 'There is no current text to refine',
        path: ['currentText'],
      });
    }
    if (v.mode === 'refine' && !v.instruction) {
      ctx.addIssue({
        code: 'custom',
        message: 'An instruction is required to refine',
        path: ['instruction'],
      });
    }
  });

export type AuthorIntroBackgroundInput = z.infer<typeof authorIntroBackgroundSchema>;

/** Pull + guard the uploaded file from a multipart request. `{ ok:false, response }` on failure. */
export async function parseUploadGuard(
  request: Request
): Promise<{ ok: true; file: File } | { ok: false; response: Response }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return {
      ok: false,
      response: errorResponse('Expected a multipart upload', {
        code: 'INVALID_UPLOAD',
        status: 400,
      }),
    };
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return {
      ok: false,
      response: errorResponse('No file provided', { code: 'NO_FILE', status: 400 }),
    };
  }
  if (file.size > INTRO_BACKGROUND_MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      response: errorResponse('File is too large (max 25MB)', {
        code: 'FILE_TOO_LARGE',
        status: 413,
      }),
    };
  }
  if (!hasAllowedExtension(file.name)) {
    return {
      ok: false,
      response: errorResponse(`Unsupported file type (allowed: ${ALLOWED_EXTENSIONS.join(', ')})`, {
        code: 'UNSUPPORTED_FILE_TYPE',
        status: 415,
      }),
    };
  }
  return { ok: true, file };
}
