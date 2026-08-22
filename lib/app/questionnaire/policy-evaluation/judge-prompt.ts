/**
 * The interviewer-policy judge prompts (F18.8).
 *
 * One prompt per dimension, each blind to the others — same shape as both sibling panels. Pure and
 * provider-agnostic: no SDK import, no Prisma. The output contract is prompt-guided JSON; the Zod
 * schema in `judge-schema.ts` is the validator, not something sent to the provider.
 *
 * **Two things this does that the scope panel does not, both deliberate:**
 *
 * 1. **Per-dimension sections.** {@link SECTIONS_FOR} decides what each judge is *shown*. The scope
 *    panel serialises its whole config for every judge because a scope config is small; a policy DTO
 *    carrying 150 question prompts is an order of magnitude larger and three of the four rubrics
 *    have no use for them. The DTO stays one shape (one schema, one capability arg, one snapshot
 *    column) — only the rendering varies. Do not "fix" this back to parity with the scope panel.
 * 2. **`knownIssues` are printed WITH their stable ids**, and each rubric's `ignore` clause names
 *    the ids it must not repeat — so a judge matches id to id rather than paraphrase to paraphrase.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  HOUSE_RULE_KIND_LABELS,
  INTERVIEWER_APPROACH_LABELS,
  FUNNEL_PACE_LABELS,
  QUESTION_FIDELITY_LABELS,
  QUESTION_FIDELITY_LEVELS,
} from '@/lib/app/questionnaire/types';
import { POLICY_EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/policy-evaluation/dimensions';
import type {
  PolicyEvaluationDimension,
  PolicyStructureInput,
} from '@/lib/app/questionnaire/policy-evaluation/types';

/** The rubric inserts for one dimension. */
interface PolicyDimensionRubric {
  focus: string;
  scale: string;
  ignore: string;
  editGuidance: string;
}

/** Which sections of the DTO each judge is shown. Everything gets meta, context and knownIssues. */
const SECTIONS_FOR: Record<PolicyEvaluationDimension, readonly PolicySection[]> = {
  rule_coherence: ['houseRules'],
  arc_fit: ['strategy'],
  fidelity_calibration: ['fidelity'],
  // The only judge permitted to read across blocks — which is what keeps the other three clean.
  cross_layer_conflict: ['houseRules', 'strategy', 'fidelity', 'tone', 'routing'],
};

type PolicySection = 'houseRules' | 'strategy' | 'fidelity' | 'tone' | 'routing';

const DIMENSION_RUBRICS: Record<PolicyEvaluationDimension, PolicyDimensionRubric> = {
  rule_coherence: {
    focus:
      'Judge the house rules AS PROSE — the judgement calls a keyword matcher cannot make. Look for: two `always` rules that pull in opposite directions; a `never` that swallows an `always`; two rules saying the same thing in different words; a rule so vague ("be appropriate", "be professional") that no turn would behave differently for its presence; an `if_asked` whose trigger is so broad it fires constantly or so narrow it never will; an `if_asked` whose text is a SCRIPT rather than the substance of an answer (the interviewer paraphrases it, so a scripted sentence will not survive); and a rule addressed to the RESPONDENT rather than to the interviewer.',
    scale: `- 1.0 — Every rule is specific, actionable, distinct, and aimed at the interviewer.
- 0.7 — Mostly sound; one rule is vague or overlaps another.
- 0.5 — Several rules are vague, duplicated, or would not change any turn.
- 0.3 — Most rules would not reliably change the interviewer's behaviour.
- 0.0 — The rule set is contradictory or says nothing actionable.`,
    ignore:
      'Everything the mechanical conflict checker already caught, listed for you under KNOWN ISSUES with its id — do not restate any of them: `house-rules-empty`, `form-only-house-rules`, `house-rules-overpromise-anonymity`, `house-rules-identity-vs-anonymous`, `house-rules-support-not-configured`, `house-rules-engine-controlled`, `house-rules-format-override`, `house-rules-multi-question`. Also NOT yours: the questioning arc (Arc-Fit judges it), the fidelity dial (Fidelity-Calibration), and ANY conflict between a rule and a tone dial or another config block (Cross-Layer). You judge the rules against each other and against themselves.',
    editGuidance:
      'To sharpen a rule, target `"house_rule:<id>"` and attach `"proposedEdit": { "op": "edit_house_rule", "kind": "always|never|if_asked", "text": "<the full rewritten rule>", "trigger": "<only for if_asked>" }` — the full replacement, not a patch, and `trigger` ONLY when `kind` is `if_asked`. To park a rule that should not be in force, use `{ "op": "set_house_rule_enabled", "enabled": false }`; to remove one outright, `{ "op": "delete_house_rule" }` — prefer parking. You MAY propose at most ONE missing rule per run, targeting `"house_rules"` with `{ "op": "add_house_rule", ... }` — and only when its absence is a real gap for THIS questionnaire. There is a dedicated assistant for drafting rule libraries; do not compete with it.',
  },
  arc_fit: {
    focus:
      "Judge whether the questioning arc suits THIS questionnaire's goal, audience and length. Reason against the PRE-COMPUTED pace profile you are given — never invent your own band numbers. Consider: a `targeted` approach on a short exploratory instrument whose goal is to understand how people experience something (the funnel exists for exactly that); `open` throughout on a long battery with many specific items; a `brisk` pace on a sensitive audience, where a one-question opening window gives nobody room to settle; a `gradual` pace on an instrument so short the arc never leaves the open band at all; `reflect` on a transactional audience, where reflecting each answer back costs a turn for little; `batchRelated` off on an instrument with many closely-related short items; `probeDepth` off when the goal is depth.",
    scale: `- 1.0 — The approach, pace, opening and tactics all suit the goal, audience and length.
- 0.7 — Broadly right; one setting is slightly off for this instrument.
- 0.5 — The arc noticeably works against the goal or the audience.
- 0.3 — The arc is wrong for this instrument in more than one way.
- 0.0 — The arc actively defeats what the questionnaire is for.`,
    ignore:
      'Everything under KNOWN ISSUES, by id — above all `opening-examples-empty`, `opening-examples-targeted` and `form-only-persona`. Also NOT yours: the WORDING of the opening examples (a dedicated assistant drafts those and this panel has no op to rewrite them), the house rules (Rule-Coherence), the fidelity dial (Fidelity-Calibration), and any interaction with tone or routing (Cross-Layer).',
    editGuidance:
      'Target `"strategy"` and attach exactly one of: `{ "op": "set_approach", "approach": "funnel|open|targeted" }`, `{ "op": "set_pace", "pace": "gradual|balanced|brisk" }`, `{ "op": "set_opening_mode", "openingMode": "auto|examples" }`, or `{ "op": "set_tactics", "probeDepth": <bool>, "reflect": <bool>, "batchRelated": <bool> }` (include only the tactics you are changing). Do NOT propose `set_opening_mode: "examples"` unless usable example openings already exist — that would make the setting inert.',
  },
  fidelity_calibration: {
    focus:
      'Judge whether the "ask as written" dial is set coherently across the instrument, and whether each question held to its wording earns the cost. THE HEADLINE CASE, and check it first: if the version-level gate is OFF while questions carry non-Balanced stored values, the author has set sliders that do nothing — say so as a `major` finding. Then: a validated battery where some items are Must-ask and structurally identical neighbours are Balanced (a battery\'s comparability is all-or-nothing); Must-ask on a free-text question, where the protected thing is the wording and no answer control renders; Must-ask used as a synonym for "required" (they are orthogonal — required is whether it must be answered, fidelity is how it must be put); Free on a question the stated goal clearly needs directly; and a Close/Must-ask count so large that the raised satisfaction floors you are given will hold sessions open well past what the instrument can support.',
    scale: `- 1.0 — The dial is set deliberately and consistently; every Must-ask earns it.
- 0.7 — Mostly coherent; one question's stop looks arbitrary.
- 0.5 — Related questions are set inconsistently, or several Must-asks do not need to be.
- 0.3 — The dial appears to have been set at random, or the gate contradicts the values.
- 0.0 — The settings would actively damage the data or the conversation.`,
    ignore:
      'Everything under KNOWN ISSUES, by id. Never re-derive the satisfaction floors, the level counts, or the fidelity weighting — all are given to you. NEVER propose a prompt rewrite, a type change, or a required/optional change: those belong to the questionnaire design panel and this panel has no op for them. If a question needs rewording, say so in prose and leave it there.',
    editGuidance:
      'For one question, target `"question:<key>"` and attach `"proposedEdit": { "op": "set_question_fidelity", "fidelity": <0 | 0.25 | 0.5 | 0.75 | 1> }` (0 = Free, 0.5 = Balanced, 1 = Must ask). For the gate itself, target `"fidelity"` with `{ "op": "set_fidelity_enabled", "enabled": true|false }` — this is the right op for the "sliders set but the feature is off" case. For the stop new questions start at, `{ "op": "set_default_fidelity", "defaultFidelity": <stop> }`.',
  },
  cross_layer_conflict: {
    focus:
      'You are the ONLY judge allowed to reason across blocks. Look for: a house rule that fights a tone dial ("never use humour" with the humour dial set high, "keep replies to one sentence" with verbosity high) — house rules are applied AFTER the tone dials, so the rule wins silently and the dial the admin set is a lie; a rule prescribing a register while a selectable persona already prescribes another; a `targeted` approach while Adaptive Scope is on — the routing planner decides the whole interview from the OPENING, and a targeted approach means there is barely an opening to read (this is the highest-value finding you can make); a brisk pace against an opening follow-up allowance that assumed several opening turns, or a gradual one against an allowance of one; Must-ask questions concentrated in a CONDITIONAL topic, which a plan may never seat at all (routing always wins — a must-ask is never a reason to widen an interview, so the author has marked something an instrument that many respondents will never see); a large Must-ask set with an `open` approach, whose broad-invitation clause overrides the very "ask the one question provided" behaviour a must-ask depends on; and a rule that implies confidentiality without using any word a keyword matcher would catch.',
    scale: `- 1.0 — The layers reinforce each other; nothing one sets is silently undone by another.
- 0.7 — One minor tension that would rarely bite.
- 0.5 — A real conflict an admin would be surprised by.
- 0.3 — Several layers work against each other.
- 0.0 — The configuration is self-defeating.`,
    ignore:
      "Every keyword-matchable version of the above is already under KNOWN ISSUES with an id — do not repeat any of them, in particular `house-rules-overpromise-anonymity`, `house-rules-identity-vs-anonymous`, `house-rules-support-not-configured`, `house-rules-engine-controlled`, `house-rules-format-override`, `house-rules-multi-question`, `anonymous-hides-capture`, `sensitivity-no-support`, the `form-only-*` family, and the `adaptive-scope-*` family. Also NOT yours: the INTERNAL coherence of the rule set (Rule-Coherence), whether the arc suits the goal (Arc-Fit), or whether one question's stop is right (Fidelity-Calibration). You judge only the interactions BETWEEN blocks.",
    editGuidance:
      'Prefer the cheapest fix that resolves the conflict. For a rule-vs-dial conflict, target `"tone"` with `{ "op": "set_tone_dimension", "dimension": "<key>", "enabled": <bool>, "level": <1-5> }` — adjusting the dial the rule already overrides is usually less destructive than rewriting the client\'s rule. You may also use `{ "op": "set_house_rule_enabled", "enabled": false }` on `"house_rule:<id>"`, or the `set_approach` / `set_pace` ops on `"strategy"`. **Do NOT propose `edit_house_rule` (rewriting a rule\'s text) — that is Rule-Coherence\'s op.** Flag the collision and propose the other side of it, or say it in prose.',
  },
};

function systemRules(dimension: PolicyEvaluationDimension): string {
  const rubric = DIMENSION_RUBRICS[dimension];
  const spec = POLICY_EVALUATION_DIMENSION_SPECS[dimension];
  return `You are the ${spec.label}, one of four independent reviewers of a questionnaire's INTERVIEWER POLICY.

The policy is what the client configured about HOW their questions are put to a respondent: house \
rules (things the interviewer must always do, never do, or say if asked), the questioning arc \
(broad-to-specific, and how fast), and a per-question "ask as written" dial. You are reviewing the \
CONFIGURATION as authored, not any real conversation.

The policy exists to serve two goals at once: the interviewer should behave the way the client's \
policy says, and the policy should say something an interviewer can actually act on — specific \
enough to change a turn, coherent with itself, and coherent with the settings it sits beside.

YOUR DIMENSION
${rubric.focus}

SCORING (a single \`score\` in [0,1])
${rubric.scale}

NOT YOUR JOB
${rubric.ignore}

HARD RULES
- Judge only what you are shown. Never invent a rule, question, or setting that is not in the config.
- Be specific: quote the offending text in \`sourceQuote\` when your finding points at one.
- Severity: \`major\` = would materially damage the interview or the data; \`minor\` = worth fixing; \
\`info\` = an observation. Reserve \`major\`.
- A configuration that is simply MINIMAL is not a fault. An empty or default policy scores well if \
nothing about it is wrong — do not manufacture findings to look useful.
- Findings must be actionable. If you cannot say what to change, do not raise it.

PROPOSING AN EDIT
${rubric.editGuidance}
Attach \`proposedEdit\` only when you are confident of every field. A finding without one is still \
useful — it is reviewed and applied by hand.

OUTPUT — respond with ONLY this JSON object, no prose around it and no code fences:
{
  "score": <number 0-1>,
  "findings": [
    {
      "targetKey": "<house_rule:<id> | house_rules | strategy | fidelity | tone | question:<key>>",
      "severity": "info" | "minor" | "major",
      "proposedChange": "<what to change>",
      "rationale": "<why, in one or two sentences>",
      "sourceQuote": "<the offending text, when there is one>",
      "proposedEdit": { ... }
    }
  ]
}
An empty \`findings\` array is a valid and often correct answer.`;
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

function renderMeta(input: PolicyStructureInput): string {
  const { meta, context } = input;
  const lines = [
    `Title: ${meta.title}`,
    `Goal: ${meta.goal ?? '(none stated)'}`,
    `Audience: ${meta.audienceSummary ?? '(none stated)'}`,
    `Size: ${meta.questionCount} questions across ${meta.sectionCount} sections`,
    `Presentation: ${context.presentationMode}`,
    `Anonymous mode: ${context.anonymousMode ? 'on' : 'off'}`,
    `Sensitivity awareness: ${context.sensitivityAwareness ? 'on' : 'off'}${
      context.sensitivityAwareness && !context.hasSupportMessage ? ' (no support message set)' : ''
    }`,
  ];
  return lines.join('\n');
}

function renderHouseRules(input: PolicyStructureInput): string {
  const { houseRules } = input;
  if (!houseRules.enabled) return 'House rules are switched OFF for this questionnaire.';
  const active = houseRules.rules.filter((r) => r.enabled);
  if (active.length === 0) return 'House rules are on, but no rule is switched on.';
  return active
    .map((r) => {
      const trigger = r.trigger ? ` [asked about: ${r.trigger}]` : '';
      return `- (${r.id}) ${HOUSE_RULE_KIND_LABELS[r.kind]}${trigger}: ${r.text}`;
    })
    .join('\n');
}

function renderStrategy(input: PolicyStructureInput): string {
  const s = input.strategy;
  if (!s.enabled) return 'The questioning approach is left at the default; no arc is configured.';
  const p = s.paceProfile;
  const lines = [
    `Approach: ${INTERVIEWER_APPROACH_LABELS[s.approach]}`,
    `Pace: ${FUNNEL_PACE_LABELS[s.pace]}${s.approach === 'funnel' ? '' : ' (ignored — pace applies to the funnel only)'}`,
    'Pace profile (PRE-COMPUTED — use these numbers, do not derive your own):',
    `  - opening window: the first ${p.openingWindow} question(s) get the broad, permission-giving invitation`,
    `  - broad while coverage is below ${Math.round(p.openBelow * 100)}%`,
    `  - specific once coverage is above ${Math.round(p.targetedAbove * 100)}%`,
    `  - with no coverage signal: broad for ${p.openRounds} rounds, specific after ${p.targetedRounds}`,
    `Opening questions: ${s.openingMode === 'examples' ? `admin examples (${s.openingExamples.length} written, ${s.guidedOpeningActive ? 'in use' : 'NOT in use — none are usable'})` : "the interviewer's own framings"}`,
    `Tactics: probe shallow answers ${s.probeDepth ? 'on' : 'off'}; reflect answers back ${s.reflect ? 'on' : 'off'}; invite related gaps together ${s.batchRelated ? 'on' : 'off'}`,
  ];
  return lines.join('\n');
}

function renderTone(input: PolicyStructureInput): string {
  const t = input.tone;
  if (t.personaSelectionEnabled) {
    return 'A selectable built-in persona replaces this version’s tone dials, so the dials below do not apply.';
  }
  const lines: string[] = [];
  lines.push(
    t.dials.length > 0
      ? `Tone dials (−2 = low, 0 = neutral, +2 = high): ${t.dials
          .map((d) => `${d.label} ${d.displayLevel > 0 ? '+' : ''}${d.displayLevel}`)
          .join(', ')}`
      : 'No tone dial is set; the default voice applies.'
  );
  if (t.personaText) lines.push(`Persona: ${t.personaText}`);
  return lines.join('\n');
}

function renderFidelity(input: PolicyStructureInput): string {
  const f = input.fidelity;
  const lines: string[] = [];
  lines.push(
    f.enabled
      ? `The "ask as written" dial is ON. New questions start at ${QUESTION_FIDELITY_LABELS[f.defaultLevel]}.`
      : 'The "ask as written" dial is OFF for this version — every question is asked conversationally, WHATEVER a question\'s stored value says.'
  );
  lines.push(
    `Stored values across all ${f.questionsTotal} questions: ${QUESTION_FIDELITY_LEVELS.map(
      (l) => `${QUESTION_FIDELITY_LABELS[l]} ${f.distribution[l]}`
    ).join(', ')}`
  );
  lines.push(
    `Answer-confidence floor each level imposes (PRE-COMPUTED for this version): ${QUESTION_FIDELITY_LEVELS.map(
      (l) => `${QUESTION_FIDELITY_LABELS[l]} ${f.satisfactionFloors[l].toFixed(2)}`
    ).join(', ')}`
  );
  if (f.truncated) {
    lines.push(
      `You are seeing ${f.questionsShown} of ${f.questionsTotal} questions, chosen to include EVERY question whose stored value is not Balanced. The distribution above is complete.`
    );
  }
  lines.push('');
  lines.push('Questions (stored value → what the interviewer actually does):');
  for (const q of f.questions) {
    const effective =
      q.storedLevel === q.level
        ? QUESTION_FIDELITY_LABELS[q.level]
        : `${QUESTION_FIDELITY_LABELS[q.storedLevel]} → ${QUESTION_FIDELITY_LABELS[q.level]} (the gate is off)`;
    const topics = q.topicKeys.length > 0 ? ` [topics: ${q.topicKeys.join(', ')}]` : '';
    lines.push(
      `- (${q.key}) [${q.sectionTitle}] ${q.type}, ${q.required ? 'required' : 'optional'}, weight ${q.weight}: ${effective}${topics}\n    "${q.prompt}"`
    );
  }
  return lines.join('\n');
}

function renderRouting(input: PolicyStructureInput): string {
  const r = input.routing;
  if (!r.adaptiveScopeEnabled) {
    return 'Adaptive scope is OFF — every topic runs for every respondent, so routing cannot hide a question.';
  }
  const lines = [
    `Adaptive scope is ON: up to ${r.maxConditionalTopics} conditional topics per interview.`,
    r.limitOpeningProbes
      ? `Opening follow-ups are capped at ${r.maxOpeningProbes} for the whole opening.`
      : 'Opening follow-ups are not capped.',
    'The routing planner decides the whole interview from the OPENING answers.',
  ];
  if (r.mustAskByTopic.length > 0) {
    lines.push('Questions held to their wording, by topic (PRE-COMPUTED):');
    for (const t of r.mustAskByTopic) {
      lines.push(
        `  - ${t.label} (${t.topicKey}) — ${t.conditional ? 'CONDITIONAL, may not be seated' : 'always asked'}: ${t.mustAskCount} must-ask, ${t.closeCount} close`
      );
    }
  }
  return lines.join('\n');
}

function renderKnownIssues(input: PolicyStructureInput): string {
  if (input.knownIssues.length === 0) {
    return 'The mechanical conflict checker found nothing.';
  }
  return input.knownIssues
    .map((i) => `- [${i.severity}/${i.id}] ${i.title} — ${i.message}`)
    .join('\n');
}

const SECTION_RENDERERS: Record<
  PolicySection,
  { heading: string; render: (input: PolicyStructureInput) => string }
> = {
  houseRules: { heading: 'HOUSE RULES', render: renderHouseRules },
  strategy: { heading: 'QUESTIONING ARC', render: renderStrategy },
  fidelity: { heading: 'ASK-AS-WRITTEN DIAL', render: renderFidelity },
  tone: { heading: 'TONE', render: renderTone },
  routing: { heading: 'ROUTING (ADAPTIVE SCOPE)', render: renderRouting },
};

/** Build the `[system, user]` messages for one dimension's judge call. */
export function buildPolicyJudgePrompt(
  dimension: PolicyEvaluationDimension,
  structure: PolicyStructureInput
): LlmMessage[] {
  const blocks: string[] = [`QUESTIONNAIRE\n${renderMeta(structure)}`];
  for (const section of SECTIONS_FOR[dimension]) {
    const { heading, render } = SECTION_RENDERERS[section];
    blocks.push(`${heading}\n${render(structure)}`);
  }
  blocks.push(
    `KNOWN ISSUES — ALREADY CAUGHT BY THE MECHANICAL CONFLICT CHECKER (do not repeat these as findings)\n${renderKnownIssues(structure)}`
  );

  return [
    { role: 'system', content: systemRules(dimension) },
    {
      role: 'user',
      content: `${blocks.join('\n\n')}\n\nReview this interviewer policy on your dimension and return the JSON object.`,
    },
  ];
}
