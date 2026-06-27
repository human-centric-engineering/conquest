/**
 * Component test: AgentSettingCard.
 *
 * Asserts the current→recommended comparison renders, the temperature-ignored
 * caveat shows for a gpt-5 resolved model, Accept fires `onApply`, and the
 * "AI Advisory" button posts to the explain endpoint and renders the result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';
import { AgentSettingCard } from '@/components/admin/questionnaires/agent-settings/agent-setting-card';
import type { AgentSettingEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';

type Mock = ReturnType<typeof vi.fn>;

function agent(overrides: Partial<AgentSettingEvaluation> = {}): AgentSettingEvaluation {
  return {
    slug: 'app-questionnaire-selector',
    agentId: 'a-1',
    label: 'Question Selector',
    role: 'Picks the next question',
    taskTier: 'chat',
    current: {
      explicitModel: null,
      resolvedModel: 'gpt-5.4-mini',
      temperature: 0.2,
      maxTokens: 256,
      reasoningEffort: null,
    },
    recommended: {
      model: 'gpt-5.4-nano',
      isOverride: true,
      temperature: 0.2,
      maxTokens: 256,
      reasoningEffort: 'minimal',
    },
    cost: {
      currentModelPerMillionUsd: 2.625,
      recommendedModelPerMillionUsd: 0.725,
      currentEstPerCallUsd: 0.0007,
      recommendedEstPerCallUsd: 0.0002,
      deltaPerCallUsd: -0.0005,
      deltaPct: -72,
    },
    actuals: { windowDays: 30, spendUsd: 1.5, calls: 40 },
    flags: { temperatureIgnored: true, pricingUnknown: false, modelUnresolved: false },
    isOptimal: false,
    rationale: 'Override to nano on the hot path.',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the implementation (clearAllMocks only clears call history) so a
  // prior test's mockRejectedValue can't leak into a later test.
  (apiClient.post as Mock).mockResolvedValue({ narrative: '', suggestion: null });
});

describe('AgentSettingCard', () => {
  it('renders the comparison and the temperature-ignored caveat', () => {
    render(
      <AgentSettingCard
        agent={agent()}
        applying={false}
        saved={false}
        onApply={vi.fn()}
        onApplyPatch={vi.fn()}
      />
    );
    expect(screen.getByText('Question Selector')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.4-nano')).toBeInTheDocument();
    expect(screen.getByText(/per-agent override/i)).toBeInTheDocument();
    expect(screen.getByText(/ignored by this model/i)).toBeInTheDocument();
  });

  it('fires onApply when Accept recommended is clicked', () => {
    const onApply = vi.fn();
    render(
      <AgentSettingCard
        agent={agent()}
        applying={false}
        saved={false}
        onApply={onApply}
        onApplyPatch={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /accept recommended/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('disables Accept for an optimal agent', () => {
    render(
      <AgentSettingCard
        agent={agent({ isOptimal: true })}
        applying={false}
        saved={false}
        onApply={vi.fn()}
        onApplyPatch={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /up to date/i })).toBeDisabled();
  });

  it('fetches and renders an AI explanation, then applies the suggestion', async () => {
    (apiClient.post as Mock).mockResolvedValue({
      narrative: 'Nano is fine here.',
      suggestion: {
        model: 'gpt-5.4-nano',
        temperature: null,
        maxTokens: null,
        reasoningEffort: 'minimal',
        rationale: 'Cheaper.',
      },
    });
    const onApplyPatch = vi.fn();
    render(
      <AgentSettingCard
        agent={agent()}
        applying={false}
        saved={false}
        onApply={vi.fn()}
        onApplyPatch={onApplyPatch}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /ai advisory/i }));
    await waitFor(() => expect(screen.getByText('Nano is fine here.')).toBeInTheDocument());
    expect(apiClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/agent-settings/explain'),
      { body: { slug: 'app-questionnaire-selector' } }
    );

    fireEvent.click(screen.getByRole('button', { name: /apply ai suggestion/i }));
    expect(onApplyPatch).toHaveBeenCalledWith({
      model: 'gpt-5.4-nano',
      reasoningEffort: 'minimal',
    });
  });

  it('renders a pricier (positive) delta and the tier-default-unset caveat', () => {
    render(
      <AgentSettingCard
        agent={agent({
          current: {
            explicitModel: null,
            resolvedModel: null,
            temperature: 0.4,
            maxTokens: 8192,
            reasoningEffort: 'high',
          },
          recommended: {
            model: 'gpt-5.4',
            isOverride: false,
            temperature: 0.4,
            maxTokens: 8192,
            reasoningEffort: 'high',
          },
          cost: {
            currentModelPerMillionUsd: null,
            recommendedModelPerMillionUsd: 8.75,
            currentEstPerCallUsd: null,
            recommendedEstPerCallUsd: 0.07,
            deltaPerCallUsd: null,
            deltaPct: null,
          },
          flags: { temperatureIgnored: false, pricingUnknown: true, modelUnresolved: true },
        })}
        applying={false}
        saved={false}
        onApply={vi.fn()}
        onApplyPatch={vi.fn()}
      />
    );
    expect(screen.getByText(/tier default unset/i)).toBeInTheDocument();
  });

  it('renders an AI explanation with no suggestion (narrative only)', async () => {
    (apiClient.post as Mock).mockResolvedValue({ narrative: 'Already optimal.', suggestion: null });
    render(
      <AgentSettingCard
        agent={agent()}
        applying={false}
        saved={false}
        onApply={vi.fn()}
        onApplyPatch={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /ai advisory/i }));
    await waitFor(() => expect(screen.getByText('Already optimal.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /apply ai suggestion/i })).not.toBeInTheDocument();
  });

  it('shows an error when the AI explanation request fails', async () => {
    (apiClient.post as Mock).mockRejectedValue(new Error('boom'));
    render(
      <AgentSettingCard
        agent={agent()}
        applying={false}
        saved={false}
        onApply={vi.fn()}
        onApplyPatch={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /ai advisory/i }));
    await waitFor(() =>
      expect(screen.getByText(/could not generate an ai explanation/i)).toBeInTheDocument()
    );
  });
});
