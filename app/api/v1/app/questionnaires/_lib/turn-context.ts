/**
 * Route-local turn-context loader for the live respondent surface (F6.1, PR4).
 *
 * The session-scoped equivalent of `buildSelectionContext`: it loads a real session's
 * version structure, config, captured answers, and recent transcript from the DB and maps
 * them into the in-memory shape the pure orchestrator reads. The orchestrator core
 * (`lib/app/questionnaire/orchestrator/**`) stays Prisma-free; this is its DB seam.
 *
 * Unlike the F4.1 preview builder (which takes an answered-set in the request body), this
 * reads `answered`/`existingAnswers` from real `AppAnswerSlot` rows and `recentMessages`
 * from prior `AppQuestionnaireTurn` rows, and surfaces the **active question** (the slot the
 * previous turn asked for) so extraction knows what's being answered. The route adds the
 * per-turn `userMessage` + resolved `flags` to finish the {@link TurnState}.
 */

import { prisma } from '@/lib/db/client';
import {
  ANSWER_PROVENANCES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  QUESTION_TYPES,
  SENSITIVITY_SEVERITIES,
  narrowToEnum,
  type QuestionType,
  type SensitivitySeverity,
} from '@/lib/app/questionnaire/types';
import type { SensitivityNote } from '@/lib/app/questionnaire/sensitivity/types';
import {
  CONTRADICTION_RESOLUTIONS,
  type ContradictionResolution,
  type PendingContradiction,
  type RaisedContradiction,
} from '@/lib/app/questionnaire/contradiction/types';
import { isRecord } from '@/lib/utils';
import { toConfigView, CONFIG_SELECT } from '@/app/api/v1/app/questionnaires/_lib/detail';
import type { AnsweredView, QuestionView } from '@/lib/app/questionnaire/selection';
import {
  buildSessionScope,
  type SessionScope,
} from '@/app/api/v1/app/questionnaires/_lib/session-scope';
import { isDataSlotInScope, isQuestionInScope } from '@/lib/app/questionnaire/scope/resolve';
import { buildSectionState, type SectionState } from '@/lib/app/questionnaire/sections/state';
import { countOpeningProbes, type OpeningProbeBudget } from '@/lib/app/questionnaire/scope/probe';
import type {
  DataSlotAnsweredView,
  DataSlotTarget,
  ExistingAnswerView,
  TurnState,
} from '@/lib/app/questionnaire/orchestrator';

/** How many prior turns of transcript to feed the capabilities (oldest → newest). */
const RECENT_TURNS_WINDOW = 12;

/**
 * Parse the persisted `pendingContradiction` JSON into a {@link PendingContradiction}, or null when
 * absent/malformed. Defensive: a bad row (manual edit / drift) degrades to "none pending" rather than
 * crashing the turn.
 */
function parsePendingContradiction(raw: unknown): PendingContradiction | null {
  if (!isRecord(raw)) return null;
  const slotKeys = raw.slotKeys;
  if (!Array.isArray(slotKeys) || !slotKeys.every((k): k is string => typeof k === 'string')) {
    return null;
  }
  if (slotKeys.length === 0) return null;
  if (typeof raw.explanation !== 'string' || typeof raw.statement !== 'string') return null;
  if (typeof raw.raisedAtTurnIndex !== 'number') return null;
  // A combined probe parks each conflict it covered under `findings` (one entry per contradiction), so
  // the resolution turn can stamp every ledger entry. Parse defensively per-entry; drop malformed ones.
  // Absent/empty (a single-conflict or pre-feature row) → the resolution falls back to `slotKeys`.
  const findings: NonNullable<PendingContradiction['findings']> = [];
  if (Array.isArray(raw.findings)) {
    for (const f of raw.findings) {
      if (!isRecord(f)) continue;
      if (
        !Array.isArray(f.slotKeys) ||
        !f.slotKeys.every((k): k is string => typeof k === 'string') ||
        f.slotKeys.length === 0
      ) {
        continue;
      }
      if (typeof f.explanation !== 'string') continue;
      findings.push({
        slotKeys: f.slotKeys,
        explanation: f.explanation,
        ...(typeof f.suggestedProbe === 'string' ? { suggestedProbe: f.suggestedProbe } : {}),
      });
    }
  }
  return {
    slotKeys,
    explanation: raw.explanation,
    statement: raw.statement,
    raisedAtTurnIndex: raw.raisedAtTurnIndex,
    ...(typeof raw.suggestedProbe === 'string' ? { suggestedProbe: raw.suggestedProbe } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  };
}

/**
 * Parse the persisted `raisedContradictions` JSON into a clean {@link RaisedContradiction}[] — the
 * "don't nag" ledger. Defensive per-entry: malformed rows (manual edit / drift) are skipped, never
 * crashing the turn; a non-array degrades to `[]` (the phase then treats nothing as already-raised).
 */
function parseRaisedContradictions(raw: unknown): RaisedContradiction[] {
  if (!Array.isArray(raw)) return [];
  const out: RaisedContradiction[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { key, slotKeys, resolution, raisedAtTurnIndex } = entry;
    if (typeof key !== 'string' || key.length === 0) continue;
    if (!Array.isArray(slotKeys) || !slotKeys.every((k): k is string => typeof k === 'string')) {
      continue;
    }
    if (!(CONTRADICTION_RESOLUTIONS as readonly string[]).includes(resolution as string)) continue;
    if (typeof raisedAtTurnIndex !== 'number') continue;
    out.push({
      key,
      slotKeys,
      resolution: resolution as ContradictionResolution,
      raisedAtTurnIndex,
    });
  }
  return out;
}

/**
 * Parse the persisted `raisedMilestones` JSON into a clean `number[]` — the completeness-milestone
 * "don't nag" ledger. Defensive: a non-array degrades to `[]`, and non-integer/out-of-range entries
 * are dropped rather than crashing the turn.
 */
function parseRaisedMilestones(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 99
  );
}

/** A slot projected into the richer shape the P4 capabilities read (incl. type config). */
export interface CapabilitySlotView {
  id: string;
  key: string;
  sectionId: string;
  prompt: string;
  type: QuestionType;
  required: boolean;
  typeConfig?: unknown;
  guidelines?: string;
  /** Free-text comment fields: the slot's current living paraphrase this session (when captured),
   *  so the extractor accumulates new mentions into it rather than starting over. */
  currentParaphrase?: string | null;
}

/** The structural half of a turn — everything but the per-turn `userMessage` + `flags`. */
export type TurnContextBase = Omit<TurnState, 'userMessage' | 'flags' | 'progressQuestions'> & {
  /**
   * F17.33. Optional on {@link TurnState} — a hand-built state (a unit test, the preview harness)
   * may leave it out and get today's behaviour — but this loader ALWAYS computes it, so every
   * consumer downstream of a real session can read it without a fallback. Narrowing it here rather
   * than making it required upstream keeps the "omitted = `questions`" contract where the pure
   * layer needs it, and removes the `?? questions` dance where it cannot arise.
   */
  progressQuestions: QuestionView[];
};

/** Audience calibration the interviewer uses to set tone + language (subset of `AudienceShape`). */
export interface TurnAudience {
  role?: string;
  expertiseLevel?: string;
  sensitivity?: string;
  locale?: string;
}

/** Version-level framing the conversational question phraser reads (goal + audience). */
export interface TurnMeta {
  goal?: string;
  audience?: TurnAudience;
}

/** What {@link buildTurnContext} resolves for one live turn. */
export interface LoadedTurnContext {
  session: {
    id: string;
    status: string;
    versionId: string;
    respondentUserId: string | null;
    /** Admin preview session marker — gates the admin-only Turn Inspector. */
    isPreview: boolean;
    /** Short support reference shown to the respondent; null for rows predating the column. */
    publicRef?: string | null;
    /** Cohorts & Rounds: the round this session runs within (null = open-ended, not gated). */
    roundId: string | null;
    /** Cohorts & Rounds: the cohort member the session belongs to (null when round-less or link-grant). */
    cohortMemberId: string | null;
    /** Selectable interviewer persona: the respondent's chosen persona key (null ⇒ default applies). */
    selectedPersonaKey: string | null;
  };
  /**
   * Respondent-facing archive marker on the running version (ISO `Date` or null). Non-null = the
   * version has been archived and must stop serving respondents; the turn route refuses with
   * `VERSION_ARCHIVED` (preview sessions are exempt — admins may still rehearse).
   */
  versionArchivedAt: Date | null;
  base: TurnContextBase;
  /** Richer slot views for the capability args (the orchestrator only needs QuestionView). */
  slots: CapabilitySlotView[];
  /** The slot `key` the previous turn asked for — extraction's active question (if any). */
  activeQuestionKey: string | null;
  /** `id → QuestionView` for response enrichment without re-querying. */
  byId: Map<string, QuestionView>;
  /** Version goal + audience — used by the conversational question phraser (not the pure core). */
  meta: TurnMeta;
  /**
   * Conditional Topics (P17): what this interview is about.
   *
   * `base.questions`, `base.dataSlots` and {@link slots} are ALREADY filtered by it — this is
   * carried so the route can decide whether the planner needs to run, and so the reasoning trace
   * can explain why a topic is or is not in play. `scope.active` is false for every version that
   * never opted in, and nothing downstream behaves differently in that case.
   */
  scope: SessionScope;
  /**
   * Sectioned interviews (P21): which section this turn is bounded to, and whether it may close.
   *
   * `base.questions`, `base.dataSlots` and {@link slots} are ALREADY bounded by it, exactly as they
   * are already filtered by {@link scope}. Carried so the route can persist the run, the prompt
   * builder can open a section, and the surfaces can draw the tab strip. `active` is false for every
   * version that never opted in, and nothing downstream behaves differently in that case.
   */
  sectionState: SectionState;
}

/** Pull the interviewer-relevant string fields out of the opaque `audience` Json. */
function toTurnAudience(audience: unknown): TurnAudience | undefined {
  if (audience === null || typeof audience !== 'object') return undefined;
  const a = audience as Record<string, unknown>;
  const out: TurnAudience = {};
  if (typeof a.role === 'string') out.role = a.role;
  if (typeof a.expertiseLevel === 'string') out.expertiseLevel = a.expertiseLevel;
  if (typeof a.sensitivity === 'string') out.sensitivity = a.sensitivity;
  if (typeof a.locale === 'string') out.locale = a.locale;
  return Object.keys(out).length > 0 ? out : undefined;
}

function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/**
 * Load the turn context for a session, or `null` if the session doesn't exist. Maps the
 * persisted version structure + answers + recent turns into the orchestrator's shapes.
 */
export async function buildTurnContext(sessionId: string): Promise<LoadedTurnContext | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      versionId: true,
      respondentUserId: true,
      publicRef: true,
      // Cohorts & Rounds: the round + member this session belongs to — read by the continue-time
      // access guard (round window + active membership). Null on every open-ended session.
      roundId: true,
      cohortMemberId: true,
      // Selectable interviewer persona: the respondent's chosen persona key, resolved against the
      // version's persona library at turn time (resolveEffectiveTone) so the chosen voice governs.
      selectedPersonaKey: true,
      // Admin preview marker — gates the admin-only Turn Inspector telemetry in the route.
      isPreview: true,
      // Seriousness / abuse gate: the prior strike count the orchestrator folds a new strike into.
      abuseStrikes: true,
      // Sensitivity awareness / safeguarding: the session's remembered disclosures, threaded into
      // the phraser so EVERY later question stays gentle (not just the disclosure turn).
      sensitivityLevel: true,
      sensitivityNotes: true,
      // Probe-confirm contradiction flow: a `probe`-mode contradiction parked on a prior turn,
      // awaiting this turn's confirmation. Null = none pending.
      pendingContradiction: true,
      // "Don't nag" ledger: contradictions already surfaced this session, so the phase never re-raises
      // the same conflict (RaisedContradiction[]). Empty list on a session that has raised none.
      raisedContradictions: true,
      // "Don't nag" ledger for completeness milestones: percent-complete thresholds already
      // banner-shown this session (number[]). Empty list on a session that has raised none.
      raisedMilestones: true,
      // F17.33: the highest progress figure this session has ever displayed, so a scope widening
      // cannot make the bar run backwards. Presentation state only — no gate reads it.
      progressFloorPct: true,
      // Conditional Topics (P17): the frozen decision about which topics this interview covers.
      // Null on every ordinary session, and before the planner has run on an adaptive one —
      // both of which resolve to "everything the always-run phases hold". See session-scope.ts.
      interviewPlan: true,
      earlySeatedTopics: true,
      // P21: the section run state, read every turn from the row already loaded.
      sectionRun: true,
      version: {
        select: {
          // Version framing for the conversational question phraser (F6 interviewer).
          goal: true,
          audience: true,
          // Respondent-facing archive gate: an archived version stops serving turns (the route
          // refuses with VERSION_ARCHIVED) even while its status is still `launched`.
          archivedAt: true,
          config: { select: CONFIG_SELECT },
          // Data Slots feature: the version's data slots (the abstraction-layer targets). The
          // `questions` mapping (AppDataSlotQuestion) rides along so the extractor can ALSO answer
          // the question(s) a filled slot captures — the schema-documented forward propagation.
          dataSlots: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              key: true,
              name: true,
              description: true,
              theme: true,
              ordinal: true,
              weight: true,
              questions: { select: { questionSlot: { select: { key: true } } } },
            },
          },
          sections: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              ordinal: true,
              // P21: the label a document-sourced interview section carries. Cheap, and the only
              // thing the section resolver needs that this select did not already have.
              title: true,
              questions: {
                orderBy: { ordinal: 'asc' },
                select: {
                  id: true,
                  key: true,
                  ordinal: true,
                  weight: true,
                  // Question fidelity (raw stored value) — read through `resolveQuestionFidelity`
                  // downstream so the version-level gate is honoured.
                  fidelity: true,
                  required: true,
                  type: true,
                  prompt: true,
                  guidelines: true,
                  // Adaptive-selector framing (`adaptive` only): why this question exists.
                  rationale: true,
                  typeConfig: true,
                  tags: { select: { tagId: true } },
                },
              },
            },
          },
        },
      },
      answers: {
        // Oldest → newest. The contradiction phase's look-back window keeps the most recent N of
        // `existingAnswers` (`applyCompareWindow`), which is only meaningful if the list has an
        // order at all — without this the rows came back in whatever order Postgres chose, so
        // "the last 3 answers" was three arbitrary ones.
        orderBy: { updatedAt: 'asc' },
        select: {
          value: true,
          confidence: true,
          provenanceLabel: true,
          rationale: true,
          // Free-text living paraphrase — surfaced on the candidate slot so the extractor builds on it.
          paraphrase: true,
          questionSlot: { select: { id: true, key: true } },
        },
      },
      // Data Slots feature: this session's data-slot fills (the respondent-facing capture). The
      // value + paraphrase are loaded so the extractor can see what's already recorded and
      // UPDATE/CORRECT it across turns (not just whether the slot is filled).
      dataSlotFills: {
        select: {
          dataSlotId: true,
          confidence: true,
          value: true,
          paraphrase: true,
          provenanceLabel: true,
          provisional: true,
        },
      },
      turns: {
        orderBy: { ordinal: 'desc' },
        take: RECENT_TURNS_WINDOW,
        select: {
          userMessage: true,
          agentResponse: true,
          targetedQuestionId: true,
          targetedDataSlotId: true,
          ordinal: true,
        },
      },
      // The TRUE turn count — `turns` above is windowed (take), so its length saturates at
      // RECENT_TURNS_WINDOW and can't seed the monotonic selection round past that.
      _count: { select: { turns: true } },
    },
  });
  if (!session) return null;

  // Free-text living paraphrase per slot id (when captured) — surfaced on the candidate slot view
  // so the extractor accumulates new mentions into it across turns.
  const paraphraseBySlotId = new Map<string, string>();
  for (const a of session.answers) {
    if (typeof a.paraphrase === 'string' && a.paraphrase.trim().length > 0) {
      paraphraseBySlotId.set(a.questionSlot.id, a.paraphrase);
    }
  }

  const questions: QuestionView[] = [];
  const slots: CapabilitySlotView[] = [];
  for (const section of session.version.sections) {
    for (const slot of section.questions) {
      questions.push({
        id: slot.id,
        key: slot.key,
        sectionId: section.id,
        sectionOrdinal: section.ordinal,
        ordinal: slot.ordinal,
        weight: slot.weight,
        fidelity: slot.fidelity,
        required: slot.required,
        type: asQuestionType(slot.type),
        tagIds: slot.tags.map((t) => t.tagId),
        prompt: slot.prompt,
        guidelines: slot.guidelines,
        rationale: slot.rationale,
      });
      slots.push({
        id: slot.id,
        key: slot.key,
        sectionId: section.id,
        prompt: slot.prompt,
        type: asQuestionType(slot.type),
        required: slot.required,
        ...(slot.typeConfig !== null ? { typeConfig: slot.typeConfig } : {}),
        ...(slot.guidelines !== null ? { guidelines: slot.guidelines } : {}),
        ...(paraphraseBySlotId.has(slot.id)
          ? { currentParaphrase: paraphraseBySlotId.get(slot.id) }
          : {}),
      });
    }
  }

  // Coverage view (questionId + confidence) and the richer value view (for refinement).
  const answered: AnsweredView[] = [];
  const existingAnswers: ExistingAnswerView[] = [];
  for (const a of session.answers) {
    answered.push({ questionId: a.questionSlot.id, confidence: a.confidence });
    existingAnswers.push({
      slotKey: a.questionSlot.key,
      value: a.value,
      provenance: narrowToEnum(a.provenanceLabel, ANSWER_PROVENANCES, 'direct'),
      ...(a.confidence !== null ? { confidence: a.confidence } : {}),
      ...(a.rationale !== null ? { rationale: a.rationale } : {}),
    });
  }

  // Recent transcript oldest → newest: the rows came newest-first, so reverse, then
  // interleave each turn's user message and agent reply.
  const recentMessages: string[] = [];
  for (const turn of [...session.turns].reverse()) {
    if (turn.userMessage.trim().length > 0) recentMessages.push(turn.userMessage);
    if (turn.agentResponse.trim().length > 0) recentMessages.push(turn.agentResponse);
  }

  // Data Slots feature: the version's data slots, theme-grouped (stable: theme first-seen order,
  // then ordinal) for topic-local targeting. `dataSlotAnswered` is the per-session fill state.
  const themeOrder = new Map<string, number>();
  for (const ds of session.version.dataSlots) {
    if (!themeOrder.has(ds.theme)) themeOrder.set(ds.theme, themeOrder.size);
  }
  const dataSlots: DataSlotTarget[] = session.version.dataSlots
    .map((ds) => ({
      id: ds.id,
      key: ds.key,
      name: ds.name,
      description: ds.description,
      theme: ds.theme,
      ordinal: ds.ordinal,
      weight: ds.weight,
      // The question keys this slot captures — drives the extractor's forward propagation.
      mappedQuestionKeys: ds.questions.map((q) => q.questionSlot.key),
    }))
    .sort((a, b) => {
      const ta = themeOrder.get(a.theme) ?? 0;
      const tb = themeOrder.get(b.theme) ?? 0;
      return ta !== tb ? ta - tb : a.ordinal - b.ordinal;
    });
  const dataSlotAnswered: DataSlotAnsweredView[] = session.dataSlotFills.map((f) => ({
    dataSlotId: f.dataSlotId,
    confidence: f.confidence,
    value: f.value,
    paraphrase: f.paraphrase,
    // Threaded so a `direct` (stated) fill stays covered across turns — never re-asked or parked on a
    // later turn just because its confidence number sits below the fill threshold (see `isCovered`).
    provenance: narrowToEnum(f.provenanceLabel, ANSWER_PROVENANCES, 'direct'),
    provisional: f.provisional,
  }));
  const byDataSlotId = new Map(dataSlots.map((s) => [s.id, s]));

  // Data Slots feature: how many times in a row the most-recently targeted data slot has been
  // asked about (the re-ask/park signal). `session.turns` is newest-first; count the leading run
  // of turns targeting the same data-slot id. Only the active slot gets a count (others are 0);
  // the orchestrator parks it once this reaches `maxDataSlotAttempts` and it's still unfilled.
  const dataSlotAttempts: Record<string, number> = {};
  const headTargetedSlotId = session.turns[0]?.targetedDataSlotId ?? null;
  if (headTargetedSlotId && byDataSlotId.has(headTargetedSlotId)) {
    let run = 0;
    for (const t of session.turns) {
      if (t.targetedDataSlotId === headTargetedSlotId) run += 1;
      else break;
    }
    dataSlotAttempts[headTargetedSlotId] = run;
  }

  // The active target is whatever the most recent turn asked for (newest-first → [0]). The
  // generic `targetedQuestionId` column holds a QUESTION id in question mode and a DATA-SLOT id
  // in data-slot mode — resolve against both maps; at most one matches.
  const lastTargetedId = session.turns[0]?.targetedQuestionId ?? null;
  // Built from the UNSCOPED set on purpose: a turn taken before the plan narrowed the interview may
  // have targeted a question now out of scope, and the extractor still needs to know what was asked
  // in order to read the answer to it. Scope governs what is asked NEXT, never what was.
  const byId = new Map(questions.map((q) => [q.id, q]));
  const activeQuestionKey = lastTargetedId ? (byId.get(lastTargetedId)?.key ?? null) : null;
  const activeDataSlotKey = lastTargetedId ? (byDataSlotId.get(lastTargetedId)?.key ?? null) : null;

  const { saved: _saved, ...config } = toConfigView(session.version.config);
  void _saved;

  // ── Conditional Topics (P17) ──────────────────────────────────────────────────────────────────
  // THE choke point. Filtering here — rather than in each consumer — is what makes scope
  // impossible to apply inconsistently: targeting, the end-of-run sweep, coverage, completion and
  // contradiction candidates all read these three lists, so narrowing them once narrows everything.
  //
  // Weights are threaded so a `light`-depth topic (the blind-spot check) contributes its most
  // important members rather than whichever happened to be authored first.
  const scope = await buildSessionScope(prisma, {
    versionId: session.versionId,
    settings: config.conditionalTopics,
    interviewPlan: session.interviewPlan,
    earlySeatedTopics: session.earlySeatedTopics,
    weightByQuestionKey: new Map(questions.map((q) => [q.key, q.weight])),
    weightByDataSlotKey: new Map(dataSlots.map((d) => [d.key, d.weight])),
  });

  const scopedQuestions = scope.scope.active
    ? questions.filter((q) => isQuestionInScope(scope.scope, q.key))
    : questions;
  const scopedSlots = scope.scope.active
    ? slots.filter((s) => isQuestionInScope(scope.scope, s.key))
    : slots;
  const scopedDataSlots = scope.scope.active
    ? dataSlots.filter((d) => isDataSlotInScope(scope.scope, d.key))
    : dataSlots;

  // ── Sectioned interviews (P21) ────────────────────────────────────────────────────────────────
  // The second choke point, and deliberately AFTER scope rather than beside it: sections decide the
  // ORDER and the BOUNDARY, scope decides what applies at all, and a section can only ever narrow
  // what scope already allowed. Feeding it the unscoped lists plus the resolved scope keeps that
  // one-way relationship explicit instead of implied by call order.
  //
  // `sectionState.active` is false for every version that never opted in AND every one resolving to
  // fewer than two sections, and while it is false nothing below changes a thing.
  const sectionState = buildSectionState({
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...config },
    settings: config.sections,
    topics: scope.topics,
    conditionalTopicsEnabled: scope.settings.enabled,
    dataSlots,
    documentSections: session.version.sections.map((sec) => ({
      id: sec.id,
      title: sec.title,
      ordinal: sec.ordinal,
    })),
    questions,
    answered,
    ...(scope.scope.active
      ? {
          scope: {
            questionKeys: scope.scope.questionKeys,
            dataSlotKeys: scope.scope.dataSlotKeys,
          },
        }
      : {}),
    storedRun: session.sectionRun,
    sessionId: session.id,
  });

  // The section boundary. Deliberately carried ALONGSIDE the scoped lists rather than replacing
  // them, and that distinction is the whole of invariant 2: **sections decide what is asked next,
  // never what counts as done.**
  //
  // `questions` / `dataSlots` stay scope-level, so the submit gate, the weighted coverage, the
  // progress bar and the milestone ledger all keep measuring the WHOLE interview. Narrowing them
  // here would have made a session offer to submit the moment its first section was covered, and
  // shown 100% while six sections were still to come.
  //
  // The two lists below are for TARGETING only: which data slot to pursue, which question to sweep,
  // when a must-ask fires. Absent (undefined, not empty) when the interview is not sectioned, so
  // every consumer's `?? questions` fallback restores the pre-P21 behaviour exactly.
  //
  // Also NOT bounded: `answered`, `existingAnswers` and `recentMessages`. What the respondent
  // already said does not stop being true because they moved to another section, and the extractor
  // needs the whole picture to read a correction against.
  const inSection = sectionState.activeSection;
  const sectionQuestionKeys = inSection ? new Set(inSection.questionKeys) : null;
  const sectionDataSlotKeys = inSection ? new Set(inSection.dataSlotKeys) : null;
  const sectionedQuestions = sectionQuestionKeys
    ? scopedQuestions.filter((q) => sectionQuestionKeys.has(q.key))
    : scopedQuestions;
  const sectionedDataSlots = sectionDataSlotKeys
    ? scopedDataSlots.filter((d) => sectionDataSlotKeys.has(d.key))
    : scopedDataSlots;
  // P21: what the active section is called, and what follows it. Read only to compose the
  // section-covered reply. `ordinal` is a contiguous index over the resolved list, so the next
  // section is simply the next entry.
  const sectionMeta = inSection
    ? {
        key: inSection.key,
        label: inSection.label,
        nextLabel: sectionState.sections[inSection.ordinal + 1]?.label ?? null,
      }
    : null;

  // F17.33: the denominator for the PROGRESS FIGURE — deliberately NOT the same list as the gate's.
  //
  // `plan === null` on an enabled version is the pre-planner state: the always-run phases are in
  // scope and the conditional ones are not, and the planner will seat some of them the moment the
  // opening completes. Measuring progress against that narrow set states a total that is about to
  // GROW, so the respondent watches the bar fall in the same beat as the interviewer announcing
  // what it will now cover. Measuring against every question that could still be asked states a
  // total that can only shrink: the plan narrowing the interview moves the bar UP.
  //
  // Once the plan exists the two lists are the same thing, because the interview IS the scope.
  const progressQuestions = scope.scope.active && scope.plan === null ? questions : scopedQuestions;

  // ── The opening's follow-up allowance (G03) ───────────────────────────────────────────────
  // Resolved only while it can actually bite: the version opted in, the plan is not yet decided
  // (afterwards there is no opening left to ration), and an opening topic names data slots that
  // exist. Everyone else — every version that never opted in, and every turn after the decision —
  // pays a set intersection and no query at all.
  let openingProbe: OpeningProbeBudget | undefined;
  if (scope.settings.enabled && scope.settings.limitOpeningProbes && scope.plan === null) {
    const openingSlotKeys = new Set(
      scope.topics.filter((t) => t.phase === 'opening').flatMap((t) => t.members.dataSlotKeys)
    );
    // Against the UNSCOPED data slots: an opening topic's members are in scope by definition, but
    // resolving ids from the scoped list would silently drop any that were not, and a budget that
    // governs fewer slots than the author named is a budget that quietly over-probes.
    const openingSlotIds = new Set(
      dataSlots.filter((d) => openingSlotKeys.has(d.key)).map((d) => d.id)
    );
    if (openingSlotIds.size > 0) {
      // The FULL turn history for these slots, not the windowed `session.turns` above: an allowance
      // read off a window would silently refill itself on a long opening.
      const openingTurns = await prisma.appQuestionnaireTurn.findMany({
        where: { sessionId: session.id, targetedDataSlotId: { in: [...openingSlotIds] } },
        select: { targetedDataSlotId: true },
      });
      openingProbe = {
        slotIds: [...openingSlotIds],
        spent: countOpeningProbes(
          openingTurns.map((t) => t.targetedDataSlotId),
          openingSlotIds
        ),
        allowance: scope.settings.maxOpeningProbes,
      };
    }
  }

  // Sensitivity awareness / safeguarding: the session's remembered disclosures. The running-max
  // level switches the phraser to a gentle tone; the note summaries remind it what to be careful
  // about. Carries summaries only — the rest of each note stays on the row for analytics/events.
  const sensitivityLevel: SensitivitySeverity | null =
    session.sensitivityLevel &&
    (SENSITIVITY_SEVERITIES as readonly string[]).includes(session.sensitivityLevel)
      ? (session.sensitivityLevel as SensitivitySeverity)
      : null;
  const sensitivityNotes: string[] = Array.isArray(session.sensitivityNotes)
    ? (session.sensitivityNotes as unknown as SensitivityNote[])
        .map((n) => n?.summary)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];

  // Probe-confirm flow: parse the parked contradiction defensively (it's persisted JSON). A malformed
  // row (manual edit, schema drift) reads as "none pending" rather than crashing the turn.
  const pendingContradiction = parsePendingContradiction(session.pendingContradiction);
  // "Don't nag" ledger: contradictions already surfaced this session, so the phase never re-raises one.
  const raisedContradictions = parseRaisedContradictions(session.raisedContradictions);
  // "Don't nag" ledger for completeness milestones: thresholds already banner-shown this session.
  const raisedMilestones = parseRaisedMilestones(session.raisedMilestones);

  const audience = toTurnAudience(session.version.audience);
  const meta: TurnMeta = {
    ...(typeof session.version.goal === 'string' ? { goal: session.version.goal } : {}),
    ...(audience ? { audience } : {}),
  };

  return {
    session: {
      id: session.id,
      status: session.status,
      versionId: session.versionId,
      respondentUserId: session.respondentUserId,
      isPreview: session.isPreview,
      publicRef: session.publicRef,
      roundId: session.roundId,
      cohortMemberId: session.cohortMemberId,
      selectedPersonaKey: session.selectedPersonaKey,
    },
    versionArchivedAt: session.version.archivedAt,
    base: {
      sessionId: session.id,
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...config },
      questions: scopedQuestions,
      answered,
      existingAnswers,
      recentMessages,
      // Data Slots feature: present always (cheap); the route decides whether to run data-slot
      // mode (flag on + dataSlots non-empty). The pure orchestrators read these only in that mode.
      dataSlots: scopedDataSlots,
      dataSlotAnswered,
      activeDataSlotKey,
      dataSlotAttempts,
      // Conditional Topics (G03): the opening's shared follow-up allowance, when one governs this turn.
      ...(openingProbe ? { openingProbe } : {}),
      // Seriousness / abuse gate: the session's strikes so far (the core returns the updated count).
      abuseStrikes: session.abuseStrikes,
      // Sensitivity awareness: the remembered disclosure level + summaries (gentle-tone memory).
      sensitivityLevel,
      sensitivityNotes,
      // Probe-confirm flow: the parked contradiction awaiting confirmation (null when none).
      pendingContradiction,
      // "Don't nag" ledger: conflicts already surfaced this session (suppress re-raising).
      raisedContradictions,
      // "Don't nag" ledger for completeness milestones: thresholds already banner-shown this session.
      raisedMilestones,
      // F17.33: the progress denominator + the floor that stops the bar reversing. Both are read
      // by the display path only; every gate above uses `questions` / `scopedQuestions`.
      progressQuestions,
      progressFloorPct: session.progressFloorPct,
      // P21: the targeting pools. Undefined when unsectioned — see the note above the filter.
      ...(inSection ? { sectionQuestions: sectionedQuestions } : {}),
      ...(inSection ? { sectionDataSlots: sectionedDataSlots } : {}),
      ...(sectionMeta ? { sectionMeta } : {}),
      // Monotonic per-turn counter (the engine contract selection-context.ts calls out):
      // the TRUE number of turns already taken (not the windowed `turns` array, whose length
      // saturates at RECENT_TURNS_WINDOW), so the `random` strategy's session+round seed keeps
      // advancing and a presented-but-unanswered question isn't re-picked.
      selectionRound: session._count.turns,
    },
    slots: scopedSlots,
    activeQuestionKey,
    byId,
    meta,
    scope,
    sectionState,
  };
}
