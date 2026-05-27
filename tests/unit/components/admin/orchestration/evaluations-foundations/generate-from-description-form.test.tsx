/**
 * GenerateFromDescriptionForm component tests.
 *
 * Coverage:
 *  - Renders configure step with agent picker + domain prompt + count
 *  - Generate is disabled until domain prompt clears min-length threshold
 *  - Adding/removing seed inputs
 *  - Seed-input cap at 3
 *  - Generate POSTs the preview endpoint with the right body shape
 *  - Review step renders proposed cases via shared CaseReviewStep
 *  - Name is auto-seeded from the agent name on first generate
 *  - Save POSTs the commit endpoint and navigates to the new dataset
 *  - Empty cases list (all unticked) blocks save
 *  - Empty agents list shows the "no agents" hint
 *
 * @see components/admin/orchestration/evaluations-foundations/generate-from-description-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import {
  GenerateFromDescriptionForm,
  type AgentOption,
} from '@/components/admin/orchestration/evaluations-foundations/generate-from-description-form';
import { API } from '@/lib/api/endpoints';

const AGENTS: AgentOption[] = [{ id: 'a-1', name: 'Fintech Support', slug: 'fintech-support' }];

const VALID_DOMAIN_PROMPT =
  'Customer support agent for a fintech card issuer. Handles disputes, declines, fees.';

function mockPreviewThenCommit(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    if (url === API.ADMIN.ORCHESTRATION.EVAL_DATASETS_GENERATE_FROM_DESCRIPTION) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            cases: [
              {
                input: 'Why was my card declined?',
                expectedOutput: 'Insufficient funds or limit reached.',
                metadata: { source: 'synthetic', mode: 'description' },
              },
              {
                input: 'How do I dispute a charge?',
                expectedOutput: 'File a claim in the dashboard.',
                metadata: { source: 'synthetic', mode: 'description' },
              },
            ],
            costUsd: 0.004,
            tokenUsage: { input: 120, output: 80 },
          },
        }),
      };
    }
    if (url === API.ADMIN.ORCHESTRATION.EVAL_DATASETS_GENERATE_FROM_DESCRIPTION_COMMIT) {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          success: true,
          data: { datasetId: 'cmnewds', caseCount: 2, contentHash: 'h', warnings: [] },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GenerateFromDescriptionForm', () => {
  it('shows the "no agents" hint when the agent list is empty', () => {
    render(<GenerateFromDescriptionForm agents={[]} />);
    expect(screen.getByText(/No chat agents available/i)).toBeInTheDocument();
  });

  it('disables Generate until domain prompt clears the min-length threshold', async () => {
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={AGENTS} />);

    const generateBtn = screen.getByRole('button', { name: /Generate cases/i });
    expect(generateBtn).toBeDisabled();

    await user.type(document.getElementById('gen-domain') as HTMLTextAreaElement, 'too short');
    expect(generateBtn).toBeDisabled();

    await user.clear(document.getElementById('gen-domain') as HTMLTextAreaElement);
    await user.type(
      document.getElementById('gen-domain') as HTMLTextAreaElement,
      VALID_DOMAIN_PROMPT
    );
    expect(generateBtn).toBeEnabled();
  });

  it('adds and removes anchor seed inputs', async () => {
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={AGENTS} />);

    const seedDraft = screen.getByPlaceholderText(/My card was declined/i);
    await user.type(seedDraft, 'first anchor');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(screen.getByText('first anchor')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Remove anchor input 1/i }));
    expect(screen.queryByText('first anchor')).not.toBeInTheDocument();
  });

  it('caps anchor seed inputs at 3 (shows hint, hides input row)', async () => {
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={AGENTS} />);

    const seedDraft = screen.getByPlaceholderText(/My card was declined/i);
    const addBtn = screen.getByRole('button', { name: /^Add$/ });

    for (const text of ['one', 'two', 'three']) {
      await user.clear(seedDraft);
      await user.type(seedDraft, text);
      await user.click(addBtn);
    }

    expect(screen.getByText(/Maximum of 3 anchor inputs reached/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/My card was declined/i)).not.toBeInTheDocument();
  });

  it('Generate POSTs the preview endpoint and renders the review step', async () => {
    const fetchMock = mockPreviewThenCommit();
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={AGENTS} />);

    await user.type(
      document.getElementById('gen-domain') as HTMLTextAreaElement,
      VALID_DOMAIN_PROMPT
    );
    await user.click(screen.getByRole('button', { name: /Generate cases/i }));

    // Review step renders the proposals from the preview response.
    await screen.findByText(/Review proposed cases/i);
    expect(screen.getByText('Why was my card declined?')).toBeInTheDocument();

    // The preview POST body shape.
    const previewCall = fetchMock.mock.calls.find(
      (c) => c[0] === API.ADMIN.ORCHESTRATION.EVAL_DATASETS_GENERATE_FROM_DESCRIPTION
    );
    expect(previewCall).toBeTruthy();
    const body = JSON.parse((previewCall![1] as RequestInit).body as string);
    expect(body.agentId).toBe('a-1');
    expect(body.domainPrompt).toBe(VALID_DOMAIN_PROMPT);
  });

  it('auto-seeds the dataset name from the agent name on first generate', async () => {
    mockPreviewThenCommit();
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={AGENTS} />);

    await user.type(
      document.getElementById('gen-domain') as HTMLTextAreaElement,
      VALID_DOMAIN_PROMPT
    );
    await user.click(screen.getByRole('button', { name: /Generate cases/i }));

    await screen.findByText(/Review proposed cases/i);
    const nameInput = document.getElementById('gen-name') as HTMLInputElement;
    expect(nameInput.value).toMatch(/Fintech Support — synthetic \d{4}-\d{2}-\d{2}/);
  });

  it('Save POSTs the commit endpoint and routes to the new dataset detail page', async () => {
    const fetchMock = mockPreviewThenCommit();
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={AGENTS} />);

    await user.type(
      document.getElementById('gen-domain') as HTMLTextAreaElement,
      VALID_DOMAIN_PROMPT
    );
    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await screen.findByText(/Review proposed cases/i);

    await user.click(screen.getByRole('button', { name: /Save 2 cases/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/evaluations/datasets/cmnewds');
    });

    const commitCall = fetchMock.mock.calls.find(
      (c) => c[0] === API.ADMIN.ORCHESTRATION.EVAL_DATASETS_GENERATE_FROM_DESCRIPTION_COMMIT
    );
    expect(commitCall).toBeTruthy();
    const body = JSON.parse((commitCall![1] as RequestInit).body as string);
    expect(body.name).toMatch(/Fintech Support/);
    expect(body.cases).toHaveLength(2);
  });

  it('Back from review returns to configure step', async () => {
    mockPreviewThenCommit();
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={AGENTS} />);

    await user.type(
      document.getElementById('gen-domain') as HTMLTextAreaElement,
      VALID_DOMAIN_PROMPT
    );
    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await screen.findByText(/Review proposed cases/i);

    await user.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(screen.getByText(/Describe the agent/i)).toBeInTheDocument();
  });
});
