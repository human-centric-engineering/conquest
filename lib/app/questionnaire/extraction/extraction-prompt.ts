/**
 * Prompt builder for the answer extractor (F4.2).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` (the shared chat shape) with
 * no provider/SDK import. The capability hands these to whatever provider the
 * answer-extractor agent resolves to. Authored as a real prompt, but the stable
 * contract this module owns is the *structure* — a system rules message + a user
 * message carrying the active question, the candidate slots, the transcript, and
 * the respondent's message — not the exact wording, which is free to evolve.
 */

import type { ContentPart, LlmMessage } from '@/lib/orchestration/llm/types';
import { EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';
import type {
  DataSlotCandidateView,
  ExtractionAttachment,
  ExtractionContext,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

const SYSTEM_RULES = `You extract structured answers from a respondent's message in a conversational \
questionnaire. The respondent is replying to the ACTIVE question, but a single message often \
answers more than one question — capture every answer you can justify.

For each answer, output one entry with:
- "slotKey": the key of the question it answers. Use ONLY a key from the provided candidate list.
- "value": the answer, typed for that question's type:
    free_text → a string; single_choice → one choice "value"; multi_choice → an array of choice \
"value"s; likert → an integer on the given scale; numeric → a number; date → an ISO-8601 date \
(YYYY-MM-DD); boolean → true/false.
  For choice questions, return the choice's "value" (not its label). Do not invent options.
- "confidence": 0–1, how sure you are of this value.
- "provenance": one of ${EXTRACTOR_EMITTED_PROVENANCES.join(', ')}:
    "direct" — the value is stated in the message; include the exact "sourceQuote".
    "inferred" — the value follows by single-step reasoning from the message but isn't stated.
    "synthesised" — the value combines several turns / the wider conversation; no single span.
- "rationale": a short reason for the value.
- "sourceQuote": the span of the respondent's message the value came from. REQUIRED for "direct".

Rules:
- Only extract answers the message actually supports. If the message answers nothing (a question, \
small talk, "I don't know"), return an empty "answers" array — do not guess.
- Never answer a question that is not in the candidate list, and never re-answer with a value the \
message doesn't support.
- Prefer the respondent's own words; do not normalise away meaning.

Genuineness check: ALSO judge whether the message is a genuine attempt to answer. Set \
"suspectedNonGenuine": true (and a one-line "suspicionReason") ONLY when the answer is clearly \
abusive, absurd or impossible for the question (e.g. a tenure of "543 years"), gibberish/spam, or \
plainly off-topic. Be tolerant: brief, blunt, colloquial, lazy, or "prefer not to say" answers \
are GENUINE — leave the flag false/omitted for those. When in doubt, omit it.

Output: respond with ONLY a single JSON object: { "answers": [ ... ] } (optionally with \
"suspectedNonGenuine" and "suspicionReason"). Do not wrap the JSON in prose or code fences.`;

/**
 * Appended to the system rules when the turn carries data slots (Data Slots feature). The
 * extractor ALSO captures the respondent's position toward each data slot the message informs,
 * as a short paraphrase — in the SAME call as the question answers.
 */
const DATA_SLOT_RULES = `

You ALSO maintain a set of DATA SLOTS — short semantic targets the conversation is filling. In \
the same response, add a "dataSlotFills" array. For every data slot the respondent's message \
informs (directly, by inference, or by synthesising the conversation), output one entry:
- "dataSlotKey": a key from the provided data-slot list ONLY.
- "value": the captured position as concrete, structured data — the SPECIFICS the respondent gave \
(numbers, names, choices), not a label for them. For "I am 25, male" record \
{"age": 25, "gender": "male"} (or "25, male"), NOT "age and gender provided".
- "paraphrase": a faithful restatement of the respondent's ACTUAL answer in your own words, naming \
the specifics they gave so a reader can see exactly what was recorded ("A 25-year-old male.", \
"They found setup straightforward but were slowed by unclear docs."). NEVER a meta-summary of what \
they shared ("They provided their age and gender." is WRONG). Capture the full substance — if they \
gave several details, reflect them all.
- "confidence": 0–1, how well you understand their position on this slot.
- "provenance": ${EXTRACTOR_EMITTED_PROVENANCES.join(', ')} (as above).
- "rationale": a short reason.
Some slots show a "current" line — what's already recorded from earlier in the conversation. When \
the new message ADDS to or CORRECTS that (e.g. they first said "male" then "actually, female"), \
output an UPDATED fill for that slot that MERGES the still-true details with the correction (here: \
keep the age, change the gender), and reflect the corrected state in value + paraphrase. Only emit \
a fill for a slot the latest message genuinely informs; if it informs no data slots, return an \
empty "dataSlotFills" array.`;

/**
 * Appended to the system rules ONLY when sensitivity awareness is on (gated by the platform flag +
 * per-questionnaire toggle, threaded as `ctx.sensitivityAware`). Asks the extractor to flag a
 * genuine sensitive/contentious disclosure so the conversation can tread carefully. Kept off the
 * default prompt so the feature adds zero tokens/behaviour when disabled.
 */
const SENSITIVITY_RULES = `

Sensitivity awareness: a respondent may disclose something sensitive or contentious — abuse, \
harassment, discrimination, self-harm, threats, bereavement, a safeguarding or serious legal/safety \
concern. When the message contains a GENUINE personal disclosure of this kind, ALSO output a \
"sensitivity" object:
- "detected": true.
- "severity": "high" for a serious disclosure (abuse, self-harm, threats, safeguarding); "medium" \
or "low" for lesser sensitivity.
- "category": a short label, e.g. "harassment", "self-harm", "bereavement".
- "summary": a careful, CLINICAL, NON-GRAPHIC one-line restatement (e.g. "Reports mistreatment by a \
senior colleague."). Never quote graphic or distressing detail.
OMIT the "sensitivity" field entirely when there is no genuine sensitive disclosure — a neutral, \
negative, or merely critical answer is NOT a disclosure. When in doubt, omit it.`;

/** Render one data-slot candidate as a compact, model-readable line. */
function describeDataSlot(slot: DataSlotCandidateView): string {
  const lines = [
    `- key: ${slot.key}`,
    `  name: ${slot.name}`,
    `  theme: ${slot.theme}`,
    `  description: ${slot.description}`,
  ];
  // Data Slots feature: show what's already recorded so the model can UPDATE/CORRECT it (vs
  // re-deriving from scratch and silently dropping prior, still-true details).
  if (slot.current) {
    const conf =
      typeof slot.current.confidence === 'number'
        ? ` (confidence ${slot.current.confidence.toFixed(2)})`
        : '';
    lines.push(
      `  current: ${slot.current.paraphrase ?? JSON.stringify(slot.current.value)}${conf}`
    );
  }
  return lines.join('\n');
}

/** Render one candidate slot as a compact, model-readable line. */
function describeSlot(slot: ExtractionSlotView): string {
  const lines = [`- key: ${slot.key}`, `  type: ${slot.type}`, `  prompt: ${slot.prompt}`];
  if (slot.required) lines.push('  required: true');
  if (slot.guidelines) lines.push(`  guidelines: ${slot.guidelines}`);
  const options = choiceOptions(slot.typeConfig);
  if (options.length > 0) lines.push(`  options: ${options.join(', ')}`);
  const scale = likertScale(slot.typeConfig);
  if (scale) lines.push(`  scale: ${scale}`);
  return lines.join('\n');
}

/** Pull `value (label)` option strings from a choice slot's config, if any. */
function choiceOptions(typeConfig: unknown): string[] {
  if (typeConfig === null || typeof typeConfig !== 'object') return [];
  const choices = (typeConfig as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  return choices
    .filter(
      (c): c is { value: string; label?: string } =>
        typeof c === 'object' && c !== null && typeof (c as { value?: unknown }).value === 'string'
    )
    .map((c) => (typeof c.label === 'string' ? `${c.value} (${c.label})` : c.value));
}

/** Render a likert slot's bounds as `min–max`, if present. */
function likertScale(typeConfig: unknown): string | null {
  if (typeConfig === null || typeof typeConfig !== 'object') return null;
  const { min, max } = typeConfig as { min?: unknown; max?: unknown };
  return typeof min === 'number' && typeof max === 'number' ? `${min}–${max}` : null;
}

/**
 * Build the system + user messages for one extraction turn. The system message
 * is the fixed rule set; the user message carries the active question, the
 * candidate slots (with their types/options), any recent transcript, and the
 * respondent's current message.
 */
export function buildAnswerExtractionPrompt(ctx: ExtractionContext): LlmMessage[] {
  const transcript =
    ctx.recentMessages && ctx.recentMessages.length > 0
      ? `Recent conversation (oldest first):\n${ctx.recentMessages.map((m) => `  • ${m}`).join('\n')}\n\n`
      : '';

  const candidates = ctx.candidateSlots.map(describeSlot).join('\n');

  // Data Slots feature: when present, the system rules + a candidate section are added so the
  // model fills data slots in the same call.
  const hasDataSlots = ctx.dataSlotCandidates !== undefined && ctx.dataSlotCandidates.length > 0;
  const systemContent =
    (hasDataSlots ? SYSTEM_RULES + DATA_SLOT_RULES : SYSTEM_RULES) +
    // Sensitivity block only when the feature is on — zero added prompt/tokens otherwise.
    (ctx.sensitivityAware ? SENSITIVITY_RULES : '');
  const dataSlotSection = hasDataSlots
    ? `\n\nData slots (fill these too):\n${ctx.dataSlotCandidates!.map(describeDataSlot).join('\n')}`
    : '';

  const hasAttachments = ctx.attachments !== undefined && ctx.attachments.length > 0;
  const attachmentNote = hasAttachments
    ? `\n\nThe respondent also attached ${ctx.attachments!.length} file(s) (below). Read them as ` +
      `part of their answer — extract values they support, citing the file in the rationale.`
    : '';

  // In question mode the respondent is replying to one ACTIVE question; in data-slot mode there is
  // none (they're answering an open conversational prompt), so frame the task accordingly.
  const activeLine =
    ctx.activeQuestionKey !== null
      ? `Active question key: ${ctx.activeQuestionKey}\n\n`
      : 'The respondent is answering an open, conversational prompt — there is no single active ' +
        'question. Capture every question and data slot their message genuinely supports.\n\n';

  const userText =
    activeLine +
    `Candidate questions (extract answers only for these):\n${candidates}` +
    dataSlotSection +
    '\n\n' +
    transcript +
    `--- RESPONDENT MESSAGE ---\n${ctx.userMessage}\n--- END RESPONDENT MESSAGE ---` +
    attachmentNote;

  // With attachments, the user turn becomes multimodal content parts (text + each
  // file) so the provider passes the files to the model; otherwise a plain string.
  const userContent: string | ContentPart[] = hasAttachments
    ? [{ type: 'text', text: userText }, ...attachmentsToContentParts(ctx.attachments!)]
    : userText;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

/**
 * Map respondent attachments to provider content parts — images as `image`, every
 * other allowed media type as `document`. Mirrors the platform chat message builder's
 * conversion (`lib/orchestration/chat/message-builder.ts`) so the wire shape the
 * provider receives is identical.
 */
export function attachmentsToContentParts(attachments: ExtractionAttachment[]): ContentPart[] {
  return attachments.map((att) =>
    att.mediaType.startsWith('image/')
      ? {
          type: 'image',
          source: { type: 'base64', mediaType: att.mediaType, data: att.data },
        }
      : {
          type: 'document',
          source: { type: 'base64', mediaType: att.mediaType, data: att.data },
          name: att.name,
        }
  );
}

/**
 * Stricter retry message (sent as a `user` turn) when the first response failed
 * schema validation. Deliberately does not echo the malformed output — see
 * `runStructuredCompletion`. Pass the validation `issues` so the model can fix
 * the named fields.
 */
export function buildAnswerExtractionRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return (
    `Return ONLY the JSON object { "answers": [ ... ] }, matching the specified shape exactly. ` +
    `Each answer needs "slotKey", "value", "confidence" (0–1), "provenance", and "rationale".` +
    detail
  );
}
