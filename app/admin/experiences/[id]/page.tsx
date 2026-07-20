import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { ExperienceBlockers } from '@/components/admin/experiences/experience-ui';
import { Button } from '@/components/ui/button';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';
import {
  entryStep,
  experienceBlockers,
  routableSteps,
} from '@/lib/app/questionnaire/experiences/views';
import {
  EXPERIENCE_CONTINUITY_MODE_LABELS,
  EXPERIENCE_ROUTING_FALLBACK_LABELS,
} from '@/lib/app/questionnaire/experiences/types';
import { experienceWorkspaceBase } from '@/lib/app/questionnaire/experiences/workspace-nav';
import { ExperienceRespondentLink } from '@/components/admin/experiences/experience-respondent-link';

export const metadata: Metadata = {
  title: 'Experience overview',
};

/**
 * Experience workspace — Overview tab.
 *
 * The at-a-glance state of the journey: what it is made of, whether it can run, and what the
 * routing policy is. Readiness is the headline because it is the question an author actually has
 * while building.
 */
export default async function ExperienceOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const experience = await getExperienceDetail(id);
  if (!experience) notFound();

  const entry = entryStep(experience.steps);
  const candidates = routableSteps(experience.steps);
  const blockers = experienceBlockers(experience);

  const tiles: CqStat[] = [
    { label: 'Steps', value: experience.steps.length },
    ...(experience.kind === 'agentic_switcher'
      ? [{ label: 'Branch candidates', value: candidates.length, accent: true }]
      : [
          {
            label: 'Breakouts',
            value: experience.steps.filter((s) => s.kind === 'breakout').length,
            accent: true,
          },
        ]),
    {
      label: 'Entry',
      value: entry ? (entry.questionnaireTitle ?? entry.title) : 'Not set',
    },
    {
      label: 'Run budget',
      value: experience.costBudgetUsd ? `$${experience.costBudgetUsd.toFixed(2)}` : 'Uncapped',
    },
  ];

  return (
    <div className="space-y-6">
      <CqStatTiles stats={tiles} />

      <ExperienceBlockers blockers={blockers} />

      {/* The shareable link. Placed directly under the readiness blockers because those two answer
          the same question in sequence — "is this ready?" then "how do people reach it?" */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Share</h2>
        <div className="bg-card rounded-xl border p-4">
          <ExperienceRespondentLink
            experienceId={id}
            status={experience.status}
            accessMode={experience.accessMode}
          />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">The journey</h2>
          <Button asChild variant="outline" size="sm">
            <Link href={`${experienceWorkspaceBase(id)}/steps`}>Edit steps</Link>
          </Button>
        </div>

        {experience.steps.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border p-6 text-sm">
            No steps yet. Add an entry step — the questionnaire every run begins with — then the
            follow-ups it can lead to.
          </p>
        ) : (
          <ol className="space-y-2">
            {experience.steps.map((step) => (
              <li
                key={step.id}
                className="bg-card flex items-center justify-between gap-4 rounded-xl border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{step.title}</p>
                  <p className="text-muted-foreground truncate text-sm">
                    {step.questionnaireTitle ??
                      (step.questionnaireId
                        ? 'Questionnaire missing — it may have been deleted'
                        : 'No questionnaire attached')}
                    {step.versionNumber !== null && ` · v${step.versionNumber}`}
                  </p>
                </div>
                <code className="text-muted-foreground shrink-0 text-xs">{step.key}</code>
              </li>
            ))}
          </ol>
        )}
      </section>

      {experience.kind === 'agentic_switcher' && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Routing policy</h2>
          <dl className="bg-card grid gap-x-8 gap-y-3 rounded-xl border p-4 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-sm">Continuity</dt>
              <dd className="text-sm font-medium">
                {EXPERIENCE_CONTINUITY_MODE_LABELS[experience.continuityMode]}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-sm">If the selector is unsure</dt>
              <dd className="text-sm font-medium">
                {EXPERIENCE_ROUTING_FALLBACK_LABELS[experience.routingFallback]}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-sm">Confidence threshold</dt>
              <dd className="text-sm font-medium tabular-nums">
                {experience.minRoutingConfidence.toFixed(2)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-sm">Carry-over summary</dt>
              <dd className="text-sm font-medium">
                {experience.settings.summariseCarryOver ? 'On' : 'Off'}
              </dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}
