import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ExperienceSettingsPanel } from '@/components/admin/experiences/experience-settings-panel';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';

export const metadata: Metadata = {
  title: 'Experience settings',
};

/** Experience workspace — Settings tab. Everything about the journey except its steps. */
export default async function ExperienceSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const experience = await getExperienceDetail(id);
  if (!experience) notFound();

  return <ExperienceSettingsPanel experience={experience} />;
}
