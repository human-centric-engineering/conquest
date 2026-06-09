/**
 * LaunchChecklist component tests.
 *
 * Anti-green-bar: asserts the readiness gate mirrors `assertLaunchable` — Launch is
 * disabled until all five criteria (goal, audience with ≥1 field, ≥1 section, ≥1 question,
 * saved config) pass, an empty audience `{}` counts as not-ready, and a ready checklist
 * PATCHes the version status to `launched` via the shared authoring mutation.
 *
 * @see components/admin/questionnaires/launch-checklist.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const mockAuthoringMutate = vi.fn();
vi.mock('@/components/admin/questionnaires/authoring-mutate', () => ({
  authoringMutate: (...args: unknown[]) => mockAuthoringMutate(...args),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { LaunchChecklist } from '@/components/admin/questionnaires/launch-checklist';
import { API } from '@/lib/api/endpoints';
import type { AudienceShape } from '@/lib/app/questionnaire/types';

const READY = {
  questionnaireId: 'qn-1',
  versionId: 'v-1',
  versionNumber: 1,
  goal: 'Understand onboarding friction',
  audience: { role: 'Operations' } as AudienceShape,
  sectionCount: 1,
  questionCount: 3,
  configSaved: true,
};

async function openDialog() {
  await userEvent.click(screen.getByRole('button', { name: /review & launch/i }));
}

describe('LaunchChecklist', () => {
  beforeEach(() => {
    mockRefresh.mockReset();
    mockAuthoringMutate.mockReset().mockResolvedValue({ data: {}, meta: null });
  });

  it('enables Launch and PATCHes status when every criterion passes', async () => {
    render(<LaunchChecklist {...READY} />);
    await openDialog();

    const launch = screen.getByRole('button', { name: /^launch$/i });
    expect(launch).toBeEnabled();

    await userEvent.click(launch);

    await waitFor(() => expect(mockAuthoringMutate).toHaveBeenCalledTimes(1));
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'PATCH',
      API.APP.QUESTIONNAIRES.versionStatus('qn-1', 'v-1'),
      { status: 'launched' }
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('disables Launch when the goal is missing', async () => {
    render(<LaunchChecklist {...READY} goal={null} />);
    await openDialog();

    expect(screen.getByRole('button', { name: /^launch$/i })).toBeDisabled();
    expect(screen.getByText(/finish the unchecked items/i)).toBeInTheDocument();
  });

  it('treats an empty audience object as not ready', async () => {
    render(<LaunchChecklist {...READY} audience={{}} />);
    await openDialog();

    expect(screen.getByRole('button', { name: /^launch$/i })).toBeDisabled();
  });

  it('disables Launch when the config has not been saved', async () => {
    render(<LaunchChecklist {...READY} configSaved={false} />);
    await openDialog();

    expect(screen.getByRole('button', { name: /^launch$/i })).toBeDisabled();
  });
});
