/**
 * VersionSettingsPanel — the Settings-tab surface composing goal/audience + run-time config under
 * one fork-on-launch mutation runner. The child editors and the mutation helper are mocked; the
 * assertions pin the panel's OWN responsibilities: it renders both editors with the derived
 * version id / question count / adaptive flag, runs edits through `authoringMutate` + `router
 * .refresh()`, and on a launched-version fork shows the notice + redirects to the new draft's
 * Settings tab.
 *
 * @see components/admin/questionnaires/version-settings-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const mutateMock = vi.hoisted(() => ({ authoringMutate: vi.fn() }));
vi.mock('@/components/admin/questionnaires/authoring-mutate', () => mutateMock);

// Child editors → markers that expose their injected `run` as a button + the props the panel derives.
vi.mock('@/components/admin/questionnaires/goal-audience-editor', () => ({
  GoalAudienceEditor: ({
    run,
    versionId,
  }: {
    run: (s: () => unknown) => void;
    versionId: string;
  }) => (
    <button
      type="button"
      data-testid="ga"
      data-vid={versionId}
      onClick={() => run(() => ['PATCH', '/ga', {}])}
    >
      ga-save
    </button>
  ),
}));
vi.mock('@/components/admin/questionnaires/config-editor', () => ({
  ConfigEditor: ({
    run,
    adaptiveEnabled,
    questionCount,
  }: {
    run: (s: () => unknown) => void;
    adaptiveEnabled: boolean;
    questionCount: number;
  }) => (
    <button
      type="button"
      data-testid="cfg"
      data-adaptive={String(adaptiveEnabled)}
      data-qcount={String(questionCount)}
      onClick={() => run(() => ['PATCH', '/cfg', {}])}
    >
      cfg-save
    </button>
  ),
}));

import { VersionSettingsPanel } from '@/components/admin/questionnaires/version-settings-panel';

function graph(over: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'launched',
    goal: null,
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [
      {
        id: 's1',
        ordinal: 0,
        title: 'A',
        description: null,
        questions: [{}, {}] as never,
      },
    ],
    tags: [],
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mutateMock.authoringMutate.mockResolvedValue({ data: {}, meta: { forked: false } });
});

describe('VersionSettingsPanel', () => {
  it('renders both editors with the derived version id, question count, and adaptive flag', () => {
    render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph({ id: 'ver-9' })}
        adaptiveEnabled
        designEvalEnabled={false}
      />
    );
    expect(screen.getByText('Goal & audience')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByTestId('ga')).toHaveAttribute('data-vid', 'ver-9');
    expect(screen.getByTestId('cfg')).toHaveAttribute('data-adaptive', 'true');
    expect(screen.getByTestId('cfg')).toHaveAttribute('data-qcount', '2');
  });

  it('explains the structure review and offers the reviewer help only when design eval is on', () => {
    const { rerender } = render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph()}
        adaptiveEnabled={false}
        designEvalEnabled={false}
      />
    );
    // Off: copy stops at tone-tuning, no structure-review mention, no help affordance.
    expect(screen.getByText(/tunes its tone to the audience\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/structure review on the Evaluations tab/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /how goal and audience are used/i })
    ).not.toBeInTheDocument();

    // On: copy names the structure review and the help popover lists the reviewers.
    rerender(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph()}
        adaptiveEnabled={false}
        designEvalEnabled
      />
    );
    expect(screen.getByText(/structure review on the Evaluations tab/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /how goal and audience are used/i }));
    expect(screen.getByText('Coverage')).toBeInTheDocument();
    expect(screen.getByText('Goal match')).toBeInTheDocument();
    expect(screen.getByText('Audience match')).toBeInTheDocument();
  });

  it('runs an edit through authoringMutate and refreshes', async () => {
    render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph()}
        adaptiveEnabled={false}
        designEvalEnabled={false}
      />
    );
    fireEvent.click(screen.getByTestId('cfg'));
    await waitFor(() =>
      expect(mutateMock.authoringMutate).toHaveBeenCalledWith('PATCH', '/cfg', {})
    );
    expect(router.refresh).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('shows the fork notice and redirects to the new draft Settings on a launched-version fork', async () => {
    mutateMock.authoringMutate.mockResolvedValue({
      data: {},
      meta: { forked: true, versionId: 'ver-2', versionNumber: 2 },
    });
    render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph()}
        adaptiveEnabled={false}
        designEvalEnabled={false}
      />
    );
    fireEvent.click(screen.getByTestId('ga'));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/admin/questionnaires/qn-1/v/ver-2/settings')
    );
    expect(screen.getByText(/new draft \(v2\)/)).toBeInTheDocument();
  });

  it('surfaces an error when the mutation fails', async () => {
    mutateMock.authoringMutate.mockRejectedValue(new Error('nope'));
    render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph()}
        adaptiveEnabled={false}
        designEvalEnabled={false}
      />
    );
    fireEvent.click(screen.getByTestId('cfg'));
    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
  });
});
