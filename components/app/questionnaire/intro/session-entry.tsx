'use client';

/**
 * SessionEntry — gates the {@link SessionWorkspace} behind the respondent intro / splash screen.
 *
 * The workspace fires an LLM "kickoff" turn on mount (`autoStart`), so the intro can't live *inside*
 * it — it has to sit BEFORE it. This wrapper renders {@link QuestionnaireSplash} first (when the
 * version has the intro enabled AND this is a fresh session) and only mounts the workspace once the
 * respondent presses the proceed button, so no turn is spent before they begin. Both respondent
 * surfaces — the authenticated page and the anonymous boot — render this instead of the workspace
 * directly, so the gate is defined once.
 *
 * Resume skips the splash entirely (gated on `autoStart`, the same fresh-session signal the workspace
 * uses for `animateOpening`): a returning respondent drops straight back into their conversation.
 */

import { useState } from 'react';

import {
  SessionWorkspace,
  type SessionWorkspaceProps,
} from '@/components/app/questionnaire/session-workspace';
import { QuestionnaireSplash } from '@/components/app/questionnaire/intro/questionnaire-splash';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';

export interface SessionEntryProps extends SessionWorkspaceProps {
  /** Resolved intro for this session; `null`/disabled (or a resume) skips straight to the workspace. */
  intro?: ResolvedSessionIntro | null;
}

export function SessionEntry({ intro, ...workspaceProps }: SessionEntryProps) {
  // Show the splash only on a FRESH session (autoStart) when the version has it enabled. A resume
  // (autoStart false) never sees it — the prior conversation is already on screen.
  const splashEnabled = Boolean(intro?.enabled && workspaceProps.autoStart);
  const [proceeded, setProceeded] = useState(false);

  if (splashEnabled && !proceeded && intro) {
    return <QuestionnaireSplash intro={intro} onProceed={() => setProceeded(true)} />;
  }

  return <SessionWorkspace {...workspaceProps} />;
}
