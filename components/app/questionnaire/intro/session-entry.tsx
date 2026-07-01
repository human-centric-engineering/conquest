'use client';

/**
 * SessionEntry — hands the respondent intro to the {@link SessionWorkspace}.
 *
 * The intro used to be a pre-gate here: render the splash, and mount the workspace only once the
 * respondent proceeded (so the workspace's `autoStart` kickoff couldn't fire before they began).
 * It's now woven INTO the workspace as the first carousel surface — the respondent slides from the
 * intro into the conversation and can slide back to re-read it, exactly like the chat ↔ form toggle.
 * The workspace defers the kickoff until they first leave the intro, so the "no LLM turn before they
 * begin" guarantee is preserved without gating the mount.
 *
 * This wrapper now just forwards the resolved intro alongside the workspace props, keeping the two
 * respondent surfaces (the authenticated page and the anonymous boot) on one shared entry point. A
 * disabled intro or the read-only viewer pass a `null`/absent intro and the workspace renders
 * straight to the conversation. A resume still passes the resolved intro (so the tab persists across
 * a refresh) — only `autoStart` is resume-gated, so the workspace simply doesn't land on the intro.
 */

import {
  SessionWorkspace,
  type SessionWorkspaceProps,
} from '@/components/app/questionnaire/session-workspace';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';

export interface SessionEntryProps extends SessionWorkspaceProps {
  /** Resolved intro for this session; `null`/disabled (or a resume) renders straight to the workspace. */
  intro?: ResolvedSessionIntro | null;
}

export function SessionEntry({ intro, ...workspaceProps }: SessionEntryProps) {
  return <SessionWorkspace {...workspaceProps} intro={intro} />;
}
