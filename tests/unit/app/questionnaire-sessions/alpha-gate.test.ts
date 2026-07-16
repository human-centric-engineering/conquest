/**
 * Unit test: the alpha session-tools route gate (`withAlphaSessionToolsEnabled`).
 *
 * The wrapped handler runs only when the product is in the alpha stage, and 404s (handler untouched)
 * otherwise. The stage is resolved at module load, so each case re-imports with a fresh mock.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadGate(alpha: boolean) {
  vi.resetModules();
  vi.doMock('@/lib/app/release-stage', () => ({ IS_ALPHA: alpha }));
  return import('@/app/api/v1/app/questionnaire-sessions/_lib/alpha-gate');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/release-stage');
});

describe('withAlphaSessionToolsEnabled', () => {
  it('runs the handler when the product is in the alpha stage', async () => {
    const handler = vi.fn(async () => new Response('ok', { status: 200 }));
    const { withAlphaSessionToolsEnabled } = await loadGate(true);
    const res = await withAlphaSessionToolsEnabled(handler)({} as never, {});
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('404s and never calls the handler outside the alpha stage', async () => {
    const handler = vi.fn(async () => new Response('ok', { status: 200 }));
    const { withAlphaSessionToolsEnabled } = await loadGate(false);
    const res = await withAlphaSessionToolsEnabled(handler)({} as never, {});
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(handler).not.toHaveBeenCalled();
  });
});
