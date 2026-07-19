/**
 * Generate a version's data slots via the production generator agent and save them LIVE.
 *
 * This is the headless sibling of the generate route
 * (`[id]/versions/[vid]/data-slots/generate/route.ts`): same agent, same capability dispatch,
 * but it skips the draft + admin-review step and writes the live set directly via
 * {@link replaceDataSlots}. It exists so the demo seed and the backfill script can give a
 * pre-existing questionnaire its data-slot abstraction without any admin clicks.
 *
 * Fail-soft: a missing agent, a question-less version, or a generator failure returns a
 * structured outcome rather than throwing — the caller decides whether to warn-and-continue
 * (seed, batch backfill) or surface it. Nothing is written unless the generator returns ≥1 slot.
 */

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { GenerateDataSlotsData } from '@/lib/app/questionnaire/capabilities';
import {
  DEFAULT_DATA_SLOT_GRANULARITY,
  type DataSlotGranularity,
} from '@/lib/app/questionnaire/data-slots';
import {
  buildDataSlotStructure,
  replaceDataSlots,
  type DataSlotInput,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';

export interface GenerateAndSaveOptions {
  /** How broad/fine (and how many) slots to aim for. Defaults to `balanced`. */
  granularity?: DataSlotGranularity;
}

export interface GenerateAndSaveResult {
  /**
   * - `saved`   — generator produced slots and they were written live.
   * - `empty`   — generator ran but proposed no slots (nothing written).
   * - `skipped` — preconditions not met (no questions / agent not seeded); see `diagnostic`.
   * - `failed`  — generator dispatch failed (provider/timeout/parse); see `diagnostic` + `message`.
   */
  status: 'saved' | 'empty' | 'skipped' | 'failed';
  /** Number of live slots written (0 unless `saved`). */
  slotCount: number;
  /** Machine-readable reason for `skipped`/`failed`. */
  diagnostic?: string;
  /** Human-readable, actionable detail for `failed` (the capability's message). */
  message?: string;
}

/**
 * Run the data-slot generator over `versionId`'s questions and replace its live slot set with
 * the result. `questionnaireId` scopes the version lookup (a mismatched pair is treated as
 * "no questions").
 */
export async function generateAndSaveDataSlots(
  questionnaireId: string,
  versionId: string,
  options: GenerateAndSaveOptions = {}
): Promise<GenerateAndSaveResult> {
  const structure = await buildDataSlotStructure(questionnaireId, versionId);
  if (!structure) {
    return { status: 'skipped', slotCount: 0, diagnostic: 'no_questions' };
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    return { status: 'skipped', slotCount: 0, diagnostic: 'agent_missing' };
  }

  // Flush built-in + app capability handlers into the dispatcher — it does not lazy-register,
  // and a script/seed process has never touched a capability before. Idempotent.
  registerBuiltInCapabilities();

  const dispatch = await capabilityDispatcher.dispatch(
    GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
    { structure, versionId, granularity: options.granularity ?? DEFAULT_DATA_SLOT_GRANULARITY },
    {
      userId: null,
      agentId: agent.id,
      entityContext: {
        dataSlotsAgent: {
          provider: agent.provider,
          model: agent.model,
          fallbackProviders: agent.fallbackProviders,
        },
      },
    }
  );

  if (!dispatch.success || !dispatch.data) {
    return {
      status: 'failed',
      slotCount: 0,
      diagnostic: dispatch.error?.code ?? 'generation_failed',
      message: dispatch.error?.message,
    };
  }

  const { slots } = dispatch.data as GenerateDataSlotsData;
  if (slots.length === 0) {
    return { status: 'empty', slotCount: 0 };
  }

  // Promote the proposal straight to live (mirrors the admin's PUT save, minus the review step).
  const input: DataSlotInput[] = slots.map((s) => ({
    name: s.name,
    description: s.description,
    theme: s.theme,
    questionKeys: s.questionKeys,
  }));
  const saved = await replaceDataSlots(versionId, input);

  return { status: 'saved', slotCount: saved.length };
}
