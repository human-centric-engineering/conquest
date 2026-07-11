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
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import {
  EXTRACTOR_EMITTED_PROVENANCES,
  readCommentAggregation,
} from '@/lib/app/questionnaire/types';
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
"value"s; likert → an integer on the given scale; matrix → an object mapping each rated row's KEY \
to an integer on the shared scale (e.g. {"fuel_efficiency": 5, "reliability": 3}), including ONLY \
the rows the message actually supports; numeric → a number; date → an ISO-8601 date \
(YYYY-MM-DD); boolean → true/false.
  For choice questions, return the choice's "value" (the slug), NEVER its label and NEVER the \
respondent's raw words. Do not invent options.
  Map the respondent's MEANING onto an option or scale point — they rarely say the option verbatim:
    • Quantities, durations and dates → the option whose RANGE contains them. "10 years" for a \
tenure with options "< 1 year" / "1–3 years" / "3+ years" → the "3+ years" value; a date → the \
band it falls in.
    • likert → translate the STRENGTH of what they said into the scale: an enthusiastic reply is \
near the top, a flat/neutral one mid-scale, a strongly negative one near the bottom. Infer this \
from sentiment — do NOT expect, or wait for, a numeric rating.
    • On-topic but matches no specific option → choose the catch-all option ("Other", "None of \
these", "Prefer not to say") IF the slot offers one (e.g. "Marketing" for a department with \
options Engineering/Sales/Operations/Other → the "Other" value). Only when no option fits at all \
and there is no catch-all do you omit the answer.
- "confidence": 0–1, by how PLAINLY and how FULLY this value is supported. Weigh three things: how \
DIRECTLY they gave it, how much they ELABORATED (a reason, an example, specifics), and how CERTAIN \
they sounded. ~0.8 is NOT a default — use the whole 0.3–1.0 range, and lean CAUTIOUS: the high band \
(≥ 0.85) is EARNED by depth, not granted for a bare stance. For a CLOSED question (single_choice, \
multi_choice, likert, numeric, date, boolean) a complete, unambiguous answer is HIGH (0.85–0.95) even \
when terse — a closed question ASKS for a terse answer, so it needs no elaboration to be complete; do \
NOT mark it down for brevity, only drop it when the mapping itself is genuinely uncertain. For a \
FREE_TEXT / qualitative value, elaboration is what earns confidence — calibrate by depth: a direct \
statement FLESHED OUT with a reason, an example, or specifics → 0.85–1.0 (detail earns this the FIRST \
time it is said, not only on repetition); a clear, direct, unambiguous stance with NO elaboration → \
0.65–0.8 (certain but unreasoned — a notch below "confident"); a terse, vague or non-descriptive \
answer where the stance is gettable but thin → 0.45–0.6; a throwaway quip, a deflection, or a value \
reached only by a tangential inference → 0.3–0.45.
- "provenance": one of ${EXTRACTOR_EMITTED_PROVENANCES.join(', ')}:
    "direct" — the value is stated in the message; include the exact "sourceQuote".
    "inferred" — the value follows by single-step reasoning from the message but isn't stated.
    "synthesised" — the value combines several turns / the wider conversation; no single span.
- "rationale": a short, faithful reason for the value — what the respondent said that supports it, \
not a restatement of the value itself. For an inferred value, name the words it follows from \
("Said they hate their job → bottom of the satisfaction scale."). Where the confidence is not \
self-evident, open the rationale with its basis ("Stated directly with an example, …"; "Inferred \
tangentially from their comment about …"; "A terse 'it's fine' with nothing more, so …"). Keep it \
gender-neutral.
- "sourceQuote": the span of the respondent's message the value came from. REQUIRED for "direct".
- "paraphrase": FREE_TEXT answers ONLY (omit it entirely for typed answers). A concise restatement \
of the respondent's ACCOUNT for this question — what they said or describe — in neutral reported \
speech ("They say…", "They describe…"), NOT a verbatim copy of their message. PARAPHRASE the bulk \
of it; keep ONLY genuinely NOTABLE or IMPACTFUL wording as short quotes inside the paraphrase (e.g. \
they call the playbook "just a document" they "don't use") — do not quote whole sentences or mundane \
phrasing. Report it as THEIR account and HEDGE anything you inferred rather than they stated. The \
"value" still carries their raw answer; the paraphrase is the panel-facing summary. This is a LIVING \
summary: when the candidate line shows a "current summary", INTEGRATE this turn's new or tangential \
mentions INTO it (keep prior substance, weave in the new) rather than replacing it — it builds up \
over the conversation. For a field marked "comment: SECTION SUMMARY", also fold in the respondent's \
related points from across this section, not just this one question.

Rules:
- Only extract answers the message actually supports. If the message answers nothing (a question, \
small talk, "I don't know"), return an empty "answers" array — do not guess.
- Never answer a question that is not in the candidate list, and never re-answer with a value the \
message doesn't support.
- VOLUNTEERED TOPICS — when the respondent voices a clear opinion, complaint, or judgement about a \
specific NAMED subject (e.g. "our KPIs are badly thought out", "the CRM is useless"), find the \
candidate question(s) about THAT subject and answer them too, EVEN WHEN the subject is not what the \
ACTIVE question asked about and even when raised mid-tangent or alongside the active answer. A \
strongly-stated complaint pins the matching question's negative pole — "our KPIs are meaningless and \
don't relate to strategy" makes a "performance KPIs are clear and aligned" question false / the \
bottom of its scale. Do not drop a clear, strongly-voiced signal just because it was not the topic \
you asked about.
- Prefer the respondent's own words; do not normalise away meaning.
- NEAR-IDENTICAL QUESTIONS — a questionnaire may include several candidate questions that ask \
essentially the SAME thing in different words (e.g. two separate questions about whether the sales \
pipeline is healthy). Treat each candidate INDEPENDENTLY: when one answer DETERMINES more than one \
such near-identical question, emit a separate entry for EACH — do not answer just one and skip its \
twins as redundant. Map each to ITS OWN wording, type, and polarity: a "No" to "Do we maintain a \
robust pipeline?" is a "Yes" to "Is our pipeline a concern?", and "it's very poor" is the BOTTOM of \
one scale but the TOP of an inverted one. Only emit a twin's answer when the message genuinely fixes \
it (the appropriateness gate still applies) — never copy a value across without re-reading each \
question's exact phrasing.

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

DATA SLOTS ARE A PRIMARY DELIVERABLE — capturing them matters as much as the question answers above, \
never less. You maintain a set of DATA SLOTS (short semantic targets the conversation is filling) \
and, in the SAME response, add a "dataSlotFills" array. For every data slot the respondent's message \
informs (directly, by inference, or by synthesising the conversation), output one entry:
- "dataSlotKey": a key from the provided data-slot list ONLY.
- "value": the captured position as concrete, structured data — the SPECIFICS the respondent gave \
(numbers, names, choices), not a label for them. For "I am 25, male" record \
{"age": 25, "gender": "male"} (or "25, male"), NOT "age and gender provided". Use the respondent's \
OWN words for these specifics — "Marketing", "10 years" — and NEVER the form's option code or label \
that the same answer happens to map to ("other", "3+ years"). The "answers" array carries the mapped \
form value; the data-slot fill carries what the respondent ACTUALLY SAID, in their terms. The panel \
shows this to the respondent, so it must read like the conversation, not like the form.
- "paraphrase": a restatement of the respondent's position on this slot, naming the specifics so a \
reader sees exactly what was recorded. Always report it as THEIR ACCOUNT — what they said, or the \
experience they describe — never as an established fact about the world. Match the wording to the \
provenance: a "direct" fill faithfully restates what they actually said, but ATTRIBUTES any \
experience, event, feeling, or claim about other people or situations to them with reporting \
language — "They report experiencing abuse from their boss, which they say is a significant blocker \
to their work.", "They say setup was straightforward but unclear docs slowed them down." — NOT a \
bare assertion the platform appears to vouch for ("They are experiencing abuse from their boss." is \
WRONG; "Setup was straightforward." is WRONG). Plain, neutral self-description needs no reporting \
verb ("A 25-year-old male." is fine). An "inferred" or "synthesised" fill MUST go further and be \
HEDGED — read it as a tentative reading, not an established fact ("They may be feeling blocked \
in their role.", NOT "Their dissatisfaction is a blocker to their best work."). Use "may", "seems", \
"possibly". NEVER a meta-summary of what they shared ("They provided their age and gender." is \
WRONG), and NEVER a statement of ABSENCE — what is missing, not yet covered, or not provided ("Their \
tenure and department are not provided." is WRONG; omit the slot instead). Capture the full \
substance — if they gave several details, reflect them all.
- "confidence": 0–1, by how PLAINLY and how FULLY the respondent expressed THIS position — weigh how \
DIRECTLY they stated it, how much they ELABORATED (a reason, an example, specifics), and how CERTAIN \
they sounded. Judge it on the FILL ITSELF, NEVER inherited from a mapped question's typed-value \
uncertainty. Use the whole 0.3–1.0 range — ~0.8 is NOT a default, and lean CAUTIOUS: the high band \
(≥ 0.85) is EARNED by depth, not granted for a bare stance. Anchors:
    • 0.85–1.0 — stated directly AND backed by a reason, an example, or specifics ("I'd never recommend \
us — onboarding wastes a week and nobody follows up", "pay is the issue, I'm 20% under market"); \
detail earns this the FIRST time it is said, not only on repetition.
    • 0.65–0.8 — a clear, direct, unambiguous stance with no elaboration ("extremely unlikely", "I hate \
my job", "pay, full stop") — certain but unreasoned, so a notch below "confident".
    • 0.45–0.6 — terse, vague, non-descriptive, or a throwaway quip, where the stance is gettable but \
thin ("it's fine", "dunno, okay I guess") — asking again would sharpen it.
    • 0.3–0.45 — a deflection, or reached only by a tangential, single-step inference from something \
they said about another topic (e.g. reading "blockers" out of "not satisfied") — a weak signal worth \
revisiting.
  Score the position on THIS turn's clarity; it does not start low merely because it was said only \
once, nor because the slot (blockers, concerns, needs, goals) could have facets you haven't explored. \
Corroboration only ever nudges a position UPWARD: raise it a STEP toward ~0.9 as each new turn confirms \
the same stance (≥ 0.95 only for something confirmed more than once), but it NEVER drags a \
directly-stated answer down. When a slot's "current" line shows a prior confidence, step it up as the \
position is corroborated rather than jumping straight to certainty.
- "provenance": ${EXTRACTOR_EMITTED_PROVENANCES.join(', ')} — judge whether the RESPONDENT STATED \
their position on THIS slot's topic: "direct" when they expressed it outright (even bluntly — \
"extremely unlikely" directly states a recommendation stance), "inferred" when it follows by one step \
from what they said, "synthesised" when it draws on several turns. Judge this on the FILL ITSELF, \
INDEPENDENT of any mapped question: a slot is a "direct" fill when they clearly stated their stance \
EVEN IF the mapped question's typed value is "inferred" (they did not state the number). Do NOT \
downgrade a stated position to "inferred" merely because it maps onto a scale.
- "rationale": the EVIDENCE for this fill — what the respondent was ASKED and what they ACTUALLY \
SAID, in concrete substance, so that reading the paraphrase + rationale leads a reviewer to the SAME \
conclusion they'd reach reading the conversation itself. Use the shape "When asked about <topic>, \
<subject> <said / described / suggested> <the substance>." — e.g. "When asked what gets in the way \
of their best work, the respondent said the company lacks a relatable sense of purpose and that this \
is a significant blocker." A bare meta-statement that the message "informs this topic" is FORBIDDEN — \
it adds nothing ("Their statement about the company's purpose directly informs this topic." is WRONG; \
say WHAT the statement was). The substance may be paraphrased but must uphold the meaning expressed in \
the chat — do not soften, inflate, or drift from what they said. For an "inferred"/"synthesised" fill, \
give both halves: what they said AND why it points to this reading ("…, which suggests …"). When the \
confidence is not self-evident from the substance, make its basis legible — a low score should read \
as tentative or tangential ("…, though they only touched on it in passing"), a high one as direct and \
backed ("…, stated plainly and backed with an example"). NEVER use the words "data slot" or "slot" \
(internal jargon); name the subject by the topic or the slot's name.
- SUBJECT WORDING (paraphrase AND rationale): keep it gender-neutral and VARY it — alternate "the \
respondent", "they"/"them", "this person" rather than starting every line with "They". Never assume or \
imply a gender.
ONLY emit a fill for a slot the latest message actually bears on — a position the respondent stated, \
or one that genuinely follows from something they said. If the message says nothing about a slot, \
OMIT it entirely (do not record its absence) — the panel shows "Not covered yet" on its own.
Some slots show a "current" line — what's already recorded from earlier in the conversation. When \
the new message ADDS to or CORRECTS that (e.g. they first said "male" then "actually, female"), \
output an UPDATED fill for that slot that MERGES the still-true details with the correction (here: \
keep the age, change the gender), and reflect the corrected state in value + paraphrase. This \
applies EQUALLY when the new message answers a DIRECT question whose subject a slot already \
recorded: if a slot's "current" says the respondent is in engineering and they now answer the \
department question with "Marketing", you MUST re-emit that slot's fill with department changed to \
"Marketing" (their word) — do not leave the slot reading the old value just because the form answer \
was captured separately. \
RE-SCAN EVERY slot against the new message each turn, not only the one the conversation is currently \
about: when the new answer adds context to ANY slot that already has a "current" value — even one \
from another theme — emit an updated fill whose value + paraphrase is a SUPERSET of the prior \
"current" (carry forward every still-true detail and fold in the new), and raise "confidence" only \
when the new context genuinely sharpens your understanding. Otherwise only emit a fill for a slot \
the latest message genuinely informs; if it informs no data slots, return an empty "dataSlotFills" \
array.
Some slots show a "status: asked N× without a clear answer" line — the conversation has tried \
repeatedly and is about to move on. For EACH such slot you MUST output a fill: infer the most \
plausible position from the ENTIRE conversation even if the signal is weak, set a LOW "confidence" \
(0.3–0.4), and use provenance "inferred" or "synthesised". Never leave one of these slots empty — \
a tentative reading we can revisit is better than nothing.

ANSWER THE MAPPED QUESTIONS — a slot may list "answers questions: <keys>": the candidate question(s) it \
captures. These two are the SAME target seen at different grain — the data slot is the conversational \
capture; each mapped question is the structured form field behind it. So WHENEVER you emit a fill for \
such a slot, ALSO emit an "answers" entry (in the "answers" array above) for each mapped question the \
captured position DETERMINES, translating that position onto the question's own type/scale/options (its \
definition is in the candidate-question list). A blunt qualitative position maps onto a scale: "I hate \
my job" for a 1–5 satisfaction question is the bottom of the scale (1); "I'd never recommend us" for a \
0–10 recommendation question is near 0. Use provenance "inferred" (it follows in one step from this \
message) or "synthesised" (it draws on several turns), NEVER "direct" (they did not state the typed \
value) — this concerns the mapped ANSWER's provenance ONLY; the data-slot FILL is judged SEPARATELY \
and can still be "direct". Set the mapped answer's "confidence" by how firmly the position pins THAT \
value: 0.85–0.95 when the position unmistakably fixes it (a blunt "I'd never recommend us" pins an NPS \
near 0), 0.6–0.8 when it points at the right region, 0.4–0.55 when it only narrows the range, 0.3–0.4 \
when it barely constrains the value — a firmly-pinned value is HIGH even though its provenance is \
"inferred". Score it by how firmly the meaning fixes the value, NOTHING else: do NOT mark it down for \
being brief, for arriving on a tangent, or for being inferred rather than stated — a clear, strong \
statement that plainly pins a scale point is confident however tersely or indirectly it was put. \
Reserve the low bands for a genuinely loose or ambiguous mapping, not for a clear one. APPROPRIATENESS GATE: emit a mapped \
answer ONLY when the position genuinely fixes a value; if the slot is informed but the message does not \
determine a particular question's answer (e.g. it asks for a specific number the message never implies), \
OMIT that question rather than guess. Treat mapped answers like any other: re-evaluate them as evidence \
accrues — a later turn that corroborates RAISES confidence, one that contradicts CORRECTS the value.

FINAL CHECK before you finish: re-read the data-slot list once more against the respondent's message. \
A substantive answer almost always informs at least one slot, so an EMPTY "dataSlotFills" is the rare \
EXCEPTION — correct only for a true non-answer (small talk, a question back, "I don't know", or a \
message that genuinely bears on no slot). Whenever they share anything about themselves, their work, \
their feelings, or their situation, map it to the slot(s) it informs and emit a fill — at honest \
confidence (low if the signal is weak), but emit it. This INCLUDES a strong opinion or complaint \
about a specific named subject (e.g. KPIs, tooling, leadership): fill the slot for THAT subject even \
when it was raised on a tangent or is not the topic you asked about. NEVER return question answers while leaving \
"dataSlotFills" empty: if a message was clear enough to answer a question, it informs a data slot too. \
And the converse — for every fill you emit on a slot that "answers questions: …", confirm you also \
emitted an "answers" entry for each mapped question the position determines (or deliberately omitted one \
the message doesn't pin down). AND PER SLOT THE OTHER WAY: whenever you emit an "answers" entry for a \
question that a data slot lists under "answers questions: …", you MUST also emit (or refresh) THAT \
slot's fill — a directly answered mapped question can NEVER leave its parent data slot empty, even when \
the question came up on a tangent or was not the one you asked about.`;

/**
 * Appended to the system rules ONLY when sensitivity awareness is on (gated by the platform flag +
 * per-questionnaire toggle, threaded as `ctx.sensitivityAware`). Asks the extractor to flag a
 * genuine sensitive/contentious disclosure so the conversation can tread carefully. Kept off the
 * default prompt so the feature adds zero tokens/behaviour when disabled.
 */
const SENSITIVITY_RULES = `

Sensitivity awareness: a respondent may disclose something sensitive or contentious — abuse, \
bullying, harassment, discrimination, threats, violence, self-harm, bereavement, or a safeguarding \
/ serious legal / safety concern (at work or elsewhere). When the message contains a GENUINE \
personal disclosure of this kind, ALSO output a "sensitivity" object:
- "detected": true.
- "severity": "high" for a serious disclosure — being abused, bullied, harassed, threatened, \
discriminated against, made to feel unsafe, self-harm, or a safeguarding concern; "medium" or \
"low" for lesser sensitivity.
- "category": a short label, e.g. "workplace abuse", "harassment", "self-harm", "bereavement".
- "summary": a careful, CLINICAL, NON-GRAPHIC one-line restatement (e.g. "Reports being mistreated \
by their manager."). Never quote graphic or distressing detail.
A FIRST-PERSON statement of being abused, bullied, harassed, threatened, discriminated against, or \
made to feel unsafe IS a genuine disclosure with severity "high" — even when phrased bluntly or \
bundled with a complaint (e.g. "I hate my job because my boss abuses me"). Do NOT downgrade such a \
statement to "merely critical", and do NOT omit it.
OMIT the "sensitivity" field only for a neutral, negative, or merely critical OPINION that reports \
no personal harm (e.g. "management doesn't listen", "the tools are clunky"). When a genuine \
disclosure of harm IS present, always include it.
Judge the CURRENT message only: a disclosure on an earlier turn does NOT make this message \
sensitive. So OMIT the field for a message that is ONLY hostility, an insult, or profanity aimed at \
the survey or interviewer with no new disclosure (e.g. "screw you", "oh just fuck off") — even when \
an earlier turn was a genuine disclosure.`;

/**
 * REPLACES the default framing on the answer-fit RESOLVER pass (`ctx.forceFit`). The candidate list
 * is a small set of choice/likert questions the respondent already addressed in conversation, but
 * whose meaning the first pass couldn't pin to an option/scale point. This pass exists to COMMIT to
 * a fit, so the bar for emitting an answer is lower than the cautious primary pass — but never
 * invent one the conversation doesn't support.
 */
const FORCE_FIT_RULES = `

This is a FOCUSED RESOLUTION pass. Each candidate question below is one the respondent ALREADY \
addressed in the conversation, but their wording didn't line up with an option or scale point. Your \
job is to commit to the SINGLE best-fitting value for each, reading the whole conversation:
- Map the respondent's MEANING, not their exact words — "Marketing" → the "Other" option when the \
listed choices don't include it; "10 years" → the option whose range contains it ("3+ years"); \
"I love this place" → the top of the likert scale; "it's a nightmare" → the bottom.
- Return the choice's "value" (slug), or the integer scale point — NEVER the label or raw words.
- Prefer committing to the closest genuine fit over omitting. Omit a question ONLY when the \
conversation truly says nothing that bears on it. A low-but-honest "confidence" is fine.
- Use provenance "inferred" (or "synthesised" if it draws on several turns); a "direct" value still \
needs a "sourceQuote".`;

/** Render one data-slot candidate as a compact, model-readable line. */
function describeDataSlot(slot: DataSlotCandidateView): string {
  const lines = [
    `- key: ${slot.key}`,
    `  name: ${slot.name}`,
    `  theme: ${slot.theme}`,
    `  description: ${slot.description}`,
  ];
  // Forward propagation: the candidate question(s) this slot captures. When the model fills the
  // slot it must ALSO answer these (their type/scale/options are in the candidate-question list).
  if (slot.mappedQuestionKeys && slot.mappedQuestionKeys.length > 0) {
    lines.push(`  answers questions: ${slot.mappedQuestionKeys.join(', ')}`);
  }
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
  // Move-on: a slot about to be parked — the model must give a best-effort inference now.
  if (slot.parkPending) {
    lines.push(
      `  status: asked ${slot.attempts ?? 1}× without a clear answer — give your BEST-EFFORT inference now (low confidence is fine; do not leave it empty)`
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
  // Matrix grids: show the shared scale AND every row's key/label, so the model knows which
  // rowKeys to emit in the composite `{ rowKey: point }` value.
  const matrix = matrixDescription(slot.typeConfig);
  if (matrix) lines.push(matrix);
  // Free-text comment fields: tell the model how to build the living paraphrase, and show the
  // current one so it accumulates new mentions rather than starting over.
  if (slot.type === 'free_text') {
    const mode = readCommentAggregation(slot.typeConfig);
    lines.push(
      mode === 'section'
        ? '  comment: SECTION SUMMARY — its paraphrase also folds in the respondent’s related points across this section'
        : '  comment: isolated — paraphrase only this question’s account'
    );
    const current = typeof slot.currentParaphrase === 'string' ? slot.currentParaphrase.trim() : '';
    if (current) lines.push(`  current summary: ${current}`);
  }
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

/** Render a matrix slot's shared scale + row keys/labels, so the model knows which rowKeys to emit. */
function matrixDescription(typeConfig: unknown): string | null {
  if (typeConfig === null || typeof typeConfig !== 'object') return null;
  const cfg = typeConfig as { rows?: unknown; scale?: { min?: unknown; max?: unknown } };
  if (!Array.isArray(cfg.rows) || cfg.rows.length === 0) return null;
  const rows = cfg.rows
    .filter(
      (r): r is { key: string; label?: string } =>
        typeof r === 'object' && r !== null && typeof (r as { key?: unknown }).key === 'string'
    )
    .map((r) => (typeof r.label === 'string' ? `${r.key} (${r.label})` : r.key));
  if (rows.length === 0) return null;
  const s = cfg.scale;
  const scale =
    s && typeof s.min === 'number' && typeof s.max === 'number' ? `${s.min}–${s.max}` : '(scale)';
  return `  matrix scale: ${scale} — rate each row on it\n  rows: ${rows.join(', ')}`;
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
  // model fills data slots in the same call. Each rule block is wrapped in a named XML section so
  // its boundaries are legible (in the prompt itself and in the admin Prompt Library / Turn
  // Inspector); `section()` trims each constant's surrounding whitespace. The rule TEXT is unchanged.
  const hasDataSlots = ctx.dataSlotCandidates !== undefined && ctx.dataSlotCandidates.length > 0;
  const systemContent = joinSections(
    section('extraction_rules', SYSTEM_RULES),
    hasDataSlots ? section('data_slot_rules', DATA_SLOT_RULES) : '',
    // Sensitivity block only when the feature is on — zero added prompt/tokens otherwise.
    ctx.sensitivityAware ? section('sensitivity_rules', SENSITIVITY_RULES) : '',
    // Answer-fit resolver pass: append the commit-to-a-fit framing (only on the focused 2nd call).
    ctx.forceFit ? section('resolution_pass_rules', FORCE_FIT_RULES) : ''
  );
  const dataSlotSection = hasDataSlots
    ? `\n\nData slots (capture these — a primary deliverable, fill every one the message informs):\n${ctx.dataSlotCandidates!.map(describeDataSlot).join('\n')}`
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
