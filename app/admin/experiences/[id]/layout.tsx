import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { ExperienceSubNav } from '@/components/admin/experiences/experience-sub-nav';
import {
  ExperienceKindBadge,
  ExperienceStatusBadge,
} from '@/components/admin/experiences/experience-ui';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';
import { visibleExperienceTabs } from '@/lib/app/questionnaire/experiences/workspace-nav';

/**
 * Experience workspace chrome — header + sub-navigation, shared by every tab.
 *
 * Reads the experience directly through the read seam rather than over HTTP: a layout runs on
 * every tab navigation, and a self-fetch would add a round trip to each one for data the same
 * process can already query. The tab pages fetch their own data independently, so this only loads
 * the header fields.
 *
 * Unlike the questionnaire workspace there is no version segment — an experience is not forked, so
 * tabs nest directly under `/admin/experiences/[id]`.
 */
export default async function ExperienceWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const experience = await getExperienceDetail(id);
  if (!experience) notFound();

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <Link
          href="/admin/experiences"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Experiences
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{experience.title}</h1>
          <ExperienceKindBadge kind={experience.kind} />
          <ExperienceStatusBadge status={experience.status} />
          {experience.demoClientName && (
            <span className="text-muted-foreground text-sm">{experience.demoClientName}</span>
          )}
        </div>

        {experience.description && (
          <p className="text-muted-foreground max-w-3xl text-sm">{experience.description}</p>
        )}
      </header>

      <ExperienceSubNav experienceId={id} tabs={visibleExperienceTabs(experience.kind)} />

      <div className="pt-2">{children}</div>
    </div>
  );
}
