/**
 * Run-level respondent report (F15.4b) — one report for a whole journey.
 *
 * What the `conclude` path has promised since F15.2. Until this existed, "See your summary" pointed
 * at the last leg's own report, which described one questionnaire rather than the journey the
 * respondent actually took.
 *
 * ## The design in one line
 *
 * This module assembles INPUTS; it does not fork the pipeline. `generateReportFromInputs` already
 * takes pre-assembled transcript / data-slot / coverage material, so KB grounding, the web-search
 * rounds, the report agent, the formatter, the appendix pass and the method record all apply to a
 * run report unchanged. A second generation pipeline would have doubled the surface and drifted.
 *
 * ## Whose settings, whose client
 *
 * Settings come from the ENTRY leg's version config. A run spans several versions, so something has
 * to arbitrate, and the entry leg is the only leg every run has. Anchoring on the last leg would
 * mean two respondents on the same experience receive differently-styled reports purely because the
 * selector routed them differently.
 *
 * The KB scope comes from the EXPERIENCE's `demoClientId` — a real relation, and the correct scope
 * for a journey the client owns. Falling back to a leg's questionnaire would pick an arbitrary one.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { buildAnswerPanelView } from '@/lib/app/questionnaire/panel/answer-panel';
import { loadSessionExport } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-export';
import {
  buildAnswerTranscript,
  buildDataSlotContextBlock,
  buildUnansweredQuestionsBlock,
} from '@/lib/app/questionnaire/report/content';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import type { NotAssessedTopic } from '@/lib/app/questionnaire/scope/types';
import {
  generateReportFromInputs,
  type GeneratedReport,
} from '@/lib/app/questionnaire/report/generate';

/** One leg's assembled material, in journey order. */
interface LegMaterial {
  ordinal: number;
  title: string;
  transcript: string;
  dataSlotContext: string;
  answered: number;
  total: number;
  unansweredBlock: string;
  goal: string | null;
  /** Conditional Topics (P17): what THIS leg did not cover, or covered only as a sample. */
  notAssessed: NotAssessedTopic[];
  /** Conditional Topics (P17): what THIS leg covered in full — see {@link mergeNotAssessed}. */
  assessedTopicLabels: string[];
}

/**
 * Assemble one leg's material. Returns null when the leg's export cannot be loaded — a leg whose
 * session was pruned must not sink the whole report, it just contributes nothing.
 */
async function loadLegMaterial(
  sessionId: string,
  ordinal: number,
  includeConfidence: boolean
): Promise<LegMaterial | null> {
  const loaded = await loadSessionExport(sessionId);
  if (!loaded) return null;

  const panel = buildAnswerPanelView({
    status: loaded.status,
    scope: 'full_progress',
    sections: loaded.sections,
    answers: loaded.answers,
  });

  return {
    ordinal,
    title: loaded.questionnaireTitle,
    transcript: buildAnswerTranscript(
      {
        questionnaireTitle: loaded.questionnaireTitle,
        goal: loaded.goal,
        audience: loaded.audience,
        sections: panel.sections,
      },
      { includeConfidence }
    ),
    dataSlotContext: buildDataSlotContextBlock(loaded.dataSlotGroups, { includeConfidence }),
    answered: panel.answeredCount,
    total: panel.totalCount,
    unansweredBlock: buildUnansweredQuestionsBlock(panel.sections),
    goal: loaded.goal,
    notAssessed: loaded.notAssessed ?? [],
    assessedTopicLabels: loaded.assessedTopicLabels ?? [],
  };
}

/** Match topics across legs by label, case- and whitespace-insensitively. */
function topicIdentity(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Merge the legs' Conditional Topics records into one journey-level record.
 *
 * A run spans several questionnaires, each with its own topics, so the same area can appear in more
 * than one leg with a different outcome. Two rules follow from that, and both exist to stop the
 * report contradicting its own transcript:
 *
 *  1. **A topic any leg assessed in full is dropped entirely.** The prompt's not-assessed fence says
 *     "you know nothing whatsoever about this respondent in these areas — do not write about them".
 *     Applying that to an area another leg measured properly would suppress the journey's best
 *     material. Silence about the gap is the lesser error.
 *  2. **Sampled beats skipped.** If one leg sampled an area and another skipped it, the respondent
 *     WAS asked about it and their answers are in the transcript. Presenting it as never-asked would
 *     be false; `partial` therefore wins whenever any leg contributed a sample.
 *
 * Question counts are summed — every entry counts questions that were not asked, so the sum is the
 * journey's total unasked questions for that area. Journey order is preserved (first appearance).
 * Topics are matched by LABEL, not key: keys are version-scoped, so two legs describing the same
 * area almost never share one.
 */
function mergeNotAssessed(legs: readonly LegMaterial[]): NotAssessedTopic[] {
  const assessedSomewhere = new Set(
    legs.flatMap((leg) => leg.assessedTopicLabels.map(topicIdentity))
  );

  const merged = new Map<string, NotAssessedTopic>();
  for (const leg of legs) {
    for (const topic of leg.notAssessed) {
      const identity = topicIdentity(topic.label);
      if (assessedSomewhere.has(identity)) continue; // rule 1
      const existing = merged.get(identity);
      if (!existing) {
        merged.set(identity, { ...topic });
        continue;
      }
      existing.questionCount += topic.questionCount;
      existing.partial = existing.partial || topic.partial; // rule 2
    }
  }
  return [...merged.values()];
}

/**
 * Join per-leg blocks under headed sections.
 *
 * The leg headings are load-bearing, not decoration. Without them the writer reads one flat wall of
 * Q&A and cannot tell that the respondent was asked about a topic TWICE, in two different
 * questionnaires — which is exactly the kind of progression a journey report should notice and a
 * single-questionnaire report never can.
 */
function joinLegBlocks(legs: LegMaterial[], pick: (leg: LegMaterial) => string): string {
  return legs
    .map((leg) => ({ leg, body: pick(leg).trim() }))
    .filter(({ body }) => body.length > 0)
    .map(({ leg, body }) => `## Part ${leg.ordinal + 1} — ${leg.title}\n\n${body}`)
    .join('\n\n');
}

/**
 * Generate the run-level report for a concluded experience run.
 *
 * Throws on unrecoverable problems (unknown run, no legs with loadable answers, no provider,
 * malformed model output after retry) — the worker maps a throw to a `failed` row, exactly as for
 * a session report.
 */
export async function generateRunReport(runId: string): Promise<GeneratedReport> {
  const run = await prisma.appExperienceRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      experience: { select: { title: true, demoClientId: true } },
      legs: {
        orderBy: { ordinal: 'asc' },
        select: { sessionId: true, ordinal: true },
      },
    },
  });
  if (!run) throw new Error(`Run ${runId} not found for report generation`);
  if (run.legs.length === 0) throw new Error(`Run ${runId} has no legs to report on`);

  // Settings from the ENTRY leg — see the module note.
  const entrySessionId = run.legs[0].sessionId;
  const entryMeta = await prisma.appQuestionnaireSession.findUnique({
    where: { id: entrySessionId },
    select: { version: { select: { config: { select: { respondentReport: true } } } } },
  });
  const settings = narrowRespondentReportSettings(entryMeta?.version?.config?.respondentReport);
  const includeConfidence = settings.generation.discountLowConfidence;

  // Sequential, not Promise.all: each `loadSessionExport` is a multi-table read of a whole
  // conversation, and a run has a handful of legs. Fanning them out buys little and makes the
  // worst case spikier on the connection pool while a worker holds a lease.
  const materials: LegMaterial[] = [];
  for (const leg of run.legs) {
    const material = await loadLegMaterial(leg.sessionId, leg.ordinal, includeConfidence);
    if (material) materials.push(material);
    else
      logger.warn('run report: leg export unavailable, skipping', { runId, ordinal: leg.ordinal });
  }
  if (materials.length === 0) {
    throw new Error(`Run ${runId} has no legs with loadable answers`);
  }

  const answered = materials.reduce((sum, m) => sum + m.answered, 0);
  const total = materials.reduce((sum, m) => sum + m.total, 0);
  // Coverage across the WHOLE journey. A respondent who answered one leg fully and abandoned the
  // next mid-way is at partial coverage overall, and the caveat should say so — reporting the
  // final leg's completion alone would overstate how much of the journey was actually answered.
  const completionPct = total > 0 ? Math.round((answered / total) * 100) : 100;
  const notAssessed = mergeNotAssessed(materials);

  return generateReportFromInputs({
    settings,
    // The entry leg's goal frames the journey; later legs' goals are visible in their own headed
    // transcript sections.
    goal: materials[0].goal,
    transcript: joinLegBlocks(materials, (leg) => leg.transcript),
    dataSlotContext: joinLegBlocks(materials, (leg) => leg.dataSlotContext),
    completionPct,
    coverage: {
      answered,
      total,
      unansweredBlock: joinLegBlocks(materials, (leg) => leg.unansweredBlock),
    },
    // The experience owns the client attribution — a real relation, and the right KB scope for a
    // journey. Picking one leg's questionnaire would be arbitrary.
    demoClientId: run.experience.demoClientId,
    // A sentinel in the same shape as the preview path's `preview:<vid>`. Used only for research
    // logging and KB warnings, never as a lookup key.
    sessionId: `run:${runId}`,
    // What the journey never asked about. The per-leg transcripts above are already narrowed to the
    // questions each leg actually asked, so this adds no material — it tells the writer WHY an area
    // is missing, which is what stops it reading a deliberately-skipped area as a respondent who
    // declined, or recommending they "complete" something they were told did not apply.
    ...(notAssessed.length > 0 ? { notAssessed } : {}),
  });
}
