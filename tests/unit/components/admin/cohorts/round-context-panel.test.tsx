/**
 * Unit: RoundContextPanel render — grouping, attribution labels, source badges, empty state, and the
 * contextEnabled toggle. The router + apiClient are mocked; this asserts what the panel SHOWS, not
 * interaction wiring (the API behaviour is covered by the route tests).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { RoundContextPanel } from '@/components/admin/cohorts/round-context-panel';
import type { BriefableQuestionnaire, RoundContextEntryView } from '@/lib/app/questionnaire/rounds';

const BRIEFABLE: BriefableQuestionnaire[] = [
  {
    questionnaireId: 'qn-1',
    title: 'Onboarding Survey',
    versionId: 'v-1',
    questions: [{ id: 'q1', prompt: 'How was setup?', sectionTitle: 'Setup' }],
  },
];

const entry = (over: Partial<RoundContextEntryView>): RoundContextEntryView => ({
  id: 'e1',
  roundId: 'r-1',
  versionId: 'v-1',
  questionSlotId: null,
  questionPrompt: null,
  title: 'A note',
  content: 'Some background',
  source: 'manual',
  ordinal: 0,
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
  ...over,
});

describe('RoundContextPanel', () => {
  it('shows the empty state when there are no entries', () => {
    render(
      <RoundContextPanel roundId="r-1" contextEnabled={false} entries={[]} briefable={BRIEFABLE} />
    );
    expect(screen.getByText(/No briefing notes yet/i)).toBeInTheDocument();
  });

  it('groups entries under their questionnaire title and labels attribution', () => {
    render(
      <RoundContextPanel
        roundId="r-1"
        contextEnabled
        entries={[
          entry({ id: 'e1', title: 'Revenue', source: 'manual' }),
          entry({
            id: 'e2',
            title: 'Setup steps',
            questionSlotId: 'q1',
            questionPrompt: 'How was setup?',
            source: 'ai_suggested',
          }),
        ]}
        briefable={BRIEFABLE}
      />
    );
    expect(screen.getByText('Onboarding Survey')).toBeInTheDocument();
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    // General entry shows a "General" attribution; the attributed one shows the question prompt.
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText(/How was setup\?/)).toBeInTheDocument();
    // Source badges render (manual + AI).
    expect(screen.getByText('AI')).toBeInTheDocument();
  });

  it('prompts to attach a questionnaire when none are briefable', () => {
    render(<RoundContextPanel roundId="r-1" contextEnabled entries={[]} briefable={[]} />);
    expect(screen.getByText(/Attach a questionnaire to this round first/i)).toBeInTheDocument();
  });
});
