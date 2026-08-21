/**
 * Interviewer strategy → asking-prompt instructions (questioning approach).
 *
 * When the admin enables an interviewer strategy, these clauses OVERRIDE the default
 * questioning-approach guidance in `buildStreamingQuestionPrompt` — the openness `approach` (a
 * session-level arc) plus any additive tactics. Disabled ⇒ empty string ⇒ the default voice is
 * unchanged.
 *
 * Pure + provider-agnostic (no Prisma/LLM imports), like `tone.ts`: a narrower that coerces the
 * stored Json onto a complete {@link InterviewerStrategySettings}, and a builder that renders the
 * enabled approach/tactics into imperative prompt text given the session's progress.
 */

import { isRecord } from '@/lib/utils';
import { narrowPromptText } from '@/lib/app/questionnaire/chat/prompt-text';
import {
  DEFAULT_INTERVIEWER_STRATEGY,
  FUNNEL_PACES,
  INTERVIEWER_APPROACHES,
  INTERVIEWER_OPENING_MODES,
  MAX_OPENING_EXAMPLES,
  OPENING_EXAMPLE_MAX,
  type FunnelPace,
  type InterviewerApproach,
  type InterviewerOpeningMode,
  type InterviewerStrategySettings,
} from '@/lib/app/questionnaire/types';

/**
 * Project the stored `interviewerStrategy` Json (we wrote it, but it may be `{}`, partial,
 * legacy-null, or malformed) onto a complete {@link InterviewerStrategySettings}: `enabled` strictly
 * boolean, `approach`/`pace`/`openingMode` known members (else the default), tactics strictly
 * boolean, `openingExamples` a bounded array of sanitised non-empty strings.
 *
 * Rows written before the pace/opening fields existed simply lack those keys and fall back to the
 * defaults, which reproduce the original hard-coded behaviour — no backfill required.
 */
export function narrowInterviewerStrategy(value: unknown): InterviewerStrategySettings {
  const obj = isRecord(value) ? value : {};
  const approach = INTERVIEWER_APPROACHES.includes(obj.approach as InterviewerApproach)
    ? (obj.approach as InterviewerApproach)
    : DEFAULT_INTERVIEWER_STRATEGY.approach;
  const pace = FUNNEL_PACES.includes(obj.pace as FunnelPace)
    ? (obj.pace as FunnelPace)
    : DEFAULT_INTERVIEWER_STRATEGY.pace;
  const openingMode = INTERVIEWER_OPENING_MODES.includes(obj.openingMode as InterviewerOpeningMode)
    ? (obj.openingMode as InterviewerOpeningMode)
    : DEFAULT_INTERVIEWER_STRATEGY.openingMode;
  const openingExamples = (Array.isArray(obj.openingExamples) ? obj.openingExamples : [])
    .map((entry) => narrowPromptText(entry, OPENING_EXAMPLE_MAX))
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_OPENING_EXAMPLES);
  return {
    enabled: obj.enabled === true,
    approach,
    pace,
    openingMode,
    openingExamples,
    probeDepth: obj.probeDepth === true,
    reflect: obj.reflect === true,
    batchRelated: obj.batchRelated === true,
  };
}

/** Where the conversation is in the funnel arc, derived from coverage (with progress as a fallback). */
export type FunnelPhase = 'open' | 'mixed' | 'targeted';

/**
 * The four numbers that define one arc. They move together as a {@link FunnelPace} because they are
 * not independently meaningful: an admin who widened the open band but left the opening window at
 * one ask would get an arc that contradicts itself.
 *
 * - `openingWindow` — asks at the very start of a session that get the richer, permission-giving,
 *   breadth-first invitation (and a relaxed brevity floor) instead of the ongoing broad clause.
 *   Beyond it, the open phase reverts to its standard broad invitation.
 * - `openBelow` / `targetedAbove` — coverage below the first is the broad/open phase; above the
 *   second it's the targeted phase; between them, mixed.
 * - `openRounds` / `targetedRounds` — the same three bands expressed in asks, used when there is no
 *   coverage signal yet.
 */
export interface FunnelPaceProfile {
  openingWindow: number;
  openBelow: number;
  targetedAbove: number;
  openRounds: number;
  targetedRounds: number;
}

/**
 * `balanced` is the arc's original hard-coded constants, unchanged — it is what makes this dial a
 * provable no-op for every questionnaire that has never touched it. The other two stops widen and
 * narrow every band in step.
 */
export const FUNNEL_PACE_PROFILES: Record<FunnelPace, FunnelPaceProfile> = {
  gradual: {
    openingWindow: 3,
    openBelow: 0.55,
    targetedAbove: 0.85,
    openRounds: 5,
    targetedRounds: 12,
  },
  balanced: {
    openingWindow: 2,
    openBelow: 0.4,
    targetedAbove: 0.75,
    openRounds: 3,
    targetedRounds: 8,
  },
  brisk: {
    openingWindow: 1,
    openBelow: 0.25,
    targetedAbove: 0.55,
    openRounds: 2,
    targetedRounds: 5,
  },
};

/**
 * The profile governing THIS session.
 *
 * Pace is honoured for `funnel` only, and deliberately so: the admin editor shows the dial only for
 * that approach, so letting a stored pace quietly reshape an `open` session's opening window would
 * be an effect with no visible cause. `open` and `targeted` always read `balanced`.
 */
export function paceProfile(settings: InterviewerStrategySettings | undefined): FunnelPaceProfile {
  if (settings?.approach !== 'funnel') return FUNNEL_PACE_PROFILES.balanced;
  return FUNNEL_PACE_PROFILES[settings.pace] ?? FUNNEL_PACE_PROFILES.balanced;
}

/** Context the funnel arc reads to decide its phase. */
export interface InterviewerStrategyContext {
  /** Fraction of the questionnaire covered so far (0–1), when known. */
  coverage?: number | null;
  /** Selection round (0-based count of asks so far) — the fallback when coverage is absent. */
  questionsAsked: number;
  /** The respondent has been giving short/terse answers — bias the funnel toward targeted sooner. */
  respondentTerse?: boolean;
  /**
   * The broad area/theme the selected question belongs to (e.g. a data slot's theme). The OPEN
   * phase broadens to THIS area instead of the one specific question, so a wide answer can fill
   * several neighbours at once. Absent ⇒ the clause says "this general area".
   */
  topicArea?: string | null;
}

/**
 * Resolve the funnel phase from coverage (preferred) or the selection round, then apply the terse
 * bias. The profile defaults to `balanced`, which is the arc's original behaviour.
 */
export function funnelPhase(
  ctx: InterviewerStrategyContext,
  profile: FunnelPaceProfile = FUNNEL_PACE_PROFILES.balanced
): FunnelPhase {
  let phase: FunnelPhase;
  if (typeof ctx.coverage === 'number') {
    phase =
      ctx.coverage < profile.openBelow
        ? 'open'
        : ctx.coverage < profile.targetedAbove
          ? 'mixed'
          : 'targeted';
  } else {
    phase =
      ctx.questionsAsked < profile.openRounds
        ? 'open'
        : ctx.questionsAsked < profile.targetedRounds
          ? 'mixed'
          : 'targeted';
  }
  // Terse respondent → step one notch toward targeted (open→mixed, mixed→targeted): they aren't
  // rambling, so broad invitations aren't paying off — get specific sooner.
  if (ctx.respondentTerse) {
    if (phase === 'open') return 'mixed';
    if (phase === 'mixed') return 'targeted';
  }
  return phase;
}

/** "the broad area of X" when the theme is known, else a generic fallback. */
function areaPhrase(ctx: InterviewerStrategyContext): string {
  const area = ctx.topicArea?.trim();
  return area ? `the broad area of ${area}` : 'this general area';
}

/**
 * The OPEN clause deliberately BROADENS the scope past the single selected question — the phraser is
 * otherwise told to "ask the ONE question provided", so without this explicit override it just
 * rewords that specific question openly instead of asking a genuinely general opener. The first few
 * asks (the pace profile's `openingWindow`) get the richer, permission-giving {@link openingClause};
 * after that the ongoing broad invitation below carries the open phase.
 */
function openClause(
  ctx: InterviewerStrategyContext,
  profile: FunnelPaceProfile,
  settings: InterviewerStrategySettings
): string {
  if (ctx.questionsAsked < profile.openingWindow) return openingClause(ctx, settings);
  return (
    'QUESTIONING APPROACH — be highly OPEN and general right now. Treat the specific question below ' +
    `as ONLY a hint to the AREA to explore — do NOT ask it narrowly. Instead, ask ONE broad, ` +
    `exploratory question that invites the respondent to talk freely about ${areaPhrase(ctx)} ` +
    '("Tell me about…", "Share your thoughts on…", "Walk me through…"), so a single expansive answer ' +
    'can cover several related points at once. This OVERRIDES the "ask the one question provided" and ' +
    '"one thing at a time" guidance above — a wide, easy invitation matters more than the exact ' +
    'underlying question. Keep probing openly while they are forthcoming.'
  );
}

/**
 * The framing half of the opening clause: where the wording of the opener comes from.
 *
 * `auto` hands the model a MENU of framings and tells it to vary between them, so different
 * respondents get different openings. `examples` swaps that menu for the admin's own openers as
 * GUIDANCE — the register and breadth to aim at, never a script to read. Reproducing one verbatim
 * would give every respondent the same opener, which is the failure mode the menu exists to avoid,
 * so the clause bans it explicitly rather than trusting the word "example" to carry that.
 *
 * An `examples` mode with nothing usable in it falls back to the menu: an empty list must never
 * produce a degraded opener (see {@link usesGuidedOpening}).
 */
function framingClause(settings: InterviewerStrategySettings): string {
  if (usesGuidedOpening(settings)) {
    const examples = settings.openingExamples
      .map((example, index) => `(${index + 1}) "${example}"`)
      .join(' ');
    return (
      'The client has supplied example opening questions that show the KIND of opener they want. Be ' +
      'GUIDED by them — match their breadth, register and spirit, and the sort of thinking they ask ' +
      'for — but do NOT reproduce one verbatim, quote it, or treat the list as a script. Write your ' +
      'OWN opener in the same vein, adapted to this questionnaire and this respondent, and vary it ' +
      `between respondents. Examples: ${examples}`
    );
  }
  return (
    'Choose ONE natural framing and make it your own — VARY it, do not recite a script. Framings to ' +
    'draw on: broad & conversational ("I\'d like to invite you to talk about your experiences of…"); ' +
    'story-first ("could you tell me about your overall experience of…?"); reflection-first ("what ' +
    'comes to mind when you think about…?"); very open ("what\'s it really like to experience…?"); ' +
    'blank page ("if you had a blank page to describe…, what would you write?"); appreciative & ' +
    'critical ("what stands out most, both positively and negatively?").'
  );
}

/**
 * The OPENING clause — used for the first few asks (the pace profile's `openingWindow`) in an open
 * phase. Richer and more subtle than the ongoing broad clause: it invites the respondent to talk
 * freely and broadly before any specific question, gives explicit permission to speak at length,
 * welcomes experiences as much as opinions, and closes with a {@link framingClause} — the
 * interviewer's own menu of framings, or the admin's examples. On the second ask it follows the
 * respondent's lead — widening again if their first answer was thin, or probing deeper if it
 * surfaced something that matters. The brevity floor is relaxed for these turns (see
 * {@link usesOpenOpening}).
 */
function openingClause(
  ctx: InterviewerStrategyContext,
  settings: InterviewerStrategySettings
): string {
  const second =
    ctx.questionsAsked >= 1
      ? ctx.respondentTerse
        ? 'Their opening answer was brief, so gently widen again and invite more breadth rather ' +
          'than narrowing yet. '
        : 'If their opening answer raised something that clearly matters to them, FOLLOW that ' +
          'thread and probe it more deeply now — let their answer lead — rather than resetting to a ' +
          'fresh broad topic; only if it was thin should you widen again. '
      : '';
  return (
    'QUESTIONING APPROACH — this is the OPENING of the conversation, so make your first couple of ' +
    `asks especially open. Invite the respondent to talk freely and broadly about ${areaPhrase(ctx)} ` +
    'in their own words — breadth before detail, experiences as much as opinions, and no leading ' +
    'language. Make it genuinely easy and unpressured: signal there are no right or wrong answers, ' +
    'they can take it in whatever direction feels most relevant, and they should feel free to take ' +
    'their time and think aloud. You may briefly note that you complete the questionnaire quietly in ' +
    "the background as they talk, so they needn't answer it directly — but do not make that the " +
    'focus. CRUCIAL: the specific topic below is ONLY a pointer to the area — do NOT ask about it, ' +
    `name it, or bold it. Stay at the level of ${areaPhrase(ctx)} as a whole, or go wider still to ` +
    "their overall experience of the questionnaire's subject (see the goal); take the BROADEST " +
    'sensible framing, never the one narrow topic. ' +
    second +
    framingClause(settings) +
    ' This OVERRIDES the "ask the ' +
    'one question provided" and "one thing at a time" guidance above — a wide, permission-giving ' +
    'invitation matters more than the underlying question right now.'
  );
}

function targetedClause(): string {
  return (
    'QUESTIONING APPROACH — be TARGETED and efficient. Ask ONE specific, concrete question at a ' +
    'time, aimed squarely at a remaining gap. Keep preamble minimal and move briskly; favour a ' +
    'direct, answerable ask over a broad invitation to ramble.'
  );
}

function mixedClause(ctx: InterviewerStrategyContext): string {
  return (
    `QUESTIONING APPROACH — keep questions fairly open and conversational, inviting detail about ` +
    `${areaPhrase(ctx)}, but begin steering toward the specific points still missing — open enough ` +
    'to invite elaboration, pointed enough to fill the gaps.'
  );
}

function funnelClause(
  ctx: InterviewerStrategyContext,
  profile: FunnelPaceProfile,
  settings: InterviewerStrategySettings
): string {
  const phase = funnelPhase(ctx, profile);
  if (phase === 'open') return openClause(ctx, profile, settings);
  if (phase === 'mixed') return mixedClause(ctx);
  return targetedClause();
}

/**
 * Render the enabled interviewer strategy into prompt text that OVERRIDES the default
 * questioning-approach guidance. Returns `''` when disabled (default voice unchanged).
 */
export function buildInterviewerStrategyInstructions(
  settings: InterviewerStrategySettings | undefined,
  ctx: InterviewerStrategyContext
): string {
  if (!settings?.enabled) return '';

  const profile = paceProfile(settings);
  const clauses: string[] = [];
  if (settings.approach === 'funnel') clauses.push(funnelClause(ctx, profile, settings));
  else if (settings.approach === 'open') clauses.push(openClause(ctx, profile, settings));
  else clauses.push(targetedClause());

  // Additive tactics — combine with any approach.
  if (settings.probeDepth) {
    clauses.push(
      'PROBE FOR DEPTH — if their last answer was shallow, vague, or surface-level, ask ONE brief ' +
        'follow-up to draw out the substance ("What makes you say that?", "Can you give an example?") ' +
        'before moving on to anything new.'
    );
  }
  if (settings.reflect) {
    clauses.push(
      'REFLECT AND CONFIRM — before the next question, briefly play back the gist of what you just ' +
        'heard in your own words, as a STATEMENT ("So the backdrop most of the time is sadness.", ' +
        '"It sounds like that decision still sits with you."). Keep it to one short clause and do ' +
        'not parrot them verbatim. CRUCIAL: the playback must NOT be a question — no "is that ' +
        'right?", "does that sound fair?", "have I got that?" or any other confirming tag, and no ' +
        'question mark. Stating it back is enough; they will correct you if it is off. The ONLY ' +
        'question in your message is the next question you go on to ask.'
    );
  }
  if (settings.batchRelated) {
    clauses.push(
      'BATCH RELATED — when several remaining gaps are closely related, you MAY invite two or three ' +
        'together in one natural question rather than strictly one at a time, as long as it still ' +
        'reads as a single, easy ask (this is the one allowed exception to the one-thing-at-a-time ' +
        'rule above).'
    );
  }

  return clauses.join(' ');
}

/**
 * Whether THIS turn is an "open opening" — the first few asks (the pace profile's `openingWindow`)
 * of a session whose resolved phase is open: the `open` approach (always open) or `funnel` while
 * {@link funnelPhase} reads `open`. The single source of truth for "give this opening room": the
 * phraser uses it to relax the brevity floor so the richer {@link openingClause} invitation fits.
 * False when the strategy is disabled, the approach/phase isn't open, or we're past the window.
 */
export function usesOpenOpening(
  settings: InterviewerStrategySettings | undefined,
  ctx: InterviewerStrategyContext
): boolean {
  if (!settings?.enabled) return false;
  const profile = paceProfile(settings);
  if (ctx.questionsAsked >= profile.openingWindow) return false;
  if (settings.approach === 'open') return true;
  if (settings.approach === 'funnel') return funnelPhase(ctx, profile) === 'open';
  return false;
}

/**
 * Whether the admin's example openers actually govern the opening framing: `examples` mode with at
 * least one usable example left after narrowing.
 *
 * The emptiness check is the point. `examples` with nothing in it — a mode switched on before the
 * list was written, or a list whose entries were all whitespace — must fall back to the
 * interviewer's own framings menu rather than render an examples block with no examples in it. The
 * editor uses this to warn the admin that the mode is currently doing nothing.
 */
export function usesGuidedOpening(settings: InterviewerStrategySettings | undefined): boolean {
  if (settings?.openingMode !== 'examples') return false;
  return settings.openingExamples.some((example) => example.trim().length > 0);
}
