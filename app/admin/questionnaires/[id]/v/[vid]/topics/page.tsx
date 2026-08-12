/**
 * Topics tab — author Adaptive Scope (P17): which parts of this questionnaire apply to which
 * respondent, and who decides.
 *
 * ConQuest already decides which question next (selection strategies) and which questionnaire next
 * (the Experience switcher). This tab is the gap between them. Screeners, eligibility, role-specific
 * question sets and any long instrument that should not ask all of itself to everyone are the same
 * requirement — and before this the only way to express it was to split the questionnaire, which
 * costs cross-section scoring and cohort analysis.
 *
 * Lifted into the workspace (header + version selector come from the layout); reads `vid` from the
 * path. All four pieces — topics, settings, coherence findings, key inventory — come from one
 * endpoint, `cache()`d so the Overview tab's launch row shares the same fetch.
 */
import type { Metadata } from 'next';

import { TopicsPanel } from '@/components/admin/questionnaires/topics/topics-panel';
import { getVersionTopicsCached } from '@/lib/app/questionnaire/workspace-data';

export const metadata: Metadata = {
  title: 'Topics · Questionnaire',
  description: 'Author the topics adaptive scope decides between, and the rules that govern it.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

export default async function TopicsTab({ params }: PageProps) {
  const { id, vid } = await params;
  const payload = await getVersionTopicsCached(id, vid);

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Uploading a document seeds one always-asked topic per section, so a fresh questionnaire has
        a complete set that changes nothing about how it runs. Turning adaptive scope on is what
        makes the conditional ones a choice — decided once, when the opening completes.
      </p>

      <TopicsPanel questionnaireId={id} versionId={vid} payload={payload} />
    </div>
  );
}
