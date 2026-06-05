/**
 * Prompt builder for the design-time judges (F5.1).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` (the shared chat shape) with no
 * provider/SDK import. The `evaluate-structure` capability hands these to whatever
 * provider each judge agent resolves to. As with the F4 prompts, the stable contract
 * this module owns is the *structure* — a system rules message carrying the
 * dimension's rubric plus a user message serialising the questionnaire — not the exact
 * wording, which is free to evolve.
 *
 * The **rubric lives here, in code**, not in the agent row. The seeded judge agents
 * carry a mirror of the rubric in `systemInstructions` purely so they're
 * self-describing in the admin UI; the load-bearing wording is these builders, the
 * same split F4.5's completion agent uses. That's what makes the panel reproducible
 * and git-diffable: tuning a judge is a code change, reviewed like any other.
 *
 * Output contract (validated by `judge-schema.ts`): one JSON object with a continuous
 * `score` in [0, 1] and a `findings` array. Each finding addresses its target by
 * `targetKey`: a question's stable `key`, `section:<title>`, or the literal `goal` /
 * `audience`. Stating the addressing convention in the prompt keeps the judge's
 * `targetKey` reconcilable by F5.3 at apply time.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import type {
  EvaluationDimension,
  VersionStructureInput,
  StructureSection,
} from '@/lib/app/questionnaire/evaluation/types';
import type { AudienceShape } from '@/lib/app/questionnaire/types';

/** The rubric inserts for one dimension. */
interface DimensionRubric {
  /** What the judge looks at — the dimension's focus. */
  focus: string;
  /** The 0.0–1.0 scoring scale with anchor points. */
  scale: string;
  /** What this judge does NOT score, so dimensions don't bleed into each other. */
  ignore: string;
}

/**
 * Per-dimension rubrics. Each follows the platform evaluation-judge shape (a focused
 * job + a continuous anchored scale + an explicit IGNORE clause) adapted from "score a
 * response" to "score a questionnaire's structure and propose edits".
 */
const DIMENSION_RUBRICS: Record<EvaluationDimension, DimensionRubric> = {
  clarity: {
    focus:
      'Judge whether each question is clearly worded: unambiguous, asking exactly one thing (not double-barrelled), free of undefined jargon, and answerable without re-reading. Flag vague wording, loaded or leading phrasing, and questions that smuggle in two asks.',
    scale: `- 1.0 — Every question is crisp and single-barrelled.
- 0.7 — Mostly clear; one or two questions are slightly wordy or mildly ambiguous.
- 0.5 — Several questions are ambiguous or double-barrelled.
- 0.3 — Most questions need rewording to be answerable.
- 0.0 — Pervasively unclear.`,
    ignore:
      'Whether the question is the RIGHT question for the goal (Coverage/Goal-Match judge that), its answer type (Type-Fit), or its position (Ordering). Score wording only.',
  },
  coverage: {
    focus:
      "Judge whether the question set covers the stated GOAL. Identify aspects of the goal that no question addresses (gaps). A finding's proposedChange should name the missing topic and suggest a question to add; target it at `goal`.",
    scale: `- 1.0 — The goal is fully covered; no material gaps.
- 0.7 — Largely covered; one secondary aspect of the goal is missing.
- 0.5 — Notable gaps; an important part of the goal is unaddressed.
- 0.3 — Major gaps; the goal is only partially served.
- 0.0 — The questions barely address the goal.`,
    ignore:
      'Redundancy (Duplicates judge that), wording (Clarity), and whether existing questions are on-mission (Goal-Match). Score gaps only — what is MISSING.',
  },
  duplicates: {
    focus:
      'Judge whether questions are distinct. Flag pairs (or groups) of questions that ask substantially the same thing, even across different sections or with different wording. For each, target the later/weaker question by its `key` and propose merging or removing it.',
    scale: `- 1.0 — Every question is distinct.
- 0.7 — One borderline overlap.
- 0.5 — A clear duplicate pair, or several near-duplicates.
- 0.3 — Multiple redundant questions.
- 0.0 — Pervasive duplication.`,
    ignore:
      'Gaps (Coverage), wording (Clarity), and ordering. Score redundancy only — what is REPEATED.',
  },
  type_fit: {
    focus:
      "Judge whether each question's answer type fits what it asks. The available types are free_text, single_choice, multi_choice, likert, numeric, date, boolean. Flag mismatches — e.g. a rating question typed free_text, a yes/no typed free_text, a 'select all that apply' typed single_choice, a date typed free_text. Target each by its `key` and propose the better type.",
    scale: `- 1.0 — Every question's type fits.
- 0.7 — One mild mismatch.
- 0.5 — Several questions would be better with a different type.
- 0.3 — Most types are poorly chosen.
- 0.0 — Types are essentially arbitrary.`,
    ignore: 'Wording (Clarity), coverage, ordering. Score the type↔question fit only.',
  },
  ordering: {
    focus:
      'Judge whether the questions flow sensibly. Flag questions that depend on a later question, sensitive/personal questions placed too early, or an order that would confuse or fatigue a respondent. Target a question by its `key` (or a section by `section:<title>`) and propose where it should move.',
    scale: `- 1.0 — The order is logical and considerate throughout.
- 0.7 — Mostly fine; one question is slightly out of place.
- 0.5 — A few ordering problems (a dependency inverted, a sensitive question early).
- 0.3 — The order works against the respondent in several places.
- 0.0 — The order is effectively random.`,
    ignore: 'Wording (Clarity), coverage, duplicates, type. Score sequence and placement only.',
  },
  audience_match: {
    focus:
      'Judge whether the questionnaire fits its stated AUDIENCE — register, reading level, length/burden, and assumptions about what the audience knows. Flag questions that are too technical (or too basic), assume unavailable knowledge, or impose unreasonable burden for that audience. When the audience is unknown, say so and score conservatively.',
    scale: `- 1.0 — Pitched squarely at the audience throughout.
- 0.7 — Mostly well-pitched; one or two questions miss the register.
- 0.5 — Several questions misjudge the audience.
- 0.3 — Largely mismatched to the audience.
- 0.0 — Wrong audience entirely.`,
    ignore:
      'Coverage and duplicates. Where wording is unclear *for this audience specifically*, that is in scope here; generic ambiguity is the Clarity judge.',
  },
  goal_match: {
    focus:
      "Judge whether every question earns its place against the stated GOAL. Flag off-mission questions — ones that don't serve the goal — and target each by its `key`, proposing removal or a refocus. This is the inverse of Coverage: Coverage finds what's missing, Goal-Match finds what shouldn't be there.",
    scale: `- 1.0 — Every question serves the goal.
- 0.7 — One question is tangential.
- 0.5 — Several questions stray from the goal.
- 0.3 — Much of the questionnaire is off-mission.
- 0.0 — The questions don't serve the stated goal.`,
    ignore:
      'Gaps (Coverage judges what is missing), wording (Clarity), type, ordering. Score whether existing questions belong.',
  },
};

/** Render the structured audience into readable lines, or note its absence. */
function renderAudience(audience: AudienceShape | null): string {
  if (!audience) return '(no audience specified)';
  const lines: string[] = [];
  if (audience.description) lines.push(`description: ${audience.description}`);
  if (audience.role) lines.push(`role: ${audience.role}`);
  if (audience.expertiseLevel) lines.push(`expertise: ${audience.expertiseLevel}`);
  if (audience.estimatedDurationMinutes !== undefined)
    lines.push(`estimated duration: ${audience.estimatedDurationMinutes} min`);
  if (audience.locale) lines.push(`locale: ${audience.locale}`);
  if (audience.sensitivity) lines.push(`sensitivity: ${audience.sensitivity}`);
  if (audience.notes) lines.push(`notes: ${audience.notes}`);
  return lines.length > 0 ? lines.join('\n') : '(no audience specified)';
}

/** Render one section and its questions, numbering questions for a readable flow. */
function renderSection(section: StructureSection, startIndex: number): string {
  const header = section.description
    ? `## Section: ${section.title}\n${section.description}`
    : `## Section: ${section.title}`;
  const questions = section.questions.map((q, i) => {
    const flags = [`type=${q.type}`, q.required ? 'required' : 'optional'];
    const guide = q.guidelines ? `\n      guidance: ${q.guidelines}` : '';
    return `  ${startIndex + i + 1}. [key=${q.key}] (${flags.join(', ')}) ${q.prompt}${guide}`;
  });
  return questions.length > 0
    ? `${header}\n${questions.join('\n')}`
    : `${header}\n  (no questions)`;
}

/** Serialise the whole version structure into the judge's user message. */
function renderStructure(structure: VersionStructureInput): string {
  const sections: string[] = [];
  sections.push(`GOAL:\n${structure.goal ?? '(no goal specified)'}`);
  sections.push(`AUDIENCE:\n${renderAudience(structure.audience)}`);

  let questionIndex = 0;
  const rendered: string[] = [];
  for (const section of structure.sections) {
    rendered.push(renderSection(section, questionIndex));
    questionIndex += section.questions.length;
  }
  sections.push(
    rendered.length > 0
      ? `STRUCTURE (${questionIndex} question(s) across ${structure.sections.length} section(s)):\n\n${rendered.join('\n\n')}`
      : 'STRUCTURE: (no sections or questions)'
  );
  return sections.join('\n\n');
}

/** The shared system frame, with the dimension's rubric spliced in. */
function systemRules(dimension: EvaluationDimension): string {
  const rubric = DIMENSION_RUBRICS[dimension];
  return `You are a design-time judge reviewing a conversational questionnaire's STRUCTURE before it is launched. You evaluate ONE dimension and propose concrete edits.

YOUR DIMENSION
${rubric.focus}

SCORING SCALE — continuous 0.0 to 1.0. Use intermediate values (0.4, 0.6, 0.8, …) freely; don't snap to anchors.
${rubric.scale}

IGNORE
${rubric.ignore}

FINDINGS
- Emit a finding for each concrete issue you would fix on this dimension. A clean questionnaire yields an empty findings array — do not invent problems.
- Address each finding's "targetKey" precisely: a question by its key exactly as shown (e.g. "q_role"), a section as "section:<title>", or the version-level "goal" / "audience".
- "severity": "major" (fix before launch), "minor" (real but not blocking), or "info" (nice-to-have).
- "proposedChange": the specific edit to make. "rationale": why, in one or two sentences. "sourceQuote": the offending text, when the finding points at a specific phrase.

OUTPUT — respond with ONLY this JSON object, no prose around it and no code fences:
{
  "score": <number 0.0-1.0>,
  "findings": [
    { "targetKey": "<key | section:title | goal | audience>", "severity": "info|minor|major", "proposedChange": "<edit>", "rationale": "<why>", "sourceQuote": "<optional quote>" }
  ]
}`;
}

/**
 * Build the system + user messages for one judge over one version structure. The
 * system message carries the dimension rubric; the user message carries the serialised
 * questionnaire (goal, audience, and every section/question with its key + type).
 */
export function buildJudgePrompt(
  dimension: EvaluationDimension,
  structure: VersionStructureInput
): LlmMessage[] {
  return [
    { role: 'system', content: systemRules(dimension) },
    {
      role: 'user',
      content: `Evaluate the following questionnaire on your dimension.\n\n${renderStructure(structure)}`,
    },
  ];
}

/**
 * Stricter retry message (a `user` turn) when the first response failed schema
 * validation. Deliberately does not echo the malformed output — see
 * `runStructuredCompletion`. Pass the validation `issues` so the model can fix the
 * named fields.
 */
export function buildJudgeRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return (
    `Return ONLY the JSON object with a numeric "score" in [0, 1] and a "findings" array ` +
    `(each finding with "targetKey", "severity", "proposedChange", "rationale", and an ` +
    `optional "sourceQuote"), matching the specified shape exactly.` +
    detail
  );
}
