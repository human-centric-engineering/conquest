/**
 * LaunchChecklist component tests.
 *
 * Anti-green-bar: asserts the readiness gate mirrors `assertLaunchable` — Launch is
 * disabled until all five criteria (goal, audience with ≥1 field, ≥1 section, ≥1 question,
 * saved config) pass, an empty audience `{}` counts as not-ready, and a ready checklist
 * PATCHes the version status to `launched` via the shared authoring mutation. Also asserts
 * the inline panel: each step renders a green check when done (a muted "todo" marker when not)
 * and a "Configure" link to the page that satisfies it (Structure editor, or the data-slots tab).
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

  it('renders the steps inline (no dialog) with a Configure link per step', () => {
    render(<LaunchChecklist {...READY} />);

    // The five base steps show without opening the dialog.
    for (const label of [
      'A goal is set',
      'An audience is described',
      'At least one section',
      'At least one question',
      'Configuration saved',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // Each step links to the page that satisfies it — the base steps all open the Structure editor.
    const goalLink = screen.getByRole('link', { name: /configure: a goal is set/i });
    expect(goalLink).toHaveAttribute('href', '/admin/questionnaires/qn-1/v/v-1/structure?edit=1');
    expect(screen.getByRole('link', { name: /configure: configuration saved/i })).toHaveAttribute(
      'href',
      '/admin/questionnaires/qn-1/v/v-1/structure?edit=1'
    );
  });

  it('marks a done step ready and an outstanding step not-ready inline', () => {
    render(<LaunchChecklist {...READY} goal="Understand onboarding" configSaved={false} />);

    // The done/not-done state is exposed via the sr-only marker next to each row.
    const goalRow = screen.getByText('A goal is set').closest('li');
    const configRow = screen.getByText('Configuration saved').closest('li');
    expect(goalRow).toHaveTextContent('(ready)');
    expect(configRow).toHaveTextContent('(not ready)');
  });

  it('shows a data-slots step linking to the data-slots tab only when required', () => {
    const { rerender } = render(<LaunchChecklist {...READY} />);
    expect(screen.queryByText('Data slots generated')).not.toBeInTheDocument();

    rerender(<LaunchChecklist {...READY} dataSlotsRequired dataSlotsReady={false} />);
    expect(screen.getByText('Data slots generated')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /configure: data slots generated/i })).toHaveAttribute(
      'href',
      '/admin/questionnaires/qn-1/v/v-1/data-slots'
    );
  });
});
