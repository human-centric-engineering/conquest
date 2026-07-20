/**
 * Experience runs (P15.2) — pure domain types.
 *
 * The vocabulary and shapes the run lifecycle shares across its write seam (`_lib/run-advance.ts`),
 * its read surfaces, and the respondent client. No Prisma, no Next — safe to import from client
 * components.
 */

import type { SensitivitySeverity } from '@/lib/app/questionnaire/types';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import type {
  ExperienceContinuityMode,
  ExperienceSeamMarker,
} from '@/lib/app/questionnaire/experiences/types';

/**
 * A run's lifecycle status.
 *
 * Mirrors `SESSION_STATUSES` deliberately — an admin reading the sessions console and the runs
 * console should not have to learn two words for the same idea. `awaiting_handoff` is the single
 * addition: a leg has completed and the selector has not yet resolved, which is the window the
 * respondent's client polls through.
 */
export const EXPERIENCE_RUN_STATUSES = [
  'active',
  'awaiting_handoff',
  'completed',
  'abandoned',
  'aborted',
] as const;
export type ExperienceRunStatus = (typeof EXPERIENCE_RUN_STATUSES)[number];

/** Statuses from which a run can still progress. */
const LIVE_RUN_STATUSES: readonly ExperienceRunStatus[] = ['active', 'awaiting_handoff'];

/** Whether a run has reached a state it can never leave. */
export function isTerminalRunStatus(status: ExperienceRunStatus): boolean {
  return !LIVE_RUN_STATUSES.includes(status);
}

/** One leg's status. Simpler than a session's — a leg mirrors its session, it does not pause. */
export const EXPERIENCE_LEG_STATUSES = ['active', 'completed', 'abandoned'] as const;
export type ExperienceLegStatus = (typeof EXPERIENCE_LEG_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Carry-over                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One safeguarding disclosure, as carried between legs.
 *
 * A narrowed projection of {@link SensitivityNote} — the three fields the next interviewer needs
 * in order to handle the person well, without the turn ordinal or timestamp that only make sense
 * within the originating session.
 */
export interface CarriedSensitivityNote {
  severity: SensitivitySeverity;
  category: string;
  summary: string;
}

/**
 * One data-slot fill carried from an earlier leg.
 *
 * The data-slot layer is the semantic answer vocabulary — stable across question rewording — which
 * is why carry-over is built from fills rather than raw answers.
 */
export interface CarryOverFill {
  key: string;
  name: string;
  theme: string | null;
  /** The natural-language rendering of what the respondent conveyed. */
  paraphrase: string | null;
  /** The structured value, when the slot has one. */
  value: unknown;
  /** 0–1 extraction confidence, or null when the pipeline recorded none. */
  confidence: number | null;
}

/**
 * Everything one leg hands to the next. Frozen onto `AppExperienceRun.carryOver` at the handoff
 * and never recomputed.
 */
export interface CarryOverContext {
  /** The step key and session the context came from — so a reader can trace it back. */
  fromStepKey: string;
  fromSessionId: string;

  /** The deterministic spine: what the respondent conveyed, by data slot. */
  fills: CarryOverFill[];

  /**
   * Profile values captured earlier (name, role, whatever the entry leg asked), or null.
   *
   * Null under anonymous mode — and that check reads the SOURCE LEG's version config, never the
   * experience's. An anonymous entry leg has no snapshot to carry regardless of what the
   * experience's `carryProfile` setting says.
   */
  profile: Record<string, unknown> | null;

  /**
   * Safeguarding state carried forward. **Must** cross the seam: an experience that forgets a
   * disclosure between legs makes the next interviewer re-open it, which is the worst failure this
   * feature can produce.
   *
   * `sensitivityNotes` mirrors the session column's shape — an append-only list of
   * {@link SensitivityNote}. Carried as summaries only (severity + category + summary), never the
   * raw disclosure text, which lives in the source leg's transcript and has no business being
   * re-inlined into another questionnaire's prompt.
   */
  sensitivityLevel: SensitivitySeverity | null;
  sensitivityNotes: CarriedSensitivityNote[];

  /** Scores from the source leg, when it had a scoring schema. */
  scores: Record<string, unknown> | null;

  /**
   * The optional LLM-compressed briefing. Null when `summariseCarryOver` is off or the call
   * failed — the deterministic fills alone are always a usable context.
   */
  briefing: string | null;
  /** The bridging line that becomes the next leg's first assistant turn. Null if not summarised. */
  openingLine: string | null;
  /** Short theme labels the summariser judged worth carrying. Empty when not summarised. */
  carriedThemes: string[];

  /** When this payload was frozen (ISO). */
  builtAt: string;
}

/* -------------------------------------------------------------------------- */
/* Advance result                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What `advanceExperienceRun` decided.
 *
 * A discriminated union rather than a nullable session id, so a caller cannot forget to handle
 * "the run concluded" — the case that carries the report.
 */
export type AdvanceResult =
  /** Routed onward: a new leg exists and the respondent should continue into it. */
  | { kind: 'leg'; runId: string; sessionId: string; stepKey: string; ordinal: number }
  /** The journey is over; the run-level report is the next thing the respondent sees. */
  | { kind: 'conclude'; runId: string; reason: ConcludeReason }
  /** Nothing to do — the run had already advanced (a concurrent call won the race). */
  | { kind: 'noop'; runId: string }
  /** Could not advance. `code` is machine-readable; `message` is admin-facing. */
  | { kind: 'blocked'; runId: string; code: AdvanceBlockedCode; message: string };

/** Why a run concluded rather than routing onward. */
export const CONCLUDE_REASONS = [
  /** The selector chose to conclude. */
  'selector',
  /** The run hit its cost budget; the fork was forced closed. */
  'budget',
  /** The experience defines no further candidates. */
  'no_candidates',
  /** The configured fallback concludes, and the selector could not be trusted. */
  'fallback',
] as const;
export type ConcludeReason = (typeof CONCLUDE_REASONS)[number];

/**
 * Why an advance could not proceed.
 *
 * Deliberately short. A `blocked` result means the CALLER asked for something incoherent (an
 * unknown run, a session that is not part of it) or an unexpected error occurred — not that the
 * journey hit a dead end. A dead end (the chosen step is unrunnable, the budget is exhausted, no
 * candidates remain) always resolves to `conclude`, because a stranded respondent who never
 * receives a report is strictly worse than one whose journey ended early.
 */
export const ADVANCE_BLOCKED_CODES = [
  'RUN_NOT_FOUND',
  'RUN_TERMINAL',
  'LEG_NOT_COMPLETE',
  'STEP_UNRESOLVABLE',
] as const;
export type AdvanceBlockedCode = (typeof ADVANCE_BLOCKED_CODES)[number];

/* -------------------------------------------------------------------------- */
/* Session ↔ run membership                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a respondent surface needs to know about the run its session belongs to (P15.3).
 *
 * Carried on the session STATUS VIEW rather than handed back by the submit response, and that
 * choice is load-bearing: the submit response is seen exactly once, so a respondent who reloads
 * a completed leg — or returns to the tab an hour later — would otherwise land on the terminal
 * completion screen with no idea the journey continues. The status view is re-read on every
 * mount, so run membership survives a refresh.
 *
 * `null` for an ordinary standalone session, which is the overwhelming majority — the lookup is a
 * single indexed hit on the `@unique` `sessionId`.
 */
export interface SessionExperienceContext {
  runId: string;
  /**
   * The run's stable public ref — the `/x/<publicRef>` address, when it has one.
   *
   * Null only for a pre-column run. Its presence is what tells the respondent surface it is on the
   * stable address, where continuing means REFRESHING in place rather than navigating: pushing the
   * URL you are already on is a no-op, so a stitched handoff there would silently do nothing.
   */
  publicRef: string | null;
  /** This leg's 0-based position. `> 0` means earlier legs exist to stitch above this one. */
  ordinal: number;
  /**
   * How the seam is presented. Read live from the experience rather than frozen onto the run, so
   * an author switching modes changes what in-flight respondents see — which is exactly the
   * promise that `linked` and `stitched` share a persistence shape.
   */
  continuityMode: ExperienceContinuityMode;
  /** Only applied under `stitched`; see {@link ExperienceSeamMarker}. */
  seamMarker: ExperienceSeamMarker;
  /** This leg's step title — the divider label. Null when the step pointer no longer resolves. */
  stepTitle: string | null;
}

/* -------------------------------------------------------------------------- */
/* Stitched history                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One earlier leg's conversation, as the stitched surface replays it above the live one (P15.3).
 *
 * Deliberately NOT folded into the live `turns` array, and deliberately not expressed by widening
 * {@link QuestionnaireTurn} with a `seam` role. The turn array is consumed by the reveal cursor,
 * the inspector drawer, and `report/craft.ts` — which maps `turn.role` directly onto an
 * `LlmMessage`. A synthetic role would have travelled into a real LLM call as a role the provider
 * does not accept. Keeping history a separate, read-only prop means none of those paths change.
 */
export interface StitchedSegment {
  /** The step this leg fulfilled — the divider label. Null when the step pointer no longer resolves. */
  stepTitle: string | null;
  /** The leg's replayed conversation, oldest first. */
  turns: QuestionnaireTurn[];
}

/**
 * Every leg BEFORE the one currently being answered, oldest first.
 *
 * Empty for the entry leg, which is the common case and renders exactly as a standalone session.
 */
export interface StitchedHistory {
  segments: StitchedSegment[];
}

/* -------------------------------------------------------------------------- */
/* Poll status                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the respondent's client sees while polling after a submit.
 *
 * `pending` is the honest answer during the selector window: the client keeps polling. Everything
 * else is terminal for that poll loop.
 */
export type RunPollState =
  | { state: 'pending' }
  | {
      state: 'leg';
      sessionId: string;
      stepTitle: string;
      message: string;
      /**
       * A freshly-minted access token for the NEW leg — present only on the no-login surface.
       *
       * Without it the anonymous respondent cannot open leg B at all: they hold a signed token
       * scoped to leg A's session id, and leg B is a different session. The authenticated surface
       * needs nothing here, because a cookie already proves who they are.
       *
       * Minted only when the caller proved ownership by presenting a valid token for a sibling leg
       * of THIS run. It is a lateral move within a journey the caller is already inside, never a
       * way to obtain a credential for a session they could not otherwise reach.
       */
      sessionToken?: string;
    }
  | { state: 'conclude'; reason: ConcludeReason; message: string }
  | { state: 'failed'; message: string };
