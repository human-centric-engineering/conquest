/**
 * Authenticated respondent surface bootstrap — DB read seam (F7.1).
 *
 * The signed-in session page needs two things before it can render: the ownership fields
 * (so it can 404 a session that isn't this user's, without confirming existence) and the
 * version's presentation config (anonymous mode, chat/form, voice/attachment/reasoning
 * opt-ins). Loading them lives here in the API layer rather than in the page so the page
 * stays free of direct Prisma access, consistent with the other `_lib` loaders
 * (`loadSessionStatus`, `loadAnswerPanelState`, `loadTranscript`).
 *
 * Returns `null` when the session id doesn't resolve (the page maps that to 404).
 */

import { prisma } from '@/lib/db/client';

/** Ownership + presentation config the authenticated surface needs to render. */
export interface SessionSurfaceConfig {
  status: string;
  respondentUserId: string | null;
  config: {
    anonymousMode: boolean;
    presentationMode: string;
    inlineCorrectionEnabled: boolean;
    voiceEnabled: boolean;
    attachmentsEnabled: boolean;
    reasoningStreamEnabled: boolean;
    reasoningStreamPlacement: string;
    reasoningStreamDwellMs: number;
    reasoningStreamPerItemMs: number;
  } | null;
}

/** Load the ownership fields + version config for a session. `null` when it doesn't exist. */
export async function loadSessionSurfaceConfig(
  sessionId: string
): Promise<SessionSurfaceConfig | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      respondentUserId: true,
      version: {
        select: {
          config: {
            select: {
              anonymousMode: true,
              presentationMode: true,
              inlineCorrectionEnabled: true,
              voiceEnabled: true,
              attachmentsEnabled: true,
              reasoningStreamEnabled: true,
              reasoningStreamPlacement: true,
              reasoningStreamDwellMs: true,
              reasoningStreamPerItemMs: true,
            },
          },
        },
      },
    },
  });

  if (!row) return null;

  return {
    status: row.status,
    respondentUserId: row.respondentUserId,
    config: row.version.config,
  };
}
