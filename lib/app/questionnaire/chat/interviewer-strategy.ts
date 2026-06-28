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

const OPEN_CLAUSE =
  'QUESTIONING APPROACH — be highly OPEN and general. Lead with broad, exploratory invitations ' +
  '("Tell me about…", "Share your thoughts on…", "What\'s been on your mind about…") that let the ' +
  'respondent talk freely and at length; a single rambling answer can cover several topics at once. ' +
  'Stay loosely guided by what is still unanswered, but encourage tangents and follow their lead ' +
  'rather than marching through specifics.';

const TARGETED_CLAUSE =
  'QUESTIONING APPROACH — be TARGETED and efficient. Ask ONE specific, concrete question at a time, ' +
  'aimed squarely at a remaining gap. Keep preamble minimal and move briskly; favour a direct, ' +
  'answerable ask over a broad invitation to ramble.';

const FUNNEL_PHASE_CLAUSE: Record<FunnelPhase, string> = {
  open:
    'QUESTIONING APPROACH — you are EARLY in a funnel interview, so be highly OPEN and general. ' +
    'Lead with broad invitations ("Tell me about…", "Share your thoughts on…") so the respondent ' +
    'talks freely — one expansive answer can fill several topics at once. Keep probing openly while ' +
    'they are forthcoming; do not pin them to narrow specifics yet.',
  mixed:
    'QUESTIONING APPROACH — you are MID-WAY through a funnel interview. Keep questions fairly open ' +
    'and conversational, but begin steering toward the specific areas still missing — open enough ' +
    'to invite detail, pointed enough to fill the gaps.',
  targeted:
    'QUESTIONING APPROACH — you are LATE in a funnel interview, closing out. Switch to TARGETED, ' +
    'specific questions that efficiently fill the remaining gaps, one concrete thing at a time. You ' +
    'may still drop in the occasional open invitation where a gap needs richer detail.',
};

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
  if (settings.approach === 'funnel') clauses.push(FUNNEL_PHASE_CLAUSE[funnelPhase(ctx)]);
  else if (settings.approach === 'open') clauses.push(OPEN_CLAUSE);
  else clauses.push(TARGETED_CLAUSE);

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
