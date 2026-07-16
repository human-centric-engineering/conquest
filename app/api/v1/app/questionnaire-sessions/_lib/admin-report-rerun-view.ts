/**
 * Admin "re-run report" read seam — the DB reads behind the session viewer's re-run panel.
 *
 * Admin-route-local (kept out of `lib/app/**`, which is Prisma-free), exactly like
 * {@link loadAdminSessionView}: the viewer page is API-first and must not touch Prisma directly, so the
 * version's report config + client-attribution read lives here and the page just calls it.
 *
 * Seeds {@link SessionReportRerun} with the version's current report config (the re-run starting point),
 * whether the questionnaire has an attributed client KB (gates the KB-grounding toggle), and the existing
 * re-run history.
 */

import { prisma } from '@/lib/db/client';

import type { RespondentReportSettings } from '@/lib/app/questionnaire/types';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import {
  getRespondentReportRevisionsView,
  type RespondentReportRevisionsView,
} from '@/lib/app/questionnaire/report/revision';

/** Everything the session viewer's re-run panel needs at page load. */
export interface AdminReportRerunPanel {
  /** The version's current report config, narrowed — the re-run starting point. */
  settings: RespondentReportSettings;
  /** True when the questionnaire has an attributed client KB (gates the KB-grounding toggle). */
  hasClient: boolean;
  /** The delivered report + existing re-run history for the session. */
  initialView: RespondentReportRevisionsView;
}

/**
 * Load the re-run panel seed for one session under `versionId`. A missing/incomplete version config
 * narrows to the report defaults (same defensive read as everywhere else), so this never throws on a
 * partially-configured version.
 */
export async function loadAdminReportRerunPanel(
  versionId: string,
  sessionId: string
): Promise<AdminReportRerunPanel> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      config: { select: { respondentReport: true } },
      questionnaire: { select: { demoClientId: true } },
    },
  });

  return {
    settings: narrowRespondentReportSettings(version?.config?.respondentReport),
    hasClient: Boolean(version?.questionnaire?.demoClientId),
    initialView: await getRespondentReportRevisionsView(sessionId),
  };
}
