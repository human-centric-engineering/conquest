/**
 * AttributedQuestionnaires component tests.
 *
 * The list makes the demo-client delete guard actionable in place: each row's ⋯ menu
 * detaches the questionnaire ("Make generic") or reassigns it to another active client,
 * via `PATCH /api/v1/app/questionnaires/:id { demoClientId }`. Key behaviours:
 *  - "Make generic (detach)" PATCHes demoClientId: null, then refreshes
 *  - "Reassign to" → a target PATCHes demoClientId: that client's id, then refreshes
 *  - the reassign submenu is omitted when there are no other active clients
 *  - a failed PATCH renders an inline error and does not refresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mock next/navigation ─────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mockRouterRefresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// ─── Mock API client ──────────────────────────────────────────────────────────

const { mockApiPatch, MockAPIClientError } = vi.hoisted(() => {
  class HoistedAPIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  }
  return { mockApiPatch: vi.fn(), MockAPIClientError: HoistedAPIClientError };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: mockApiPatch },
  APIClientError: MockAPIClientError,
}));

// ─── Component import ─────────────────────────────────────────────────────────

import { AttributedQuestionnaires } from '@/components/admin/demo-clients/attributed-questionnaires';

const QUESTIONNAIRES = [{ id: 'q-1', title: 'Acme Survey', status: 'draft' as const }];
const TARGETS = [{ id: 'dc-2', slug: 'globex', name: 'Globex' }];

beforeEach(() => {
  vi.clearAllMocks();
  mockApiPatch.mockResolvedValue(undefined);
});

const openRowMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /attribution actions for acme survey/i }));
};

describe('AttributedQuestionnaires', () => {
  it('detaches a questionnaire by PATCHing demoClientId: null, then refreshes', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AttributedQuestionnaires questionnaires={QUESTIONNAIRES} reassignTargets={TARGETS} />);

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /make generic \(detach\)/i }));

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith('/api/v1/app/questionnaires/q-1', {
        body: { demoClientId: null },
      })
    );
    expect(mockRouterRefresh).toHaveBeenCalledOnce();
  });

  it('reassigns to a chosen client by PATCHing that client id, then refreshes', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AttributedQuestionnaires questionnaires={QUESTIONNAIRES} reassignTargets={TARGETS} />);

    await openRowMenu(user);
    // Open the reassign submenu (click toggles it open), then pick a target.
    await user.click(screen.getByRole('menuitem', { name: /reassign to/i }));
    // Radix submenu-item onSelect is unreliable under userEvent's pointer sequence in
    // jsdom; a raw click exercises the same onSelect handler deterministically.
    const target = await screen.findByRole('menuitem', { name: 'Globex' });
    fireEvent.click(target);

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith('/api/v1/app/questionnaires/q-1', {
        body: { demoClientId: 'dc-2' },
      })
    );
    expect(mockRouterRefresh).toHaveBeenCalledOnce();
  });

  it('omits the reassign submenu when there are no other active clients', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AttributedQuestionnaires questionnaires={QUESTIONNAIRES} reassignTargets={[]} />);

    await openRowMenu(user);

    expect(screen.getByRole('menuitem', { name: /make generic \(detach\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /reassign to/i })).not.toBeInTheDocument();
  });

  it('renders an inline error and does not refresh when the PATCH fails', async () => {
    mockApiPatch.mockRejectedValueOnce(new MockAPIClientError('Attribution is locked'));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AttributedQuestionnaires questionnaires={QUESTIONNAIRES} reassignTargets={TARGETS} />);

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /make generic \(detach\)/i }));

    expect(await screen.findByText('Attribution is locked')).toBeInTheDocument();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });
});
