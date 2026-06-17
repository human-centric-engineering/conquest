/**
 * Session lifecycle/status — DB read seam (F7.3).
 *
 * The data source for the respondent lifecycle UI (Submit affordance, cost-cap hint,
 * anonymous badge, resume vs. budget-pause). Reuses {@link buildTurnContext} so the
 * completion assessment is byte-identical to what the live turn computes (no drift on
 * "ready to submit"), grades the session's spend against its budget exactly as the turn
 * boundary does (F6.3), then hands the plain values to the pure
 * {@link buildSessionStatusView}.
 *
 * Returns the `session` access fields (`respondentUserId`) separately from the projected
 * `view`, so the route runs `resolveTurnAccess` without a second query. `null` when the
 * session id doesn't resolve (the route maps that to 404).
 *
 * Cost is reported only when a positive budget is configured AND enforcement is enabled —
 * otherwise the soft-cap hint would mislead (nothing would actually pause). The pure
 * builder projects only the coarse tier, never the raw USD spend.
 */

import { SESSION_STATUSES, narrowToEnum } from '@/lib/app/questionnaire/types';
import { assessCompletion } from '@/lib/app/questionnaire/completion/completion-logic';
import {
  buildSessionStatusView,
  classifyCostCap,
  type CostCapTier,
  type SessionStatusView,
} from '@/lib/app/questionnaire/session';
import {
  isCostCapEnforcementEnabled,
  isDataSlotsEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import { sumSessionTurnCost } from '@/app/api/v1/app/questionnaires/_lib/turns';

/** What the route needs: access fields + the rendered status view. */
export interface LoadedSessionStatus {
  session: { id: string; respondentUserId: string | null };
  view: SessionStatusView;
}

/** Load a session's lifecycle status. `null` when the session doesn't exist. */
export async function loadSessionStatus(sessionId: string): Promise<LoadedSessionStatus | null> {
  const loaded = await buildTurnContext(sessionId);
  if (!loaded) return null;

  const status = narrowToEnum(loaded.session.status, SESSION_STATUSES, 'active');
  const anonymous = loaded.session.respondentUserId === null;

  let assessment = assessCompletion({
    questions: loaded.base.questions,
    answered: loaded.base.answered,
    config: loaded.base.config,
    sessionId: loaded.base.sessionId,
  });

  // Data Slots feature: only the SUBMIT gate is mode-specific — data-slot mode offers to submit
  // strictly when every question is answered (matching `runDataSlotTurn`, not the configurable
  // weighted threshold), so the Submit affordance and the turn loop can't disagree. The progress
  // bar's `coverage`, by contrast, KEEPS the weighted question coverage from `assessCompletion`,
  // so the top bar, the reasoning trace's "X% covered so far", and the panel's "What we're
  // learning" header all report one question-completeness figure. Coverage and kind are consumed
  // independently downstream (bar vs `canSubmitSession`), so overriding only the gate is safe.
  const dataSlots = loaded.base.dataSlots ?? [];
  if (dataSlots.length > 0 && (await isDataSlotsEnabled())) {
    const total = loaded.base.questions.length;
    const allAnswered = total > 0 && assessment.answeredCount >= total;
    assessment = {
      ...assessment,
      kind: allAnswered ? 'offer' : 'not_ready',
      requiredUnansweredKeys: allAnswered ? [] : assessment.requiredUnansweredKeys,
    };
  }

  // Grade spend against the budget exactly as the turn boundary does — but only when a
  // budget is set and enforcement is on, so the UI's hint matches what would actually happen.
  const capUsd = loaded.base.config.costBudgetUsd;
  let costTier: CostCapTier = 'none';
  let capped = false;
  if (capUsd !== null && capUsd > 0 && (await isCostCapEnforcementEnabled())) {
    capped = true;
    const spentUsd = await sumSessionTurnCost(sessionId);
    costTier = classifyCostCap(spentUsd, capUsd);
  }

  const view = buildSessionStatusView({ status, assessment, costTier, capped, anonymous });

  return {
    session: { id: loaded.session.id, respondentUserId: loaded.session.respondentUserId },
    view,
  };
}
