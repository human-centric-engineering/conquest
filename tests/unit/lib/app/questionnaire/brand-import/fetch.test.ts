/**
 * Unit tests: the budgeted, SSRF-guarded fetcher.
 *
 * The redirect case is the one that matters. `checkSafeProviderUrl` validates ONE url, so under
 * `redirect: 'follow'` a public address that 302s to `169.254.169.254` would reach cloud metadata
 * through a guard that reported `ok` — and in the URL import that response would then be measured
 * and echoed back as a proposed brand colour. The hop-by-hop re-validation is what stops it, and it
 * is asserted directly rather than assumed from the code shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HarvestBudget, fetchResource } from '@/lib/app/questionnaire/brand-import/fetch';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
}

function redirect(to: string, status = 302): Response {
  // `Response.redirect` marks the response type as opaque-redirect in some runtimes; construct it
  // directly so `headers.get('location')` is readable, exactly as it is off the wire.
  return new Response(null, { status, headers: { location: to } });
}

describe('fetchResource', () => {
  it('returns the bytes and the final URL on a clean fetch', async () => {
    fetchMock.mockResolvedValue(ok('<html></html>'));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.buffer.toString()).toBe('<html></html>');
    expect(result.finalUrl).toBe('https://acme.example/');
    expect(result.contentType).toBe('text/html');
  });

  it('refuses an unsafe target before making any request at all', async () => {
    const result = await fetchResource(
      'http://169.254.169.254/latest/meta-data/',
      new HarvestBudget()
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect INTO cloud metadata, having allowed the first hop', async () => {
    // The whole reason redirects are followed manually.
    fetchMock
      .mockResolvedValueOnce(redirect('http://169.254.169.254/latest/meta-data/'))
      .mockResolvedValueOnce(ok('secrets'));

    const result = await fetchResource('https://acme.example/logo.png', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('redirected somewhere we will not follow');
    // The second fetch must never happen: the guard runs before the request, not after it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows an ordinary redirect and reports where it landed', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://www.acme.example/'))
      .mockResolvedValueOnce(ok('<html></html>'));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The final URL matters: relative logo paths are resolved against it, not against what the
    // admin typed.
    expect(result.finalUrl).toBe('https://www.acme.example/');
  });

  it('resolves a relative Location against the URL that issued it', async () => {
    fetchMock.mockResolvedValueOnce(redirect('/en/')).mockResolvedValueOnce(ok('<html></html>'));

    await fetchResource('https://acme.example/home', new HarvestBudget());

    expect(fetchMock.mock.calls[1][0]).toBe('https://acme.example/en/');
  });

  it('gives up after too many redirects', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(redirect(`${url}x`)));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('too many times');
  });

  it('explains a bot wall in terms an admin can act on', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "HTTP 403" tells an admin nothing about what to do next; naming the cause is what makes the
    // screenshot suggestion land as an answer.
    expect(result.reason).toContain('block automated readers');
  });

  it('refuses an over-large resource on its declared length, without downloading it', async () => {
    fetchMock.mockResolvedValue(ok('x', { 'content-length': String(50 * 1024 * 1024) }));

    const budget = new HarvestBudget();
    const result = await fetchResource('https://acme.example/huge.css', budget);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('too large');
  });

  it('still checks the real size, because a declared length can lie', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    fetchMock.mockResolvedValue(ok(huge));

    const result = await fetchResource('https://acme.example/huge.css', new HarvestBudget());

    expect(result.ok).toBe(false);
  });

  it('never throws on a network error — it reports one', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('We could not reach that address.');
  });
});

describe('HarvestBudget', () => {
  it('stops after the request cap and says which cap stopped it', async () => {
    fetchMock.mockResolvedValue(ok('ok'));
    const budget = new HarvestBudget({
      maxRequests: 2,
      maxResourceBytes: 1024,
      maxTotalBytes: 4096,
      timeoutMs: 10_000,
    });

    await fetchResource('https://acme.example/a', budget);
    await fetchResource('https://acme.example/b', budget);
    const third = await fetchResource('https://acme.example/c', budget);

    expect(third.ok).toBe(false);
    expect(budget.truncated).toBe(true);
    // The note is what stops a truncated harvest looking like a complete answer.
    expect(budget.note()).toContain('2 requests');
  });

  it('counts redirect hops against the request cap', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(redirect(`${url}x`)));
    const budget = new HarvestBudget({
      maxRequests: 2,
      maxResourceBytes: 1024,
      maxTotalBytes: 4096,
      timeoutMs: 10_000,
    });

    await fetchResource('https://acme.example/', budget);

    // A redirect chain is a fan-out too — three hops is three requests, not one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a clean budget as untruncated, with no note', () => {
    const budget = new HarvestBudget();
    expect(budget.truncated).toBe(false);
    expect(budget.note()).toBeNull();
  });

  it('refuses once the clock has run out', async () => {
    const budget = new HarvestBudget(
      { maxRequests: 10, maxResourceBytes: 1024, maxTotalBytes: 4096, timeoutMs: 1000 },
      0
    );

    // The budget was constructed at t=0 with a 1s window; by real `Date.now()` it is long spent.
    const result = await fetchResource('https://acme.example/', budget);

    expect(result.ok).toBe(false);
    expect(budget.note()).toContain('ran out of time');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
