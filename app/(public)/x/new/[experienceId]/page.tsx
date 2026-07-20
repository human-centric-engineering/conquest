import type { Metadata } from 'next';

import { RunStartBoot } from '@/components/app/questionnaire/experiences/run-start-boot';

export const metadata: Metadata = {
  title: 'Getting started',
  // Not indexable: loading this URL CREATES a run, so a crawler would mint junk journeys.
  robots: { index: false, follow: false },
};

/**
 * The respondent entry point for an experience (P15.3) — the shareable link an author hands out.
 *
 * Distinct from `/x/<publicRef>`, which OPENS an existing journey. This one starts a new one and
 * immediately replaces itself with that journey's stable address, so the respondent never sees
 * this URL in their history.
 *
 * A two-segment path (`/x/new/<id>`) so it can never be confused with a one-segment public ref.
 *
 * Deliberately does no access checking of its own: `createExperienceRun` decides from the
 * experience's `accessMode` whether a walk-up may start it, exactly as the anonymous questionnaire
 * route does. Gating here as well would put the rule in two places and let them disagree.
 */
export default async function StartExperiencePage({
  params,
}: {
  params: Promise<{ experienceId: string }>;
}) {
  const { experienceId } = await params;
  return <RunStartBoot experienceId={experienceId} />;
}
