/**
 * Component test: AgentSettingsPanel.
 *
 * Asserts the panel renders the task-tier and agent cards, that applying a tier
 * recommendation PATCHes the settings with a partial `defaultModels` map, and
 * that accepting an agent PATCHes the per-agent fields — both followed by a
 * re-fetch of the evaluation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
  // Mirror the real class's public members so error-detail assertions stay honest.
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
      public details?: Record<string, unknown>
    ) {
      super(message);
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { AgentSettingsPanel } from '@/components/admin/questionnaires/agent-settings/agent-settings-panel';
import type { AgentSettingsEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';

type Mock = ReturnType<typeof vi.fn>;

function evaluation(): AgentSettingsEvaluation {
  return {
    generatedAt: '2026-06-27T00:00:00.000Z',
    taskTiers: [
      {
        tier: 'reasoning',
        label: 'Reasoning',
        currentModel: 'gpt-4o',
        recommendedModel: 'gpt-5.4',
        currentModelPerMillionUsd: 6.25,
        recommendedModelPerMillionUsd: 8.75,
        isOptimal: false,
        rationale: 'Hard one-off work.',
      },
    ],
    infraDefaults: [
      {
        tier: 'embeddings',
        currentModel: 'text-embedding-3-small',
        recommendedModel: 'text-embedding-3-small',
        isOptimal: true,
        rationale: 'fine',
      },
    ],
    agents: [
      {
        slug: 'app-questionnaire-extractor',
        agentId: 'a-ext',
        label: 'Questionnaire Extractor',
        role: 'Parses documents',
        taskTier: 'reasoning',
        current: {
          explicitModel: null,
          resolvedModel: 'gpt-4o',
          temperature: 0.2,
          maxTokens: 16384,
          reasoningEffort: null,
        },
        recommended: {
          model: 'gpt-5.4',
          isOverride: false,
          temperature: 0.2,
          maxTokens: 16384,
          reasoningEffort: 'high',
        },
        cost: {
          currentModelPerMillionUsd: 6.25,
          recommendedModelPerMillionUsd: 8.75,
          currentEstPerCallUsd: 0.1,
          recommendedEstPerCallUsd: 0.14,
          deltaPerCallUsd: 0.04,
          deltaPct: 40,
        },
        actuals: { windowDays: 30, spendUsd: null, calls: null },
        flags: { temperatureIgnored: true, pricingUnknown: false, modelUnresolved: false },
        isOptimal: false,
        rationale: 'High effort extraction.',
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (apiClient.get as Mock).mockResolvedValue(evaluation());
  (apiClient.patch as Mock).mockResolvedValue({});
  (apiClient.post as Mock).mockResolvedValue({ narrative: '', suggestion: null });
});

describe('AgentSettingsPanel', () => {
  it('renders the tier and agent cards', () => {
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    expect(screen.getByRole('heading', { name: /agent settings/i })).toBeInTheDocument();
    expect(screen.getByText('Questionnaire Extractor')).toBeInTheDocument();
    expect(screen.getByText('Reasoning agents')).toBeInTheDocument();
  });

  it('applies a tier recommendation with a partial defaultModels patch then refetches', async () => {
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    // The first "Apply" button belongs to the reasoning tier card.
    const applyButtons = screen.getAllByRole('button', { name: /^apply$/i });
    fireEvent.click(applyButtons[0]);

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.SETTINGS, {
        body: { defaultModels: { reasoning: 'gpt-5.4' } },
      })
    );
    expect(apiClient.get).toHaveBeenCalledWith(API.APP.QUESTIONNAIRES.agentSettings);
  });

  it('accepts an agent recommendation with the per-agent fields then refetches', async () => {
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    fireEvent.click(screen.getByRole('button', { name: /accept recommended/i }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.agentById('a-ext'), {
        body: { temperature: 0.2, maxTokens: 16384, reasoningEffort: 'high' },
      })
    );
    expect(apiClient.get).toHaveBeenCalled();
  });

  it('applies every non-optimal tier and agent via "Apply all" then refetches once', async () => {
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    // 1 non-optimal tier + 1 non-optimal agent = "Apply all (2)".
    fireEvent.click(screen.getByRole('button', { name: /apply all \(2\)/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(2));
    expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.SETTINGS, {
      body: { defaultModels: { reasoning: 'gpt-5.4' } },
    });
    expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.agentById('a-ext'), {
      body: { temperature: 0.2, maxTokens: 16384, reasoningEffort: 'high' },
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('refetches on Refresh', async () => {
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(API.APP.QUESTIONNAIRES.agentSettings)
    );
  });

  it('surfaces a generic error banner when an apply fails with a non-APIClientError', async () => {
    (apiClient.patch as Mock).mockRejectedValue(new Error('nope'));
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    fireEvent.click(screen.getByRole('button', { name: /accept recommended/i }));
    await waitFor(() => expect(screen.getByText(/failed to update agent/i)).toBeInTheDocument());
  });

  it('surfaces the APIClientError message verbatim when one is thrown', async () => {
    (apiClient.patch as Mock).mockRejectedValue(new APIClientError('Model not active'));
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    const applyButtons = screen.getAllByRole('button', { name: /^apply$/i });
    fireEvent.click(applyButtons[0]);
    await waitFor(() => expect(screen.getByText('Model not active')).toBeInTheDocument());
  });

  it('renders a non-optimal infra default with its recommendation pointer', () => {
    const evalWithStaleInfra = evaluation();
    evalWithStaleInfra.infraDefaults = [
      {
        tier: 'audio',
        currentModel: 'whisper-1',
        recommendedModel: 'gpt-4o-transcribe',
        isOptimal: false,
        rationale: 'better',
      },
    ];
    render(<AgentSettingsPanel initialEvaluation={evalWithStaleInfra} />);
    expect(screen.getByText(/set via Settings/i)).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-transcribe')).toBeInTheDocument();
  });

  it('applies an AI suggestion from a card via the per-agent patch then refetches', async () => {
    (apiClient.post as Mock).mockResolvedValue({
      narrative: 'Nano is fine.',
      suggestion: {
        model: 'gpt-5.4-nano',
        temperature: null,
        maxTokens: null,
        reasoningEffort: 'minimal',
        rationale: 'cheaper',
      },
    });
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);

    fireEvent.click(screen.getByRole('button', { name: /ai advisory/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /apply ai suggestion/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /apply ai suggestion/i }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.agentById('a-ext'), {
        body: { model: 'gpt-5.4-nano', reasoningEffort: 'minimal' },
      })
    );
    expect(apiClient.get).toHaveBeenCalled();
  });

  it('includes the override model in the per-agent patch when recommended.isOverride', async () => {
    const e = evaluation();
    e.agents[0].recommended = {
      ...e.agents[0].recommended,
      isOverride: true,
      model: 'gpt-5.4-nano',
    };
    render(<AgentSettingsPanel initialEvaluation={e} />);
    fireEvent.click(screen.getByRole('button', { name: /accept recommended/i }));
    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.agentById('a-ext'), {
        body: {
          temperature: 0.2,
          maxTokens: 16384,
          reasoningEffort: 'high',
          model: 'gpt-5.4-nano',
        },
      })
    );
  });

  it('surfaces an error when "Apply all" fails mid-batch', async () => {
    (apiClient.patch as Mock).mockRejectedValue(new Error('boom'));
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    fireEvent.click(screen.getByRole('button', { name: /apply all/i }));
    await waitFor(() =>
      expect(screen.getByText(/failed to apply all recommendations/i)).toBeInTheDocument()
    );
  });

  it('surfaces an error when Refresh fails', async () => {
    (apiClient.get as Mock).mockRejectedValue(new Error('boom'));
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(screen.getByText(/failed to refresh/i)).toBeInTheDocument());
  });

  it('skips already-optimal items during "Apply all"', async () => {
    const e = evaluation();
    e.taskTiers[0] = { ...e.taskTiers[0], isOptimal: true, currentModel: 'gpt-5.4' }; // optimal → skipped
    // agent stays non-optimal → only it is patched.
    render(<AgentSettingsPanel initialEvaluation={e} />);
    fireEvent.click(screen.getByRole('button', { name: /apply all \(1\)/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(apiClient.patch).toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.agentById('a-ext'),
      expect.anything()
    );
    // The optimal tier default must NOT be PATCHed.
    expect(apiClient.patch).not.toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.SETTINGS,
      expect.anything()
    );
  });

  it('skips an already-optimal agent during "Apply all"', async () => {
    const e = evaluation();
    // Inverse of the above: tier stays non-optimal (patched), agent is optimal (skipped).
    e.agents[0] = { ...e.agents[0], isOptimal: true };
    render(<AgentSettingsPanel initialEvaluation={e} />);
    fireEvent.click(screen.getByRole('button', { name: /apply all \(1\)/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    // Only the non-optimal tier default is PATCHed.
    expect(apiClient.patch).toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.SETTINGS,
      expect.anything()
    );
    // The optimal agent must NOT be PATCHed.
    expect(apiClient.patch).not.toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.agentById('a-ext'),
      expect.anything()
    );
  });

  it('surfaces an error when applying an AI suggestion fails', async () => {
    (apiClient.post as Mock).mockResolvedValue({
      narrative: 'try nano',
      suggestion: {
        model: 'gpt-5.4-nano',
        temperature: null,
        maxTokens: null,
        reasoningEffort: null,
        rationale: 'cheaper',
      },
    });
    (apiClient.patch as Mock).mockRejectedValue(new Error('patch failed'));
    render(<AgentSettingsPanel initialEvaluation={evaluation()} />);
    fireEvent.click(screen.getByRole('button', { name: /ai advisory/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /apply ai suggestion/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /apply ai suggestion/i }));
    await waitFor(() =>
      expect(screen.getByText(/failed to apply suggestion/i)).toBeInTheDocument()
    );
  });

  it('disables "Apply all" with no count when everything is already optimal', () => {
    const e = evaluation();
    e.taskTiers[0] = { ...e.taskTiers[0], isOptimal: true, currentModel: 'gpt-5.4' };
    e.agents[0] = { ...e.agents[0], isOptimal: true };
    render(<AgentSettingsPanel initialEvaluation={e} />);
    const applyAll = screen.getByRole('button', { name: /^apply all$/i });
    expect(applyAll).toBeDisabled();
    // Both cards show the Optimal badge in the all-optimal state.
    expect(screen.getAllByText('Optimal').length).toBeGreaterThanOrEqual(2);
  });

  it('shows an empty state when no evaluation loaded', () => {
    render(<AgentSettingsPanel initialEvaluation={null} />);
    expect(screen.getByText(/could not load the agent settings evaluation/i)).toBeInTheDocument();
  });
});
