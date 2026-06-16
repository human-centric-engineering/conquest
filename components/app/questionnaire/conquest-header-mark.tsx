import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';
import { HeaderPortal } from '@/components/app/questionnaire/header-portal';

/**
 * The ConQuest brand lockup, portaled into the admin header bar beside the
 * theme toggle. Shared by the two ConQuest app surfaces (Questionnaires and
 * Demo clients) so the mark appears consistently across the whole nav section
 * — render it once per subtree layout.
 */
export function ConquestHeaderMark() {
  return (
    <HeaderPortal>
      <ConquestWordmark size="page" showSubtitle />
    </HeaderPortal>
  );
}
