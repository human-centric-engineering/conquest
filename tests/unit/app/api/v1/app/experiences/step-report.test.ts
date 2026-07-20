/**
 * loadStepReportScope (F15.4) — resolving `(experienceId, stepId)` to a report scope.
 *
 * The load-bearing behaviours: a step from another experience must not resolve, the scope must
 * pin the version the legs ACTUALLY ran, and the three ordinary "nothing to report on" states
 * must return null rather than throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceStep: { findFirst: vi.fn() },
    appExperience: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findFirst: vi.fn() },
    appQuestionnaireConfig: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

import {
  loadStepReportScope,
  isStepReportEnabledForVersion,
} from '@/app/api/v1/app/experiences/_lib/step-report';

const EXPERIENCE_ID = 'exp_1';
const STEP_ID = 'step_1';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.prisma.appExperience.findUnique.mockResolvedValue({ title: 'Onboarding journey' });
  prismaMock.prisma.appExperienceStep.findFirst.mockResolvedValue({
    id: STEP_ID,
    title: 'Team depth',
    questionnaireId: 'q_1',
    versionId: 'ver_pinned',
  });
});

describe('loadStepReportScope', () => {
  it('scopes the lookup by BOTH experience and step id', async () => {
    await loadStepReportScope(EXPERIENCE_ID, STEP_ID);

    // A step id from another experience must 404, not silently report on someone else's journey.
    expect(prismaMock.prisma.appExperienceStep.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: STEP_ID, experienceId: EXPERIENCE_ID } })
    );
  });

  it('builds an experience_step scope pinned to the step’s version', async () => {
    const resolved = await loadStepReportScope(EXPERIENCE_ID, STEP_ID);

    expect(resolved).not.toBeNull();
    expect(resolved?.scope.kind).toBe('experience_step');
    expect(resolved?.scope.versionId).toBe('ver_pinned');
    expect(resolved?.versionId).toBe('ver_pinned');
  });

  it('labels the report with both the experience and the step', async () => {
    // A report titled only "Team depth" is ambiguous once several journeys reuse a questionnaire.
    const resolved = await loadStepReportScope(EXPERIENCE_ID, STEP_ID);
    expect(resolved?.entityName).toBe('Onboarding journey — Team depth');
  });

  it('falls back to the newest launched version when the step pins none', async () => {
    // Must match how a RUN resolves it: a report scoped to a different version than the legs ran
    // would resolve its data slots against the wrong vocabulary and analyse nothing.
    prismaMock.prisma.appExperienceStep.findFirst.mockResolvedValue({
      id: STEP_ID,
      title: 'Team depth',
      questionnaireId: 'q_1',
      versionId: null,
    });
    prismaMock.prisma.appQuestionnaireVersion.findFirst.mockResolvedValue({ id: 'ver_newest' });

    const resolved = await loadStepReportScope(EXPERIENCE_ID, STEP_ID);

    expect(resolved?.scope.versionId).toBe('ver_newest');
    expect(prismaMock.prisma.appQuestionnaireVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { questionnaireId: 'q_1', status: 'launched', archivedAt: null },
      })
    );
  });

  it('returns null when the step does not resolve', async () => {
    prismaMock.prisma.appExperienceStep.findFirst.mockResolvedValue(null);
    expect(await loadStepReportScope(EXPERIENCE_ID, STEP_ID)).toBeNull();
  });

  it('returns null when the step has no questionnaire attached', async () => {
    // A half-authored step is an ordinary state, not an error — there is simply nothing to analyse.
    prismaMock.prisma.appExperienceStep.findFirst.mockResolvedValue({
      id: STEP_ID,
      title: 'Team depth',
      questionnaireId: null,
      versionId: null,
    });
    expect(await loadStepReportScope(EXPERIENCE_ID, STEP_ID)).toBeNull();
  });

  it('returns null when the questionnaire has no launched version', async () => {
    prismaMock.prisma.appExperienceStep.findFirst.mockResolvedValue({
      id: STEP_ID,
      title: 'Team depth',
      questionnaireId: 'q_1',
      versionId: null,
    });
    prismaMock.prisma.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    expect(await loadStepReportScope(EXPERIENCE_ID, STEP_ID)).toBeNull();
  });

  it('still resolves when the experience title is missing', async () => {
    // The experience read is for display only; a dangling read must not deny the report.
    prismaMock.prisma.appExperience.findUnique.mockResolvedValue(null);
    const resolved = await loadStepReportScope(EXPERIENCE_ID, STEP_ID);
    expect(resolved?.entityName).toBe('Experience — Team depth');
  });
});

describe('isStepReportEnabledForVersion', () => {
  it('reads the step version’s own cohortReport opt-in', async () => {
    prismaMock.prisma.appQuestionnaireConfig.findUnique.mockResolvedValue({
      cohortReport: { enabled: true },
    });
    expect(await isStepReportEnabledForVersion('ver_1')).toBe(true);
  });

  it('is false when that questionnaire has reporting switched off', async () => {
    // Reaching a questionnaire through a journey is not consent to report on it.
    prismaMock.prisma.appQuestionnaireConfig.findUnique.mockResolvedValue({
      cohortReport: { enabled: false },
    });
    expect(await isStepReportEnabledForVersion('ver_1')).toBe(false);
  });

  it('is false when no config row exists', async () => {
    prismaMock.prisma.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    expect(await isStepReportEnabledForVersion('ver_1')).toBe(false);
  });
});
