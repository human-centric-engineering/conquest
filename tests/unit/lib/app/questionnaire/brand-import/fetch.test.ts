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

import * as safeUrlModule from '@/lib/security/safe-url';
import {
  HarvestBudget,
  fetchResource,
  type BudgetLimits,
} from '@/lib/app/questionnaire/brand-import/fetch';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ok(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
}

function redirect(to: string, status = 302): Response {
  // `Response.redirect` marks the response type as opaque-redirect in some runtimes; construct it
  // directly so `headers.get('location')` is readable, exactly as it is off the wire.
  return new Response(null, { status, headers: { location: to } });
}

/**
 * A response whose body cannot be cleanly cancelled.
 *
 * `fetchResource` calls `response.body?.cancel().catch(() => {})` at three separate points, to
 * release the connection before moving past a response it isn't going to read. Each of those
 * catch handlers only actually RUNS when cancel() rejects — a normal stream resolves cleanly, so
 * a response built from a plain string never exercises them. This is what does.
 */
function withUncancellableBody(status: number, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'));
    },
    cancel() {
      return Promise.reject(new Error('this stream refuses to cancel'));
    },
  });
  return new Response(stream, { status, headers });
}

const SMALL_BUDGET: BudgetLimits = {
  maxRequests: 10,
  maxResourceBytes: 1024,
  maxTotalBytes: 4096,
  timeoutMs: 10_000,
};

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

  it('never throws when what it catches is not even an Error', async () => {
    // fetch() itself only ever rejects with an Error, but AbortSignal plumbing and test doubles
    // can reject with anything — the message-building has to survive a non-Error too.
    fetchMock.mockRejectedValue('a plain string, not an Error');

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('We could not reach that address.');
  });

  it('names a timeout specifically, rather than the generic "could not reach"', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutError);

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('That site took too long to respond.');
  });

  it('falls back to a generic refusal message when the safety check gives no reason of its own', async () => {
    // `checkSafeProviderUrl` always sets `message` on a real rejection today, but the fallback
    // exists for defense in depth — assert it directly rather than only through the guard's
    // current implementation.
    vi.spyOn(safeUrlModule, 'checkSafeProviderUrl').mockReturnValueOnce({ ok: false });

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('it is not a safe target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic budget message when a budget refuses without recording why', async () => {
    // HarvestBudget itself always records a reason before refusing, but fetchResource's fallback
    // is defensive against any object satisfying the budget's shape, so it is exercised directly
    // with a fake budget rather than only through HarvestBudget's own behaviour.
    const emptyBudget = {
      claimRequest: () => false,
      note: () => null,
      remainingMs: () => 1000,
      maxResourceBytes: 1024,
      spend: () => {},
    } as unknown as HarvestBudget;

    const result = await fetchResource('https://acme.example/', emptyBudget);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('The import ran out of budget.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a redirect that names no Location to follow', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('without saying where');
  });

  it('reports a redirect Location that cannot be resolved into a URL at all', async () => {
    // An unterminated IPv6 literal — the one shape `new URL(location, current)` actually throws
    // on, versus treating it as a relative path the way it does almost everything else.
    fetchMock
      .mockResolvedValueOnce(redirect('http://[::1'))
      .mockResolvedValueOnce(ok('<html></html>'));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('somewhere unreadable');
  });

  it('releases the connection on a redirect even when the body refuses to cancel cleanly', async () => {
    fetchMock
      .mockResolvedValueOnce(withUncancellableBody(302, { location: 'https://www.acme.example/' }))
      .mockResolvedValueOnce(ok('<html></html>'));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    // The cancel() rejection is swallowed — a hop that will not release cleanly must not stop the
    // harvest from following the redirect anyway.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finalUrl).toBe('https://www.acme.example/');
  });

  it('releases the connection on a refused status even when the body refuses to cancel cleanly', async () => {
    fetchMock.mockResolvedValue(withUncancellableBody(403));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('block automated readers');
  });

  it('releases the connection on an over-large declared length even when the body refuses to cancel', async () => {
    fetchMock.mockResolvedValue(
      withUncancellableBody(200, {
        'content-type': 'text/css',
        'content-length': String(50 * 1024 * 1024),
      })
    );

    const result = await fetchResource('https://acme.example/huge.css', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('too large');
  });

  it('reports null content-type as null rather than as an empty string', async () => {
    // A string body gets an automatic `text/plain` content-type from the Response constructor;
    // a binary body does not, which is what actually lets this exercise the missing-header path.
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBeNull();
  });

  it.each([
    [401, 'block automated readers'],
    [404, 'not found (404)'],
    [429, 'slow down (429)'],
    [500, 'returned an error (500)'],
    [418, 'returned HTTP 418'],
  ])('describes a %i status in terms an admin can act on', async (status, expected) => {
    fetchMock.mockResolvedValue(new Response('nope', { status }));

    const result = await fetchResource('https://acme.example/', new HarvestBudget());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(expected);
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

  it('stops once the total-bytes cap is spent and says so', async () => {
    // The total-bytes cap is checked at the START of the next claim, against whatever the
    // previous resource actually spent — not against its own request. So it takes two calls: one
    // that spends past the cap, and a second that finds it already gone.
    const budget = new HarvestBudget({ ...SMALL_BUDGET, maxTotalBytes: 5 });
    fetchMock.mockResolvedValue(ok('this body is well over five bytes long'));

    await fetchResource('https://acme.example/a', budget);
    const second = await fetchResource('https://acme.example/b', budget);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain('download limit');
    expect(budget.truncated).toBe(true);
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
