/**
 * SessionEntry — forwards the resolved intro into the workspace.
 *
 * The intro is no longer a pre-gate here (it's a carousel surface inside the workspace, which defers
 * the kickoff itself — see the SessionWorkspace tests). So these tests only assert the forwarding
 * contract: SessionEntry always mounts the workspace and hands it the `intro` prop verbatim, whether
 * that's an enabled intro, a disabled one, or none at all.
 *
 * @see components/app/questionnaire/intro/session-entry.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const workspaceProps = vi.fn();
vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: (props: Record<string, unknown>) => {
    workspaceProps(props);
    return <div data-testid="workspace">workspace</div>;
  },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionEntry', () => {
  it('mounts the workspace and forwards an enabled intro plus the session props', () => {
    render(<SessionEntry intro={intro(true)} sessionId="s1" autoStart />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(workspaceProps).toHaveBeenCalledTimes(1);
    expect(workspaceProps.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      autoStart: true,
      intro: expect.objectContaining({ enabled: true }),
    });
  });

  it('forwards a disabled intro through to the workspace (which renders straight to the conversation)', () => {
    render(<SessionEntry intro={intro(false)} sessionId="s1" autoStart />);
    expect(workspaceProps.mock.calls[0][0]).toMatchObject({
      intro: expect.objectContaining({ enabled: false }),
    });
  });

  it('forwards a null intro (a resume or a no-intro version) unchanged', () => {
    render(<SessionEntry intro={null} sessionId="s1" autoStart={false} />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(workspaceProps.mock.calls[0][0]).toMatchObject({ intro: null });
  });

  it('does not pass an intro key as anything but null when omitted', () => {
    render(<SessionEntry sessionId="s1" />);
    expect(workspaceProps.mock.calls[0][0].intro ?? null).toBeNull();
  });
});
