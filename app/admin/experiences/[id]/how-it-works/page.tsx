import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ExperienceDiagram } from '@/components/admin/experiences/experience-diagram';
import { ExperienceExamples } from '@/components/admin/experiences/experience-examples';
import { ExperienceBlockers } from '@/components/admin/experiences/experience-ui';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';
import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { buildExperienceDiagram } from '@/lib/app/questionnaire/experiences/diagram/build';
import { experienceBlockers } from '@/lib/app/questionnaire/experiences/views';
import {
  EXPERIENCE_KIND_DESCRIPTIONS,
  EXPERIENCE_KIND_LABELS,
} from '@/lib/app/questionnaire/experiences/types';
import {
  ROUTING_RULE_OPERATORS,
  type RoutingRule,
} from '@/lib/app/questionnaire/experiences/routing/types';
import { getWorkflowDiagram } from '@/lib/app/questionnaire/workflows/registry';

export const metadata: Metadata = {
  title: 'How this experience works',
};

/**
 * The generic explainer diagram that matches each kind.
 *
 * Both are registered in the Behind-the-Scenes registry, so this tab and the demo visualizer render
 * the same curated artefact rather than two descriptions that can drift apart.
 */
const EXPLAINER_SLUG: Record<string, string> = {
  agentic_switcher: 'experience-switcher',
  facilitated_meeting: 'experience-meeting',
};

/**
 * Experience workspace — How it works.
 *
 * Answers "what am I building?" in three passes: this experience as it currently stands, the
 * general shape of its kind, and worked examples. The first is generated from the authored rows, so
 * it stays true as the author edits; the second and third are curated.
 */
export default async function ExperienceHowItWorksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const experience = await getExperienceDetail(id);
  if (!experience) notFound();

  // Rules only matter to the switcher's diagram; a facilitated meeting has no fork to draw, so the
  // query is skipped rather than fetched and discarded.
  const ruleRows =
    experience.kind === 'agentic_switcher'
      ? await prisma.appExperienceRoutingRule.findMany({
          where: { experienceId: id },
          orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
        })
      : [];

  const rules: RoutingRule[] = ruleRows.map((r) => ({
    id: r.id,
    dataSlotKey: r.dataSlotKey,
    operator: narrowToEnum(r.operator, ROUTING_RULE_OPERATORS, 'equals'),
    value: r.value,
    targetStepKey: r.targetStepKey,
    ordinal: r.ordinal,
  }));

  const definition = buildExperienceDiagram(experience, rules);
  const blockers = experienceBlockers(experience);

  const explainer = getWorkflowDiagram(EXPLAINER_SLUG[experience.kind] ?? '');

  return (
    <div className="max-w-5xl space-y-10">
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">This experience</h2>
          <p className="text-muted-foreground text-sm">
            Built from the steps and rules you have authored. It updates as you edit them.
          </p>
        </div>

        {blockers.length > 0 ? <ExperienceBlockers blockers={blockers} /> : null}

        <ExperienceDiagram
          definition={definition}
          caption={
            experience.steps.length === 0
              ? 'Nothing authored yet — add an entry step on the Steps tab.'
              : undefined
          }
        />
      </section>

      {explainer ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">
              How {EXPERIENCE_KIND_LABELS[experience.kind].toLowerCase()} experiences work
            </h2>
            <p className="text-muted-foreground text-sm">
              {EXPERIENCE_KIND_DESCRIPTIONS[experience.kind]}
            </p>
          </div>

          <ExperienceDiagram definition={explainer.definition} caption={explainer.description} />

          <p className="text-muted-foreground text-sm">
            This diagram, the run lifecycle, and every other ConQuest pipeline are in{' '}
            <Link
              className="underline underline-offset-4"
              href={`/admin/questionnaires/behind-the-scenes?workflow=${explainer.slug}`}
            >
              Behind the Scenes
            </Link>
            , where each step also shows the agent, prompt and settings behind it.
          </p>
        </section>
      ) : null}

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Worked examples</h2>
          <p className="text-muted-foreground text-sm">
            Three shapes this kind of experience takes. The mechanism is the same in each — only the
            questionnaires differ.
          </p>
        </div>

        <ExperienceExamples kind={experience.kind} />
      </section>
    </div>
  );
}
