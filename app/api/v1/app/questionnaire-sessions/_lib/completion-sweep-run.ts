/**
 * Session completion-sweep runner (impure) — the submit-time contradiction pass.
 *
 * On submit / early-finish, before a session completes and its respondent report is generated, run
 * one contradiction detection pass over ALL captured answers. This is the live-session analogue of the
 * admin preview route's completion sweep (`.../versions/:vid/complete`): same detector capability, same
 * caps, same fail-soft posture — but sourced from the session's stored answers rather than a request
 * body. The pure {@link filterSweepFindings} then decides which findings survive against the ledger;
 * this module only dispatches the detector.
 *
 * Fail-soft throughout: a missing detector, an oversized input, or a dispatch error returns `[]` (a
 * clean sweep) so a wrap-up is never blocked by an infrastructure problem. The findings come back
 * already normalised by the capability (unknown/unanswered slots dropped, symmetric pairs deduped).
 */

import { logger as baseLogger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  MAX_CONTRADICTION_SLOTS,
  MAX_CONTRADICTION_ANSWERS,
  type DetectContradictionsData,
} from '@/lib/app/questionnaire/capabilities';
import type { ContradictionFinding } from '@/lib/app/questionnaire/contradiction/types';
import type { ContradictionMode } from '@/lib/app/questionnaire/types';
import type { CapabilitySlotView } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import type { ExistingAnswerView } from '@/lib/app/questionnaire/orchestrator';

/** What the sweep needs from the loaded session — a narrow slice of the turn context. */
export interface CompletionSweepInput {
  sessionId: string;
  userId: string;
  /** The version's question slots (for the detector's prompt + option/scale vocabulary). */
  slots: CapabilitySlotView[];
  /** The answers captured so far (the sweep compares these against each other). */
  answers: ExistingAnswerView[];
  /** The version's contradiction mode — the caller has already gated `off`. */
  mode: ContradictionMode;
}

/** The sweep outcome — the (normalised) findings plus the LLM spend they cost (0 when it no-op'd). */
export interface CompletionSweepResult {
  findings: ContradictionFinding[];
  costUsd: number;
}

/**
 * Run the completion sweep over the session's answers. Returns the (normalised) findings + spend, or
 * `{ findings: [], costUsd: 0 }` fail-soft. The caller filters the findings against the ledger and
 * decides whether to hold the submit.
 */
export async function runCompletionSweep(
  input: CompletionSweepInput
): Promise<CompletionSweepResult> {
  const log = baseLogger;
  const clean: CompletionSweepResult = { findings: [], costUsd: 0 };

  // The detector only reasons over answered slots; trim to those so the cap tracks the answer count,
  // not the questionnaire's size (mirrors the admin preview sweep).
  const answeredKeys = new Set(input.answers.map((a) => a.slotKey));
  const sweepSlots = input.slots.filter((s) => answeredKeys.has(s.key));

  // Need at least two answered slots to have anything to compare (no `currentStatement` at submit).
  if (input.answers.length < 2 || sweepSlots.length < 2) return clean;

  // Oversized input can't run — treat as clean rather than a doomed dispatch (mirrors the admin sweep).
  if (
    sweepSlots.length > MAX_CONTRADICTION_SLOTS ||
    input.answers.length > MAX_CONTRADICTION_ANSWERS
  ) {
    log.warn('Completion sweep skipped: input exceeds detector caps', {
      sessionId: input.sessionId,
      slotCount: sweepSlots.length,
      answerCount: input.answers.length,
    });
    return clean;
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    log.error('Contradiction-detector agent not found; run db:seed', {
      slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
    });
    return clean;
  }

  // Flush capability handlers before dispatch — submit may be the first capability touch on a fresh
  // process (the dispatcher does not lazy-register). Idempotent, one-shot.
  registerBuiltInCapabilities();

  const dispatch = await capabilityDispatcher.dispatch(
    DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
    {
      slots: sweepSlots.map((s) => ({
        key: s.key,
        prompt: s.prompt,
        type: s.type,
        typeConfig: s.typeConfig,
        required: s.required,
        ...(s.guidelines !== undefined ? { guidelines: s.guidelines } : {}),
      })),
      answers: input.answers.map((a) => ({
        slotKey: a.slotKey,
        value: a.value,
        confidence: a.confidence ?? null,
        provenance: a.provenance,
      })),
      mode: input.mode,
      // The sweep compares ALL answers (compareWindow: 'all'), so no window trimming.
      windowN: 0,
      sessionId: input.sessionId,
    },
    {
      userId: input.userId,
      agentId: agent.id,
      entityContext: {
        contradictionDetectorAgent: {
          provider: agent.provider,
          model: agent.model,
          fallbackProviders: agent.fallbackProviders,
        },
      },
    }
  );

  if (dispatch.success && dispatch.data) {
    const data = dispatch.data as DetectContradictionsData;
    return { findings: data.findings, costUsd: data.costUsd ?? 0 };
  }
  // Fail-soft: a failed sweep counts as clean so a wrap-up never 5xxs.
  log.warn('Completion sweep failed; treating as clean', {
    sessionId: input.sessionId,
    code: dispatch.error?.code,
  });
  return clean;
}
