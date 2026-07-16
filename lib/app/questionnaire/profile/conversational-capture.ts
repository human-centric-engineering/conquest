/**
 * Conversational profile capture (F-capture) — interviewer prompt directive + transcript extraction.
 *
 * The `conversational` capture mode drops the form gate and instead has the live interviewer gather
 * the admin-authored `profileFields` naturally in the flow of conversation. This module builds the
 * imperative directive spliced into the interviewer's system prompt (mirroring the tone / strategy
 * builders), and a best-effort extraction that maps the transcript back to the fields so they land in
 * the same `AppRespondentProfileSnapshot` the form path writes.
 *
 * Only ever used for a NON-anonymous version (the resolver / caller guard on `anonymousMode`).
 */

import { z } from 'zod';

import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';
import { validateProfileSubmission } from '@/lib/app/questionnaire/profile/validate-profile-fields';
import { upsertProfileSnapshot } from '@/lib/app/questionnaire/profile/profile-snapshot';
import {
  asProfileValues,
  type ProfileValues,
} from '@/lib/app/questionnaire/profile/profile-values';

/**
 * Build the interviewer directive for conversational capture, or `''` when there's nothing to
 * collect (no fields). Injected only while the snapshot is still incomplete, so the interviewer stops
 * asking once the details are in hand. The wording keeps it gentle — weave it in, don't interrogate.
 */
export function buildProfileCaptureInstructions(fields: ProfileFieldConfig[]): string {
  if (fields.length === 0) return '';
  const lines = fields
    .map((f) => `- ${f.label}${f.required ? ' (needed)' : ' (if they offer it)'}`)
    .join('\n');
  return (
    'Early in the conversation, naturally collect a few details about the respondent before moving ' +
    'deep into the questionnaire — weave the ask into the flow, one at a time, and never as a form or ' +
    'a bulk list. Do not interrogate; if they skip an optional one, let it go. The details:\n' +
    lines +
    '\nOnce you have them, do not ask again — carry on with the questionnaire.'
  );
}

/**
 * The profile values already persisted for a session (empty object when there's no snapshot yet). The
 * interviewer reads these to decide whether the conversational subset still needs gathering
 * (`conversationalCaptureActive`) — in a hybrid version the form gate may have written the `form`
 * subset first, so "a snapshot exists" is no longer the same as "the conversational fields are in hand".
 */
export async function readProfileSnapshotValues(sessionId: string): Promise<ProfileValues> {
  const snapshot = await prisma.appRespondentProfileSnapshot.findUnique({
    where: { sessionId },
    select: { values: true },
  });
  return asProfileValues(snapshot?.values) ?? {};
}

const EXTRACT_MAX_TOKENS = 600;
const EXTRACT_TIMEOUT_MS = 8_000;

const extractionSchema = z.object({
  found: z.array(z.object({ key: z.string(), value: z.string() })),
});
const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    found: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'string' } },
        required: ['key', 'value'],
      },
    },
  },
  required: ['found'],
};

/** How many recent turns to feed the extractor — enough context, bounded for cost/latency. */
const EXTRACT_TURN_WINDOW = 12;

function buildExtractionPrompt(
  fields: ProfileFieldConfig[],
  transcript: { role: 'user' | 'assistant'; content: string }[]
): LlmMessage[] {
  const fieldLines = fields.map((f) => `- ${f.key}: ${f.label} (${f.type})`).join('\n');
  const convo = transcript
    .map((m) => `${m.role === 'user' ? 'Respondent' : 'Interviewer'}: ${m.content}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'Extract the respondent profile details below from the conversation, using ONLY what the ' +
        'RESPONDENT actually stated (never the interviewer, never a guess). Return one entry per field ' +
        'you can fill with a value the respondent clearly gave; OMIT any field they have not yet ' +
        'provided. Respond ONLY with JSON of shape {"found":[{"key":string,"value":string}]}.\n\n' +
        `Fields:\n${fieldLines}`,
    },
    { role: 'user', content: `Conversation so far:\n${convo}` },
  ];
}

/** Parse the extraction LLM response (fence-stripped JSON → Zod), null on any malformation (triggers
 *  the temp-0 retry). Exported for direct testing. */
export function parseExtraction(raw: string): z.infer<typeof extractionSchema> | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = extractionSchema.safeParse(JSON.parse(cleaned));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort: extract the conversationally-gathered profile details from the transcript and persist
 * whatever the respondent has provided so far, MERGING into the snapshot (the shared upsert accumulates
 * across passes — see `profile-snapshot.ts`). Persist is PARTIAL, not all-or-nothing: a field the
 * respondent has answered lands immediately even if others are still outstanding, which is what lets a
 * hybrid version's form subset and conversational subset coexist in one snapshot and matches the
 * confirmed "persist partial, don't block" rule. Whether the interviewer keeps asking is governed
 * separately by `conversationalCaptureActive` (required fields keep the directive alive; optional ones
 * are taken as-offered). `fields` is the CONVERSATIONAL subset only. Runs each turn while that subset is
 * still active; entirely non-fatal (an LLM/DB failure just retries next turn). Never called for an
 * anonymous version (the caller guards on `anonymousMode`).
 */
export async function extractAndPersistConversationalProfile(opts: {
  sessionId: string;
  respondentUserId: string | null;
  fields: ProfileFieldConfig[];
}): Promise<void> {
  const { sessionId, respondentUserId, fields } = opts;
  if (fields.length === 0) return;

  try {
    // Role-accurate recent transcript (the current turn is already persisted before this runs).
    const turns = await prisma.appQuestionnaireTurn.findMany({
      where: { sessionId },
      orderBy: { ordinal: 'desc' },
      take: EXTRACT_TURN_WINDOW,
      select: { userMessage: true, agentResponse: true },
    });
    if (turns.length === 0) return;
    const transcript: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const t of turns.reverse()) {
      if (t.agentResponse.trim()) transcript.push({ role: 'assistant', content: t.agentResponse });
      if (t.userMessage.trim()) transcript.push({ role: 'user', content: t.userMessage });
    }
    if (transcript.length === 0) return;

    const binding = await resolveAgentProviderAndModel(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );
    const provider = await getProvider(binding.providerSlug);
    const { value } = await runStructuredCompletion<z.infer<typeof extractionSchema>>({
      provider,
      model: binding.model,
      messages: buildExtractionPrompt(fields, transcript),
      parse: parseExtraction,
      retryUserMessage: 'Respond ONLY with JSON: {"found":[{"key":string,"value":string}]}.',
      responseSchema: EXTRACTION_JSON_SCHEMA,
      responseSchemaName: 'profile_extraction',
      maxTokens: EXTRACT_MAX_TOKENS,
      timeoutMs: EXTRACT_TIMEOUT_MS,
      phase: 'profile-capture-extraction',
    });

    const validKeys = new Set(fields.map((f) => f.key));
    const raw: Record<string, string> = {};
    for (const { key, value: v } of value.found) {
      if (validKeys.has(key) && v.trim() !== '') raw[key] = v.trim();
    }
    if (Object.keys(raw).length === 0) return; // nothing captured yet — keep gathering

    // Validate + normalise only the fields the respondent has actually answered (honouring each one's
    // `validation` mode), so a partial capture persists without a missing-required rejection blocking
    // the fields that ARE in hand. The upsert merges into any existing snapshot (e.g. the form subset).
    const capturedFields = fields.filter((f) => f.key in raw);
    const result = await validateProfileSubmission({ fields: capturedFields, raw, sessionId });
    if (!result.ok) return;
    if (Object.keys(result.values).length === 0) return; // all captured values dropped as blank

    await upsertProfileSnapshot(prisma, sessionId, respondentUserId, result.values);
    logger.info('conversational_capture: profile snapshot persisted', {
      appQuestionnaireSessionId: sessionId,
      fieldCount: Object.keys(result.values).length,
    });
  } catch (err) {
    // Non-fatal: a failed extraction just retries on the next turn. Never blocks the conversation.
    logger.warn('conversational_capture: extraction failed (will retry next turn)', {
      appQuestionnaireSessionId: sessionId,
      error: errorMessage(err),
    });
  }
}
