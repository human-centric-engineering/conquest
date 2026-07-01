/**
 * Answer-slot panel — DB read seam (F7.2).
 *
 * Loads everything the respondent panel needs in ONE query: the session's status +
 * access fields, the version's section/slot structure, the captured answers, and the
 * per-turn ordinals (so an answer's `lastUpdatedTurnId` resolves to a 1-based turn
 * index for click-to-jump). Hands the plain rows to the pure
 * {@link buildAnswerPanelView} for the join + scope filter + count derivation.
 *
 * Returns the `session` access fields (`respondentUserId`) separately from the
 * projected `view`, so the route can run `resolveTurnAccess` without a second query.
 * Returns `null` when the session id doesn't resolve (the route maps that to 404).
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` panel module is Prisma-free.
 */

import { prisma } from '@/lib/db/client';
import {
  ANSWER_PROVENANCES,
  ANSWER_SLOT_PANEL_SCOPES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  QUESTION_TYPES,
  SESSION_STATUSES,
  narrowToEnum,
  type AnswerProvenance,
  type AnswerSlotPanelScope,
} from '@/lib/app/questionnaire/types';
import {
  buildAnswerPanelView,
  type PanelAnswerInput,
  type PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import { weightedCoverage } from '@/lib/app/questionnaire/selection/context';
import type {
  AnswerPanelView,
  DataSlotFillHistoryEntry,
  DataSlotPanelGroup,
  PanelRefinementEntry,
} from '@/lib/app/questionnaire/panel/types';
import { DATA_SLOT_FILLED_THRESHOLD } from '@/lib/app/questionnaire/orchestrator';

/** What the route needs: access fields + the rendered panel view. */
export interface LoadedAnswerPanel {
  session: { id: string; respondentUserId: string | null };
  view: AnswerPanelView;
}

/** Cast a stored `refinementHistory` Json column back to our entry array. */
function asRefinementHistory(value: unknown): PanelRefinementEntry[] {
  return Array.isArray(value) ? (value as PanelRefinementEntry[]) : [];
}

/** Cast a data-slot fill's stored `refinementHistory` Json column back to its entry array. */
function asDataSlotHistory(value: unknown): DataSlotFillHistoryEntry[] {
  return Array.isArray(value) ? (value as DataSlotFillHistoryEntry[]) : [];
}

/**
 * Mean of the non-null confidences, or `undefined` when none are scored — the panel header's
 * "avg confidence" figure. An honest mean over every scored fill (a low-confidence tangential fill
 * drags it down by design); `null`/unscored values are excluded, not treated as zero.
 */
function meanConfidence(values: Array<number | null>): number | undefined {
  const scored = values.filter((c): c is number => c !== null && !Number.isNaN(c));
  if (scored.length === 0) return undefined;
  return scored.reduce((sum, c) => sum + c, 0) / scored.length;
}

/** Narrow a stored `provenanceLabel` (free String column) to the provenance enum, or null. */
function asProvenance(value: string | null | undefined): AnswerProvenance | null {
  return value != null && (ANSWER_PROVENANCES as readonly string[]).includes(value)
    ? (value as AnswerProvenance)
    : null;
}

/** Narrow a stored `answerSlotPanelScope` to the enum (default when unknown/absent). */
function asPanelScope(value: string | null | undefined): AnswerSlotPanelScope {
  return value != null && (ANSWER_SLOT_PANEL_SCOPES as readonly string[]).includes(value)
    ? (value as AnswerSlotPanelScope)
    : DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope;
}

/**
 * Load a session's answer-panel state. `null` when the session doesn't exist. When
 * `dataSlotMode` is on, the view's `dataSlotGroups` carries the themed data-slot rows (the
 * respondent-facing abstraction layer) and `answeredCount`/`totalCount` track the background
 * questions; the question section rows are suppressed (the respondent never sees raw answers).
 */
export async function loadAnswerPanelState(
  sessionId: string,
  dataSlotMode = false,
  forForm = false
): Promise<LoadedAnswerPanel | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      respondentUserId: true,
      version: {
        select: {
          // `presentationMode` gates whether the breadth meter may itemise a slot's mapped
          // questions — only in `both`, where the respondent also sees the form (Data Slots feature).
          // `inlineCorrectionEnabled` (Variant B) is a second reason to itemise: the inline "fix"
          // editor needs each mapped question's editable shape to correct a data-slot reading.
          config: {
            select: {
              answerSlotPanelScope: true,
              presentationMode: true,
              inlineCorrectionEnabled: true,
            },
          },
          // Data Slots feature: the version's data slots (rendered when dataSlotMode), each with the
          // keys of the questions it abstracts over (M:N) so the seam can compute per-slot breadth.
          dataSlots: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              key: true,
              name: true,
              description: true,
              theme: true,
              questions: { select: { questionSlot: { select: { key: true } } } },
            },
          },
          sections: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              title: true,
              questions: {
                orderBy: { ordinal: 'asc' },
                select: {
                  key: true,
                  prompt: true,
                  type: true,
                  typeConfig: true,
                  required: true,
                  weight: true,
                },
              },
            },
          },
        },
      },
      answers: {
        select: {
          value: true,
          paraphrase: true,
          confidence: true,
          provenanceLabel: true,
          rationale: true,
          respondentEdited: true,
          lastUpdatedTurnId: true,
          refinementHistory: true,
          questionSlot: { select: { key: true } },
        },
      },
      // Data Slots feature: the session's fills (the respondent-facing capture). `refinementHistory`
      // carries prior values when the respondent changed their answer, surfaced as "Earlier: …".
      dataSlotFills: {
        select: {
          dataSlotId: true,
          paraphrase: true,
          provenanceLabel: true,
          confidence: true,
          rationale: true,
          provisional: true,
          lastUpdatedTurnId: true,
          refinementHistory: true,
        },
      },
      turns: { select: { id: true, ordinal: true } },
    },
  });
  if (!row) return null;

  // Map turn id → 1-based ordinal so an answer's lastUpdatedTurnId becomes a turn index.
  const turnOrdinal = new Map(row.turns.map((t) => [t.id, t.ordinal]));

  const sections: PanelSectionInput[] = row.version.sections.map((s) => ({
    sectionId: s.id,
    title: s.title,
    slots: s.questions.map((q) => ({
      slotKey: q.key,
      prompt: q.prompt,
      type: q.type,
      typeConfig: q.typeConfig,
      required: q.required,
    })),
  }));

  const answers: PanelAnswerInput[] = row.answers.map((a) => ({
    slotKey: a.questionSlot.key,
    value: a.value,
    paraphrase: a.paraphrase ?? null,
    provenance: a.provenanceLabel,
    confidence: a.confidence,
    rationale: a.rationale,
    respondentEdited: a.respondentEdited,
    answeredAtTurnIndex:
      a.lastUpdatedTurnId != null ? (turnOrdinal.get(a.lastUpdatedTurnId) ?? null) : null,
    refinementHistory: asRefinementHistory(a.refinementHistory),
  }));

  // The raw form (P-presentation) always needs the WHOLE structure: every question,
  // answered or not, so it can render and let the respondent edit. `answerSlotPanelScope`
  // is a CHAT-panel setting (it may hide pending prompts there) and must not gate the form
  // — so the form view forces `full_progress` regardless of the version's scope.
  const view = buildAnswerPanelView({
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
    scope: forForm ? 'full_progress' : asPanelScope(row.version.config?.answerSlotPanelScope),
    sections,
    answers,
  });

  // Question mode: average confidence across answered question slots (data-slot mode overrides below).
  const questionAvg = meanConfidence(answers.map((a) => a.confidence));
  if (questionAvg !== undefined) view.averageConfidence = questionAvg;

  // Data Slots feature: when in data-slot mode, replace the question rows with themed data-slot
  // groups (paraphrase + confidence). The header/progress keep tracking the BACKGROUND questions
  // — the respondent sees the abstraction layer, never the raw question answers.
  // The form surface is always question-based (P-presentation): even when data slots are on,
  // it edits the underlying questions directly, so it keeps the question sections and never
  // swaps in the data-slot groups. The chat panel still shows the data-slot abstraction.
  if (!forForm && dataSlotMode && row.version.dataSlots.length > 0) {
    // Breadth inputs, built once: which questions are answered (+ their confidence), each
    // question's prompt + version order, and whether the panel may itemise the mapped questions
    // (only in `both` mode — see `showSlotQuestions`). `orderIndex` keeps a slot's question list in
    // the questionnaire's own order rather than the M:N join's insertion order.
    const presentationMode = row.version.config?.presentationMode ?? 'both';
    const showSlotQuestions = presentationMode === 'both';
    // Inline correction (Variant B) also needs the mapped questions itemised — with their editable
    // type/config/value — so a data-slot "fix" can edit the underlying questions. The breadth-list
    // DISPLAY still gates on `showSlotQuestions`; this only governs whether `coverage.questions` is
    // populated (so plain chat-only-without-correction keeps shipping nothing).
    const inlineCorrectionEnabled = row.version.config?.inlineCorrectionEnabled ?? false;
    const itemiseQuestions = showSlotQuestions || inlineCorrectionEnabled;
    const orderedQuestions = row.version.sections.flatMap((s) => s.questions);
    const promptByKey = new Map(orderedQuestions.map((q) => [q.key, q.prompt]));
    const typeByKey = new Map(orderedQuestions.map((q) => [q.key, q.type]));
    const typeConfigByKey = new Map(orderedQuestions.map((q) => [q.key, q.typeConfig]));
    const orderIndex = new Map(orderedQuestions.map((q, i) => [q.key, i]));
    const answeredKeys = new Set(row.answers.map((a) => a.questionSlot.key));
    const confidenceByKey = new Map(row.answers.map((a) => [a.questionSlot.key, a.confidence]));
    const valueByKey = new Map(row.answers.map((a) => [a.questionSlot.key, a.value]));

    const fillByDataSlotId = new Map(
      row.dataSlotFills.map((f) => [
        f.dataSlotId,
        {
          paraphrase: f.paraphrase,
          // The stored column is a free String; narrow to the provenance enum (null when unrecognised).
          provenance: asProvenance(f.provenanceLabel),
          confidence: f.confidence,
          rationale: f.rationale,
          provisional: f.provisional,
          // 1-based turn that last touched this fill (null when the turn is somehow missing) — used
          // by the workspace to detect the fills a turn just produced and scroll to them.
          answeredAtTurnIndex:
            f.lastUpdatedTurnId != null ? (turnOrdinal.get(f.lastUpdatedTurnId) ?? null) : null,
          history: asDataSlotHistory(f.refinementHistory),
        },
      ])
    );
    const groups: DataSlotPanelGroup[] = [];
    const byTheme = new Map<string, DataSlotPanelGroup>();
    for (const ds of row.version.dataSlots) {
      const fill = fillByDataSlotId.get(ds.id);
      // A slot is covered at a confident fill OR when parked with a provisional best-effort one
      // (the respondent sees forward progress; the marker flags it as tentative).
      const provisional = fill?.provisional ?? false;
      const filled = (fill?.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD || provisional;
      // Breadth: this slot's mapped questions, in version order, with per-question completeness.
      // `questions` is itemised only in `both` mode; otherwise the meter shows the summary alone.
      const mappedKeys = ds.questions
        .map((q) => q.questionSlot.key)
        .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
      const coverage = {
        total: mappedKeys.length,
        answered: mappedKeys.filter((k) => answeredKeys.has(k)).length,
        questions: itemiseQuestions
          ? mappedKeys.map((k) => ({
              key: k,
              label: promptByKey.get(k) ?? k,
              type: narrowToEnum(typeByKey.get(k) ?? 'free_text', QUESTION_TYPES, 'free_text'),
              typeConfig: typeConfigByKey.get(k) ?? null,
              answered: answeredKeys.has(k),
              confidence: answeredKeys.has(k) ? (confidenceByKey.get(k) ?? null) : null,
              value: valueByKey.get(k) ?? null,
            }))
          : [],
      };
      let group = byTheme.get(ds.theme);
      if (!group) {
        group = { theme: ds.theme, slots: [] };
        byTheme.set(ds.theme, group);
        groups.push(group);
      }
      group.slots.push({
        key: ds.key,
        name: ds.name,
        description: ds.description,
        paraphrase: fill?.paraphrase ?? null,
        provenance: fill?.provenance ?? null,
        confidence: fill?.confidence ?? null,
        rationale: fill?.rationale ?? null,
        filled,
        provisional,
        answeredAtTurnIndex: fill?.answeredAtTurnIndex ?? null,
        // Prior states, oldest first (only present once the answer changed at least once) — the
        // evolution the row's "Edited" dialog walks through, each step with its own why + when.
        history: (fill?.history ?? []).map((h) => ({
          paraphrase: h.previousParaphrase,
          confidence: h.previousConfidence,
          rationale: h.previousRationale ?? null,
          changedAt: h.changedAt ?? null,
        })),
        coverage,
      });
    }
    view.dataSlotGroups = groups;
    view.showSlotQuestions = showSlotQuestions;
    // Average confidence in data-slot mode is the mean over the data-slot FILLS the respondent sees
    // (their abstraction layer), not the hidden question answers — so it matches the rows on screen.
    view.averageConfidence = meanConfidence(
      groups.flatMap((g) => g.slots.map((s) => s.confidence))
    );
    // Progress tracks the WEIGHTED question coverage — the same completeness figure the reasoning
    // trace's "X% covered so far" shows (`coverageRatio`) — so the two never disagree. Data slots
    // are the respondent-facing abstraction layer, not the deliverable, so they no longer move the
    // bar; progress is guided by how much of the questionnaire's questions have been answered. We
    // still never leak the raw "N of M" question count in data-slot mode — only this percentage.
    const coverageQuestions = row.version.sections.flatMap((s) =>
      s.questions.map((q) => ({ id: q.key, weight: q.weight }))
    );
    view.progressPercent = Math.round(weightedCoverage(coverageQuestions, answeredKeys) * 100);
    // Question rows are suppressed in data-slot mode; the header/progress use the coverage percent.
    view.sections = [];
  }

  return { session: { id: row.id, respondentUserId: row.respondentUserId }, view };
}
