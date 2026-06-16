import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';

/**
 * Sidebar section header for the Questionnaires nav group.
 *
 * Supplied as the section's `titleNode` (see `lib/app/admin-nav.ts`) so the
 * plain uppercase "QUESTIONNAIRES" label is replaced by the ConQuest brand
 * lockup. Padding/margin mirror the default `<h3>` the sidebar would otherwise
 * render, so the items below stay aligned.
 */
export function QuestionnairesNavBrand() {
  return (
    <div className="mb-2 px-2">
      <ConquestWordmark size="nav" showSubtitle />
    </div>
  );
}
