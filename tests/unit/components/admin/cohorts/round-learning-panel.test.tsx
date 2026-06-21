/**
 * Unit: RoundLearningPanel render — the bias warning, toggle state, threshold control, digest preview
 * (insight + respondent count + divergence band), and empty state. Router + apiClient mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class extends Error {},
}));

import { RoundLearningPanel } from '@/components/admin/cohorts/round-learning-panel';
import type { LearningDigestRow } from '@/lib/app/questionnaire/learning/digest';
import type { BriefableQuestionnaire } from '@/lib/app/questionnaire/rounds';

const BRIEFABLE: BriefableQuestionnaire[] = [
  { questionnaireId: 'q1', title: 'Survey A', versionId: 'v-1', questions: [] },
];

const row = (over: Partial<LearningDigestRow>): LearningDigestRow => ({
  versionId: 'v-1',
  slotKind: 'data_slot',
  slotKey: 'workload',
  insight: 'Several mentioned heavy workload near month-end.',
  respondentCount: 5,
  divergence: 0.8,
  refreshedAt: '2026-06-21T10:00:00.000Z',
  ...over,
});

function renderPanel(extra: Partial<React.ComponentProps<typeof RoundLearningPanel>> = {}) {
  return render(
    <RoundLearningPanel
      roundId="r-1"
      learningEnabled
      learningConfig={{ minRespondents: 3 }}
      digest={[]}
      briefable={BRIEFABLE}
      {...extra}
    />
  );
}

describe('RoundLearningPanel', () => {
  it('always shows the bias warning', () => {
    renderPanel();
    expect(screen.getByText(/introduces bias by design/i)).toBeInTheDocument();
  });

  it('shows the empty state referencing the threshold when there is no digest', () => {
    renderPanel({ digest: [], learningConfig: { minRespondents: 4 } });
    expect(screen.getByText(/at least 4 respondents have completed/i)).toBeInTheDocument();
  });

  it('renders themes with their respondent count and a high-split divergence badge', () => {
    renderPanel({ digest: [row({})] });
    expect(screen.getByText(/Several mentioned heavy workload/i)).toBeInTheDocument();
    expect(screen.getByText('High split')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('reflects the configured minimum-respondents value', () => {
    renderPanel({ learningConfig: { minRespondents: 7 } });
    expect(screen.getByLabelText(/Minimum respondents/i)).toHaveValue(7);
  });
});
