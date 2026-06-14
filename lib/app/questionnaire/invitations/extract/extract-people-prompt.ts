/**
 * Prompt builder for AI invitee extraction. Pure, provider-agnostic — returns `LlmMessage[]` (the
 * shared chat shape) for either parsed document TEXT (PDF/DOCX) or an IMAGE content part (a
 * screenshot/photo of a list). The model returns the {@link extractPeopleSchema} JSON, validated by
 * `parseExtractedPeople`.
 */

import type { ContentPart, LlmMessage } from '@/lib/orchestration/llm/types';

const SYSTEM = `You extract a list of PEOPLE TO INVITE from the supplied content (a document or an \
image of a list). Return ONLY a JSON object: { "people": [ { "email", "firstName?", "surname?", \
"jobTitle?", "team?", "organisation?" } ] }.

Rules:
- Include a person ONLY if you can find a real email address for them. Skip anyone without one.
- Copy emails verbatim (do not guess or correct domains). Lowercase them.
- Fill firstName/surname/jobTitle/team/organisation only when clearly present; omit otherwise.
- Never invent people or details. Deduplicate by email.
- Output ONLY the JSON object — no prose, no markdown fences.`;

/** Stricter retry instruction when the first response failed to parse. */
export const EXTRACT_PEOPLE_RETRY =
  'Return ONLY the JSON object { "people": [ { "email", "firstName?", "surname?", "jobTitle?", ' +
  '"team?", "organisation?" } ] } — no prose, no code fences.';

/** Build messages for extracting people from already-parsed document text. */
export function buildPeopleTextPrompt(documentText: string): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Extract the people to invite from this text:\n\n${documentText}`,
    },
  ];
}

/** Build messages for extracting people from an image (base64), as a multimodal user turn. */
export function buildPeopleImagePrompt(image: { mediaType: string; data: string }): LlmMessage[] {
  const parts: ContentPart[] = [
    { type: 'text', text: 'Extract the people to invite from this image.' },
    { type: 'image', source: { type: 'base64', mediaType: image.mediaType, data: image.data } },
  ];
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: parts },
  ];
}
