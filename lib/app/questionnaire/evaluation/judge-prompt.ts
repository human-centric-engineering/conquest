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

import { MAX_FINDINGS_PER_JUDGE } from '@/lib/app/questionnaire/evaluation/judge-schema';
import type {
  EvaluationDimension,
  VersionStructureInput,
  StructureQuestion,
  StructureRouting,
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
  /**
   * Guidance for the optional structured `proposedEdit` (F5.3) this dimension should
   * attach when its fix maps cleanly to one machine-applicable op. Named per dimension so
   * a clarity judge proposes `replace_prompt`, a type-fit judge `change_type`, etc. The
   * op is an accelerator the review queue can apply in one click; when no op fits, the
   * judge omits it and describes the change in prose only.
   */
  editGuidance: string;
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
    editGuidance:
      'When you propose a clearer wording, attach `"proposedEdit": { "op": "replace_prompt", "prompt": "<the full rewritten question>" }`. If the fix is to the author guidance rather than the prompt, use `{ "op": "edit_guidelines", "guidelines": "<new guidance, or null to clear>" }`. ' +
      'For a DOUBLE-BARRELLED question — one that smuggles in two asks — attach `{ "op": "split_question", "prompt": "<the first ask, as its own question>", "secondPrompt": "<the second ask, as its own question>", "secondKey": "<concise snake_case key for the second>" }`. Split rather than reword whenever both asks are worth keeping: rewording one away loses an answer the author wanted. Between them the two prompts must cover everything the original asked and add nothing it did not — a split is a reshaping of one question, not a licence to write a third.',
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
    editGuidance:
      'For a gap, target `"goal"` and attach `"proposedEdit": { "op": "add_question", "prompt": "<the question>", "type": "<answer type>", "key": "<concise snake_case key>", "sectionKey": "<existing section title, optional>" }`. ' +
      'Choose `type` to fit the answer the question actually invites — do NOT default to `likert`: use `free_text` for open-ended or descriptive answers ("How would you describe…", "What challenges…"); `likert` ONLY for agreement / satisfaction / frequency on a fixed scale ("Rate your morale from 1–5"); `single_choice` / `multi_choice` for a fixed option set (add the options in `typeConfig`); `numeric`, `date`, or `boolean` when the answer is a number, a date, or yes/no. ' +
      'Make `key` a short, scannable `snake_case` slug of the essential noun(s) — not the whole sentence (e.g. `work_morale`, not `how_would_you_describe_your_current_morale_at_work`). This drafts a new question for the admin to confirm.',
  },
  duplicates: {
    focus:
      'Judge whether questions are distinct. Flag pairs (or groups) of questions that ask substantially the same thing, even across different sections or with different wording. For each, target the later/weaker question by its `key` and propose merging or removing it.',
    // No routing sentence here. The "do not let it lower your score" instruction lives in the
    // CO-OCCURRENCE block, which is spliced in only when routing is actually configured — a
    // questionnaire with no topics must not be told about "opening" and "depth" questions it
    // does not have.
    scale: `- 1.0 — Every question is distinct.
- 0.7 — One borderline overlap.
- 0.5 — A clear duplicate pair, or several near-duplicates.
- 0.3 — Multiple redundant questions.
- 0.0 — Pervasive duplication.`,
    ignore:
      'Gaps (Coverage), wording (Clarity), and ordering. Score redundancy only — what is REPEATED.',
    editGuidance:
      'Where the two questions only PARTLY overlap — each asks something the other misses — prefer salvaging over deleting: target the weaker/later one and attach `"proposedEdit": { "op": "replace_prompt", "prompt": "<narrowed to the part the other does not cover>" }`, so the distinct half survives. ' +
      'Attach `"proposedEdit": { "op": "delete_question" }` when the question is genuinely redundant and nothing about it is worth keeping. There is no merge op, so when wording from the deleted question should survive in the one you keep, put that wording in `proposedChange`. ',
  },
  type_fit: {
    focus:
      "Judge whether each question's answer type fits what it asks. The available types are free_text, single_choice, multi_choice, likert, matrix, numeric, date, boolean. Use `matrix` for a battery of items rated on ONE shared scale (a rating grid). Flag mismatches — e.g. a rating question typed free_text, a yes/no typed free_text, a 'select all that apply' typed single_choice, a date typed free_text, or a rating grid split into many separate likerts (should be one `matrix`). Target each by its `key` and propose the better type.",
    scale: `- 1.0 — Every question's type fits.
- 0.7 — One mild mismatch.
- 0.5 — Several questions would be better with a different type.
- 0.3 — Most types are poorly chosen.
- 0.0 — Types are essentially arbitrary.`,
    ignore: 'Wording (Clarity), coverage, ordering. Score the type↔question fit only.',
    editGuidance:
      'Attach `"proposedEdit": { "op": "change_type", "type": "<the better type>" }`. When the new type needs configuration (single_choice/multi_choice need choices, likert needs a scale), include a `"typeConfig"` object with that configuration; omit it and the admin will fill it in.',
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
    editGuidance:
      'When a question should move, target it by its key and attach `"proposedEdit": { "op": "reorder", "ordinal": <0-based position within its section> }`. To move it into a different section, add `"targetSectionKey": "<section title>"`. Use this only when the better position is unambiguous; otherwise describe the move in prose.',
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
    editGuidance:
      'To re-pitch the audience itself, target `"audience"` and attach `"proposedEdit": { "op": "edit_audience", "audience": { <only the sub-fields to change, e.g. "expertiseLevel": "novice"> } }`. To soften a single question for this audience, target its key with `{ "op": "edit_guidelines", "guidelines": "<guidance>" }` or `{ "op": "replace_prompt", "prompt": "<reworded>" }`.',
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
    editGuidance:
      'For an off-mission question, first ask whether it can be pointed back at the goal. If it can, prefer the refocus: attach `"proposedEdit": { "op": "replace_prompt", "prompt": "<the refocused question>" }` so the admin keeps the slot and loses only the drift. Attach `{ "op": "delete_question" }` when nothing about the question serves the goal and no rewording would change that. ' +
      'If the goal itself is mis-stated, target `"goal"` with `{ "op": "edit_goal", "goal": "<the corrected goal>" }`.',
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

/**
 * Plain-English names for the four phases, used in BOTH the per-question annotation and the
 * co-occurrence rule.
 *
 * Same words in both places on purpose: a judge that reads `phase=conditional` on a question and
 * "asked when it fits" in its rubric has to hold a translation in mind while reasoning. Buying that
 * attention back in the structure block is far cheaper than spending it in the rubric.
 */
const PHASE_WORDS: Record<string, string> = {
  opening: 'opening',
  core: 'always-asked',
  conditional: 'asked-when-it-fits',
  closing: 'closing',
};

/** How a question's topics read on its line, or `''` when routing is off. */
function topicAnnotation(
  question: StructureQuestion,
  phaseByTopic: Map<string, string> | null
): string {
  if (!phaseByTopic || question.topicKeys === undefined) return '';
  if (question.topicKeys.length === 0) return ', topic=NONE — never asked while routing is on';
  const parts = question.topicKeys.map((key) => {
    const phase = phaseByTopic.get(key);
    return phase ? `${key}/${PHASE_WORDS[phase] ?? phase}` : key;
  });
  return `, topic=${parts.join(' + ')}`;
}

/** Render one section and its questions, numbering questions for a readable flow. */
function renderSection(
  section: StructureSection,
  startIndex: number,
  phaseByTopic: Map<string, string> | null
): string {
  const header = section.description
    ? `## Section: ${section.title}\n${section.description}`
    : `## Section: ${section.title}`;
  const questions = section.questions.map((q, i) => {
    const flags = [`type=${q.type}`, q.required ? 'required' : 'optional'];
    const guide = q.guidelines ? `\n      guidance: ${q.guidelines}` : '';
    return `  ${startIndex + i + 1}. [key=${q.key}] (${flags.join(', ')}${topicAnnotation(q, phaseByTopic)}) ${q.prompt}${guide}`;
  });
  return questions.length > 0
    ? `${header}\n${questions.join('\n')}`
    : `${header}\n  (no questions)`;
}

/**
 * Render the routing frame that sits above the structure.
 *
 * States the PROPORTION as well as the rule. A judge told "12 of the 40 questions below are asked
 * only when they fit" calibrates severity far better than one handed the rule alone — the same
 * reason `renderCosts` hands the budget judge pre-computed numbers instead of asking it to derive
 * them.
 */
function renderRouting(routing: StructureRouting, totalQuestions: number): string {
  const conditionalTopics = routing.topics.filter((t) => t.phase === 'conditional');
  // Only mention the cap where it can actually bind. "At most 3 of them are chosen" alongside a
  // single conditional topic is not wrong so much as incoherent, and a frame a judge half-disbelieves
  // is worse than a shorter one it can take at face value.
  const cap =
    routing.maxConditionalTopics < conditionalTopics.length
      ? ` At most ${routing.maxConditionalTopics} of them are chosen for any one respondent.`
      : '';
  const lines = [
    'ROUTING — this questionnaire does not ask all of itself to everyone.',
    `Questions are grouped into topics. The "opening" topics run first, and their answers are what an agent reads when deciding which of the ${conditionalTopics.length} "asked-when-it-fits" topic(s) apply to this respondent.${cap} "always-asked" and "closing" topics run for everyone.`,
    `${routing.conditionalQuestionCount} of the ${totalQuestions} question(s) below are in an "asked-when-it-fits" topic, so many respondents will not see them.`,
  ];
  const roster = routing.topics.map(
    (t) =>
      `  - ${t.label} (${t.key}) — ${PHASE_WORDS[t.phase] ?? t.phase}, ${t.questionCount} question(s)${t.depth === 'light' ? ', and only the most important few are asked' : ''}`
  );
  return `${lines.join('\n')}\n\nTOPICS:\n${roster.join('\n')}`;
}

/** Serialise the whole version structure into the judge's user message. */
function renderStructure(structure: VersionStructureInput): string {
  const sections: string[] = [];
  sections.push(`GOAL:\n${structure.goal ?? '(no goal specified)'}`);
  sections.push(`AUDIENCE:\n${renderAudience(structure.audience)}`);

  // Absent on every version that does not use Conditional Topics, which is most of them — and the
  // whole block, annotations included, then renders exactly as it did before F17.34.
  const routing = structure.routing;
  const phaseByTopic = routing
    ? new Map(routing.topics.map((t) => [t.key, t.phase] as const))
    : null;
  if (routing) {
    const totalQuestions = structure.sections.reduce((n, s) => n + s.questions.length, 0);
    sections.push(renderRouting(routing, totalQuestions));
  }

  let questionIndex = 0;
  const rendered: string[] = [];
  for (const section of structure.sections) {
    rendered.push(renderSection(section, questionIndex, phaseByTopic));
    questionIndex += section.questions.length;
  }
  sections.push(
    rendered.length > 0
      ? `STRUCTURE (${questionIndex} question(s) across ${structure.sections.length} section(s)):\n\n${rendered.join('\n\n')}`
      : 'STRUCTURE: (no sections or questions)'
  );
  return sections.join('\n\n');
}

/**
 * The extra paragraph three dimensions get when Conditional Topics is on.
 *
 * Only three, and only when routing is actually configured: a rule that restates the default is
 * attention spent for nothing, and `systemRules` already carries a focus, a five-anchor scale, an
 * IGNORE clause, edit guidance and eight FINDINGS bullets.
 *
 * The Duplicates entry is deliberately short. An earlier draft keyed a rule on every pair of the
 * four phases — a sixteen-cell truth table written as prose, which a model collapses to whichever
 * rule it read first. What survives is one principle and the two consequences that are not already
 * the status quo; `core` × `core` needs no words because nothing about it changes.
 */
const ROUTING_RULES: Partial<Record<EvaluationDimension, string>> = {
  duplicates: `CO-OCCURRENCE — routing is on for this questionnaire.
Two questions are only duplicates if the SAME respondent is asked both.
- The opening is deliberately the broad version of what the depth topics probe later: its answers are what decide which of those topics this respondent gets. Overlap between an opening question and a later one is the design working, not redundancy. Never propose delete_question for it, keep any such finding at "info", and do not let it lower your score.
- Two questions in different "asked-when-it-fits" topics may never both be asked. Say so in your rationale and drop the severity one level.
- Everything else is a duplicate exactly as it would be without routing.

Where the weaker question sits in an "asked-when-it-fits" topic, prefer \`replace_prompt\` over deleting it even when the overlap is real: that topic may hold only a handful of questions, and removing one can leave it with too little to ask.`,

  ordering: `ROUTING — the phases ARE the sequence.
Opening topics run first, "asked-when-it-fits" topics run after them (and only for some respondents), closing topics run last. A question appearing after the opening because its topic is conditional is correctly placed, not out of order. Judge the order WITHIN a topic, and the placement of sensitive questions, rather than the phase boundaries themselves.`,

  goal_match: `ROUTING — a narrow question is not automatically off-mission.
A question inside an "asked-when-it-fits" topic is asked only of the respondents that topic is for, so judge it against the goal AS IT APPLIES TO THEM. A question that would be irrelevant to most respondents but is exactly right for the ones its topic selects is on-mission. Reserve your findings for questions that serve no respondent the goal describes.`,
};

/** The shared system frame, with the dimension's rubric spliced in. */
function systemRules(dimension: EvaluationDimension, routingOn: boolean): string {
  const rubric = DIMENSION_RUBRICS[dimension];
  const routingRule = routingOn ? ROUTING_RULES[dimension] : undefined;
  return `You are a design-time judge reviewing a conversational questionnaire's STRUCTURE before it is launched. You evaluate ONE dimension and propose concrete edits.

YOUR DIMENSION
${rubric.focus}${routingRule ? `\n\n${routingRule}` : ''}

SCORING SCALE — continuous 0.0 to 1.0. Use intermediate values (0.4, 0.6, 0.8, …) freely; don't snap to anchors.
${rubric.scale}

IGNORE
${rubric.ignore}

FINDINGS
- Emit a finding for each concrete issue you would fix on this dimension. A clean questionnaire yields an empty findings array — do not invent problems.
- Emit at most ${MAX_FINDINGS_PER_JUDGE} findings, ordered most severe first, and keep each one tight (one rewritten question, one or two sentences of rationale). Your whole answer has a token budget: a long tail of minor findings costs you the important ones.
- **Lead with the fix, not the complaint.** Wherever an alternative is feasible, "proposedChange" must BE that alternative — the actual rewritten question, the better answer type, the position to move to — not a description of what is wrong with the current one. "This question is double-barrelled" is a complaint; "Split into: 'What is your role?' and 'How long have you been in it?'" is a finding. Save the diagnosis for "rationale".
- Only diagnose without an alternative when you genuinely cannot propose one — the fix depends on facts you cannot see in the structure (a policy, a definition, what the author meant). Say what you would need, in "rationale". Prefer a concrete, imperfect alternative the admin can edit over a correct complaint they have to solve from scratch.
- Address each finding's "targetKey" precisely: a question by its key exactly as shown (e.g. "q_role"), a section as "section:<title>", or the version-level "goal" / "audience".
- "severity": "major" (fix before launch), "minor" (real but not blocking), or "info" (nice-to-have).
- "proposedChange": the specific edit to make, in plain prose. "rationale": why, in one or two sentences. "sourceQuote": the offending text, when the finding points at a specific phrase.

STRUCTURED EDIT (optional)
${rubric.editGuidance}
Prefer attaching "proposedEdit" whenever the fix maps to the op above — it is what lets the admin apply your suggestion in one click instead of retyping it. Omit it when no op fits the fix, or when a field would have to be guessed: never invent a key, section title, or type you cannot see in the structure. A prose-only finding is still worth making; it just costs the admin more work, so reach for it second.

OUTPUT — respond with ONLY this JSON object, no prose around it and no code fences:
{
  "score": <number 0.0-1.0>,
  "findings": [
    { "targetKey": "<key | section:title | goal | audience>", "severity": "info|minor|major", "proposedChange": "<edit>", "rationale": "<why>", "sourceQuote": "<optional quote>", "proposedEdit": <optional structured op, omit if none fits> }
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
    { role: 'system', content: systemRules(dimension, structure.routing !== undefined) },
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
  // With no issue paths, the first response never parsed as JSON — usually a code fence or
  // an answer cut off at the token cap. Ask for brevity as well as shape: a shorter answer is
  // the one thing that can actually clear a truncation on the retry, which reuses the same cap.
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema. Keep the response short —' +
        ' emit only your most important findings, with brief rationales — so the JSON object closes' +
        ' well within the token limit.';
  return (
    `Return ONLY the JSON object with a numeric "score" in [0, 1] and a "findings" array ` +
    `(each finding with "targetKey", "severity", "proposedChange", "rationale", an ` +
    `optional "sourceQuote", and an optional structured "proposedEdit"), matching the ` +
    `specified shape exactly. Omit "proposedEdit" rather than guessing one.` +
    detail
  );
}
