/**
 * Rate-Limit Policy Table
 *
 * Single source of truth for which rate-limit tier applies to which API path.
 * Consumed by `lib/security/rate-limit-middleware.ts`, which runs from
 * `proxy.ts` at the project root on every API request (Next.js 16 renamed the
 * `middleware.ts` file convention to `proxy.ts`).
 *
 * **This is the canonical rate-limit configuration for Sunrise.** Reviewing
 * rate-limit policy = reviewing this one file. Adding a new section to the
 * admin surface, splitting a tier, raising a cap — all happen here, never in
 * route handlers.
 *
 * Route handlers do NOT call section limiters directly. The only acceptable
 * in-handler rate-limit call is an additive *per-flow* cap (e.g.
 * `chatLimiter`, `audioLimiter`, `imageLimiter` for the expensive chat-stream
 * flows). Those layer on top of the section tier applied by the middleware.
 *
 * @see lib/security/rate-limit-middleware.ts — the dispatcher that consumes this table
 * @see lib/security/rate-limit.ts — tier definitions and limiter instances
 * @see proxy.ts — project-root wiring
 */

import type { RateLimitTier } from '@/lib/security/rate-limit';

/**
 * How the caller is identified when building the rate-limit token.
 *
 * - `'ip'` — keyed on the client IP only. Use when the session can't (or
 *   shouldn't) be resolved at middleware time, e.g. authentication flows
 *   where the caller has no session yet, or webhook ingress where the source
 *   is identified by signature rather than session.
 * - `'session-user'` — keyed on the better-auth `session.user.id`. Falls back
 *   to IP if no session is present (the route handler will surface 401 if it
 *   requires auth — the rate-limit middleware doesn't enforce auth, it
 *   protects against abuse on top of whatever the route itself enforces).
 * - `'api-key'` — keyed on the API key hash from the `Authorization` header.
 *   Falls back to IP if no key. Used for routes that accept programmatic
 *   access via API keys instead of cookie sessions.
 * - `'embed-token'` — keyed on the embed token + client IP. Used for embedded
 *   widget surfaces where the caller is anonymous but the token identifies
 *   the embedding site.
 */
export type RateLimitKey = 'ip' | 'session-user' | 'api-key' | 'embed-token';

/**
 * One rule in the rate-limit policy table.
 *
 * Rules are evaluated in declaration order. **First match wins** — list the
 * most specific path patterns first.
 */
export interface RateLimitRule {
  /**
   * Path matcher. `RegExp` is preferred for precision; a literal string
   * matches as a prefix (e.g. `'/api/v1/admin/'` matches anything under that
   * prefix). The matched value is `request.nextUrl.pathname`.
   */
  match: RegExp | string;

  /** Which tier (limiter + cap) to apply. Resolved via `RATE_LIMIT_TIERS`. */
  tier: RateLimitTier;

  /** How to identify the caller. See {@link RateLimitKey}. */
  key: RateLimitKey;

  /**
   * Optional predicate. When it returns `true`, skip rate-limiting for this
   * specific request even when the path matches. Useful for trusted internal
   * callers (e.g. a request bearing a service-account header) or feature
   * flags that selectively disable the cap.
   *
   * Receives the raw `Request` so it can inspect headers, URL, etc. — but
   * NOT the session (session resolution happens after the rule fires).
   */
  skip?: (request: Request) => boolean;
}

/**
 * Credential-surface paths under `/api/auth/**` that warrant the OWASP-grade
 * 5/min brute-force cap. Anything else under `/api/auth/**` (`get-session`,
 * `sign-out`, OAuth `callback/*`, `list-sessions`, `revoke-session`) is high-
 * frequency / bursty-but-legitimate traffic and is skipped by
 * {@link skipNonCredentialAuthRoutes} so legitimate users on shared NATs don't
 * collectively hit the cap on session refreshes.
 */
const CREDENTIAL_AUTH_PATTERN =
  /^\/api\/auth\/(sign-in|sign-up|forget-password|reset-password|send-verification-email|verify-email|change-password|accept-invite)(\/|$|\?)/;

/**
 * Skip predicate for the `/api/auth/**` rule. Returns `true` (skip rate
 * limiting) for non-credential auth endpoints; returns `false` (apply the
 * 5/min auth cap) for credential endpoints.
 */
function skipNonCredentialAuthRoutes(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return !CREDENTIAL_AUTH_PATTERN.test(pathname);
}

/**
 * The rate-limit policy.
 *
 * **Ordering matters.** Each request is matched against rules top-to-bottom;
 * the first match wins. List sub-sections before parent sections, and tighter
 * (more specific) paths before broader ones.
 *
 * The default `'api'` tier at the bottom catches any `/api/v1/**` route that
 * doesn't match a more specific rule — including future routes added by
 * downstream forks. New forks inherit reasonable protection on day one
 * without having to remember anything.
 */
export const RATE_LIMIT_POLICY: readonly RateLimitRule[] = [
  // ── Admin surface ────────────────────────────────────────────────────────
  // Orchestration UI is the chatty admin surface — agents, workflows,
  // knowledge, executions. Looser cap (120/min) to absorb editor traffic
  // where one user action fans out into several list/validate/preview calls.
  {
    match: /^\/api\/v1\/admin\/orchestration\//,
    tier: 'orchestration',
    key: 'session-user',
  },

  // Core admin endpoints — users, logs, feature flags, invitations, stats.
  // Tighter cap (30/min) — these endpoints aren't part of any chatty UI
  // workflow and benefit from defense-in-depth against compromised
  // admin accounts.
  {
    match: /^\/api\/v1\/admin\//,
    tier: 'admin',
    key: 'session-user',
  },

  // ── Authentication surface ───────────────────────────────────────────────
  // Login, signup, password reset, verification. Keyed on IP (no session
  // yet) and capped tight (5/min) per OWASP brute-force guidance.
  // better-auth's own endpoints live under /api/auth/** — Sunrise's
  // application-layer auth lives under /api/v1/auth/**.
  //
  // The /api/auth/** rule matches every better-auth endpoint but ALSO
  // matches frequent non-credential reads — `get-session` fires on every
  // page focus, `sign-out` is one-shot but legitimate, and OAuth provider
  // callbacks are bursty by design. The skip predicate keeps the 5/min
  // brute-force cap targeted at the credential surface (sign-in, sign-up,
  // forget-password, reset-password, send-verification-email, verify-email,
  // change-password, accept-invite) and lets the rest through unrated at
  // the middleware layer — matching the pre-refactor behaviour and
  // preventing spurious 429s on shared-NAT session refreshes.
  {
    match: /^\/api\/v1\/auth\//,
    tier: 'auth',
    key: 'ip',
  },
  {
    match: /^\/api\/auth\//,
    tier: 'auth',
    key: 'ip',
    skip: skipNonCredentialAuthRoutes,
  },

  // ── MCP transport (LLM-agent interface) ──────────────────────────────────
  // MCP is a distinct interface from the human-facing REST API: server-to-
  // server, always API-key-authenticated, much chattier per session (agents
  // iterate through tool calls inside a conversation). It gets its own tier
  // (300/min by default — override with `RATE_LIMIT_MCP`) keyed by api-key
  // so two customers sharing a NAT'd egress get independent buckets. The
  // per-customer budget knob is `McpRateLimiter` inside the handler, sized
  // from the `apiKey.rateLimit` field; this section tier is the coarse
  // ceiling above it.
  {
    match: /^\/api\/v1\/mcp(\/|$)/,
    tier: 'mcp',
    key: 'api-key',
  },

  // ── Consumer surfaces with non-session keying ────────────────────────────
  // These all use the `'api'` tier (100/min) for the section cap, but the
  // *keying* differs from the default `session-user` because the caller's
  // identity is established by something other than a session cookie.
  // Per-flow tighter caps (apiKeyChatLimiter, embedChatLimiter, inboundLimiter,
  // contactLimiter) layer on top inside their respective handlers.

  // Webhook triggers authenticate via API key (Authorization: Bearer <key>);
  // there is no user session, and keying on IP would incorrectly group all
  // calls from a single sender even if they hold distinct keys.
  {
    match: /^\/api\/v1\/webhooks\//,
    tier: 'api',
    key: 'api-key',
  },
  // Embed widgets are anonymous; the embed token identifies the embedding
  // site. Token + IP composite (built by the middleware) mirrors the
  // long-shipping `embed:user:${token}:${ip}` convention used by the
  // per-flow `embedChatLimiter`.
  {
    match: /^\/api\/v1\/embed\//,
    tier: 'api',
    key: 'embed-token',
  },
  // Inbound triggers (Slack app-mention webhooks, Postmark email parses,
  // generic HMAC-signed senders) are server-to-server. No session, no
  // API key in the conventional sense — keyed on the remote IP.
  {
    match: /^\/api\/v1\/inbound\//,
    tier: 'api',
    key: 'ip',
  },
  // Contact form is unauthenticated public submission. Per-flow
  // contactLimiter inside the handler enforces the tight 5/hour cap;
  // the section tier here is a defense-in-depth upper bound.
  {
    match: /^\/api\/v1\/contact/,
    tier: 'api',
    key: 'ip',
  },

  // ── General authenticated API ────────────────────────────────────────────
  // Catch-all for every other route under /api/v1/. Default 100/min,
  // keyed on session. Anonymous traffic falls back to IP keying inside
  // the middleware. Routes that need a TIGHTER per-flow cap on top of
  // this (chat-stream, audio, image, upload, invite, password-reset, etc.)
  // keep their sub-limiter call in the handler — it's additive to this
  // section tier.
  {
    match: /^\/api\/v1\//,
    tier: 'api',
    key: 'session-user',
  },
];

/**
 * Find the first policy rule whose `match` accepts the given pathname.
 *
 * Returns `null` if no rule matches — the middleware treats that as
 * "don't rate-limit this request" (typical for non-API routes like
 * `/admin/users` page or static assets, which the middleware matcher
 * should already have excluded, but we double-check anyway).
 *
 * The `policy` parameter defaults to the canonical {@link RATE_LIMIT_POLICY}.
 * Production callers always use the default. The optional argument exists so
 * unit tests can exercise the matcher against a synthetic policy — including
 * the string-prefix `match` branch that no production rule uses yet — without
 * needing module-level mocks or coverage suppression annotations.
 */
export function findRateLimitRule(
  pathname: string,
  policy: readonly RateLimitRule[] = RATE_LIMIT_POLICY
): RateLimitRule | null {
  for (const rule of policy) {
    if (typeof rule.match === 'string') {
      if (pathname.startsWith(rule.match)) return rule;
    } else if (rule.match.test(pathname)) {
      return rule;
    }
  }
  return null;
}
