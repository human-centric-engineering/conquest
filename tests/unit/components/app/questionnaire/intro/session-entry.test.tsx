/**
 * SessionEntry — gates the workspace behind the intro splash.
 *
 * The workspace is mocked (it owns heavy stream/panel hooks); these tests only assert the gating
 * logic: splash shows for a fresh, intro-enabled session and the workspace mounts after proceed;
 * a disabled intro or a resume mounts the workspace straight away (so the LLM kickoff isn't deferred
 * behind a screen no one asked for).
 *
 * @see components/app/questionnaire/intro/session-entry.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: () => <div data-testid="workspace">workspace</div>,
}));

import { SessionEntry } from '@/components/app/questionnaire/intro/session-entry';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';

function intro(enabled: boolean): ResolvedSessionIntro {
  return {
    enabled,
    questionnaireTitle: 'Q',
    background: '',
    copy: {
      howItWorks: { heading: 'How it works', body: 'body' },
      whatYouGet: null,
      goodToKnow: [],
      buttonLabel: 'Begin',
    },
  };
}

const SPLASH = /how it works/i;

describe('SessionEntry', () => {
  it('shows the splash for a fresh, intro-enabled session', () => {
    render(<SessionEntry intro={intro(true)} sessionId="s1" autoStart />);
    expect(screen.getByText(SPLASH)).toBeInTheDocument();
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
  });

  it('mounts the workspace after the proceed button is pressed', async () => {
    render(<SessionEntry intro={intro(true)} sessionId="s1" autoStart />);
    await userEvent.click(screen.getByRole('button', { name: /begin/i }));
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(screen.queryByText(SPLASH)).not.toBeInTheDocument();
  });

  it('mounts the workspace directly when the intro is disabled', () => {
    render(<SessionEntry intro={intro(false)} sessionId="s1" autoStart />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(screen.queryByText(SPLASH)).not.toBeInTheDocument();
  });

  it('skips the splash on resume (autoStart false) even when enabled', () => {
    render(<SessionEntry intro={intro(true)} sessionId="s1" autoStart={false} />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(screen.queryByText(SPLASH)).not.toBeInTheDocument();
  });

  it('mounts the workspace when there is no intro at all', () => {
    render(<SessionEntry intro={null} sessionId="s1" autoStart />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });
});
