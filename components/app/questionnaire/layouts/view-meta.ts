/**
 * Label + icon per carousel surface.
 *
 * Module-scoped so it isn't reallocated on every render — the workspace re-renders on each
 * streaming token. Shared by every layout: whatever the arrangement, "Intro" is called Intro and
 * carries the same icon, so a respondent moving between legs of an Experience that use different
 * layouts still recognises the controls.
 */

import { BookOpen, ClipboardList, Drama, ListChecks, MessageSquare } from 'lucide-react';

import type { WorkspaceView } from '@/lib/hooks/use-session-workspace';

export const VIEW_META: Record<WorkspaceView, { label: string; Icon: typeof BookOpen }> = {
  intro: { label: 'Intro', Icon: BookOpen },
  capture: { label: 'Details', Icon: ClipboardList },
  persona: { label: 'Interviewer', Icon: Drama },
  chat: { label: 'Chat', Icon: MessageSquare },
  form: { label: 'Form', Icon: ListChecks },
};
