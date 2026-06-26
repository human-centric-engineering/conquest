/**
 * Assemble the whole-questionnaire snapshot the Config Advisor reasons over.
 *
 * Reuses {@link getVersionGraph} (which already narrows config + audience) for the structural graph,
 * then adds the extras the graph view doesn't carry: questionnaire identity + demo-client brand, the
 * version's session count (so the advisor can state the lifecycle reality), the data slots, and the
 * scoring schema. Returns a discriminated union — `{ ok: true, value }` or `{ ok: false, response }`
 * carrying a ready-made 404 — mirroring `compose-pipeline.ts`.
 *
 * Keeps the snapshot BOUNDED: per-section counts + a small sample of prompts (not every prompt) and a
 * capped sample of data-slot names, so the prompt cost stays predictable on large questionnaires.
 */

import { errorResponse } from '@/lib/api/responses';
import { prisma } from '@/lib/db/client';

import type { AppQuestionnaireStatus, QuestionType } from '@/lib/app/questionnaire/types';
import type {
  AdvisorContext,
  AdvisorSectionSummary,
} from '@/lib/app/questionnaire/advisor/context';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';

type ContextResult = { ok: true; value: AdvisorContext } | { ok: false; response: Response };

/** How many sample question prompts to include per section (keeps the prompt bounded). */
const SAMPLE_PROMPTS_PER_SECTION = 3;
/** How many data-slot samples to include. */
const SAMPLE_DATA_SLOTS = 12;

export async function loadAdvisorContext(
  questionnaireId: string,
  versionId: string
): Promise<ContextResult> {
  const graph = await getVersionGraph(questionnaireId, versionId);
  if (!graph) {
    return {
      ok: false,
      response: errorResponse('Questionnaire version not found', {
        code: 'NOT_FOUND',
        status: 404,
      }),
    };
  }

  const [questionnaire, sessionCount, dataSlotCount, dataSlotSamples, scoring] = await Promise.all([
    prisma.appQuestionnaire.findUnique({
      where: { id: questionnaireId },
      select: { title: true, status: true, demoClient: { select: { name: true } } },
    }),
    prisma.appQuestionnaireSession.count({ where: { versionId } }),
    prisma.appDataSlot.count({ where: { versionId } }),
    prisma.appDataSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      take: SAMPLE_DATA_SLOTS,
      select: { name: true, theme: true },
    }),
    prisma.appScoringSchema.findUnique({
      where: { versionId },
      select: { name: true },
    }),
  ]);

  if (!questionnaire) {
    return {
      ok: false,
      response: errorResponse('Questionnaire not found', { code: 'NOT_FOUND', status: 404 }),
    };
  }

  // Structure summary — counts + a bounded sample of prompts.
  let questionCount = 0;
  let requiredCount = 0;
  const typeHistogram: Partial<Record<QuestionType, number>> = {};
  const sections: AdvisorSectionSummary[] = graph.sections.map((s) => {
    questionCount += s.questions.length;
    for (const q of s.questions) {
      if (q.required) requiredCount += 1;
      typeHistogram[q.type] = (typeHistogram[q.type] ?? 0) + 1;
    }
    return {
      title: s.title,
      questionCount: s.questions.length,
      samplePrompts: s.questions.slice(0, SAMPLE_PROMPTS_PER_SECTION).map((q) => q.prompt),
    };
  });

  return {
    ok: true,
    value: {
      questionnaire: {
        title: questionnaire.title,
        // The questionnaire's own lifecycle status (the version's status is reported separately on
        // `version.status` below) — distinct facts the advisor reasons over. The DB column is a
        // string; narrow to the enum as `getVersionGraph` does for its own status fields.
        status: questionnaire.status as AppQuestionnaireStatus,
        demoClientName: questionnaire.demoClient?.name ?? null,
      },
      version: {
        versionNumber: graph.versionNumber,
        status: graph.status,
        goal: graph.goal,
        audience: graph.audience,
        sessionCount,
      },
      structure: {
        sectionCount: graph.sections.length,
        questionCount,
        requiredCount,
        optionalCount: questionCount - requiredCount,
        typeHistogram,
        sections,
      },
      config: graph.config,
      dataSlots: {
        count: dataSlotCount,
        samples: dataSlotSamples.map((d) => ({ name: d.name, theme: d.theme })),
      },
      scoring: {
        present: scoring !== null,
        name: scoring?.name ?? null,
      },
    },
  };
}
