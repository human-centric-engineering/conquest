import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  ExperienceStepReports,
  type StepReportTarget,
} from '@/components/admin/experiences/experience-step-reports';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';

export const metadata: Metadata = {
  title: 'Experience reports',
};

/**
 * Experience workspace — Reports tab (F15.4).
 *
 * One cohort report per STEP. The step list comes from the same enriched detail read the other
 * tabs use (which already resolves questionnaire titles in a batched pair of queries), so this
 * page adds no per-row fetch.
 */
export default async function ExperienceReportsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const experience = await getExperienceDetail(id);
  if (!experience) notFound();

  const steps: StepReportTarget[] = experience.steps.map((step) => ({
    stepId: step.id,
    key: step.key,
    title: step.title,
    questionnaireTitle: step.questionnaireTitle,
    // A step with no questionnaire has no respondents and therefore nothing to report on. The
    // pointer is unmodelled (UG-1) so it may also dangle — an unresolvable questionnaire is
    // treated the same way, and the panel is simply not offered.
    reportable: step.questionnaireId !== null,
  }));

  return <ExperienceStepReports experienceId={id} steps={steps} />;
}
