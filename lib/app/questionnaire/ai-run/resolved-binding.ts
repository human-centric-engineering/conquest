/**
 * Reading the resolved model off a capability dispatch, for provenance.
 *
 * `AppAiRun.provider` / `.model` are documented as the binding that actually served a call. They
 * did not hold it. Every caller recorded the AGENT ROW's configured values, and the app's agents
 * deliberately ship with empty `provider`/`model` so they resolve to a tier at call time — so the
 * column stored `''`, `'n/a'` or `'resolved-at-runtime'` for calls that had really run on, say,
 * `openai/gpt-5.4`. Answering "which model served this run?" meant joining `ai_cost_log` on a
 * timestamp, which is exactly what a corpus-run ledger cannot ask of the next reader.
 *
 * The capabilities resolve the binding before dialling and now return it beside their result.
 * This module is the read side: a narrow, defensive parse rather than a cast, because a dispatch
 * result is `unknown` at the boundary and a capability that predates the wider data type must
 * degrade to the sentinel rather than throw inside a provenance write.
 *
 * Pure — no Prisma, no provider, no Next.
 */

/** The sentinel meaning "no model served this" — a call that failed before reaching a provider. */
export const UNRESOLVED_BINDING = 'n/a';

export interface ResolvedRunBinding {
  provider: string;
  model: string;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Pull the resolved `provider` / `model` out of a capability's dispatch data.
 *
 * Falls back to {@link UNRESOLVED_BINDING} on either field the dispatch did not carry, so a
 * provenance row is always written with a legible value. A partially-populated result keeps the
 * half it has: knowing the provider but not the model still beats recording neither.
 */
export function readResolvedBinding(data: unknown): ResolvedRunBinding {
  if (typeof data !== 'object' || data === null) {
    return { provider: UNRESOLVED_BINDING, model: UNRESOLVED_BINDING };
  }
  const source = data as Record<string, unknown>;
  return {
    provider: readString(source, 'provider') ?? UNRESOLVED_BINDING,
    model: readString(source, 'model') ?? UNRESOLVED_BINDING,
  };
}

/**
 * Normalise a binding a caller already holds (e.g. an agent row, or a verifier's own report).
 *
 * The `??` trap this replaces: `verification.provider ?? 'n/a'` looks right but an agent that
 * resolves at call time carries an EMPTY STRING, not `null`, so the sentinel never fired and the
 * column stored `''`. Empty and nullish are both "not resolved" here.
 */
export function normaliseBinding(
  provider?: string | null,
  model?: string | null
): ResolvedRunBinding {
  return {
    provider: provider && provider.trim().length > 0 ? provider : UNRESOLVED_BINDING,
    model: model && model.trim().length > 0 ? model : UNRESOLVED_BINDING,
  };
}

/**
 * Pull the USD cost of a capability's LLM call out of its dispatch data.
 *
 * The sibling of {@link readResolvedBinding}, and the same gap one column over. `AppAiRun.costUsd`
 * was never written by the ingest chain — `stream/route.ts`, `scope-candidacy.ts` and
 * `routing-analysis.ts` all omitted it, while the session-side writers (`plan-scope.ts`,
 * `amend-plan.ts`, `run-advance.ts`) passed it — so the routing corpus' documented
 * "pull the run rows" query returned a blank cost column every time and a reader had to join
 * `ai_cost_log` on a timestamp to price a run.
 *
 * `null` rather than `0` when absent: zero is a real answer meaning "this was free", and a
 * provenance row that cannot price itself should say so rather than under-report the bill.
 * Negative and non-finite values are treated as absent for the same reason.
 */
export function readResolvedCost(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>).costUsd;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
