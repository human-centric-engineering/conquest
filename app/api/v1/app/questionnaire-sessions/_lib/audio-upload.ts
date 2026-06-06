/**
 * Audio-upload validation for the live respondent transcribe route (F6.2).
 *
 * The shape Sunrise's {@link validateTranscribeUpload} validates is *almost* what we need — but
 * that helper mandates an `agentId` form field (the admin / embed transcribe endpoints carry it),
 * whereas the respondent transcribe route gets its agent context from the session in the URL. So
 * this is a thin app-side variant: the same `audio` + optional `language` checks, no `agentId`.
 *
 * It deliberately reuses the platform's size cap and MIME allowlist **constants**
 * (`MAX_TRANSCRIBE_BYTES`, `ALLOWED_AUDIO_PREFIXES`) so the accepted formats and limit can't drift
 * from the admin / embed endpoints. We don't fork-edit the platform validator.
 *
 * Returns a discriminated union so the route can forward a pre-built error response on failure
 * without re-implementing the standard error envelope — same convention as the platform helper.
 */

import { errorResponse } from '@/lib/api/responses';
import { ALLOWED_AUDIO_PREFIXES, MAX_TRANSCRIBE_BYTES } from '@/lib/validations/transcribe';

/** ISO 639-1 language hint pattern (e.g. `en`, `es`, `pt-BR`) — mirrors the platform validator. */
const LANGUAGE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

export interface AudioUploadOk {
  ok: true;
  value: {
    file: File;
    language?: string;
  };
}

export interface AudioUploadErr {
  ok: false;
  response: Response;
}

export type AudioUploadResult = AudioUploadOk | AudioUploadErr;

function isAllowedAudioMime(type: string): boolean {
  if (!type) return false;
  return ALLOWED_AUDIO_PREFIXES.some((prefix) => type.toLowerCase().startsWith(prefix));
}

/**
 * Parse + validate the transcribe-route multipart body. Returns `{ ok: true, value }` on success
 * or `{ ok: false, response }` carrying the appropriate 400/413/415 error response on failure;
 * callers should forward `response` directly. Error codes match the platform validator so client
 * mapping is shared across the admin, embed, and respondent transcribe surfaces.
 */
export function validateAudioUpload(formData: FormData): AudioUploadResult {
  const file = formData.get('audio');
  if (!(file instanceof File)) {
    return {
      ok: false,
      response: errorResponse('Missing audio field', {
        code: 'MISSING_AUDIO',
        status: 400,
        details: { audio: ['An audio file must be supplied in the `audio` form field'] },
      }),
    };
  }

  if (file.size === 0) {
    return {
      ok: false,
      response: errorResponse('Audio file is empty', {
        code: 'AUDIO_EMPTY',
        status: 400,
      }),
    };
  }

  if (file.size > MAX_TRANSCRIBE_BYTES) {
    return {
      ok: false,
      response: errorResponse('Audio file exceeds size limit', {
        code: 'AUDIO_TOO_LARGE',
        status: 413,
        details: { audio: [`Maximum size is ${MAX_TRANSCRIBE_BYTES} bytes`] },
      }),
    };
  }

  if (!isAllowedAudioMime(file.type)) {
    return {
      ok: false,
      response: errorResponse('Unsupported audio MIME type', {
        code: 'AUDIO_INVALID_TYPE',
        status: 415,
        details: {
          audio: [`Allowed prefixes: ${ALLOWED_AUDIO_PREFIXES.join(', ')}`],
          received: [file.type || '<empty>'],
        },
      }),
    };
  }

  const languageRaw = formData.get('language');
  let language: string | undefined;
  if (languageRaw !== null) {
    if (typeof languageRaw !== 'string' || !LANGUAGE_PATTERN.test(languageRaw)) {
      return {
        ok: false,
        response: errorResponse('Invalid language field', {
          code: 'INVALID_LANGUAGE',
          status: 400,
          details: { language: ['Expected an ISO 639-1 code, e.g. "en"'] },
        }),
      };
    }
    language = languageRaw;
  }

  return {
    ok: true,
    value: language !== undefined ? { file, language } : { file },
  };
}
