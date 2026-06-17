/**
 * DataSlotEmbeddingStep component tests.
 *
 * DataSlotEmbeddingStep is a thin wrapper that points the shared {@link EmbeddingCoverageStep} at the
 * data-slot embed endpoint with data-slot copy. These tests render the real wrapper (no mock of the
 * shared step) so they prove the wiring end-to-end: coverage is read from `GET …/embed-data-slots`,
 * the data-slot noun + empty copy render, and the generate action POSTs to the same endpoint.
 *
 * @see components/admin/questionnaires/data-slot-embedding-step.tsx
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
  AuthoringError: class AuthoringError extends Error {},
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { DataSlotEmbeddingStep } from '@/components/admin/questionnaires/data-slot-embedding-step';

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
  const last = values[values.length - 1];
  fetchMock.mockResolvedValue({ json: () => Promise.resolve({ success: true, data: last }) });
  global.fetch = fetchMock;
  return fetchMock;
}

const PROPS = { questionnaireId: 'qn-1', versionId: 'v-1' };

beforeEach(() => {
  mockRefresh.mockReset();
  mockAuthoringMutate.mockReset().mockResolvedValue({ data: {}, meta: null });
});

describe('DataSlotEmbeddingStep', () => {
  it('reads coverage from the data-slot embed endpoint and shows data-slot copy when slots are missing', async () => {
    const fetchMock = mockCoverageSequence({ total: 5, embedded: 2, missing: 3 });
    render(<DataSlotEmbeddingStep {...PROPS} />);

    // The data-slot noun + partial-coverage copy prove nounPlural was threaded through.
    expect(await screen.findByText(/2 of 5/i)).toBeInTheDocument();
    expect(screen.getByText(/3 still need embedding/i)).toBeInTheDocument();
    expect(screen.getByText(/data slots embedded/i)).toBeInTheDocument();
    // GET hit the data-slot endpoint, not the question-slot one.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/embed-data-slots'),
      expect.anything()
    );
  });

  it('shows the data-slot ready state and a re-embed action when every slot is embedded', async () => {
    mockCoverageSequence({ total: 7, embedded: 7, missing: 0 });
    render(<DataSlotEmbeddingStep {...PROPS} />);

    expect(await screen.findByText(/all 7 data slots are embedded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-embed all data slots/i })).toBeInTheDocument();
  });

  it('prompts to generate data slots first when the version has none (no generate button)', async () => {
    mockCoverageSequence({ total: 0, embedded: 0, missing: 0 });
    render(<DataSlotEmbeddingStep {...PROPS} />);

    // The data-slot-specific emptyNote, not the question-slot one.
    expect(await screen.findByText(/generate and save data slots first/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument();
  });

  it('generates missing embeddings via the data-slot endpoint, then refetches and refreshes the checklist', async () => {
    mockCoverageSequence(
      { total: 5, embedded: 2, missing: 3 },
      { total: 5, embedded: 5, missing: 0 }
    );
    render(<DataSlotEmbeddingStep {...PROPS} />);

    await userEvent.click(await screen.findByRole('button', { name: /generate embeddings/i }));

    // Default generate embeds only the missing slots (no force flag) against the data-slot endpoint.
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/embed-data-slots'),
      {}
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(await screen.findByText(/all 5 data slots are embedded/i)).toBeInTheDocument();
  });

  it('forces a full re-embed from the ready state', async () => {
    mockCoverageSequence({ total: 4, embedded: 4, missing: 0 });
    render(<DataSlotEmbeddingStep {...PROPS} />);

    await userEvent.click(await screen.findByRole('button', { name: /re-embed all data slots/i }));

    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/embed-data-slots'),
      { force: true }
    );
  });
});
