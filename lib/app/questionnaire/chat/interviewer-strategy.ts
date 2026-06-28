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
 * rewords that specific question openly instead of asking a genuinely general opener.
 */
function openClause(ctx: InterviewerStrategyContext): string {
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
