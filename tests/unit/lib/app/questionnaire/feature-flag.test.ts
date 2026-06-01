import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  APP_QUESTIONNAIRES_FLAG,
  ensureQuestionnairesEnabled,
  isQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { isFeatureEnabled } from '@/lib/feature-flags';

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(),
}));

const mockedIsFeatureEnabled = vi.mocked(isFeatureEnabled);

describe('questionnaire feature flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isQuestionnairesEnabled', () => {
    it('delegates to isFeatureEnabled with the APP_QUESTIONNAIRES_ENABLED flag', async () => {
      mockedIsFeatureEnabled.mockResolvedValue(true);

      const result = await isQuestionnairesEnabled();

      expect(result).toBe(true);
      expect(mockedIsFeatureEnabled).toHaveBeenCalledWith(APP_QUESTIONNAIRES_FLAG);
      // Guard the exact flag name — the seed and any external toggling rely on it.
      expect(APP_QUESTIONNAIRES_FLAG).toBe('APP_QUESTIONNAIRES_ENABLED');
    });

    it('returns false when the flag is disabled', async () => {
      mockedIsFeatureEnabled.mockResolvedValue(false);

      await expect(isQuestionnairesEnabled()).resolves.toBe(false);
    });
  });

  describe('ensureQuestionnairesEnabled', () => {
    it('returns null (no gate) when the app is enabled', async () => {
      mockedIsFeatureEnabled.mockResolvedValue(true);

      await expect(ensureQuestionnairesEnabled()).resolves.toBeNull();
    });

    it('returns a 404 NOT_FOUND envelope when the app is disabled', async () => {
      mockedIsFeatureEnabled.mockResolvedValue(false);

      const res = await ensureQuestionnairesEnabled();

      expect(res).not.toBeNull();
      expect(res).toBeInstanceOf(Response);
      expect(res?.status).toBe(404);

      const body = await res?.json();
      expect(body).toEqual({
        success: false,
        error: { message: 'Not found', code: 'NOT_FOUND' },
      });
    });
  });
});
