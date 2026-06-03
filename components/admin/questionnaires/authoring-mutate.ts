/**
 * Client mutation helper for the questionnaire editor (F2.1 / PR2).
 *
 * `apiClient` returns only the response `data`, but the authoring editor needs the
 * `meta` too — it carries the fork outcome (`forked`, `versionId`, `versionNumber`)
 * that drives the "edited a launched version → new draft" notice and redirect. So
 * this thin wrapper does the fetch itself and returns both halves, throwing the
 * server's error message on failure (for inline errors / toasts).
 */

import { parseApiResponse } from '@/lib/api/parse-response';

/** The fork-outcome meta every authoring mutation returns. */
export interface AuthoringMeta {
  forked: boolean;
  versionId: string;
  versionNumber: number;
}

export interface AuthoringResult<T> {
  data: T;
  meta: AuthoringMeta | null;
}

/** Error carrying the server's code + field details so the UI can show specifics. */
export class AuthoringError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AuthoringError';
  }
}

export async function authoringMutate<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<AuthoringResult<T>> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const parsed = await parseApiResponse<T>(res);
  if (!parsed.success) {
    throw new AuthoringError(parsed.error.message, parsed.error.code, parsed.error.details);
  }
  const meta = (parsed.meta as AuthoringMeta | undefined) ?? null;
  return { data: parsed.data, meta };
}
