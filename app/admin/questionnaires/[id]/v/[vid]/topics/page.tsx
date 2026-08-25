/**
 * Conditional topics tab — which parts of this questionnaire apply to which respondent, and who
 * decides.
 *
 * ConQuest already decides which question next (selection strategies) and which questionnaire next
 * (the Experience switcher). This tab is the gap between them. Screeners, eligibility, role-specific
 * question sets and any long instrument that should not ask all of itself to everyone are the same
 * requirement — and before this the only way to express it was to split the questionnaire, which
 * costs cross-section scoring and cohort analysis.
 *
 * The URL segment stays `topics` (the unit this page edits) while the tab reads "Conditional topics"
 * (the capability it configures) — renaming the route would break every bookmark and the launch
 * checklist deep-link for no behavioural gain.
 *
 * Lifted into the workspace (header + version selector come from the layout); reads `vid` from the
 * path. All four pieces — topics, settings, coherence findings, key inventory — come from one
 * endpoint, `cache()`d so the Overview tab's launch row shares the same fetch.
 */
import type { Metadata } from 'next';

import { TopicsPanel } from '@/components/admin/questionnaires/topics/topics-panel';
import { getVersionTopicsCached } from '@/lib/app/questionnaire/workspace-data';

export const metadata: Metadata = {
  title: 'Conditional topics · Questionnaire',
  description:
    'Decide which parts of this questionnaire each respondent is asked, and who makes that call.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

export default async function ConditionalTopicsTab({ params }: PageProps) {
  const { id, vid } = await params;
  const payload = await getVersionTopicsCached(id, vid);

  return (
    <div className="max-w-4xl">
      <TopicsPanel questionnaireId={id} versionId={vid} payload={payload} />
    </div>
  );
}
