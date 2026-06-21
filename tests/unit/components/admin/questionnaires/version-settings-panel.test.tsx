/**
 * VersionSettingsPanel — the Settings-tab surface wrapping the run-time config editor under one
 * fork-on-launch mutation runner. The child editor and the mutation helper are mocked; the
 * assertions pin the panel's OWN responsibilities: it renders the config editor with the derived
 * version id / question count / adaptive flag, runs edits through `authoringMutate` + `router
 * .refresh()`, and on a launched-version fork shows the notice + redirects to the new draft's
 * Settings tab. (Goal & audience moved to the Structure tab — see goal-audience-editor.test.tsx.)
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

// Config editor → a marker that exposes its injected `run` as a button + the props the panel derives.
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
  it('renders the config editor with the derived version id, question count, and adaptive flag', () => {
    render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph({ id: 'ver-9' })}
        adaptiveEnabled
        introScreenEnabled={false}
      />
    );
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByTestId('cfg')).toHaveAttribute('data-adaptive', 'true');
    expect(screen.getByTestId('cfg')).toHaveAttribute('data-qcount', '2');
  });

  it('no longer renders the goal/audience editor (moved to the Structure tab)', () => {
    render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph()}
        adaptiveEnabled={false}
        introScreenEnabled={false}
      />
    );
    expect(screen.queryByText('Goal & audience')).not.toBeInTheDocument();
  });

  it('runs an edit through authoringMutate and refreshes', async () => {
    render(
      <VersionSettingsPanel
        questionnaireId="qn-1"
        graph={graph()}
        adaptiveEnabled={false}
        introScreenEnabled={false}
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
        introScreenEnabled={false}
      />
    );
    fireEvent.click(screen.getByTestId('cfg'));
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
        introScreenEnabled={false}
      />
    );
    fireEvent.click(screen.getByTestId('cfg'));
    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
  });
});
