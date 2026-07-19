import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  ExperienceStepsPanel,
  type QuestionnaireOption,
} from '@/components/admin/experiences/experience-steps-panel';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Experience steps',
};

/**
 * The questionnaires a step can point at.
 *
 * Fetched once for the whole page and handed to every step form — the no-N+1 rule: a picker per
 * row must not mean a request per row. Degrades to an empty list, which renders the picker with
 * only "None yet" rather than breaking the editor.
 */
async function getQuestionnaireOptions(): Promise<QuestionnaireOption[]> {
  try {
    const res = await serverFetch(`${API.APP.QUESTIONNAIRES.ROOT}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<QuestionnaireListItem[]>(res);
    if (!body.success) return [];
    return body.data.map((q) => ({ id: q.id, title: q.title, status: q.status }));
  } catch (err) {
    logger.error('experience steps page: questionnaire options fetch failed', err);
    return [];
  }
}

/** Experience workspace — Steps tab. The journey editor. */
export default async function ExperienceStepsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [experience, questionnaireOptions] = await Promise.all([
    getExperienceDetail(id),
    getQuestionnaireOptions(),
  ]);
  if (!experience) notFound();

  return (
    <ExperienceStepsPanel
      experienceId={id}
      experienceKind={experience.kind}
      steps={experience.steps}
      questionnaireOptions={questionnaireOptions}
    />
  );
}
