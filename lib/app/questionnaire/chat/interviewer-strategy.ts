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
import {
  DEFAULT_INTERVIEWER_STRATEGY,
  INTERVIEWER_APPROACHES,
  type InterviewerApproach,
  type InterviewerStrategySettings,
} from '@/lib/app/questionnaire/types';

/**
 * Project the stored `interviewerStrategy` Json (we wrote it, but it may be `{}`, partial,
 * legacy-null, or malformed) onto a complete {@link InterviewerStrategySettings}: `enabled` strictly
 * boolean, `approach` a known member (else the default), tactics strictly boolean.
 */
export function narrowInterviewerStrategy(value: unknown): InterviewerStrategySettings {
  const obj = isRecord(value) ? value : {};
  const approach = INTERVIEWER_APPROACHES.includes(obj.approach as InterviewerApproach)
    ? (obj.approach as InterviewerApproach)
    : DEFAULT_INTERVIEWER_STRATEGY.approach;
  return {
    enabled: obj.enabled === true,
    approach,
    probeDepth: obj.probeDepth === true,
    reflect: obj.reflect === true,
    batchRelated: obj.batchRelated === true,
  };
}

/**
 * The "particularly open" window at the very start of a session: the first couple of asks get a
 * richer, permission-giving, breadth-first invitation (and a relaxed brevity floor) instead of the
 * ongoing broad clause. Beyond this, the open phase reverts to its standard broad invitation.
 */
const OPENING_WINDOW = 2;

/** Where the conversation is in the funnel arc, derived from coverage (with progress as a fallback). */
export type FunnelPhase = 'open' | 'mixed' | 'targeted';

/** Coverage below this is still the broad/open phase; above the upper bound it's the targeted phase. */
const FUNNEL_OPEN_BELOW = 0.4;
const FUNNEL_TARGETED_ABOVE = 0.75;
/** Without a coverage signal, fall back to the selection round: open for the first few asks, … */
const FUNNEL_OPEN_ROUNDS = 3;
const FUNNEL_TARGETED_ROUNDS = 8;

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

/** Resolve the funnel phase from coverage (preferred) or the selection round, then apply the terse bias. */
export function funnelPhase(ctx: InterviewerStrategyContext): FunnelPhase {
  let phase: FunnelPhase;
  if (typeof ctx.coverage === 'number') {
    phase =
      ctx.coverage < FUNNEL_OPEN_BELOW
        ? 'open'
        : ctx.coverage < FUNNEL_TARGETED_ABOVE
          ? 'mixed'
          : 'targeted';
  } else {
    phase =
      ctx.questionsAsked < FUNNEL_OPEN_ROUNDS
        ? 'open'
        : ctx.questionsAsked < FUNNEL_TARGETED_ROUNDS
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
 * rewords that specific question openly instead of asking a genuinely general opener. The first
 * couple of asks ({@link OPENING_WINDOW}) get the richer, permission-giving {@link openingClause};
 * after that the ongoing broad invitation below carries the open phase.
 */
function openClause(ctx: InterviewerStrategyContext): string {
  if (ctx.questionsAsked < OPENING_WINDOW) return openingClause(ctx);
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
 * The OPENING clause — used for the first couple of asks ({@link OPENING_WINDOW}) in an open phase.
 * Richer and more subtle than the ongoing broad clause: it invites the respondent to talk freely and
 * broadly before any specific question, gives explicit permission to speak at length, welcomes
 * experiences as much as opinions, and offers a MENU of framings the model varies between (no script,
 * so different respondents get different openings). On the second ask it follows the respondent's
 * lead — widening again if their first answer was thin, or probing deeper if it surfaced something
 * that matters. The brevity floor is relaxed for these turns (see {@link usesOpenOpening}).
 */
function openingClause(ctx: InterviewerStrategyContext): string {
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
    'Choose ONE natural framing and make it your own — VARY it, do not recite a script. Framings to ' +
    'draw on: broad & conversational ("I\'d like to invite you to talk about your experiences of…"); ' +
    'story-first ("could you tell me about your overall experience of…?"); reflection-first ("what ' +
    'comes to mind when you think about…?"); very open ("what\'s it really like to experience…?"); ' +
    'blank page ("if you had a blank page to describe…, what would you write?"); appreciative & ' +
    'critical ("what stands out most, both positively and negatively?"). This OVERRIDES the "ask the ' +
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

function funnelClause(ctx: InterviewerStrategyContext): string {
  const phase = funnelPhase(ctx);
  if (phase === 'open') return openClause(ctx);
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

  const clauses: string[] = [];
  if (settings.approach === 'funnel') clauses.push(funnelClause(ctx));
  else if (settings.approach === 'open') clauses.push(openClause(ctx));
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
        'heard in your own words so they can confirm or correct it ("So it sounds like… — is that ' +
        'right?"). Keep it to one short clause; do not parrot them verbatim.'
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
 * Whether THIS turn is an "open opening" — the first couple of asks ({@link OPENING_WINDOW}) of a
 * session whose resolved phase is open: the `open` approach (always open) or `funnel` while
 * {@link funnelPhase} reads `open`. The single source of truth for "give this opening room": the
 * phraser uses it to relax the brevity floor so the richer {@link openingClause} invitation fits.
 * False when the strategy is disabled, the approach/phase isn't open, or we're past the window.
 */
export function usesOpenOpening(
  settings: InterviewerStrategySettings | undefined,
  ctx: InterviewerStrategyContext
): boolean {
  if (!settings?.enabled) return false;
  if (ctx.questionsAsked >= OPENING_WINDOW) return false;
  if (settings.approach === 'open') return true;
  if (settings.approach === 'funnel') return funnelPhase(ctx) === 'open';
  return false;
}
