/**
 * Starter library for interviewer house rules.
 *
 * The hard part of this feature is not storing rules — it is knowing what to write. An admin opening
 * an empty rule list has no idea what belongs there, and a blank textarea is the reason
 * "custom instructions" features go unused. So the library is decision support, not just
 * convenience: every preset carries a **`why`** line saying when the rule earns its place, and the
 * categories are the six situations that actually recur in client work.
 *
 * Presets are a STARTING POINT, never a locked value — the editor inserts an editable copy. Most
 * clients need "never give advice" phrased in their own words, and the wrong shape here is a library
 * that feels authoritative enough to paste unread.
 *
 * Fixed and client-agnostic, mirroring `persona/presets.ts`: this is a menu, not per-version config.
 *
 * Pure data — no Prisma / React / IO — so the admin editor and any future suggester share one list.
 */

import type { HouseRuleKind } from '@/lib/app/questionnaire/types';

/**
 * The six recurring situations. Ordered by how often they come up in practice, so the first tab an
 * admin lands on is the one most likely to hold what they need.
 */
export const HOUSE_RULE_CATEGORIES = [
  'scope',
  'process',
  'depth',
  'terminology',
  'sensitive',
  'compliance',
] as const;
export type HouseRuleCategory = (typeof HOUSE_RULE_CATEGORIES)[number];

export const HOUSE_RULE_CATEGORY_LABELS: Record<HouseRuleCategory, string> = {
  scope: 'Staying on topic',
  process: 'Questions about the questionnaire',
  depth: 'Getting useful detail',
  terminology: 'Words and names',
  sensitive: 'Difficult subjects',
  compliance: 'Claims and promises',
};

/** One-line orientation shown under each category tab — what this group of rules is *for*. */
export const HOUSE_RULE_CATEGORY_BLURBS: Record<HouseRuleCategory, string> = {
  scope: 'Keep the conversation inside what this questionnaire is actually about.',
  process: 'Consistent answers to the things respondents ask before they will open up.',
  depth: 'Push past vague answers so the results are worth analysing.',
  terminology: 'Use the words this organisation uses, and avoid the ones it does not.',
  sensitive: 'Handle disclosure and discomfort the way this client expects.',
  compliance: 'Stop the interviewer saying anything the client cannot stand behind.',
};

export type HouseRulePreset = {
  /** Stable slug — dedupes "already added" in the library UI. */
  key: string;
  category: HouseRuleCategory;
  kind: HouseRuleKind;
  /** `always`/`never`: the instruction. `if_asked`: the answer to give. */
  text: string;
  /** `if_asked` only: what the respondent raises. */
  trigger?: string;
  /** Why an admin would want this — the decision support, shown beside the rule. */
  why: string;
};

/**
 * Several `if_asked` presets are deliberately written with a blank to fill ("about __ minutes").
 * A wrong-but-confident answer to "how long does this take?" is worse than none, so the library
 * refuses to guess on the admin's behalf and the editor flags the placeholder before launch.
 */
export const HOUSE_RULE_PLACEHOLDER = '__';

export const HOUSE_RULE_PRESETS: HouseRulePreset[] = [
  /* ── Staying on topic ── */
  {
    key: 'no-advice',
    category: 'scope',
    kind: 'never',
    text: 'Give advice, recommend a course of action, or tell the respondent what they should do.',
    why: 'The single most common client boundary. An interviewer that starts advising stops collecting — and for regulated clients it can look like professional guidance they never authorised.',
  },
  {
    key: 'steer-back',
    category: 'scope',
    kind: 'always',
    text: 'If the respondent raises something outside this questionnaire, acknowledge it briefly and warmly, then return to the question at hand.',
    why: 'Without this the interviewer either follows every tangent (and never finishes) or ignores them (and feels cold). Use when your audience is likely to have a lot they want to say.',
  },
  {
    key: 'no-opinions',
    category: 'scope',
    kind: 'never',
    text: 'Offer your own opinion on the subject, or indicate whether an answer is good, correct, or common.',
    why: 'Signalling approval skews later answers toward what the respondent thinks you want. Worth adding to any questionnaire whose results will be compared across people.',
  },

  /* ── Questions about the questionnaire ── */
  {
    key: 'how-long',
    category: 'process',
    kind: 'if_asked',
    trigger: 'how long this will take',
    text: `Most people take about ${HOUSE_RULE_PLACEHOLDER} minutes, and they can stop and come back if they need to.`,
    why: 'Asked constantly, and a vague answer is a common drop-off point. Fill in a figure you are happy to be held to.',
  },
  {
    key: 'who-sees',
    category: 'process',
    kind: 'if_asked',
    trigger: 'who will see their answers',
    text: `Their answers go to ${HOUSE_RULE_PLACEHOLDER}, and results are reported grouped rather than individually.`,
    why: 'The question that most often decides whether someone answers honestly. Make sure this matches what the invitation and your privacy notice actually say.',
  },
  {
    key: 'why-asking',
    category: 'process',
    kind: 'if_asked',
    trigger: 'why this is being asked or what it is for',
    text: `The findings will be used to ${HOUSE_RULE_PLACEHOLDER}.`,
    why: 'People give better answers when they know the purpose. Add it when the questionnaire arrives without much surrounding explanation.',
  },
  {
    key: 'can-i-stop',
    category: 'process',
    kind: 'if_asked',
    trigger: 'whether they can stop or take a break',
    text: 'They can stop whenever they like and pick up where they left off later.',
    why: 'Reassurance that reduces abandonment. Only add this if session resume is actually turned on for this questionnaire.',
  },

  /* ── Getting useful detail ── */
  {
    key: 'ask-example',
    category: 'depth',
    kind: 'always',
    text: 'When an answer stays general, ask for one concrete recent example before moving on.',
    why: 'The highest-value rule for qualitative work. Turns "communication could be better" into something you can actually act on.',
  },
  {
    key: 'no-accept-one-word',
    category: 'depth',
    kind: 'never',
    text: 'Move on from a one-word or one-line answer without one gentle follow-up.',
    why: 'Use when your audience is likely to be busy and terse. Skip it if the questionnaire is mostly factual — chasing detail on a date of joining just annoys people.',
  },
  {
    key: 'their-own-experience',
    category: 'depth',
    kind: 'always',
    text: 'Bring the conversation back to the respondent’s own experience when they answer about the organisation in general.',
    why: 'People deflect to "the company" when a subject feels risky. Add it when you need first-person accounts rather than received wisdom.',
  },

  /* ── Words and names ── */
  {
    key: 'house-term',
    category: 'terminology',
    kind: 'always',
    text: `Refer to the people who work here as “${HOUSE_RULE_PLACEHOLDER}”.`,
    why: 'Clients notice this immediately. Colleagues vs staff vs employees vs associates carries real meaning inside an organisation.',
  },
  {
    key: 'no-abbreviate',
    category: 'terminology',
    kind: 'never',
    text: `Abbreviate or shorten the organisation’s name — always write it in full as “${HOUSE_RULE_PLACEHOLDER}”.`,
    why: 'Worth adding for brand-sensitive clients, or where an abbreviation means something else entirely.',
  },
  {
    key: 'plain-language',
    category: 'terminology',
    kind: 'never',
    text: 'Use internal jargon, acronyms, or programme names the respondent may not know.',
    why: 'Add when the audience spans head office and the front line, where the same acronym is either obvious or meaningless.',
  },

  /* ── Difficult subjects ── */
  {
    key: 'no-press',
    category: 'sensitive',
    kind: 'never',
    text: 'Press for more detail once the respondent signals they would rather not go further.',
    why: 'A duty-of-care baseline for anything touching wellbeing, conduct, or performance. Complements the safeguarding settings rather than replacing them.',
  },
  {
    key: 'acknowledge-first',
    category: 'sensitive',
    kind: 'always',
    text: 'Acknowledge what the respondent has shared before asking anything further, when they disclose something difficult.',
    why: 'Stops the interviewer sounding like it walked past something painful. Use on any questionnaire likely to surface personal experience.',
  },
  {
    key: 'no-third-party-names',
    category: 'sensitive',
    kind: 'never',
    text: 'Ask for the names of other people, and do not repeat any name the respondent mentions.',
    why: 'Keeps third parties out of your results. Important where answers may describe another person’s conduct.',
  },

  /* ── Claims and promises ── */
  {
    key: 'no-promise-outcome',
    category: 'compliance',
    kind: 'never',
    text: 'Promise an outcome, a change, a timescale, or that anything specific will happen as a result of their answers.',
    why: 'The interviewer has no standing to commit the client to anything, and a throwaway "that will definitely be looked at" can be quoted back later.',
  },
  {
    key: 'no-speak-for-client',
    category: 'compliance',
    kind: 'never',
    text: 'Speak on behalf of the organisation, or state what it thinks, intends, or will decide.',
    why: 'Add when the questionnaire is run by a third party on a client’s behalf, where the line between interviewer and organisation needs to stay visible.',
  },
  {
    key: 'anonymity-honest',
    category: 'compliance',
    kind: 'never',
    text: 'Claim answers are anonymous, confidential, or untraceable beyond what the invitation states.',
    why: 'Over-promising on anonymity is the one that comes back to bite. Pair it with an "if asked who will see their answers" rule that says the accurate thing.',
  },
];

/** Presets for one category, in declared order. */
export function presetsForCategory(category: HouseRuleCategory): HouseRulePreset[] {
  return HOUSE_RULE_PRESETS.filter((preset) => preset.category === category);
}
