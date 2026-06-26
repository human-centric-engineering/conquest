/**
 * Unit test: version-wide report route helpers (F14.8).
 *
 * Asserts the scope resolution + opt-in gate the version cohort-report routes depend on:
 * `loadVersionReportScope` 404-guards via `loadScopedVersion`, builds a version-scope label from the
 * questionnaire title (falling back to a default), and `isVersionReportEnabledForVersion` reads the
 * per-version `config.cohortReport.enabled` toggle (defaulting off when no config exists).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const questionnaireFindUnique = vi.fn();
const configFindUnique = vi.fn();
const loadScopedVersion = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaire: { findUnique: (...a: unknown[]) => questionnaireFindUnique(...a) },
    appQuestionnaireConfig: { findUnique: (...a: unknown[]) => configFindUnique(...a) },
  },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', () => ({
  loadScopedVersion: (...a: unknown[]) => loadScopedVersion(...a),
}));

import {
  loadVersionReportScope,
  isVersionReportEnabledForVersion,
} from '@/app/api/v1/app/questionnaires/_lib/version-report';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadVersionReportScope', () => {
  it('returns null when the version does not resolve (→ route 404)', async () => {
    loadScopedVersion.mockResolvedValue(null);

    const result = await loadVersionReportScope('q1', 'v1');

    expect(result).toBeNull();
    // It must not fall through to a questionnaire lookup once the version is unknown.
    expect(questionnaireFindUnique).not.toHaveBeenCalled();
  });

  it('builds a version scope labelled by the questionnaire title', async () => {
    loadScopedVersion.mockResolvedValue({ id: 'v1', questionnaireId: 'q1' });
    questionnaireFindUnique.mockResolvedValue({ title: 'Team Pulse' });

    const result = await loadVersionReportScope('q1', 'v1');

    expect(result).not.toBeNull();
    expect(result!.entityName).toBe('Team Pulse');
    expect(result!.scope).toEqual({
      kind: 'version',
      versionId: 'v1',
      label: 'Team Pulse — all rounds + open-ended sessions',
    });
  });

  it('falls back to a default label when the questionnaire row is missing', async () => {
    loadScopedVersion.mockResolvedValue({ id: 'v1', questionnaireId: 'q1' });
    questionnaireFindUnique.mockResolvedValue(null);

    const result = await loadVersionReportScope('q1', 'v1');

    expect(result!.entityName).toBe('Questionnaire');
    expect(result!.scope.label).toBe('Questionnaire — all rounds + open-ended sessions');
  });
});

describe('isVersionReportEnabledForVersion', () => {
  it('is true when the per-version cohort-report toggle is enabled', async () => {
    configFindUnique.mockResolvedValue({ cohortReport: { enabled: true } });

    await expect(isVersionReportEnabledForVersion('v1')).resolves.toBe(true);
  });

  it('defaults to false when no config row exists', async () => {
    configFindUnique.mockResolvedValue(null);

    await expect(isVersionReportEnabledForVersion('v1')).resolves.toBe(false);
  });

  it('is false when the toggle is explicitly disabled', async () => {
    configFindUnique.mockResolvedValue({ cohortReport: { enabled: false } });

    await expect(isVersionReportEnabledForVersion('v1')).resolves.toBe(false);
  });
});
