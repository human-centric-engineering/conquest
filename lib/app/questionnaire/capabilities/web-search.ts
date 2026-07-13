/**
 * `web_search` capability — a thin, provider-agnostic web-search tool.
 *
 * Query-in / clean-results-out: the LLM supplies a `query` (and optional `count`) and gets back a
 * normalized `{ title, url, snippet, source? }[]`. All the hardened outbound plumbing — host
 * allowlist, outbound rate limit, auth-secret resolution, timeout, response-size cap — is reused from
 * `executeHttpRequest` (`lib/orchestration/http`), the same machinery behind `call_external_api` and
 * the `external_call` workflow step. Unlike the raw HTTP tool, this one exposes a friendly, safe,
 * query-only surface with the query length-guarded under Brave's 400-char `q` cap.
 *
 * Backend: Brave Search today, selected in {@link resolveSearchBackend}. Tavily (or SerpAPI) is a
 * drop-in second backend behind the same normalized return — add a branch, no call-site change.
 *
 * Configuration is env + allowlist only (no per-agent secret): set `BRAVE_SEARCH_API_KEY` and add
 * `api.search.brave.com` to `ORCHESTRATION_ALLOWED_HOSTS`. When either is missing the call returns a
 * structured error (never throws) so the research loop degrades gracefully and a report never fails
 * because search was unconfigured.
 *
 * **Promotable to a Sunrise built-in** (`lib/orchestration/capabilities/built-in/web-search.ts`):
 * nothing here is questionnaire-specific. It lives under the app tree only so it ships via the app
 * capability seam (`lib/app/capabilities.ts`) without an upstream round-trip.
 *
 * PII: search queries are agent-generated from respondent answers and may echo personal data, so
 * `processesPii = true` and `redactProvenance()` masks the query on the durable audit row.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js.
 */

import { z } from 'zod';
import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { redactedString } from '@/lib/security/redact';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { executeHttpRequest, HttpError } from '@/lib/orchestration/http';
import {
  BRAVE_SEARCH_API_KEY_ENV,
  BRAVE_SEARCH_HOST,
  WEB_SEARCH_CAPABILITY_SLUG,
  WEB_SEARCH_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';

const SLUG = WEB_SEARCH_CAPABILITY_SLUG;

/** Per-call bounds. Query cap keeps us under Brave's 400-char `q` limit (a documented gotcha). */
const QUERY_MAX_LENGTH = 380;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
/** Web search should be quick; a slow round must not eat the report generation budget. */
const SEARCH_TIMEOUT_MS = 10_000;
/** Search JSON is small; cap defensively. */
const SEARCH_MAX_RESPONSE_BYTES = 512 * 1024;

const argsSchema = z
  .object({
    query: z.string().trim().min(1).max(QUERY_MAX_LENGTH),
    count: z.number().int().min(1).max(MAX_COUNT).optional(),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

/** One normalized search result — the shape every backend maps to. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

interface Data {
  results: WebSearchResult[];
}

/** Which backend a `web_search` call uses. Extend with `'tavily'` etc. when a second backend lands. */
type SearchBackend = 'brave';

/** Today there is one backend. The seam exists so adding Tavily is a branch here, not a call-site edit. */
function resolveSearchBackend(): SearchBackend {
  return 'brave';
}

export class AppWebSearchCapability extends BaseCapability<Args, Data> {
  readonly slug = SLUG;
  readonly processesPii = true;

  readonly functionDefinition: CapabilityFunctionDefinition = WEB_SEARCH_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * The query is agent-generated and may echo respondent PII; results are public web data. Persist a
   * masked query + a count-only preview onto the durable provenance row. The LLM still sees the full
   * results on its turn — only the audit record is redacted.
   */
  redactProvenance(
    args: Args,
    result: CapabilityResult<Data>
  ): { args: unknown; resultPreview: string } {
    const count = result.success && result.data ? result.data.results.length : 0;
    // On failure, persist only the non-PII error code — never the raw error message: an HttpError
    // from the transport embeds the full request URL (including the `q=` query, which is
    // agent-generated and may echo respondent PII), so stringifying the whole result would leak the
    // very query the success path is careful to mask.
    const preview = result.success
      ? JSON.stringify({ success: true, resultCount: count })
      : JSON.stringify({ success: false, code: result.error?.code ?? 'error' });
    return { args: { query: redactedString('query'), count: args.count }, resultPreview: preview };
  }

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const count = args.count ?? DEFAULT_COUNT;
    const backend = resolveSearchBackend();

    try {
      const results = await runBraveSearch(args.query, count, {
        capability: SLUG,
        agentId: context.agentId,
        conversationId: context.conversationId,
      });
      return this.success({ results });
    } catch (err) {
      if (err instanceof HttpError) {
        // host_not_allowed / missing_auth_secret (key unset) / rate-limit / timeout / http_error.
        // All map to a structured error — the research loop treats it as "no results" and continues.
        logger.warn('web_search: search request failed', {
          backend,
          code: err.code,
          agentId: context.agentId,
        });
        return this.error(err.message, err.code);
      }
      logger.error('web_search: unexpected error', {
        backend,
        error: err instanceof Error ? err.message : String(err),
        agentId: context.agentId,
      });
      return this.error(err instanceof Error ? err.message : 'Unknown error', 'capability_error');
    }
  }
}

/**
 * Call the Brave Search API and normalize its `web.results[]` into {@link WebSearchResult}s. Throws
 * {@link HttpError} on any transport/allowlist/auth failure (the capability maps it to a structured
 * error). Extracts the result mapping in code rather than JMESPath so `count` can vary per call.
 */
async function runBraveSearch(
  query: string,
  count: number,
  logContext: Record<string, unknown>
): Promise<WebSearchResult[]> {
  const url = `https://${BRAVE_SEARCH_HOST}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

  const response = await executeHttpRequest({
    url,
    method: 'GET',
    // Brave rejects `Authorization: Bearer` with HTTP 422 — it wants the key in `X-Subscription-Token`.
    auth: {
      type: 'api-key',
      apiKeyHeaderName: 'X-Subscription-Token',
      secret: BRAVE_SEARCH_API_KEY_ENV,
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
    logContext,
  });

  return normalizeBraveResults(response.body, count);
}

/** True only for absolute http(s) URLs — mirrors the read-path `validHttpUrl` allowlist so a
 * `javascript:`/`data:`/other-scheme URL never enters stored report content at the source boundary,
 * not just at render time. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Map Brave's `{ web: { results: [{ title, url, description, ... }] } }` to normalized results. */
export function normalizeBraveResults(body: unknown, count: number): WebSearchResult[] {
  if (!isRecord(body)) return [];
  const web = isRecord(body.web) ? body.web : null;
  const rawResults = web && Array.isArray(web.results) ? web.results : [];

  const out: WebSearchResult[] = [];
  for (const entry of rawResults) {
    if (out.length >= count) break;
    if (!isRecord(entry)) continue;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!title || !url || !isHttpUrl(url)) continue;
    const snippet = typeof entry.description === 'string' ? entry.description.trim() : '';
    const source = extractBraveSource(entry);
    out.push({ title, url, snippet, ...(source ? { source } : {}) });
  }
  return out;
}

/** Best-effort human-readable source label from Brave's `profile.name` / `meta_url.hostname`. */
function extractBraveSource(entry: Record<string, unknown>): string | null {
  const profile = isRecord(entry.profile) ? entry.profile : null;
  if (profile && typeof profile.name === 'string' && profile.name.trim())
    return profile.name.trim();
  const metaUrl = isRecord(entry.meta_url) ? entry.meta_url : null;
  if (metaUrl && typeof metaUrl.hostname === 'string' && metaUrl.hostname.trim()) {
    return metaUrl.hostname.trim();
  }
  return null;
}

/** Test-only export. */
export const __testing = { argsSchema, runBraveSearch };
