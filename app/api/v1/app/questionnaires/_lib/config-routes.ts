/**
 * Transaction-aware read-modify-write for a version's config JSON blocks (F18.8).
 *
 * The one genuinely new helper the policy panel needed. `patchConditionalTopicsSettings` covers exactly
 * one block, and the config PATCH route does an inline upsert over a whole validated body — neither
 * gives an apply engine "change this one field of this one block, inside my transaction".
 *
 * Why `tx` is a parameter rather than an afterthought: the apply engine writes the config change
 * and stamps the finding `applied` in ONE transaction. Without that, a crash between the two leaves
 * a config already changed and a finding still reading `pending` — and `add_house_rule` appends
 * unconditionally, so re-applying it duplicates the rule. Taking the client as an argument is what
 * makes the mistake hard to write.
 *
 * Each block is narrowed on read before merging, so a partial or legacy blob is repaired rather
 * than propagated, and the merge only ever touches the fields the patch names.
 */

import { prisma } from '@/lib/db/client';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { narrowHouseRules } from '@/lib/app/questionnaire/chat/house-rules';
import { narrowInterviewerStrategy } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import { narrowToneSettings } from '@/lib/app/questionnaire/chat/tone';
import {
  narrowQuestionFidelity,
  type HouseRulesSettings,
  type InterviewerStrategySettings,
  type QuestionFidelitySettings,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';

/** Any Prisma client — the base one, or a transaction client. */
type DbClient = Pick<typeof prisma, 'appQuestionnaireConfig'>;

/** The blocks this helper can patch. Each is replaced whole, after being narrowed and merged. */
export interface VersionConfigBlockPatch {
  houseRules?: HouseRulesSettings;
  interviewerStrategy?: InterviewerStrategySettings;
  questionFidelity?: QuestionFidelitySettings;
  tone?: ToneSettings;
}

/** The narrowed blocks as they stand — what a caller merges its one field into. */
export interface VersionConfigBlocks {
  houseRules: HouseRulesSettings;
  interviewerStrategy: InterviewerStrategySettings;
  questionFidelity: QuestionFidelitySettings;
  tone: ToneSettings;
}

/**
 * Read the four policy blocks, narrowed. A version with no config row yet reads as the documented
 * defaults — the same answer a session would get, so a caller never has to special-case it.
 */
export async function loadVersionConfigBlocks(
  versionId: string,
  client: DbClient = prisma
): Promise<VersionConfigBlocks> {
  const row = await client.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { houseRules: true, interviewerStrategy: true, questionFidelity: true, tone: true },
  });
  return {
    houseRules: narrowHouseRules(row?.houseRules),
    interviewerStrategy: narrowInterviewerStrategy(row?.interviewerStrategy),
    questionFidelity: narrowQuestionFidelity(row?.questionFidelity),
    tone: narrowToneSettings(row?.tone),
  };
}

/**
 * Write one or more policy blocks. Only the blocks named in `patch` are touched; the rest of the
 * config row is left alone. Upserts, because a version may not have a config row yet.
 */
export async function patchVersionConfigBlocks(
  versionId: string,
  patch: VersionConfigBlockPatch,
  client: DbClient = prisma
): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.houseRules) data.houseRules = jsonInput(patch.houseRules);
  if (patch.interviewerStrategy) data.interviewerStrategy = jsonInput(patch.interviewerStrategy);
  if (patch.questionFidelity) data.questionFidelity = jsonInput(patch.questionFidelity);
  if (patch.tone) data.tone = jsonInput(patch.tone);
  if (Object.keys(data).length === 0) return;

  await client.appQuestionnaireConfig.upsert({
    where: { versionId },
    update: data,
    create: { versionId, ...data },
  });
}
