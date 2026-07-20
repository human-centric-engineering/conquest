/**
 * Experiences (P15) — shared domain types.
 *
 * The single source of truth for every Experience vocabulary: the `const` tuples below back the
 * TypeScript types, the routes' Zod enums (`z.enum(EXPERIENCE_KINDS)`), the admin UI's filter and
 * badge options, and the `narrowToEnum` reads that guard the plain `String` columns. Adding a
 * member here updates every consumer rather than leaving hard-coded lists to drift — the house
 * style established by `lib/app/questionnaire/types.ts`.
 *
 * Pure: no Prisma, no Next. Safe to import from client components.
 */

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What kind of journey this is.
 *
 * `agentic_switcher` is **general-purpose conditional routing** — an opening questionnaire
 * followed by an AI decision to conclude or continue into a chosen follow-up. It carries no
 * assumption about domain or commercial intent: triage into a specialist assessment, escalating
 * depth on a topic the respondent cares about, branching by role, and lead qualification are all
 * the same mechanism pointed at different questionnaires.
 *
 * `facilitated_meeting` is the many-participants-at-once shape (P15.5): the same short
 * questionnaire run simultaneously, synthesised per breakout for a live facilitator.
 */
export const EXPERIENCE_KINDS = ['agentic_switcher', 'facilitated_meeting'] as const;
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

/** Human labels for the kind selector. */
export const EXPERIENCE_KIND_LABELS: Record<ExperienceKind, string> = {
  agentic_switcher: 'Agentic switcher',
  facilitated_meeting: 'Facilitated meeting',
};

/** One-line descriptions shown beneath each kind in the create form. */
export const EXPERIENCE_KIND_DESCRIPTIONS: Record<ExperienceKind, string> = {
  agentic_switcher:
    'An opening questionnaire, then an AI decision: conclude with a report, or continue into a follow-up chosen from your candidates.',
  facilitated_meeting:
    'The same short questionnaire run by many people at once, synthesised per breakout for a live facilitator.',
};

/** Lifecycle status. Mirrors `APP_QUESTIONNAIRE_STATUSES` so both surfaces read the same way. */
export const EXPERIENCE_STATUSES = ['draft', 'launched', 'archived'] as const;
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

/**
 * How the respondent experiences the seam between legs.
 *
 * **`linked` and `stitched` are the same persistence shape** — one `AppQuestionnaireSession` per
 * leg either way. `stitched` differs only in presentation, so an experience can be switched
 * between them at any time without migrating a row. That invariant is what keeps the
 * one-continuous-chat feature cheap; if `stitched` ever appears to need its own tables, the
 * requirement is wrong, not the design.
 *
 * `merged` (P15.6) is the only mode that genuinely changes persistence — a synthetic version
 * combining two questionnaires, run as one session. Deliberately last, and may never ship.
 */
export const EXPERIENCE_CONTINUITY_MODES = ['linked', 'stitched', 'merged'] as const;
export type ExperienceContinuityMode = (typeof EXPERIENCE_CONTINUITY_MODES)[number];

/** Human labels for the continuity-mode selector. */
export const EXPERIENCE_CONTINUITY_MODE_LABELS: Record<ExperienceContinuityMode, string> = {
  linked: 'Separate conversations',
  stitched: 'One continuous conversation',
  merged: 'Merged questionnaire (not yet available)',
};

/**
 * How visible the seam between legs is under `stitched` (P15.3).
 *
 * `divider` renders a labelled rule carrying the next step's title; `none` reveals the bridging
 * turn with no marker at all. Both auto-continue — the choice is about honesty, not friction.
 *
 * There is a real argument on each side, which is why this is the author's call and not ours.
 * A marker tells the respondent the subject changed and that a different questionnaire is now
 * asking, which matters when the second leg is materially more probing than the first. No marker
 * reads as one interviewer following a thread, which is the smoother experience and the whole
 * point of choosing `stitched`. Ignored entirely under `linked` and `merged`.
 */
export const EXPERIENCE_SEAM_MARKERS = ['divider', 'none'] as const;
export type ExperienceSeamMarker = (typeof EXPERIENCE_SEAM_MARKERS)[number];

/**
 * How respondents see a meeting's synthesis in their own questionnaire window (P15.5).
 *
 * `none` — the shared screen only. `tab` — a quiet extra tab beside the conversation, there when
 * they look for it. `modal` — surfaced over the conversation when the facilitator publishes it,
 * which pulls attention but interrupts anyone still typing.
 */
export const EXPERIENCE_INSIGHT_DISPLAYS = ['none', 'tab', 'modal'] as const;
export type ExperienceInsightDisplay = (typeof EXPERIENCE_INSIGHT_DISPLAYS)[number];

/** Human labels for the respondent insight-display selector. */
export const EXPERIENCE_INSIGHT_DISPLAY_LABELS: Record<ExperienceInsightDisplay, string> = {
  none: 'Shared screen only',
  tab: 'A tab in their questionnaire',
  modal: 'Pop it up over their conversation',
};

/**
 * How the facilitator console renders (P15.5).
 *
 * `standard` is the working surface — full controls, dense. `presentation` is for a projector, a
 * meeting-room screen, or a Zoom share: larger type, fewer controls, readable at distance and
 * through video compression.
 */
export const EXPERIENCE_CONSOLE_DISPLAYS = ['standard', 'presentation'] as const;
export type ExperienceConsoleDisplay = (typeof EXPERIENCE_CONSOLE_DISPLAYS)[number];

/** Human labels for the console display selector. */
export const EXPERIENCE_CONSOLE_DISPLAY_LABELS: Record<ExperienceConsoleDisplay, string> = {
  standard: 'Standard — for your own screen',
  presentation: 'Presentation — for a shared screen or projector',
};

/** Bounds on the post-clock grace window, in seconds. */
export const BREAKOUT_GRACE_MIN_SECONDS = 0;
export const BREAKOUT_GRACE_MAX_SECONDS = 300;

/** Human labels for the seam-marker selector. */
export const EXPERIENCE_SEAM_MARKER_LABELS: Record<ExperienceSeamMarker, string> = {
  divider: 'Subtle divider with the step title',
  none: 'Seamless — no marker',
};

/**
 * What to do when the routing selector cannot be trusted — it errored, named a step that does not
 * exist, or reported confidence below the experience's threshold.
 *
 * `conclude` is the default and the recommended choice: finishing with what was gathered is an
 * honest outcome, whereas routing someone into a long follow-up on a coin-flip is not.
 */
export const EXPERIENCE_ROUTING_FALLBACKS = [
  'conclude',
  'first_candidate',
  'default_step',
] as const;
export type ExperienceRoutingFallback = (typeof EXPERIENCE_ROUTING_FALLBACKS)[number];

/** Human labels for the fallback selector. */
export const EXPERIENCE_ROUTING_FALLBACK_LABELS: Record<ExperienceRoutingFallback, string> = {
  conclude: 'Conclude with a report',
  first_candidate: 'Use the first candidate step',
  default_step: 'Use the nominated default step',
};

/**
 * What a step does in the journey.
 *
 * `entry` is where a run begins; `branch` is a candidate the selector may route into; `breakout`
 * is a facilitated-meeting room (P15.5); `report` is a terminal synthesis step (P15.4).
 */
export const EXPERIENCE_STEP_KINDS = ['entry', 'branch', 'breakout', 'report'] as const;
export type ExperienceStepKind = (typeof EXPERIENCE_STEP_KINDS)[number];

/** Human labels for the step-kind selector. */
export const EXPERIENCE_STEP_KIND_LABELS: Record<ExperienceStepKind, string> = {
  entry: 'Entry',
  branch: 'Branch candidate',
  breakout: 'Breakout',
  report: 'Report',
};

/* -------------------------------------------------------------------------- */
/* Field bounds                                                               */
/* -------------------------------------------------------------------------- */

export const EXPERIENCE_TITLE_MAX_LENGTH = 200;
export const EXPERIENCE_DESCRIPTION_MAX_LENGTH = 2_000;
export const EXPERIENCE_ROUTING_INSTRUCTIONS_MAX_LENGTH = 4_000;
export const EXPERIENCE_STEP_TITLE_MAX_LENGTH = 200;
export const EXPERIENCE_STEP_PURPOSE_MAX_LENGTH = 1_000;
export const EXPERIENCE_STEP_SELECTION_CRITERIA_MAX_LENGTH = 2_000;
export const EXPERIENCE_STEP_KEY_MAX_LENGTH = 64;

/** Bounds on the routing confidence threshold. 0 accepts any answer; 1 accepts only certainty. */
export const MIN_ROUTING_CONFIDENCE_FLOOR = 0;
export const MIN_ROUTING_CONFIDENCE_CEILING = 1;

/** Run-level budget bound. A negative or absurd cap is a typo, not an intent. */
export const EXPERIENCE_COST_BUDGET_MAX_USD = 1_000;

/* -------------------------------------------------------------------------- */
/* Settings blob                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The lazily-defaulted `settings` Json on `AppExperience`.
 *
 * A blob rather than columns because the facilitated-meeting kind is expected to accumulate many
 * per-experience variants, and each should be a settings key rather than a migration. Read through
 * {@link narrowExperienceSettings}, never destructured raw — the column may be `{}`, partial, or
 * (from an older shape) carry keys we no longer recognise.
 */
export interface ExperienceSettingsShape {
  /**
   * Run an LLM compression pass over the deterministic carry-over before handing it to the next
   * leg, producing a short briefing plus the opening line of the handoff turn. Off means the next
   * leg receives the deterministic data-slot digest alone — cheaper and fully predictable, but
   * flatter.
   */
  summariseCarryOver: boolean;
  /**
   * Carry the respondent's profile snapshot (name, role, whatever the entry leg captured) into
   * later legs, so they are not asked twice. Independent of the version's `anonymousMode`, which
   * always wins: an anonymous entry leg has no snapshot to carry regardless of this setting.
   */
  carryProfile: boolean;
  /**
   * Show the respondent why they were routed where they were, using the selector's
   * `respondentMessage`. Off delivers the handoff without explanation.
   */
  showRoutingRationale: boolean;
  /**
   * `stitched` only: how visible the seam between legs is. See {@link ExperienceSeamMarker}.
   *
   * Read unconditionally but applied only under `stitched` — a `linked` journey shows a full
   * handoff card and a `merged` one has no seam to mark. Keeping the key mode-independent means
   * switching an experience between modes never loses the author's choice.
   */
  stitchedSeamMarker: ExperienceSeamMarker;
  /**
   * Facilitated meetings: re-synthesise a breakout after this many further completions. Lower is
   * more live and more expensive. Ignored by the switcher kind.
   */
  synthesisEveryNCompletions: number;
  /**
   * Facilitated meetings: suppress any insight supported by fewer than this many respondents, so
   * an individual is never identifiable from a "tension". Mirrors the k-anonymity floor the round
   * learning digest already applies.
   */
  insightMinSupport: number;
  /**
   * Facilitated meetings: whether insights are visible to respondents as well as the facilitator.
   * Per-insight overrides still apply; this is the default for newly generated ones.
   */
  surfaceInsightsToRespondents: boolean;
  /**
   * Facilitated meetings: HOW a respondent sees the synthesis in their own questionnaire window,
   * when `surfaceInsightsToRespondents` is on. `none` means the shared screen is the only place it
   * appears.
   *
   * Separate from the boolean gate because the two questions are different: whether people may see
   * the analysis at all, and whether it belongs on their own device. A room watching a projector
   * together reads differently from forty people each looking down at a phone — and on a Zoom call
   * the shared screen may be the only thing anyone can see.
   */
  respondentInsightDisplay: ExperienceInsightDisplay;
  /**
   * Facilitated meetings: how the facilitator console renders. `presentation` is the
   * shared-screen mode — larger type, fewer controls, readable from the back of a room or through
   * a compressed video call.
   *
   * A per-experience setting rather than a device guess: the same console may be on a laptop the
   * facilitator alone sees, a projector the room reads, or a Zoom share where it is the ONLY
   * surface anyone has. Nothing about the viewport tells us which.
   */
  consoleDisplayMode: ExperienceConsoleDisplay;
  /**
   * Facilitated meetings: seconds granted after a breakout's clock ends for people to finish the
   * answer they are mid-way through and submit.
   *
   * Exists because the clock ending and the room being done are not the same moment. Cutting
   * someone off mid-sentence loses the answer AND the goodwill; thirty seconds costs the meeting
   * nothing.
   */
  breakoutGraceSeconds: number;
  /** Facilitated meetings: admin guidance appended to the breakout synthesis prompt. */
  synthesisInstructions: string;
}

export const EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH = 4_000;

/** Bounds for the numeric settings, applied by {@link narrowExperienceSettings}. */
export const SYNTHESIS_EVERY_N_MIN = 1;
export const SYNTHESIS_EVERY_N_MAX = 100;
export const INSIGHT_MIN_SUPPORT_FLOOR = 2;
export const INSIGHT_MIN_SUPPORT_CEILING = 50;

/**
 * Defaults for a fresh experience.
 *
 * `insightMinSupport: 3` is the k-anonymity floor — two respondents can often identify each other
 * from a "tension between two of you", three is the smallest group where that stops being true.
 */
export const DEFAULT_EXPERIENCE_SETTINGS: ExperienceSettingsShape = {
  summariseCarryOver: true,
  carryProfile: true,
  showRoutingRationale: true,
  // `divider` rather than `none`: a respondent moving from a broad opener into a materially more
  // probing follow-up should be able to see that the subject changed. An author who wants the
  // smoother read can opt out; the reverse default would hide the seam by accident.
  stitchedSeamMarker: 'divider',
  synthesisEveryNCompletions: 3,
  insightMinSupport: 3,
  surfaceInsightsToRespondents: false,
  // Defaults to the shared screen only: a facilitated meeting is a room looking at one thing
  // together, and putting the analysis on forty phones by default changes that without being asked.
  respondentInsightDisplay: 'none',
  consoleDisplayMode: 'standard',
  // Long enough to finish a sentence and press send, short enough that the room does not drift.
  breakoutGraceSeconds: 30,
  synthesisInstructions: '',
};

/* -------------------------------------------------------------------------- */
/* Routing decision                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the selector decided at a fork. `conclude` ends the run and generates the report;
 * `route` continues into `selectedStepKey`.
 */
export const ROUTING_DECISIONS = ['conclude', 'route'] as const;
export type RoutingDecisionKind = (typeof ROUTING_DECISIONS)[number];

/**
 * How the decision was reached. Persisted alongside it so an admin reading a run can tell an AI
 * judgement from a hard rule from a safety net — three very different things that would otherwise
 * look identical in the audit trail.
 */
export const ROUTING_SOURCES = ['rule', 'llm', 'fallback', 'budget'] as const;
export type RoutingSource = (typeof ROUTING_SOURCES)[number];

/** The resolved decision at a fork, whatever produced it. */
export interface RoutingDecision {
  decision: RoutingDecisionKind;
  /** The chosen step's `key`. Always null when `decision` is `conclude`. */
  selectedStepKey: string | null;
  /** 0–1. Rule and budget decisions report 1 — they are certain by construction. */
  confidence: number;
  /** Admin-facing account of why. Persisted to the run and the AppAiRun snapshot. */
  rationale: string;
  /** What the respondent is told at the fork. Empty when the experience suppresses rationale. */
  respondentMessage: string;
  source: RoutingSource;
}

/* -------------------------------------------------------------------------- */
/* Step keys                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Derive a URL/prompt-safe step key from a title ("Deep dive: pricing" → `deep-dive-pricing`).
 *
 * Keys are how the selector names its choice, so they must survive a round-trip through an LLM
 * prompt unambiguously — lowercase kebab, no punctuation. An empty result falls back to `step`,
 * which the caller de-duplicates against existing keys.
 */
export function slugifyStepKey(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, EXPERIENCE_STEP_KEY_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'step';
}
