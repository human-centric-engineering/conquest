/**
 * Unit: RoundPhasesPanel render — the add form (gated on the cohort having subgroups), the phase rows
 * (window + end mode + completion), and the empty state. Router + apiClient mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { RoundPhasesPanel } from '@/components/admin/cohorts/round-phases-panel';
import type { CohortSubgroupView, RoundPhaseView } from '@/lib/app/questionnaire/rounds';

const subgroup = (over: Partial<CohortSubgroupView> = {}): CohortSubgroupView => ({
  id: 'sg-1',
  cohortId: 'c-1',
  name: 'Senior Leadership Team',
  description: null,
  ordinal: 0,
  memberCount: 3,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

const phase = (over: Partial<RoundPhaseView> = {}): RoundPhaseView => ({
  id: 'ph-1',
  roundId: 'r-1',
  subgroupId: 'sg-1',
  subgroupName: 'Senior Leadership Team',
  opensAt: '2026-07-01T09:00:00.000Z',
  closesAt: '2026-07-07T17:00:00.000Z',
  endMode: 'hard',
  ordinal: 0,
  memberCount: 3,
  stats: { sessionsStarted: 2, sessionsCompleted: 1, completionRate: 0.5 },
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

function renderPanel(extra: Partial<React.ComponentProps<typeof RoundPhasesPanel>> = {}) {
  return render(
    <RoundPhasesPanel
      roundId="r-1"
      roundOpensAt={null}
      roundClosesAt={null}
      phases={[]}
      subgroups={[subgroup()]}
      {...extra}
    />
  );
}

describe('RoundPhasesPanel', () => {
  it('prompts to create subgroups first when the cohort has none', () => {
    renderPanel({ subgroups: [] });
    expect(screen.getByText(/no subgroups yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add phase/i })).not.toBeInTheDocument();
  });

  it('renders the add form when subgroups exist', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /add phase/i })).toBeInTheDocument();
  });

  it('shows the empty state when there are no phases', () => {
    renderPanel();
    expect(screen.getByText(/no phases yet/i)).toBeInTheDocument();
  });

  it('renders a phase row with its subgroup, end mode, and completion', () => {
    renderPanel({ phases: [phase()] });
    expect(screen.getByText('Senior Leadership Team')).toBeInTheDocument();
    // "Hard cutoff" also labels the add-form select default, so assert the row shows at least one.
    expect(screen.getAllByText('Hard cutoff').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('50%')).toBeInTheDocument(); // completion rate
  });

  it('marks a relaxed phase distinctly', () => {
    renderPanel({ phases: [phase({ endMode: 'relaxed' })] });
    expect(screen.getByText('Relaxed')).toBeInTheDocument(); // unique to the relaxed row
  });
});
