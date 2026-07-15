/**
 * Respondent profile-field validation (F-capture) — deterministic, agentic, or hybrid per field.
 *
 * Extends the pure deterministic validation in `profile-values.ts` with an optional best-effort LLM
 * pass that BOTH normalises a value (proper-case names, tidy organisation, E.164-ish phone) AND flags
 * implausible / garbage input (`asdf`, `test@test`). Each field's `validation` mode decides which
 * layers run:
 *   - `deterministic` — Zod/regex only (format, required, select membership). No LLM.
 *   - `agentic`       — structural checks (required, number/select) stay deterministic; text/email
 *                        plausibility + normalisation are delegated to the LLM.
 *   - `hybrid`        — the deterministic gate runs first (a format failure rejects WITHOUT spending
 *                        an LLM call); on pass, the agentic layer normalises/flags.
 *
 * The agentic layer is NON-FATAL: an LLM outage / timeout / malformed response falls back to the
 * deterministic-passed value and never blocks a respondent (mirrors `resolveAnswerFit`'s convention
 * in `capabilities/extract-answer-slots.ts`). Server-only (provider resolution + cost logging).
 *
 * ANONYMOUS MODE: never reaches here — the capture seam skips collection entirely when
 * `anonymousMode = true`, so no profile values are validated, stored, or surfaced.
 */

import { z } from 'zod';

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';
import {
  buildProfileValuesSchema,
  type ProfileValues,
} from '@/lib/app/questionnaire/profile/profile-values';

/** Outcome of validating a raw submission against a version's profile fields. */
export type ProfileValidationResult =
  /** Every field passed; `values` are cleaned + (where agentic) normalised, ready to persist. */
  | { ok: true; values: ProfileValues }
  /** One or more fields failed; `fieldErrors` is keyed by field `key` for per-input display. */
  | { ok: false; fieldErrors: Record<string, string>; message: string };

const AGENTIC_MAX_TOKENS = 800;
const AGENTIC_TIMEOUT_MS = 8_000;
/**
 * Max characters a raw `text`/`email` value may carry into the AGENTIC path. The deterministic schema
 * already caps text at 2000 / email at 320 (`profile-values.ts`), but the agentic path deliberately
 * skips that gate — so without this a token holder could push a multi-MB value straight into the paid
 * LLM (input-token cost) and into the persisted JSON. Mirrors the deterministic ceilings.
 */
const AGENTIC_MAX_TEXT_LEN = 2000;
const AGENTIC_MAX_EMAIL_LEN = 320;

/** True when a raw value is "not supplied" (mirrors `validateProfileValues`' cleaning). */
function isBlank(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
  );
}

type FieldCheck = { ok: true; value: string | number } | { ok: false; message: string };

/**
 * Deterministic single-field check: required-ness + the type-aware schema (reused from
 * `profile-values.ts` so the client form and this server seam share the exact same rules).
 */
function checkFieldDeterministic(field: ProfileFieldConfig, raw: unknown): FieldCheck {
  if (isBlank(raw)) {
    return field.required
      ? { ok: false, message: `${field.label} is required` }
      : { ok: true, value: '' }; // optional + blank → dropped by the caller
  }
  const parsed = buildProfileValuesSchema([field]).safeParse({ [field.key]: raw });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid value' };
  }
  return { ok: true, value: (parsed.data as ProfileValues)[field.key] };
}

/**
 * Structural-only check for an `agentic` field: `number`/`select` correctness stays deterministic
 * (a select must be a real option; a number must parse), while `text`/`email` plausibility is left to
 * the LLM. Required-ness is always enforced here.
 */
function checkFieldStructural(field: ProfileFieldConfig, raw: unknown): FieldCheck {
  if (isBlank(raw)) {
    return field.required
      ? { ok: false, message: `${field.label} is required` }
      : { ok: true, value: '' };
  }
  if (field.type === 'number' || field.type === 'select') {
    return checkFieldDeterministic(field, raw);
  }
  // text / email: accept the trimmed string; the LLM judges plausibility. Bound the length first so an
  // oversized value can't reach the paid LLM (input-token cost) or land in the persisted snapshot.
  const trimmed = String(raw).trim();
  const max = field.type === 'email' ? AGENTIC_MAX_EMAIL_LEN : AGENTIC_MAX_TEXT_LEN;
  if (trimmed.length > max) {
    return { ok: false, message: `${field.label} is too long (max ${max} characters)` };
  }
  return { ok: true, value: trimmed };
}

/** The LLM plausibility/normalisation response, one row per submitted agentic field. */
const agenticResponseSchema = z.object({
  results: z.array(
    z.object({
      key: z.string(),
      plausible: z.boolean(),
      normalized: z.string(),
      reason: z.string().optional(),
    })
  ),
});
type AgenticResponse = z.infer<typeof agenticResponseSchema>;

const AGENTIC_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          plausible: { type: 'boolean' },
          normalized: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['key', 'plausible', 'normalized'],
      },
    },
  },
  required: ['results'],
};

function buildAgenticPrompt(
  fields: { field: ProfileFieldConfig; value: string | number }[]
): LlmMessage[] {
  const lines = fields
    .map(
      ({ field, value }) =>
        `- key: ${field.key} | label: ${field.label} | type: ${field.type} | value: ${JSON.stringify(value)}`
    )
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You validate short profile fields a person entered before a questionnaire (their name, ' +
        'email, organisation, etc.). For each field decide whether the value is a PLAUSIBLE, ' +
        'genuine entry (reject obvious placeholders/gibberish like "asdf", "test test", "n/a", ' +
        '"test@test", repeated characters) and return a NORMALISED version (proper-case names, ' +
        'tidy organisation names, trim whitespace, E.164-style phone where it is clearly a phone ' +
        'number). Never invent information: if the value is already clean, echo it. Keep emails ' +
        'lowercased. Respond ONLY with JSON of shape ' +
        '{"results":[{"key":string,"plausible":boolean,"normalized":string,"reason"?:string}]}. ' +
        'Set reason only when plausible is false, as a short respondent-facing explanation.',
    },
    { role: 'user', content: `Fields:\n${lines}` },
  ];
}

/** Parse the agentic LLM response (fence-stripped JSON → Zod), returning null on any malformation
 *  (which triggers `runStructuredCompletion`'s temp-0 retry). Exported for direct testing. */
export function parseAgentic(raw: string): AgenticResponse | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = agenticResponseSchema.safeParse(JSON.parse(cleaned));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validate a raw respondent submission against a version's profile fields, honouring each field's
 * `validation` mode. Returns cleaned + normalised {@link ProfileValues} on success, or per-field
 * error messages on failure. The agentic layer is best-effort and never throws.
 */
export async function validateProfileSubmission(opts: {
  fields: ProfileFieldConfig[];
  raw: Record<string, unknown>;
  /** For cost-log correlation. */
  sessionId: string;
  agentId?: string;
}): Promise<ProfileValidationResult> {
  const { fields, raw, sessionId, agentId } = opts;
  const fieldErrors: Record<string, string> = {};
  const values: ProfileValues = {};
  // Fields whose value survives the deterministic/structural gate and wants an agentic pass.
  const agenticCandidates: { field: ProfileFieldConfig; value: string | number }[] = [];

  for (const field of fields) {
    const rawValue = raw[field.key];
    const wantsAgentic = field.validation === 'agentic' || field.validation === 'hybrid';
    // `agentic` softens text/email format to the LLM; `deterministic`/`hybrid` gate on it first.
    const check =
      field.validation === 'agentic'
        ? checkFieldStructural(field, rawValue)
        : checkFieldDeterministic(field, rawValue);

    if (!check.ok) {
      fieldErrors[field.key] = check.message;
      continue;
    }
    // Optional + blank → not supplied; drop it (never persisted, never sent to the LLM).
    if (isBlank(rawValue)) continue;

    values[field.key] = check.value;
    // Select values are constrained choices — no plausibility/normalisation needed.
    if (wantsAgentic && field.type !== 'select') {
      agenticCandidates.push({ field, value: check.value });
    }
  }

  // A deterministic/hybrid format failure already rejected the submission — return before any LLM.
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, message: 'Some details need a quick fix.' };
  }
  if (agenticCandidates.length === 0) {
    return { ok: true, values };
  }

  // ── Agentic pass — best-effort, non-fatal. Any failure keeps the deterministic values. ──
  try {
    const binding = await resolveAgentProviderAndModel(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );
    const provider = await getProvider(binding.providerSlug);
    const completion = await runStructuredCompletion<AgenticResponse>({
      provider,
      model: binding.model,
      messages: buildAgenticPrompt(agenticCandidates),
      parse: parseAgentic,
      retryUserMessage:
        'Respond ONLY with JSON: {"results":[{"key":string,"plausible":boolean,"normalized":string,"reason"?:string}]}.',
      responseSchema: AGENTIC_RESPONSE_JSON_SCHEMA,
      responseSchemaName: 'profile_validation',
      maxTokens: AGENTIC_MAX_TOKENS,
      timeoutMs: AGENTIC_TIMEOUT_MS,
      phase: 'profile-validation',
    });

    void logCost({
      ...(agentId ? { agentId } : {}),
      operation: CostOperation.CHAT,
      model: binding.model,
      provider: binding.providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'profile_validation', appQuestionnaireSessionId: sessionId },
    }).catch((err) => {
      logger.error('validate_profile_fields: logCost rejected', { error: errorMessage(err) });
    });

    const byKey = new Map(completion.value.results.map((r) => [r.key, r]));
    for (const { field } of agenticCandidates) {
      const result = byKey.get(field.key);
      if (!result) continue; // model dropped the field → keep the deterministic value
      if (!result.plausible) {
        fieldErrors[field.key] =
          result.reason?.trim() || `Enter a valid ${field.label.toLowerCase()}`;
        continue;
      }
      const normalized = result.normalized.trim();
      if (normalized === '') continue; // never overwrite with an empty normalisation
      if (field.type === 'number') {
        // Only accept a numeric normalisation; a non-finite "tidy" (e.g. "1,000", "42 people") must
        // NOT clobber the deterministically-coerced number with a string in a number-typed slot.
        if (Number.isFinite(Number(normalized))) values[field.key] = Number(normalized);
      } else {
        values[field.key] = normalized;
      }
    }
  } catch (err) {
    // Non-fatal: an LLM outage must never block a respondent. Deterministic values stand.
    logger.warn('validate_profile_fields: agentic pass failed (deterministic values stand)', {
      appQuestionnaireSessionId: sessionId,
      error: errorMessage(err),
    });
    return { ok: true, values };
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, message: 'Some details need a quick fix.' };
  }
  return { ok: true, values };
}
