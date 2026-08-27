// @vitest-environment happy-dom

/**
 * Unit tests: `PlanPreviewCard` — the Conditional topics dry-run (F17.14).
 *
 * The card's job is to turn a plan into a **diagnosis**. A rendering that shows which topics were
 * chosen but not which layer chose them sends the author to edit the wrong thing — criteria when the
 * cap was at fault, or the cap when a hard rule was. So the assertions here are mostly about the
 * decision trace being legible, not about the plan being displayed at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({ apiClient: { post: vi.fn() } }));

import { PlanPreviewCard } from '@/components/admin/questionnaires/topics/plan-preview-card';
import { apiClient } from '@/lib/api/client';
import type { PlanPreviewForm, PlanPreviewResult } from '@/lib/app/questionnaire/scope/views';
import type { InterviewPlan, Topic } from '@/lib/app/questionnaire/scope/types';

type Mock = ReturnType<typeof vi.fn>;

function topic(key: string, label: string, phase: Topic['phase'] = 'conditional'): Topic {
  return {
    id: `t-${key}`,
    key,
    label,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it applies' : null,
    depth: 'full',
    members: { questionKeys: [], dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
    trigger: null,
  };
}

const FORM: PlanPreviewForm = {
  openingQuestions: [{ key: 'open_a', prompt: 'What brought you here?' }],
  fillTargets: [
    { key: 'outcome', name: 'Outcome named', watchedByVeto: true },
    { key: 'situation', name: 'Situation', watchedByVeto: false },
  ],
};

const TOPICS = [topic('growth', 'Growth'), topic('talent', 'Talent'), topic('data', 'Data')];

function plan(overrides: Partial<InterviewPlan> = {}): InterviewPlan {
  return {
    v: 1,
    topics: [{ key: 'growth', depth: 'full', source: 'llm', rationale: 'they named growth' }],
    excluded: [],
    checkTopicKey: null,
    confidence: 0.82,
    source: 'llm',
    respondentMessage: 'I want to go deeper on growth.',
    decidedAtTurn: 0,
    decidedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function result(overrides: Partial<PlanPreviewResult> = {}): PlanPreviewResult {
  return {
    plan: plan(),
    proposedKeys: ['growth'],
    skippedModelReason: null,
    costUsd: 0.0041,
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof PlanPreviewCard>> = {}) {
  return render(
    <PlanPreviewCard
      questionnaireId="qn-1"
      versionId="ver-1"
      form={FORM}
      topics={TOPICS}
      enabled
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (apiClient.post as Mock).mockResolvedValue(result());
});

describe('PlanPreviewCard — the form', () => {
  it('offers a box per opening question, labelled with what it asked', () => {
    renderCard();
    expect(screen.getByLabelText('What brought you here?')).toBeInTheDocument();
  });

  it('marks the slot a rule watches, so leaving it empty reads as deliberate', () => {
    renderCard();
    // Without this an author fills every box out of tidiness and never sees the veto fire.
    expect(screen.getByText('a rule watches this')).toBeInTheDocument();
  });

  it('explains itself rather than vanishing when no topic is conditional', () => {
    renderCard({ topics: [topic('spine', 'Spine', 'core')] });

    // It used to render nothing, which was fine when this was one of a dozen cards on a long
    // page. On the Check tab of its own it would be most of what the tab has to show, and silence
    // there reads as a page that failed to load. The copy names the one thing that would fill it.
    expect(screen.getByText(/Nothing to preview yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Mark at least one topic as conditional/i)).toBeInTheDocument();
    // Still no form: there is genuinely no decision to try.
    expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
  });

  it('says the preview still runs when conditional topics is switched off', () => {
    renderCard({ enabled: false });
    expect(screen.getByText(/Conditional topics is off/i)).toBeInTheDocument();
  });
});

describe('PlanPreviewCard — what it sends', () => {
  it('drops empty answers and empty fills rather than sending blanks', async () => {
    renderCard();

    fireEvent.change(screen.getByLabelText('What brought you here?'), {
      target: { value: '  Deals keep slipping  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const body = (apiClient.post as Mock).mock.calls[0]?.[1] as {
      body: { answers: { key: string; text: string }[]; fills: unknown[] };
    };

    expect(body.body.answers).toEqual([{ key: 'open_a', text: 'Deals keep slipping' }]);
    // An untouched fill box means "the extractor captured nothing" — a real input, and the one a
    // `not_exists` veto needs. Sending it as an empty string would defeat the rule.
    expect(body.body.fills).toEqual([]);
  });

  it('sends a fill the author set, and still omits the one they left empty', async () => {
    renderCard();

    // `situation` is filled; `outcome` — the slot a veto watches — is deliberately left alone.
    fireEvent.change(screen.getByLabelText(/Situation/), {
      target: { value: '  40 reps, direct only  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const body = (apiClient.post as Mock).mock.calls[0]?.[1] as {
      body: { fills: { key: string; paraphrase: string }[] };
    };

    // Exactly one fill goes over the wire. If the empty one were materialised the veto could never
    // be demonstrated, which is the single most valuable thing this card does.
    expect(body.body.fills).toEqual([{ key: 'situation', paraphrase: '40 reps, direct only' }]);
  });
});

describe('PlanPreviewCard — the decision trace', () => {
  it('names the layer that chose each selected topic', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    expect(await screen.findByText('Growth')).toBeInTheDocument();
    expect(screen.getAllByText('Chosen by the agent').length).toBeGreaterThan(0);
  });

  it('distinguishes a topic the agent never picked from one a limit took back', async () => {
    (apiClient.post as Mock).mockResolvedValue(
      result({
        plan: plan({
          excluded: [
            { key: 'talent', source: 'budget', rationale: 'no time for this' },
            { key: 'data', source: 'llm', rationale: 'not indicated' },
          ],
        }),
        // The agent wanted `talent`; the budget removed it. `data` it never chose.
        proposedKeys: ['growth', 'talent'],
      })
    );

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    await screen.findByText('Talent');
    // The whole reason `proposedKeys` is returned: this points the author at the limit rather than
    // at the criteria, and it must appear for `talent` only.
    expect(screen.getByText('Removed by a limit you set')).toBeInTheDocument();
    expect(screen.getByText(/a limit you set removed it/i)).toBeInTheDocument();
    expect(screen.getByText('Not chosen by the agent')).toBeInTheDocument();
  });

  it('says a limit removed it when the CAP trimmed the agent, not just the budget', async () => {
    // The case the card exists for, and the one the record gets wrong on its own: a proposal the
    // cap trims is stored as `source: 'llm'` with the rationale "nothing in the opening pointed at
    // this area" (guardrails.ts). Believing that record would send the author to rewrite criteria
    // that worked perfectly.
    (apiClient.post as Mock).mockResolvedValue(
      result({
        plan: plan({
          excluded: [
            {
              key: 'talent',
              source: 'llm',
              rationale: 'Not selected — nothing in the opening pointed at this area.',
            },
          ],
        }),
        proposedKeys: ['growth', 'talent'],
      })
    );

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    await screen.findByText('Talent');
    expect(screen.getByText('Removed by a limit you set')).toBeInTheDocument();
    // The misleading stored rationale must not be shown beside the correction.
    expect(screen.queryByText(/nothing in the opening pointed at this area/i)).toBeNull();
  });

  it('never badges an excluded topic "Chosen by the agent"', async () => {
    (apiClient.post as Mock).mockResolvedValue(
      result({
        plan: plan({
          excluded: [{ key: 'data', source: 'llm', rationale: 'not indicated' }],
        }),
        proposedKeys: ['growth'],
      })
    );

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    await screen.findByText('Data');
    // `llm` on a SEATED topic means "chosen by the agent"; on an excluded one it means the exact
    // opposite. Reusing the seated vocabulary put that label under "Not in this interview".
    const excludedRegion = screen.getByText('Data').closest('li');
    expect(excludedRegion).not.toHaveTextContent('Chosen by the agent');
    expect(excludedRegion).toHaveTextContent('Not chosen by the agent');
  });

  it('explains itself when no model call happened', async () => {
    (apiClient.post as Mock).mockResolvedValue(
      result({ skippedModelReason: 'There was nothing to decide.', proposedKeys: [] })
    );

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    expect(await screen.findByText('There was nothing to decide.')).toBeInTheDocument();
  });

  it('surfaces a failure instead of leaving the old plan on screen', async () => {
    (apiClient.post as Mock).mockRejectedValue(new Error('Rate limit exceeded'));

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /preview the decision/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Rate limit exceeded');
    expect(screen.queryByText('Growth')).not.toBeInTheDocument();
  });
});
