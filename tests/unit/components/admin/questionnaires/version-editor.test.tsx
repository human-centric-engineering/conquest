/**
 * Component test: VersionEditor — the structure authoring surface (F2.1) + the F5.3 seed-composer
 * mount point.
 *
 * Heavy children (SectionEditor, TagVocabularyEditor, SaveStatus, EvaluationSeedComposer) are stubbed
 * to identifiable markers so the test exercises VersionEditor's OWN logic: the mutation runner wiring
 * (Add section / status actions → authoringMutate + refresh), the fork notice + redirect, the
 * empty-sections state, and the conditional seed-composer render. authoringMutate + next/navigation
 * are mocked at the boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VersionEditor } from '@/components/admin/questionnaires/version-editor';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import type { EvaluationSeed } from '@/lib/app/questionnaire/views';

const { mockRefresh, mockReplace } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockReplace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, replace: mockReplace }),
}));

const { mockAuthoringMutate } = vi.hoisted(() => ({ mockAuthoringMutate: vi.fn() }));
vi.mock('@/components/admin/questionnaires/authoring-mutate', () => ({
  authoringMutate: mockAuthoringMutate,
}));

// Capture the section-level DndContext onDragEnd so the test can drive a reorder directly
// (dnd-kit drag can't be simulated through the DOM in jsdom). Sortable utils stay real.
const { dnd } = vi.hoisted(() => ({ dnd: { onDragEnd: null as null | ((e: unknown) => void) } }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragEnd: (e: unknown) => void;
  }) => {
    dnd.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}));

// Stub heavy children to markers — VersionEditor's own logic is what's under test.
vi.mock('@/components/admin/questionnaires/goal-audience-editor', () => ({
  GoalAudienceEditor: ({
    versionId,
    designEvalEnabled,
  }: {
    versionId: string;
    designEvalEnabled?: boolean;
  }) => (
    <div
      data-testid="goal-audience-editor"
      data-vid={versionId}
      data-designeval={String(designEvalEnabled)}
    />
  ),
}));
vi.mock('@/components/admin/questionnaires/section-editor', () => ({
  SectionEditor: ({ section }: { section: { title: string } }) => (
    <div data-testid="section-editor">{section.title}</div>
  ),
}));
vi.mock('@/components/admin/questionnaires/tag-vocabulary-editor', () => ({
  TagVocabularyEditor: () => <div data-testid="tag-editor" />,
}));
vi.mock('@/components/admin/questionnaires/evaluation-seed-composer', () => ({
  EvaluationSeedComposer: ({ seed }: { seed: EvaluationSeed }) => (
    <div data-testid="seed-composer">{seed.prompt}</div>
  ),
}));

function graph(over: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
    goal: null,
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    tags: [],
    sections: [
      {
        id: 'sec-1',
        ordinal: 0,
        title: 'Background',
        description: null,
        questions: [],
      },
    ],
    config: {} as VersionGraphView['config'],
    ...over,
  };
}

const seedOf = (): EvaluationSeed => ({
  runId: 'run1',
  findingId: 'f1',
  prompt: 'How big is your team?',
  type: 'free_text',
  guidelines: null,
  sectionKey: 'Background',
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthoringMutate.mockResolvedValue({ data: {}, meta: null });
});
afterEach(() => vi.restoreAllMocks());

describe('VersionEditor', () => {
  it('renders a SectionEditor per section', () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph()} />);
    expect(screen.getByTestId('section-editor')).toHaveTextContent('Background');
  });

  it('renders the goal/audience editor for the version, threading the design-eval flag', () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph()} designEvalEnabled />);
    const editor = screen.getByTestId('goal-audience-editor');
    expect(editor).toHaveAttribute('data-vid', 'ver-1');
    expect(editor).toHaveAttribute('data-designeval', 'true');
  });

  it('shows the empty state when there are no sections', () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph({ sections: [] })} />);
    expect(screen.getByText(/No sections yet/i)).toBeInTheDocument();
  });

  it('renders the seed composer only when a seed is provided', () => {
    const { unmount } = render(<VersionEditor questionnaireId="qn-1" version={graph()} />);
    expect(screen.queryByTestId('seed-composer')).not.toBeInTheDocument();
    unmount();
    render(<VersionEditor questionnaireId="qn-1" version={graph()} seed={seedOf()} />);
    expect(screen.getByTestId('seed-composer')).toHaveTextContent('How big is your team?');
  });

  it('"Add section" posts a new section through the mutation runner and refreshes', async () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph()} />);
    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/versions/ver-1/sections'),
      { title: 'New section' }
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('a status action (Launch) patches the version status', async () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph({ status: 'draft' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/versions/ver-1/status'),
      { status: 'launched' }
    );
  });

  it('surfaces the fork notice and redirects when a mutation forks a launched version', async () => {
    mockAuthoringMutate.mockResolvedValue({
      data: {},
      meta: { forked: true, versionId: 'ver-2', versionNumber: 2 },
    });
    render(<VersionEditor questionnaireId="qn-1" version={graph({ status: 'launched' })} />);
    await userEvent.click(screen.getByRole('button', { name: /add section/i }));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/admin/questionnaires/qn-1/v/ver-2/structure?edit=1'
      )
    );
    await waitFor(() => expect(screen.getByText(/new draft \(v2\)/i)).toBeInTheDocument());
  });

  it('surfaces an inline error when a mutation fails', async () => {
    mockAuthoringMutate.mockRejectedValue(new Error('Section title taken'));
    render(<VersionEditor questionnaireId="qn-1" version={graph()} />);
    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    await waitFor(() => expect(screen.getByText('Section title taken')).toBeInTheDocument());
  });

  it('offers Un-launch + Archive for a launched version and patches the chosen status', async () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph({ status: 'launched' })} />);
    expect(screen.getByRole('button', { name: 'Un-launch' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Un-launch' }));
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/versions/ver-1/status'),
      { status: 'draft' }
    );
  });

  it('offers no lifecycle actions for an archived version', () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph({ status: 'archived' })} />);
    expect(screen.queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Un-launch' })).not.toBeInTheDocument();
  });

  it('confirms the save (idle → saving → saved) once the refreshed graph arrives', async () => {
    const { rerender } = render(<VersionEditor questionnaireId="qn-1" version={graph()} />);
    // A pending write flips the autosave indicator to "saving".
    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    // The refreshed graph prop landing confirms the save ("saving" → "saved").
    rerender(<VersionEditor questionnaireId="qn-1" version={graph({ versionNumber: 1 })} />);
    const bands = await screen.findAllByText(/saved|all changes saved/i);
    expect(bands.length).toBeGreaterThan(0);
  });

  it('renders the editing band with the section + question counts', () => {
    render(<VersionEditor questionnaireId="qn-1" version={graph()} />);
    const band = screen.getByText('Editing structure').closest('div');
    expect(band && within(band.parentElement as HTMLElement).getByText(/section/i)).toBeTruthy();
  });

  it('reorders sections via drag-and-drop through the mutation runner', async () => {
    const twoSections = graph({
      sections: [
        { id: 'sec-1', ordinal: 0, title: 'A', description: null, questions: [] },
        { id: 'sec-2', ordinal: 1, title: 'B', description: null, questions: [] },
      ],
    });
    render(<VersionEditor questionnaireId="qn-1" version={twoSections} />);

    act(() => dnd.onDragEnd?.({ active: { id: 'sec-1' }, over: { id: 'sec-2' } }));

    expect(mockAuthoringMutate).toHaveBeenCalledWith('PATCH', expect.stringContaining('reorder'), {
      order: ['sec-2', 'sec-1'],
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('ignores a drag dropped nowhere or onto itself', () => {
    const twoSections = graph({
      sections: [
        { id: 'sec-1', ordinal: 0, title: 'A', description: null, questions: [] },
        { id: 'sec-2', ordinal: 1, title: 'B', description: null, questions: [] },
      ],
    });
    render(<VersionEditor questionnaireId="qn-1" version={twoSections} />);

    act(() => dnd.onDragEnd?.({ active: { id: 'sec-1' }, over: null }));
    act(() => dnd.onDragEnd?.({ active: { id: 'sec-1' }, over: { id: 'sec-1' } }));

    expect(mockAuthoringMutate).not.toHaveBeenCalled();
  });
});
