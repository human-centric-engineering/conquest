/**
 * Unit: CohortSubgroupsPanel render — the create form, the subgroup rows (name + description +
 * member count), and the empty state. Router + apiClient mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { CohortSubgroupsPanel } from '@/components/admin/cohorts/cohort-subgroups-panel';
import type { CohortSubgroupView } from '@/lib/app/questionnaire/rounds';

const sg = (over: Partial<CohortSubgroupView> = {}): CohortSubgroupView => ({
  id: 'sg-1',
  cohortId: 'c-1',
  name: 'Senior Leadership Team',
  description: 'The execs',
  ordinal: 0,
  memberCount: 3,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('CohortSubgroupsPanel', () => {
  it('always renders the create form (name + add button)', () => {
    render(<CohortSubgroupsPanel cohortId="c-1" subgroups={[]} />);
    expect(screen.getByPlaceholderText(/Senior Leadership Team/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add subgroup/i })).toBeInTheDocument();
  });

  it('shows the empty state when there are no subgroups', () => {
    render(<CohortSubgroupsPanel cohortId="c-1" subgroups={[]} />);
    expect(screen.getByText(/no subgroups yet/i)).toBeInTheDocument();
  });

  it('renders a subgroup row with its name, description, and member count', () => {
    render(<CohortSubgroupsPanel cohortId="c-1" subgroups={[sg()]} />);
    expect(screen.getByText('Senior Leadership Team')).toBeInTheDocument();
    expect(screen.getByText('The execs')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
