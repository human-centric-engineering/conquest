/**
 * Experience-wide synthesis (P15.8) — assembling what the synthesiser reads.
 *
 * ## The rule this module exists to enforce
 *
 * **Prose in, prose out.** The material is built from FINISHED per-step outputs and never from
 * sessions. Re-aggregating sessions across steps looks like the obvious implementation and is a
 * trap: `buildCohortDataset` resolves everything by a single `versionId` and `buildDataSlots` joins
 * fills by `dataSlotId` — the row id, not the key — so a fill from another version finds no bucket
 * and is dropped with no error and no warning. An experience spans versions by definition, so the
 * naive version would emit a confident, well-formatted report over a fraction of the data. Nothing
 * here may import `buildCohortDataset`, and a test asserts it.
 *
 * ## The two kinds read different things, because they produce different things
 *
 * - `agentic_switcher` → ready per-step **cohort reports** (`AppCohortReport`, latest revision).
 *   Plus the routing distribution, which is the one genuinely cross-step fact a switcher has: how
 *   the population actually divided.
 * - `facilitated_meeting` → **breakout insights** (`AppExperienceInsight`), which are the meeting's
 *   real output. Step reports usually do not exist for a meeting at all.
 *
 * ## Anonymity carries through by construction
 *
 * Meeting insights are re-gated here with {@link applySupportGate} at the experience's current
 * `insightMinSupport`, exactly as the facilitator console does on read. Anything below the floor
 * never enters the material, so the synthesiser cannot surface it, paraphrase it, or fold it into a
 * finding. The gate is applied at the point of reading rather than trusted from write time so that
 * RAISING the threshold after a meeting immediately narrows what any later synthesis can see.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { htmlToParagraphs } from '@/lib/app/questionnaire/cohort-report/pdf-model';
import { validateCohortReportContent } from '@/lib/app/questionnaire/cohort-report/content';
import { applySupportGate } from '@/lib/app/questionnaire/experiences/meeting/anonymity';
import { EXPERIENCE_INSIGHT_KINDS } from '@/lib/app/questionnaire/experiences/meeting/types';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import type {
  ExperienceSynthesisCoverage,
  SynthesisCoverageReason,
} from '@/lib/app/questionnaire/experiences/synthesis/types';

/** One step's contribution, already flattened to text. */
export interface SynthesisStepBlock {
  stepKey: string;
  stepTitle: string;
  /** `entry` | `branch` | `breakout` | `report` — the reader needs to know a branch is a branch. */
  stepKind: string;
  /** Flattened prose. Never raw HTML, never raw chat. */
  body: string;
}

/** How the population divided — the one cross-step fact a switcher owns. */
export interface RoutingDistributionEntry {
  stepKey: string;
  stepTitle: string;
  runs: number;
}

export interface SynthesisMaterial {
  experienceTitle: string;
  experienceKind: string;
  blocks: SynthesisStepBlock[];
  coverage: ExperienceSynthesisCoverage[];
  /** Switcher only. Empty for a meeting. */
  routing: RoutingDistributionEntry[];
  concludedRuns: number;
}

/** Cap on how much of one step's report is carried, so a long journey cannot blow the context. */
const MAX_BODY_CHARS_PER_STEP = 12_000;

function clip(body: string): string {
  return body.length > MAX_BODY_CHARS_PER_STEP
    ? `${body.slice(0, MAX_BODY_CHARS_PER_STEP)}\n[truncated]`
    : body;
}

/**
 * Flatten a stored cohort report into prose.
 *
 * Section bodies are persisted as HTML (the generator runs `markdownToHtml` before saving), so they
 * are stripped rather than passed through — feeding tags to the synthesiser wastes tokens and
 * invites it to emit markup of its own.
 */
function flattenCohortReport(rawContent: unknown): string {
  const content = validateCohortReportContent(rawContent);
  const parts: string[] = [];

  if (content.summary) parts.push(htmlToParagraphs(content.summary).join('\n'));
  for (const sec of content.sections) {
    const body = htmlToParagraphs(sec.body).join('\n');
    if (body.trim() !== '') parts.push(`### ${sec.heading}\n${body}`);
  }
  if (content.recommendations.length > 0) {
    parts.push(`### Recommendations\n${content.recommendations.map((r) => `• ${r}`).join('\n')}`);
  }
  return parts.join('\n\n').trim();
}

/** Steps that could in principle contribute — a step with no questionnaire never can. */
function eligibleStepKinds(experienceKind: string): readonly string[] {
  return experienceKind === 'facilitated_meeting' ? ['entry', 'breakout'] : ['entry', 'branch'];
}

/**
 * Build the material for one experience.
 *
 * Returns coverage for EVERY eligible step, included or not — a reader judging the synthesis needs
 * to see what was missing, and a step that contributed nothing is as informative as one that did.
 */
export async function buildSynthesisMaterial(experienceId: string): Promise<SynthesisMaterial> {
  const experience = await prisma.appExperience.findUnique({
    where: { id: experienceId },
    select: { id: true, title: true, kind: true, settings: true },
  });
  if (!experience) throw new Error('Experience not found');

  const steps = await prisma.appExperienceStep.findMany({
    where: { experienceId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, key: true, title: true, kind: true, questionnaireId: true },
  });

  const kinds = eligibleStepKinds(experience.kind);
  const eligible = steps.filter((s) => kinds.includes(s.kind));

  const blocks: SynthesisStepBlock[] = [];
  const coverage: ExperienceSynthesisCoverage[] = [];

  const note = (
    step: { key: string; title: string },
    included: boolean,
    reason: SynthesisCoverageReason
  ): void => {
    coverage.push({ stepKey: step.key, stepTitle: step.title, included, reason });
  };

  if (experience.kind === 'facilitated_meeting') {
    const minSupport = narrowExperienceSettings(experience.settings).insightMinSupport;

    // One query for every insight across every meeting of this experience — not one per step.
    const insights = await prisma.appExperienceInsight.findMany({
      where: { meeting: { experienceId } },
      orderBy: [{ stepId: 'asc' }, { ordinal: 'asc' }],
      select: { stepId: true, kind: true, statement: true, detail: true, supportCount: true },
    });

    const byStep = new Map<string, typeof insights>();
    for (const insight of insights) {
      const list = byStep.get(insight.stepId) ?? [];
      list.push(insight);
      byStep.set(insight.stepId, list);
    }

    for (const step of eligible) {
      // The gate, re-applied on read at the CURRENT threshold. Raising the setting after a meeting
      // must immediately narrow what a synthesis can see.
      const gated = applySupportGate(byStep.get(step.id) ?? [], minSupport);
      if (gated.length === 0) {
        note(step, false, 'no_insights');
        continue;
      }
      const body = gated
        .map((i) => {
          const kind = narrowToEnum(i.kind, EXPERIENCE_INSIGHT_KINDS, 'theme');
          const detail = i.detail ? ` — ${i.detail}` : '';
          return `• [${kind}, ${i.supportCount} people] ${i.statement}${detail}`;
        })
        .join('\n');
      blocks.push({
        stepKey: step.key,
        stepTitle: step.title,
        stepKind: step.kind,
        body: clip(body),
      });
      note(step, true, 'included');
    }

    return {
      experienceTitle: experience.title,
      experienceKind: experience.kind,
      blocks,
      coverage,
      routing: [],
      concludedRuns: 0,
    };
  }

  /* ---- agentic_switcher: ready per-step cohort reports ---- */

  const withQuestionnaire = eligible.filter((s) => s.questionnaireId !== null);
  for (const step of eligible) {
    if (step.questionnaireId === null) note(step, false, 'no_questionnaire');
  }

  const reports =
    withQuestionnaire.length === 0
      ? []
      : await prisma.appCohortReport.findMany({
          where: {
            scopeKind: 'experience_step',
            experienceStepOwnerId: { in: withQuestionnaire.map((s) => s.id) },
          },
          select: {
            experienceStepOwnerId: true,
            status: true,
            revisions: {
              orderBy: { revisionNumber: 'desc' },
              take: 1,
              select: { content: true },
            },
          },
        });

  const reportByStep = new Map(reports.map((r) => [r.experienceStepOwnerId ?? '', r]));

  for (const step of withQuestionnaire) {
    const report = reportByStep.get(step.id);
    if (!report) {
      note(step, false, 'no_report');
      continue;
    }
    if (report.status !== 'ready') {
      note(step, false, 'not_ready');
      continue;
    }
    const body = flattenCohortReport(report.revisions[0]?.content);
    if (body === '') {
      note(step, false, 'empty_report');
      continue;
    }
    blocks.push({
      stepKey: step.key,
      stepTitle: step.title,
      stepKind: step.kind,
      body: clip(body),
    });
    note(step, true, 'included');
  }

  /* ---- routing distribution: how the population actually divided ---- */

  const runs = await prisma.appExperienceRun.findMany({
    where: { experienceId, status: 'completed' },
    select: { legs: { select: { stepId: true }, orderBy: { ordinal: 'asc' } } },
  });

  const runsByStep = new Map<string, number>();
  for (const run of runs) {
    // Count each step once per run: a leg revisited would otherwise inflate its share.
    for (const stepId of new Set(run.legs.map((l) => l.stepId))) {
      runsByStep.set(stepId, (runsByStep.get(stepId) ?? 0) + 1);
    }
  }

  const routing: RoutingDistributionEntry[] = eligible
    .map((step) => ({
      stepKey: step.key,
      stepTitle: step.title,
      runs: runsByStep.get(step.id) ?? 0,
    }))
    .filter((entry) => entry.runs > 0);

  logger.info('experience synthesis: material built', {
    experienceId,
    kind: experience.kind,
    included: blocks.length,
    eligible: coverage.length,
  });

  return {
    experienceTitle: experience.title,
    experienceKind: experience.kind,
    blocks,
    coverage,
    routing,
    concludedRuns: runs.length,
  };
}
