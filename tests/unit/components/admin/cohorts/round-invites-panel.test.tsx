/**
 * Unit: RoundInvitesPanel — generating per-member invite links, and the per-row QR affordance.
 *
 * The list shows names rather than URLs, so the QR expands inline for one row at a time; that
 * exclusivity is the behaviour worth pinning (a code per row would bury the names the admin is
 * scanning for). apiClient mocked.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());

// Mirror the real module's shape: a partial apiClient would make a future `get`/`patch`
// call silently `undefined` rather than a type error, and APIClientError's real constructor
// carries code/status/details that assertions may come to depend on.
vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
      public details?: unknown
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { APIClientError } from '@/lib/api/client';
import { RoundInvitesPanel } from '@/components/admin/cohorts/round-invites-panel';

const RESULT = {
  created: 2,
  skipped: 0,
  unlaunchedQuestionnaires: 0,
  activeMembers: 2,
  links: [
    {
      memberId: 'm-1',
      email: 'amy@example.com',
      name: 'Amy',
      versionId: 'v-1',
      url: 'https://cq.app/q/v-1?i=tok-amy',
    },
    {
      memberId: 'm-2',
      email: 'bo@example.com',
      name: 'Bo',
      versionId: 'v-1',
      url: 'https://cq.app/q/v-1?i=tok-bo',
    },
  ],
};

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue(RESULT);
});

afterEach(() => {
  // Several tests redefine navigator.clipboard directly; neither restoreAllMocks nor
  // unstubAllGlobals undoes a defineProperty, so put the original descriptor back.
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

async function generate() {
  const user = userEvent.setup();
  render(<RoundInvitesPanel roundId="r-1" questionnaireCount={1} />);
  await user.click(screen.getByRole('button', { name: /generate invitations/i }));
  await screen.findByText('Amy');
  return user;
}

describe('RoundInvitesPanel', () => {
  it('disables generation until a questionnaire is attached', () => {
    render(<RoundInvitesPanel roundId="r-1" questionnaireCount={0} />);

    expect(screen.getByRole('button', { name: /generate invitations/i })).toBeDisabled();
    expect(screen.getByText(/attach at least one questionnaire/i)).toBeInTheDocument();
  });

  it('lists a minted link per member after generating', async () => {
    await generate();

    expect(post).toHaveBeenCalledOnce();
    expect(screen.getByText('amy@example.com')).toBeInTheDocument();
    expect(screen.getByText('bo@example.com')).toBeInTheDocument();
  });

  it('copies a row link without displaying the URL', async () => {
    const user = await generate();

    // Installed after `userEvent.setup()`, which otherwise replaces navigator.clipboard
    // with its own stub and swallows the write.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const amyRow = screen.getByText('Amy').closest('li');
    await user.click(within(amyRow as HTMLElement).getByRole('button', { name: /copy link/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://cq.app/q/v-1?i=tok-amy'));
    // The token-bearing URL is never rendered — checked against the whole document text,
    // not just a token substring, so no fragment of it can leak into the row.
    expect(document.body.textContent).not.toContain('https://cq.app/q/v-1');
    expect(document.body.textContent).not.toContain('tok-amy');
  });

  it('keeps every QR collapsed until asked', async () => {
    await generate();

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^qr$/i })).toHaveLength(2);
  });

  it('expands the QR for the row it was requested on', async () => {
    const user = await generate();
    const amyRow = screen.getByText('Amy').closest('li') as HTMLElement;

    await user.click(within(amyRow).getByRole('button', { name: /^qr$/i }));

    expect(within(amyRow).getByRole('img', { name: /QR code for invite-Amy/ })).toBeInTheDocument();
  });

  it('shows only one QR at a time', async () => {
    const user = await generate();
    const amyRow = screen.getByText('Amy').closest('li') as HTMLElement;
    const boRow = screen.getByText('Bo').closest('li') as HTMLElement;

    await user.click(within(amyRow).getByRole('button', { name: /^qr$/i }));
    await user.click(within(boRow).getByRole('button', { name: /^qr$/i }));

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(within(boRow).getByRole('img')).toBeInTheDocument();
    expect(within(amyRow).queryByRole('img')).not.toBeInTheDocument();
  });

  it('collapses the QR when its own toggle is pressed again', async () => {
    const user = await generate();
    const amyRow = screen.getByText('Amy').closest('li') as HTMLElement;

    await user.click(within(amyRow).getByRole('button', { name: /^qr$/i }));
    await user.click(within(amyRow).getByRole('button', { name: /hide qr/i }));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('reports a failed generation instead of rendering an empty list', async () => {
    post.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<RoundInvitesPanel roundId="r-1" questionnaireCount={1} />);

    await user.click(screen.getByRole('button', { name: /generate invitations/i }));

    expect(await screen.findByText(/could not generate invitations/i)).toBeInTheDocument();
  });

  it('surfaces the API error message rather than the generic fallback', async () => {
    post.mockRejectedValue(new APIClientError('Round window has closed'));
    const user = userEvent.setup();
    render(<RoundInvitesPanel roundId="r-1" questionnaireCount={1} />);

    await user.click(screen.getByRole('button', { name: /generate invitations/i }));

    // The server's reason is actionable; the generic fallback is not.
    expect(await screen.findByText('Round window has closed')).toBeInTheDocument();
    expect(screen.queryByText(/could not generate invitations/i)).not.toBeInTheDocument();
  });

  it('reports questionnaires skipped for having no launched version', async () => {
    post.mockResolvedValue({ ...RESULT, unlaunchedQuestionnaires: 2 });
    const user = userEvent.setup();
    render(<RoundInvitesPanel roundId="r-1" questionnaireCount={3} />);

    await user.click(screen.getByRole('button', { name: /generate invitations/i }));

    expect(await screen.findByText(/skipped \(no launched version\)/i)).toBeInTheDocument();
  });

  it('does not let a stale copy reset clear a newer row’s confirmation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RoundInvitesPanel roundId="r-1" questionnaireCount={1} />);
    await user.click(screen.getByRole('button', { name: /generate invitations/i }));
    await screen.findByText('Amy');

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    const amyRow = screen.getByText('Amy').closest('li') as HTMLElement;
    const boRow = screen.getByText('Bo').closest('li') as HTMLElement;

    await user.click(within(amyRow).getByRole('button', { name: /copy link/i }));
    vi.advanceTimersByTime(1000);
    await user.click(within(boRow).getByRole('button', { name: /copy link/i }));

    // Amy's 1500ms timer fires here; its `c === url` guard must leave Bo's state alone.
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(within(boRow).getByText('Copied')).toBeInTheDocument());
    expect(within(amyRow).queryByText('Copied')).not.toBeInTheDocument();

    vi.useRealTimers();
  });
});
