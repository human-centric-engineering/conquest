import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { MeetingParticipantBoot } from '@/components/app/questionnaire/experiences/meeting-participant-boot';
import { prisma } from '@/lib/db/client';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import { normalizeSessionRef } from '@/lib/app/questionnaire/session-ref';

export const metadata: Metadata = {
  title: 'Join',
  // A meeting address is private to the room and creates state when used; never index it.
  robots: { index: false, follow: false },
};

/**
 * The participant's entry to a facilitated meeting (P15.5) — `/m/<joinRef>`.
 *
 * The address that goes on the slide. Deliberately public: a facilitated meeting is commonly a
 * one-off with a room of people who have no account, and the experience's `accessMode` decides
 * whether a login is required — the same gate a walk-up questionnaire uses.
 *
 * The ref is normalised the way a support code is, so someone typing what they read off a screen
 * gets in despite an O-for-0 or a stray dash.
 */
export default async function MeetingJoinPage({
  params,
}: {
  params: Promise<{ joinRef: string }>;
}) {
  const { joinRef } = await params;

  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { joinRef: normalizeSessionRef(joinRef) },
    select: {
      id: true,
      title: true,
      experience: { select: { title: true, settings: true } },
    },
  });
  if (!meeting) notFound();

  const settings = narrowExperienceSettings(meeting.experience.settings);

  return (
    <MeetingParticipantBoot
      meetingId={meeting.id}
      title={meeting.title ?? meeting.experience.title}
      insightDisplay={
        settings.surfaceInsightsToRespondents ? settings.respondentInsightDisplay : 'none'
      }
    />
  );
}
