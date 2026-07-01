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
import {
  requestForkConfirm,
  type ForkConfirmDetails,
} from '@/components/admin/questionnaires/fork-confirm-bridge';

/** The server error code that means "editing this launched version will fork a new draft — confirm." */
const VERSION_FORK_CONFIRMATION_REQUIRED = 'VERSION_FORK_CONFIRMATION_REQUIRED';

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

/**
 * Thrown when the admin declines the "create a new draft?" confirmation. Nothing was written.
 * Runners should treat it as a benign no-op (resync from the server, no error banner).
 */
export class ForkCancelledError extends Error {
  constructor() {
    super('Edit cancelled — no new version was created.');
    this.name = 'ForkCancelledError';
  }
}

function mutateFetch(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  confirm: 'prompt' | 'confirmed'
): Promise<Response> {
  return fetch(path, {
    method,
    // `x-fork-confirm` opts this request into the fork-confirmation protocol: `prompt` asks the
    // server to 409 rather than silently fork a launched version; `confirmed` is the post-dialog retry.
    headers: { 'Content-Type': 'application/json', 'x-fork-confirm': confirm },
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function authoringMutate<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<AuthoringResult<T>> {
  let parsed = await parseApiResponse<T>(await mutateFetch(method, path, body, 'prompt'));

  // The edit would fork a launched version — confirm with the admin, then retry (or cancel).
  if (!parsed.success && parsed.error.code === VERSION_FORK_CONFIRMATION_REQUIRED) {
    const confirmed = await requestForkConfirm(
      parsed.error.details as unknown as ForkConfirmDetails
    );
    if (!confirmed) throw new ForkCancelledError();
    parsed = await parseApiResponse<T>(await mutateFetch(method, path, body, 'confirmed'));
  }

  if (!parsed.success) {
    throw new AuthoringError(parsed.error.message, parsed.error.code, parsed.error.details);
  }
  const meta = (parsed.meta as AuthoringMeta | undefined) ?? null;
  return { data: parsed.data, meta };
}
