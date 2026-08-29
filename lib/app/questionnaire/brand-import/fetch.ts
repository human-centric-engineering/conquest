/**
 * Brand import — budgeted, SSRF-guarded fetching.
 *
 * Harvesting a brand is not one request. It is a page, then its stylesheets, then the images it
 * points at — a fan-out, where the knowledge-base ingester (`lib/orchestration/knowledge/url-fetcher.ts`)
 * fetches exactly one document with one size cap. That difference is the whole reason this module
 * exists rather than widening that one:
 *
 *  - **A budget, not a per-file cap.** Requests, total bytes and wall clock are all bounded across
 *    the WHOLE harvest. A per-resource cap alone lets a hostile (or merely enormous) site walk us
 *    through fifty 1.9MB stylesheets.
 *  - **Exceeding a cap is a result, not an error.** We stop, note what we skipped, and hand back
 *    what we have. A truncated harvest that proposes four fields is worth more than a failure, and
 *    the note is what stops it looking like a complete answer.
 *  - **Every failure below the first is swallowed.** A missing favicon must not fail an import that
 *    already found a logo and a palette.
 *
 * ## The redirect loop
 *
 * `checkSafeProviderUrl` validates ONE url. Under `redirect: 'follow'` it would therefore only ever
 * see the first, and `https://attacker.example/logo.png` → 302 → `http://169.254.169.254/…` reaches
 * cloud metadata — whose response would then be measured, and in the URL case echoed back as a
 * proposed colour. So redirects are followed manually and re-validated at every hop, exactly as the
 * ingester does. Refusing redirects outright is not an option here: `http`→`https` upgrades, CDN
 * redirects and www-canonicalisation are all normal on the first request of any real site.
 *
 * The guard's own documented limits are inherited, not fixed here: it does not resolve DNS, so a
 * hostname pointing at a private address is not blocked, and rebinding is not defended against.
 * See `lib/security/safe-url.ts`.
 */

import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { logger } from '@/lib/logging';

/** Redirect hops permitted per resource. Matches the browser default and the ingester. */
const MAX_REDIRECTS = 5;

/** Statuses carrying a `Location` the client is expected to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Sent on every request.
 *
 * Honest about who we are rather than impersonating a browser. Sites that refuse non-browser agents
 * will refuse us — and that is a `blocked` outcome with the screenshot route offered, which is a
 * better answer than quietly pretending to be Chrome to get around someone's stated preference.
 */
const USER_AGENT = 'ConQuest-BrandImport/1.0';

export interface BudgetLimits {
  /** Total requests across the harvest, redirects included. */
  maxRequests: number;
  /** Ceiling on any single resource. */
  maxResourceBytes: number;
  /** Ceiling on everything downloaded. */
  maxTotalBytes: number;
  /** Wall clock for the whole harvest. */
  timeoutMs: number;
}

/**
 * Defaults sized for one homepage.
 *
 * 12 requests covers a page, two or three stylesheets and three or four images — comfortably more
 * than a well-built site needs and far less than an unbounded crawl. 20s is what an admin will wait
 * staring at a spinner before assuming it has hung.
 */
export const DEFAULT_BUDGET: BudgetLimits = {
  maxRequests: 12,
  maxResourceBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  timeoutMs: 20_000,
};

/**
 * The running budget for one harvest.
 *
 * A class rather than a bag of counters because the accounting has to be shared by reference across
 * the harvest's stages — page, stylesheets, images — and threading three mutable numbers through
 * every call is how one of them stops being decremented.
 */
export class HarvestBudget {
  private requestsLeft: number;
  private bytesLeft: number;
  private readonly deadline: number;
  private readonly limits: BudgetLimits;
  /** Caps that were actually hit, for the result's note. Deduplicated — one mention each. */
  private readonly hit = new Set<string>();

  constructor(limits: BudgetLimits = DEFAULT_BUDGET, now: number = Date.now()) {
    this.limits = limits;
    this.requestsLeft = limits.maxRequests;
    this.bytesLeft = limits.maxTotalBytes;
    this.deadline = now + limits.timeoutMs;
  }

  /** Milliseconds left, floored at zero. Used as the per-request abort timeout. */
  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.deadline - now);
  }

  /**
   * Claim one request slot, or report that the budget is spent.
   *
   * Records WHICH cap stopped us so the result can say "we stopped after 12 requests" rather than
   * the uninformative "some things were skipped".
   */
  claimRequest(now: number = Date.now()): boolean {
    if (this.remainingMs(now) <= 0) {
      this.hit.add(`we ran out of time after ${Math.round(this.limits.timeoutMs / 1000)}s`);
      return false;
    }
    if (this.requestsLeft <= 0) {
      this.hit.add(`we stopped after ${this.limits.maxRequests} requests`);
      return false;
    }
    if (this.bytesLeft <= 0) {
      this.hit.add('we reached the download limit');
      return false;
    }
    this.requestsLeft -= 1;
    return true;
  }

  /** Record bytes actually downloaded. */
  spend(bytes: number): void {
    this.bytesLeft -= bytes;
  }

  get maxResourceBytes(): number {
    return this.limits.maxResourceBytes;
  }

  /** True once anything was skipped — the caller turns this into the result's note. */
  get truncated(): boolean {
    return this.hit.size > 0;
  }

  /** A sentence naming what stopped us, or null when nothing did. */
  note(): string | null {
    if (this.hit.size === 0) return null;
    return `Some of the site was not read — ${[...this.hit].join(', ')}.`;
  }
}

export type FetchOutcome =
  | { ok: true; buffer: Buffer; contentType: string | null; finalUrl: string }
  | { ok: false; reason: string };

/**
 * Fetch one resource within the budget, re-validating the SSRF guard on every redirect hop.
 *
 * Never throws. Every failure — refused, unsafe, oversized, out of budget — comes back as
 * `{ ok: false, reason }` with a sentence an admin can act on, because the caller's job is to
 * decide whether that failure ends the import or is simply one image it will do without.
 */
export async function fetchResource(
  url: string,
  budget: HarvestBudget,
  options: { accept?: string; userAgent?: string } = {}
): Promise<FetchOutcome> {
  let current = url;

  for (let hop = 0; ; hop++) {
    const safety = checkSafeProviderUrl(current);
    if (!safety.ok) {
      return {
        ok: false,
        reason:
          hop === 0
            ? `That address cannot be fetched: ${safety.message ?? 'it is not a safe target'}.`
            : `That address redirected somewhere we will not follow (${current}).`,
      };
    }

    if (!budget.claimRequest()) {
      return { ok: false, reason: budget.note() ?? 'The import ran out of budget.' };
    }

    let response: Response;
    try {
      response = await fetch(current, {
        // Manual, so the guard above sees every hop. `redirect: 'follow'` would hand undici the
        // whole chain and show us only the first URL.
        redirect: 'manual',
        signal: AbortSignal.timeout(budget.remainingMs()),
        headers: {
          // Overridable for exactly one caller: Google Fonts serves a different FORMAT per agent,
          // and our honest one gets TTF where a browser gets woff2 — several times the bytes on a
          // file every respondent downloads. That is format negotiation, not an attempt to get
          // past a site's stated preference about automated readers.
          'User-Agent': options.userAgent ?? USER_AGENT,
          Accept: options.accept ?? '*/*',
        },
      });
    } catch (error) {
      return { ok: false, reason: describeFetchError(error, current) };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      // Release the socket before moving on. Under manual redirects undici holds the connection
      // out of the pool until the body is consumed or cancelled, so every hop would leak one.
      await response.body?.cancel().catch(() => {
        /* already errored or consumed */
      });

      if (!location) {
        return { ok: false, reason: `That address redirected without saying where (${current}).` };
      }
      if (hop >= MAX_REDIRECTS) {
        return {
          ok: false,
          reason: `That address redirected too many times (max ${MAX_REDIRECTS}).`,
        };
      }

      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: `That address redirected somewhere unreadable (${location}).` };
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: describeHttpStatus(response.status) };
    }

    // Trust the declared length enough to refuse early, but never enough to skip the real check —
    // a hostile server can under-declare it, and a truthful one can omit it entirely.
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > budget.maxResourceBytes) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: 'That file is too large to read.' };
    }

    let buffer: Buffer;
    try {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > budget.maxResourceBytes) {
        return { ok: false, reason: 'That file is too large to read.' };
      }
      buffer = Buffer.from(bytes);
    } catch (error) {
      return { ok: false, reason: describeFetchError(error, current) };
    }

    budget.spend(buffer.length);

    return {
      ok: true,
      buffer,
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim() ?? null,
      finalUrl: current,
    };
  }
}

/**
 * Turn an HTTP status into something an admin can act on.
 *
 * A 403 from a bot wall is the single most common way this feature fails, and "HTTP 403" tells an
 * admin nothing about what to do instead. Naming the likely cause is what makes the screenshot
 * suggestion land as an answer rather than as a consolation prize.
 */
function describeHttpStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `That site refused our request (${status}) — many sites block automated readers.`;
  }
  if (status === 404) return 'That page was not found (404).';
  if (status === 429) return 'That site asked us to slow down (429).';
  if (status >= 500) return `That site returned an error (${status}).`;
  return `That site returned HTTP ${status}.`;
}

function describeFetchError(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'That site took too long to respond.';
  }
  logger.info('Brand import: a resource could not be fetched', { url, error: message });
  return 'We could not reach that address.';
}
