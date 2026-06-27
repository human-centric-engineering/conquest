'use client';

/**
 * Two-tier lifecycle sub-navigation for the questionnaire workspace.
 *
 * Receives the already-flag-filtered lifecycle groups from the server layout and
 * renders them through the shared {@link GroupedSubNav}: a top row of phases
 * (Overview · Build · Distribute · Results · Settings) and, for the active phase,
 * a second row of its child tabs. Phases that hold nothing actionable for the
 * current status (a draft has no respondents or results) are dimmed, not hidden —
 * `dimmedWorkspacePhases` decides which. hrefs are built here via the pure
 * `workspaceTabHref` helper; the group link points at its first child.
 */
import { GroupedSubNav, type SubNavGroup } from '@/components/admin/grouped-sub-nav';
import {
  dimmedWorkspacePhases,
  workspaceTabHref,
  type ResolvedWorkspaceGroup,
  type WorkspacePhase,
} from '@/lib/app/questionnaire/workspace-nav';
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';

interface QuestionnaireSubNavProps {
  questionnaireId: string;
  versionId: string;
  groups: readonly ResolvedWorkspaceGroup[];
  status: AppQuestionnaireStatus;
}

/** Why a lifecycle phase is dimmed — shown as the group's tooltip. */
const DIM_HINT: Record<WorkspacePhase, string> = {
  build: '',
  distribute: 'Available once the questionnaire is launched',
  results: 'Results appear once respondents complete the questionnaire',
};

export function QuestionnaireSubNav({
  questionnaireId,
  versionId,
  groups,
  status,
}: QuestionnaireSubNavProps) {
  const dimmed = new Set(dimmedWorkspacePhases(status));

  const navGroups: SubNavGroup[] = groups.map((group) => {
    const tabs = group.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      href: workspaceTabHref(questionnaireId, versionId, tab),
      ...(tab.exact ? { exact: true } : {}),
    }));
    const isDimmed = group.phase !== undefined && dimmed.has(group.phase);
    return {
      id: group.id,
      label: group.label,
      href: tabs[0].href,
      tabs,
      ...(isDimmed ? { dimmed: true, dimmedHint: DIM_HINT[group.phase!] } : {}),
    };
  });

  return <GroupedSubNav groups={navGroups} ariaLabel="Questionnaire sections" />;
}
