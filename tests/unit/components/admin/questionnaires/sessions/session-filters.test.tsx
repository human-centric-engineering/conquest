/**
 * SessionFilters component tests.
 *
 * The alpha Sessions filter bar drives every control through the URL (`router.replace`, no scroll),
 * resetting to page 1 on a change — this is what makes the list state shareable, back-safe, and
 * position-preserving. Verifies the ref-search debounce, the status select, the cohort→round scoping,
 * and Clear all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';

import { SessionFilters } from '@/components/admin/questionnaires/sessions/session-filters';
import type { AdminSessionFilterOptions } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';

const OPTIONS: AdminSessionFilterOptions = {
  clients: [{ id: 'dc-1', name: 'Acme' }],
  questionnaires: [{ id: 'q-1', title: 'Onboarding' }],
  cohorts: [
    { id: 'c-1', name: 'Leadership', clientName: 'Acme' },
    { id: 'c-2', name: 'Interns', clientName: 'Acme' },
  ],
  rounds: [
    { id: 'r-1', name: 'Q3 Leadership', cohortId: 'c-1' },
    { id: 'r-2', name: 'Q3 Interns', cohortId: 'c-2' },
  ],
  hasOpenEnded: true,
  hasUnassignedClient: true,
};

function withRouter(searchParams = '') {
  const replace = vi.fn();
  vi.mocked(useRouter).mockReturnValue({
    replace,
    push: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(searchParams) as never);
  return replace;
}

beforeEach(() => {
  withRouter();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SessionFilters', () => {
  it('debounces the ref search into the URL and drops the page', async () => {
    const user = userEvent.setup();
    const replace = withRouter('page=3');
    render(<SessionFilters options={OPTIONS} />);

    await user.type(screen.getByLabelText(/support reference/i), '7F3K');
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain('q=7F3K');
    expect(url).not.toContain('page=3');
  });

  it('commits the status select immediately', async () => {
    const user = userEvent.setup();
    const replace = withRouter();
    render(<SessionFilters options={OPTIONS} />);

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(await screen.findByRole('option', { name: 'active' }));

    expect(replace).toHaveBeenCalledWith(expect.stringContaining('status=active'), {
      scroll: false,
    });
  });

  it('drops an out-of-scope round when the cohort changes', async () => {
    const user = userEvent.setup();
    // Start scoped to cohort c-1 with its round r-1 selected.
    const replace = withRouter('cohortId=c-1&roundId=r-1');
    render(<SessionFilters options={OPTIONS} />);

    // Switch to cohort c-2 — r-1 belongs to c-1, so it must be dropped.
    await user.click(screen.getByRole('combobox', { name: /cohort/i }));
    await user.click(await screen.findByRole('option', { name: /Interns/ }));

    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain('cohortId=c-2');
    expect(url).not.toContain('roundId=r-1');
  });

  it('clears every filter with Clear all', async () => {
    const user = userEvent.setup();
    const replace = withRouter('status=active&q=abc&demoClientId=dc-1');
    render(<SessionFilters options={OPTIONS} />);

    await user.click(screen.getByRole('button', { name: /clear all/i }));
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).not.toContain('status=');
    expect(url).not.toContain('q=');
    expect(url).not.toContain('demoClientId=');
  });
});
