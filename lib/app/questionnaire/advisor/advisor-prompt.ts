/**
 * Prompt builders for the Config Advisor's two phases.
 *
 * Phase 1 (`buildAdvisorNarrativePrompt`) streams a plain-language narrative: the current lifecycle
 * state, then the respondent experience the current configuration actually produces. Phase 2
 * (`buildAdvisorSuggestionsPrompt`) re-reads the same snapshot plus the narrative just produced and
 * emits a STRUCTURED JSON analysis (conflicts + one-click suggestions).
 *
 * The load-bearing reasoning rules live here (not in the seeded agent's `systemInstructions`), the
 * same split the composer uses. Pure: builds `LlmMessage[]` from a snapshot; no Prisma / Next / LLM
 * imports.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { AdvisorContext } from '@/lib/app/questionnaire/advisor/context';
import { ADVISOR_APPLYABLE_CONFIG_FIELDS } from '@/lib/app/questionnaire/advisor/advisor-schema';

/**
 * A concise reference of how the most interaction-prone settings behave + known conflict heuristics,
 * so the model reasons about real effects instead of generic survey advice. Deliberately short — the
 * full config values travel in the serialised snapshot.
 */
const SETTINGS_REFERENCE = `Reference — how key settings shape the respondent experience, and common conflicts:
- selectionStrategy: sequential|random|weighted|adaptive. 'adaptive' picks the next question with an
  LLM using the running answers; it needs enough questions answered to be worthwhile and is wasted
  when maxQuestionsPerSession is very low.
- minQuestionsAnswered / coverageThreshold: the completion bar. A high minQuestionsAnswered or
  coverageThreshold close to 1 with maxQuestionsPerSession set low can make completion unreachable.
- maxQuestionsPerSession / costBudgetUsd: hard caps. A tight cap with many required questions means
  respondents hit the cap before finishing the required set — a dead end.
- accessMode: invitation_only|public|both. 'public' (no login) combined with required PII profile or
  invitee fields, or with anonymousMode off, is a friction/trust conflict.
- anonymousMode: when on, identifying answers shouldn't be required; pair with sensitivityAwareness
  for sensitive topics.
- contradictionMode: off|flag|probe. 'probe' spends turns re-asking; with a low maxQuestionsPerSession
  it eats the budget meant for coverage. contradictionWindowN must be > 0 when mode is not 'off'.
- answerFitMode: off|fallback|always. 'always' re-maps every answer (slower, costlier) and is overkill
  for short questionnaires.
- presentationMode: chat|form|both. 'form' makes the conversational features (tone, reasoning stream,
  contradiction probing, adaptive selection) invisible — flag when those are enabled under 'form'.
- reasoningStream*: the "watch it think" overlay. Only meaningful in a chat presentation.
- sensitivityAwareness / supportMessage / supportResourceUrl: safeguarding. If sensitivityAwareness is
  on, a supportMessage/resource should usually be set; if the questionnaire is clearly sensitive and
  it's off, recommend turning it on.
- tone (persona + dimensions), respondentReport, cohortReport, intro, profileFields, inviteeFields:
  richer config blocks edited elsewhere — you MAY discuss them as conflicts, but do NOT propose them as
  one-click patches.`;

/** Serialise the snapshot into a compact, labelled block the model can read. */
export function serializeAdvisorContext(ctx: AdvisorContext): string {
  return JSON.stringify(
    {
      questionnaire: ctx.questionnaire,
      version: ctx.version,
      structure: ctx.structure,
      config: ctx.config,
      dataSlots: ctx.dataSlots,
      scoring: ctx.scoring,
    },
    null,
    2
  );
}

/** Phase 1 — the streamed narrative. */
export function buildAdvisorNarrativePrompt(ctx: AdvisorContext): LlmMessage[] {
  const system = `You are the Config Advisor for a conversational questionnaire platform (ConQuest). \
An admin has asked you to review one questionnaire version's configuration. Write a clear, concise \
narrative in Markdown with two short sections:

## Current state
One short paragraph: the lifecycle state (draft / launched / archived), version number, whether a \
config has been saved, and how many respondent sessions exist — and what that means (e.g. a launched \
version with in-flight sessions means config edits fork a new draft).

## Respondent experience
2–4 short paragraphs describing, in plain language, the experience a respondent will actually have \
given THIS configuration: how they get in (access/identity), how questions are presented and selected, \
the conversational behaviours that are on or off, how completion is judged, and any safeguarding. Be \
specific and reference settings by their effect, not just their names. If something is misconfigured \
or self-defeating, say so plainly in this prose (the precise fixes come in a separate step — do not \
output JSON or a bulleted fix-list here).

${SETTINGS_REFERENCE}`;

  const user = `Here is the questionnaire snapshot to review:\n\n${serializeAdvisorContext(ctx)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Phase 2 — the structured conflicts + one-click suggestions. */
export function buildAdvisorSuggestionsPrompt(
  ctx: AdvisorContext,
  narrative: string
): LlmMessage[] {
  const applyable = ADVISOR_APPLYABLE_CONFIG_FIELDS.join(', ');

  const system = `You are the Config Advisor for a conversational questionnaire platform (ConQuest). \
You have already written a narrative review (provided below). Now output a STRUCTURED analysis as a \
single JSON object — no prose, no Markdown, no code fence — with exactly this shape:

{
  "conflicts": [
    { "title": string, "detail": string, "settings": string[], "severity": "info"|"warning"|"critical" }
  ],
  "suggestions": [
    { "id": string, "title": string, "rationale": string, "severity": "info"|"warning"|"critical",
      "patch": { <configField>: <newValue>, ... } }
  ]
}

Rules:
- "conflicts" are problems you observed (settings that fight each other or hurt the experience). They
  are descriptive only.
- "suggestions" are concrete, one-click config changes. Each "patch" is a partial config object whose
  keys MUST be drawn ONLY from this allowlist: ${applyable}. Use the SAME value types as the snapshot's
  config (numbers for numbers, booleans for booleans, the documented enum strings for enums).
- Put co-dependent fields in the SAME patch (e.g. setting contradictionMode to "probe" must include a
  contradictionWindowN > 0; setting it to "off" must include contradictionWindowN: 0).
- Only propose a change you would actually recommend. If the configuration is already sound, return an
  empty "suggestions" array. Do NOT propose a field that is already at the value you'd recommend.
- Never invent fields. Settings outside the allowlist (tone, reports, intro, profile/invitee fields)
  may appear in "conflicts" but never in a "patch".
- Keep it tight: at most the handful of highest-value suggestions.

${SETTINGS_REFERENCE}`;

  const user = `Snapshot:\n\n${serializeAdvisorContext(ctx)}\n\nYour narrative review:\n\n${narrative}\n\nNow output the JSON analysis.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Retry nudge when the analysis JSON didn't validate (used by runStructuredCompletion). */
export function buildAdvisorRetryMessage(): string {
  return `Your previous response was not valid against the required JSON shape. Respond with ONLY a \
single JSON object matching { "conflicts": [...], "suggestions": [...] } as specified — no prose, no \
Markdown, no code fence. Every suggestion "patch" key must be one of: ${ADVISOR_APPLYABLE_CONFIG_FIELDS.join(', ')}.`;
}
