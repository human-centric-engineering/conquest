/**
 * web_search capability — unit tests.
 *
 * Covers the Brave-response normalizer, the arg schema's query length guard, and the execute path:
 * a successful search maps results, and a transport/auth failure returns a structured error (never
 * throws) so the report research loop can degrade gracefully.
 *
 * @see lib/app/questionnaire/capabilities/web-search.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import * as httpModule from '@/lib/orchestration/http';
import {
  AppWebSearchCapability,
  normalizeBraveResults,
  __testing,
} from '@/lib/app/questionnaire/capabilities/web-search';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const ctx: CapabilityContext = { userId: null, agentId: 'agent-1' };

function braveBody(results: unknown[]): unknown {
  return { web: { results } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeBraveResults', () => {
  it('maps title/url/description and extracts a source from profile/meta_url', () => {
    const out = normalizeBraveResults(
      braveBody([
        {
          title: 'First',
          url: 'https://a.test',
          description: 'About first',
          profile: { name: 'A Site' },
        },
        {
          title: 'Second',
          url: 'https://b.test',
          description: 'About second',
          meta_url: { hostname: 'b.test' },
        },
      ]),
      5
    );
    expect(out).toEqual([
      { title: 'First', url: 'https://a.test', snippet: 'About first', source: 'A Site' },
      { title: 'Second', url: 'https://b.test', snippet: 'About second', source: 'b.test' },
    ]);
  });

  it('drops entries missing a title or url and caps to count', () => {
    const out = normalizeBraveResults(
      braveBody([
        { title: '', url: 'https://x.test' },
        { title: 'No url', url: '' },
        { title: 'Ok1', url: 'https://1.test' },
        { title: 'Ok2', url: 'https://2.test' },
      ]),
      1
    );
    expect(out).toEqual([{ title: 'Ok1', url: 'https://1.test', snippet: '' }]);
  });

  it('returns [] for a malformed body', () => {
    expect(normalizeBraveResults(null, 5)).toEqual([]);
    expect(normalizeBraveResults({ web: {} }, 5)).toEqual([]);
    expect(normalizeBraveResults('nope', 5)).toEqual([]);
  });

  it('returns [] when the body has no web object at all', () => {
    // isRecord(body) is true, but body.web is undefined — a distinct branch from `{ web: {} }`
    // (where body.web IS a record, just missing `results`).
    expect(normalizeBraveResults({}, 5)).toEqual([]);
  });

  it('skips a non-record entry in the results array and keeps processing', () => {
    const out = normalizeBraveResults(
      braveBody([null, 'not-an-object', { title: 'Valid', url: 'https://valid.test' }]),
      5
    );
    expect(out).toEqual([{ title: 'Valid', url: 'https://valid.test', snippet: '' }]);
  });

  it('drops an entry whose title and url are not strings', () => {
    const out = normalizeBraveResults(
      braveBody([
        { title: 123, url: 456 },
        { title: 'Valid', url: 'https://valid.test' },
      ]),
      5
    );
    expect(out).toEqual([{ title: 'Valid', url: 'https://valid.test', snippet: '' }]);
  });

  it('drops entries whose url is not an absolute http(s) URL (scheme validated at the source)', () => {
    const out = normalizeBraveResults(
      braveBody([
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Data', url: 'data:text/html,<script>x</script>' },
        { title: 'Relative', url: '/not/absolute' },
        { title: 'Ftp', url: 'ftp://files.test/x' },
        { title: 'Good', url: 'https://ok.test/path' },
      ]),
      5
    );
    expect(out).toEqual([{ title: 'Good', url: 'https://ok.test/path', snippet: '' }]);
  });
});

describe('argsSchema', () => {
  it('rejects an over-long query and an empty query', () => {
    expect(__testing.argsSchema.safeParse({ query: 'x'.repeat(381) }).success).toBe(false);
    expect(__testing.argsSchema.safeParse({ query: '   ' }).success).toBe(false);
    expect(__testing.argsSchema.safeParse({ query: 'valid' }).success).toBe(true);
  });
});

describe('AppWebSearchCapability.execute', () => {
  it('returns normalized results on a successful search', async () => {
    const spy = vi.spyOn(httpModule, 'executeHttpRequest').mockResolvedValue({
      status: 200,
      body: braveBody([{ title: 'Hit', url: 'https://hit.test', description: 'desc' }]),
      latencyMs: 10,
    });

    const cap = new AppWebSearchCapability();
    const result = await cap.execute({ query: 'latest benchmarks', count: 3 }, ctx);

    expect(result.success).toBe(true);
    expect(result.data?.results).toEqual([
      { title: 'Hit', url: 'https://hit.test', snippet: 'desc' },
    ]);
    // Query is URL-encoded into the Brave endpoint and the count is forwarded.
    const call = spy.mock.calls[0]?.[0];
    expect(call?.url).toContain('q=latest%20benchmarks');
    expect(call?.url).toContain('count=3');
    expect(call?.auth).toMatchObject({ type: 'api-key', apiKeyHeaderName: 'X-Subscription-Token' });
  });

  it('returns a structured error (never throws) when the backend is unconfigured', async () => {
    vi.spyOn(httpModule, 'executeHttpRequest').mockRejectedValue(
      new httpModule.HttpError('missing_auth_secret', 'BRAVE key not set', false)
    );

    const cap = new AppWebSearchCapability();
    const result = await cap.execute({ query: 'anything' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('missing_auth_secret');
  });

  it('redacts the query on the provenance record', () => {
    const cap = new AppWebSearchCapability();
    const redaction = cap.redactProvenance(
      { query: 'sensitive respondent detail', count: 5 },
      { success: true, data: { results: [{ title: 'T', url: 'https://t.test', snippet: '' }] } }
    );
    expect(JSON.stringify(redaction.args)).not.toContain('sensitive respondent detail');
    expect(redaction.resultPreview).toContain('resultCount');
  });

  it('returns a structured "capability_error" for a non-HttpError thrown by the transport', async () => {
    vi.spyOn(httpModule, 'executeHttpRequest').mockRejectedValue(new Error('boom'));

    const cap = new AppWebSearchCapability();
    const result = await cap.execute({ query: 'anything' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: 'capability_error', message: 'boom' });
  });

  it('falls back to "Unknown error" when a non-Error value is thrown by the transport', async () => {
    vi.spyOn(httpModule, 'executeHttpRequest').mockRejectedValue('not-an-error-instance');

    const cap = new AppWebSearchCapability();
    const result = await cap.execute({ query: 'anything' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: 'capability_error', message: 'Unknown error' });
  });

  it('redacts the query and persists only the error code (never the raw message) for a failed result', () => {
    const cap = new AppWebSearchCapability();
    // A real HttpError message embeds the full request URL, including the `q=` query which may echo
    // respondent PII — the failure preview must not carry it into the durable provenance row.
    const failedResult = {
      success: false as const,
      error: {
        code: 'host_not_allowed',
        message:
          'Host not in ORCHESTRATION_ALLOWED_HOSTS allowlist: https://api.search.brave.com/res/v1/web/search?q=sensitive+respondent+detail&count=5',
      },
    };
    const redaction = cap.redactProvenance(
      { query: 'sensitive respondent detail', count: 5 },
      failedResult
    );

    // Neither the masked args nor the persisted preview may contain the query.
    expect(JSON.stringify(redaction.args)).not.toContain('sensitive respondent detail');
    expect(redaction.resultPreview).not.toContain('sensitive respondent detail');
    // The non-PII error code is retained for audit/debugging.
    expect(redaction.resultPreview).toBe(
      JSON.stringify({ success: false, code: 'host_not_allowed' })
    );
  });
});
