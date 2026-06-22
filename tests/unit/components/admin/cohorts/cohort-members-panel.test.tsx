/**
 * Unit: CohortMembersPanel — the subgroup column added for round phasing. The column appears only
 * when subgroups are passed (the phasing feature is on and subgroups exist), and hides otherwise.
 * Router + apiClient mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { CohortMembersPanel } from '@/components/admin/cohorts/cohort-members-panel';
import type { CohortMemberView, CohortSubgroupView } from '@/lib/app/questionnaire/rounds';

const member = (over: Partial<CohortMemberView> = {}): CohortMemberView => ({
  id: 'm-1',
  cohortId: 'c-1',
  email: 'a@x.com',
  name: 'Amy',
  notes: null,
  status: 'active',
  subgroupId: null,
  addedAt: '2026-06-01T00:00:00.000Z',
  removedAt: null,
  ...over,
});

const subgroup: CohortSubgroupView = {
  id: 'sg-1',
  cohortId: 'c-1',
  name: 'Senior Leadership Team',
  description: null,
  ordinal: 0,
  memberCount: 1,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('CohortMembersPanel subgroup column', () => {
  it('hides the Subgroup column when no subgroups are passed', () => {
    render(<CohortMembersPanel cohortId="c-1" members={[member()]} />);
    expect(screen.queryByText('Subgroup')).not.toBeInTheDocument();
  });

  it('shows the Subgroup column + per-member selector when subgroups exist', () => {
    render(<CohortMembersPanel cohortId="c-1" members={[member()]} subgroups={[subgroup]} />);
    expect(screen.getByText('Subgroup')).toBeInTheDocument();
    // The unassigned member's selector shows the "No subgroup" placeholder value.
    expect(screen.getByText('No subgroup')).toBeInTheDocument();
  });
});
