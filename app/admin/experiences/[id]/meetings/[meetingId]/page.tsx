import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { MeetingConsole, type ConsoleStep } from '@/components/admin/experiences/meeting-console';
import { prisma } from '@/lib/db/client';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import { env } from '@/lib/env';

export const metadata: Metadata = { title: 'Meeting console' };

/**
 * The live facilitator console (P15.5).
 *
 * Server-renders the agenda and the join URL, then hands over to the client component that polls.
 * `consoleDisplayMode` comes from the experience because nothing about the viewport says whether
 * this is a private laptop, a projector, or the only surface on a Zoom call.
 */
export default async function MeetingConsolePage({
  params,
}: {
  params: Promise<{ id: string; meetingId: string }>;
}) {
  const { id, meetingId } = await params;

  const meeting = await prisma.appExperienceMeeting.findFirst({
    // Scoped by both: a meeting id from another experience must 404.
    where: { id: meetingId, experienceId: id },
    select: {
      id: true,
      joinRef: true,
      title: true,
      experience: {
        select: {
          title: true,
          settings: true,
          steps: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              title: true,
              kind: true,
              durationSeconds: true,
              briefing: true,
            },
          },
        },
      },
    },
  });
  if (!meeting) notFound();

  const settings = narrowExperienceSettings(meeting.experience.settings);
  const steps: ConsoleStep[] = meeting.experience.steps;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-medium">{meeting.title ?? meeting.experience.title}</h1>
      <MeetingConsole
        meetingId={meeting.id}
        joinUrl={`${env.NEXT_PUBLIC_APP_URL}/m/${meeting.joinRef}`}
        steps={steps}
        displayMode={settings.consoleDisplayMode}
      />
    </div>
  );
}
