import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  ExperienceStepReports,
  type StepReportTarget,
} from '@/components/admin/experiences/experience-step-reports';
import { ExperienceSynthesisPanel } from '@/components/admin/experiences/experience-synthesis-panel';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';

export const metadata: Metadata = {
  title: 'Experience reports',
};

/**
 * Experience workspace — Reports tab (F15.4, F15.8).
 *
 * Two layers, in the order they are built. One cohort report per STEP (F15.4) — scoping is per
 * step and never per experience, because a step pins exactly one questionnaire version. Above them
 * the experience-wide synthesis (F15.8), which reads those finished reports rather than
 * re-aggregating sessions across versions.
 *
 * The synthesis renders FIRST because it is the answer most readers want; the per-step reports
 * below it are both its inputs and the place to go when a finding needs checking.
 *
 * The step list comes from the same enriched detail read the other tabs use (which already resolves
 * questionnaire titles in a batched pair of queries), so this page adds no per-row fetch.
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

  return (
    <div className="space-y-8">
      <ExperienceSynthesisPanel
        experienceId={id}
        isMeeting={experience.kind === 'facilitated_meeting'}
      />
      <ExperienceStepReports experienceId={id} steps={steps} />
    </div>
  );
}
