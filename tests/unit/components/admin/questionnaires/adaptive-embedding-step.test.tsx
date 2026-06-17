/**
 * AdaptiveEmbeddingStep component tests.
 *
 * Anti-green-bar: asserts the explicit embedding step reflects real coverage and wires the
 * generate action — it loads coverage from `GET …/embed-questions`, shows the missing/ready/
 * no-questions states, and a click POSTs (onlyMissing by default, `force` when re-embedding) then
 * refetches coverage and refreshes the server-rendered launch checklist.
 *
 * @see components/admin/questionnaires/adaptive-embedding-step.tsx
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
  // Declared inside the factory — the mock is hoisted above any top-level test variables.
  AuthoringError: class AuthoringError extends Error {},
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { AdaptiveEmbeddingStep } from '@/components/admin/questionnaires/adaptive-embedding-step';

interface Coverage {
  total: number;
  embedded: number;
  missing: number;
}

/** Queue coverage values the component's GET will see, oldest call first. */
function mockCoverageSequence(...values: Coverage[]) {
  const fetchMock = vi.fn();
  for (const v of values) {
    fetchMock.mockResolvedValueOnce({ json: () => Promise.resolve({ success: true, data: v }) });
  }
  // Any further calls reuse the last value.
  const last = values[values.length - 1];
  fetchMock.mockResolvedValue({ json: () => Promise.resolve({ success: true, data: last }) });
  global.fetch = fetchMock;
  return fetchMock;
}

const PROPS = { questionnaireId: 'qn-1', versionId: 'v-1', busy: false };

beforeEach(() => {
  mockRefresh.mockReset();
  mockAuthoringMutate.mockReset().mockResolvedValue({ data: {}, meta: null });
});

describe('AdaptiveEmbeddingStep', () => {
  it('shows partial coverage and a Generate button when slots are missing', async () => {
    mockCoverageSequence({ total: 5, embedded: 2, missing: 3 });
    render(<AdaptiveEmbeddingStep {...PROPS} />);

    expect(await screen.findByText(/2 of 5/i)).toBeInTheDocument();
    expect(screen.getByText(/3 still need embedding/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate embeddings/i })).toBeInTheDocument();
  });

  it('shows the ready state and a re-embed action when every slot is embedded', async () => {
    mockCoverageSequence({ total: 7, embedded: 7, missing: 0 });
    render(<AdaptiveEmbeddingStep {...PROPS} />);

    expect(await screen.findByText(/all 7 questions are embedded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-embed all questions/i })).toBeInTheDocument();
  });

  it('prompts to add questions first when the version has no slots (no generate button)', async () => {
    mockCoverageSequence({ total: 0, embedded: 0, missing: 0 });
    render(<AdaptiveEmbeddingStep {...PROPS} />);

    expect(await screen.findByText(/nothing to embed yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument();
  });

  it('generates missing embeddings, then refetches coverage and refreshes the checklist', async () => {
    // First GET → 3 missing; after the POST the component refetches → fully embedded.
    mockCoverageSequence(
      { total: 5, embedded: 2, missing: 3 },
      { total: 5, embedded: 5, missing: 0 }
    );
    render(<AdaptiveEmbeddingStep {...PROPS} />);

    await userEvent.click(await screen.findByRole('button', { name: /generate embeddings/i }));

    // Default generate embeds only the missing slots (no force flag).
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/embed-questions'),
      {}
    );
    // Coverage refetched and the server-rendered launch checklist refreshed.
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(await screen.findByText(/all 5 questions are embedded/i)).toBeInTheDocument();
  });

  it('forces a full re-embed from the ready state', async () => {
    mockCoverageSequence({ total: 4, embedded: 4, missing: 0 });
    render(<AdaptiveEmbeddingStep {...PROPS} />);

    await userEvent.click(await screen.findByRole('button', { name: /re-embed all questions/i }));

    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/embed-questions'),
      { force: true }
    );
  });
});
