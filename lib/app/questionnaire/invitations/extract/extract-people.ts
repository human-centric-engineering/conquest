/**
 * AI invitee extraction runner — resolves a provider/model from system defaults and runs one
 * structured completion to pull people out of document text or an image. Reuses the same
 * call→parse→retry→cost-log discipline as the answer extractor (`runStructuredCompletion`).
 *
 * Server-only (provider resolution + DB). PII: emails/names — the calling route gates on the
 * invite-import flag and rate-limits; cost is logged by `runStructuredCompletion`.
 */

import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import {
  assertModelSupportsAttachments,
  getProvider,
} from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/evaluations/parse-structured';

import {
  buildPeopleImagePrompt,
  buildPeopleTextPrompt,
  EXTRACT_PEOPLE_RETRY,
} from '@/lib/app/questionnaire/invitations/extract/extract-people-prompt';
import { parseExtractedPeople } from '@/lib/app/questionnaire/invitations/extract/extract-people-schema';
import type { ParsedInvitee } from '@/lib/app/questionnaire/invitations/import/types';

const MAX_TOKENS = 4000;
const TIMEOUT_MS = 30_000;

async function resolveDefault() {
  const binding = await resolveAgentProviderAndModel(
    { provider: '', model: '', fallbackProviders: [] },
    'reasoning'
  );
  const provider = await getProvider(binding.providerSlug);
  return { provider, providerSlug: binding.providerSlug, model: binding.model };
}

/** Extract people from already-parsed document text (PDF/DOCX). */
export async function extractPeopleFromText(documentText: string): Promise<ParsedInvitee[]> {
  const { provider, model } = await resolveDefault();
  const { value } = await runStructuredCompletion<ParsedInvitee[]>({
    provider,
    model,
    messages: buildPeopleTextPrompt(documentText),
    parse: parseExtractedPeople,
    retryUserMessage: EXTRACT_PEOPLE_RETRY,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  return value;
}

/** Extract people from an image (base64) — requires a vision-capable default model. */
export async function extractPeopleFromImage(image: {
  mediaType: string;
  data: string;
}): Promise<ParsedInvitee[]> {
  const { provider, providerSlug, model } = await resolveDefault();
  // Strict: a non-vision default model can't read the image — surface a clear capability error.
  await assertModelSupportsAttachments(providerSlug, model, ['vision']);
  const { value } = await runStructuredCompletion<ParsedInvitee[]>({
    provider,
    model,
    messages: buildPeopleImagePrompt(image),
    parse: parseExtractedPeople,
    retryUserMessage: EXTRACT_PEOPLE_RETRY,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  return value;
}
