import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';
import { prisma } from '@/lib/db/client';
import { EXPERIENCE_MEETING_STATUS_LABELS } from '@/lib/app/questionnaire/experiences/meeting/types';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { EXPERIENCE_MEETING_STATUSES } from '@/lib/app/questionnaire/experiences/meeting/types';
import { MeetingCreateButton } from '@/components/admin/experiences/meeting-create-button';

export const metadata: Metadata = { title: 'Meetings' };

/**
 * Experience workspace — Meetings tab (P15.5).
 *
 * One row per OCCURRENCE. The same agenda is run many times, so this is the list a facilitator
 * comes back to: last month's offsite and today's, told apart by their titles and dates.
 */
export default async function ExperienceMeetingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const experience = await getExperienceDetail(id);
  if (!experience) notFound();

  const meetings = await prisma.appExperienceMeeting.findMany({
    where: { experienceId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      joinRef: true,
      title: true,
      status: true,
      startedAt: true,
      createdAt: true,
      _count: { select: { runs: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Meetings</h2>
          <p className="text-muted-foreground text-sm">
            Each meeting is one run of this agenda with a real group of people.
          </p>
        </div>
        <MeetingCreateButton experienceId={id} />
      </div>

      {meetings.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border p-6 text-sm">
          No meetings yet. Create one when you are ready to run this with a group — you will get a
          join link to put on the screen.
        </p>
      ) : (
        <ul className="space-y-2">
          {meetings.map((m) => (
            <li
              key={m.id}
              className="bg-card flex items-center justify-between gap-4 rounded-xl border p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{m.title ?? experience.title}</p>
                <p className="text-muted-foreground text-sm">
                  {
                    EXPERIENCE_MEETING_STATUS_LABELS[
                      narrowToEnum(m.status, EXPERIENCE_MEETING_STATUSES, 'scheduled')
                    ]
                  }{' '}
                  · {m._count.runs} participant{m._count.runs === 1 ? '' : 's'} ·{' '}
                  <span className="font-mono">{m.joinRef}</span>
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/experiences/${id}/meetings/${m.id}`}>Open console</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
