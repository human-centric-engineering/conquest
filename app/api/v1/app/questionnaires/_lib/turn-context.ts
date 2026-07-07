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
export type TurnContextBase = Omit<TurnState, 'userMessage' | 'flags'>;

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
  base: TurnContextBase;
  /** Richer slot views for the capability args (the orchestrator only needs QuestionView). */
  slots: CapabilitySlotView[];
  /** The slot `key` the previous turn asked for — extraction's active question (if any). */
  activeQuestionKey: string | null;
  /** `id → QuestionView` for response enrichment without re-querying. */
  byId: Map<string, QuestionView>;
  /** Version goal + audience — used by the conversational question phraser (not the pure core). */
  meta: TurnMeta;
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
      version: {
        select: {
          // Version framing for the conversational question phraser (F6 interviewer).
          goal: true,
          audience: true,
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
              questions: {
                orderBy: { ordinal: 'asc' },
                select: {
                  id: true,
                  key: true,
                  ordinal: true,
                  weight: true,
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
  const byId = new Map(questions.map((q) => [q.id, q]));
  const activeQuestionKey = lastTargetedId ? (byId.get(lastTargetedId)?.key ?? null) : null;
  const activeDataSlotKey = lastTargetedId ? (byDataSlotId.get(lastTargetedId)?.key ?? null) : null;

  const { saved: _saved, ...config } = toConfigView(session.version.config);
  void _saved;

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
    base: {
      sessionId: session.id,
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...config },
      questions,
      answered,
      existingAnswers,
      recentMessages,
      // Data Slots feature: present always (cheap); the route decides whether to run data-slot
      // mode (flag on + dataSlots non-empty). The pure orchestrators read these only in that mode.
      dataSlots,
      dataSlotAnswered,
      activeDataSlotKey,
      dataSlotAttempts,
      // Seriousness / abuse gate: the session's strikes so far (the core returns the updated count).
      abuseStrikes: session.abuseStrikes,
      // Sensitivity awareness: the remembered disclosure level + summaries (gentle-tone memory).
      sensitivityLevel,
      sensitivityNotes,
      // Probe-confirm flow: the parked contradiction awaiting confirmation (null when none).
      pendingContradiction,
      // "Don't nag" ledger: conflicts already surfaced this session (suppress re-raising).
      raisedContradictions,
      // Monotonic per-turn counter (the engine contract selection-context.ts calls out):
      // the TRUE number of turns already taken (not the windowed `turns` array, whose length
      // saturates at RECENT_TURNS_WINDOW), so the `random` strategy's session+round seed keeps
      // advancing and a presented-but-unanswered question isn't re-picked.
      selectionRound: session._count.turns,
    },
    slots,
    activeQuestionKey,
    byId,
    meta,
  };
}
