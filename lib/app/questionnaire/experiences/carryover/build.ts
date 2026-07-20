/**
 * Carry-over context — what one leg hands to the next.
 *
 * Built in two layers:
 *
 *  1. **Deterministic (always).** Data-slot fills joined to their slots, plus the profile snapshot,
 *     scores, and safeguarding state. The data-slot layer is already the semantic answer
 *     vocabulary, so it is the spine rather than raw answers.
 *  2. **LLM compression (config-gated).** A short briefing plus the bridging line that opens the
 *     next leg. Optional by design: when it is off or it fails, the deterministic digest alone is
 *     a complete, usable context.
 *
 * The result is **frozen** onto `AppExperienceRun.carryOver` at the handoff and never recomputed.
 * An earlier leg may later be re-scored or corrected; a finished report must not shift underneath
 * it.
 *
 * ## Two invariants that are not negotiable
 *
 * **Anonymity is read from the SOURCE LEG's version config, never the experience's.** An anonymous
 * entry leg has no profile to carry regardless of what the experience's `carryProfile` setting
 * says. Getting this backwards would leak PII the respondent was promised would not be collected.
 *
 * **Safeguarding state always carries.** No setting gates it. An experience that forgets a
 * disclosure between legs makes the next interviewer re-open it, which is the worst thing this
 * feature can do to someone.
 */

import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import { isRecord } from '@/lib/utils';
import { SENSITIVITY_SEVERITIES, type SensitivitySeverity } from '@/lib/app/questionnaire/types';
import {
  narrowCarryOver,
  narrowSessionSensitivityNotes,
} from '@/lib/app/questionnaire/experiences/carryover/narrow';
import { fillPromptText } from '@/lib/app/questionnaire/experiences/carryover/text';
import {
  EXPERIENCE_HANDOFF_AGENT_SLUG,
  HANDOFF_BRIEFING_MAX_CHARS,
  HANDOFF_BRIEFING_MAX_WORDS,
  HANDOFF_OPENING_LINE_MAX_CHARS,
} from '@/lib/app/questionnaire/experiences/constants';
import type {
  CarryOverContext,
  CarryOverFill,
} from '@/lib/app/questionnaire/experiences/run/types';

const HANDOFF_TIMEOUT_MS = 12_000;
const HANDOFF_MAX_TOKENS = 700;

const briefingSchema = z.object({
  briefing: z.string(),
  openingLine: z.string(),
  carriedThemes: z.array(z.string()),
});

/** Narrow a stored Json object column to a plain record, or null when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Narrow the session's `sensitivityLevel` String column to a known severity, or null. */
function narrowSeverity(value: string | null | undefined): SensitivitySeverity | null {
  if (typeof value !== 'string') return null;
  return SENSITIVITY_SEVERITIES.find((s) => s === value) ?? null;
}

/**
 * The deterministic layer. Always succeeds — every field degrades to null/empty rather than
 * throwing, because a missing profile or an unscored session is normal, not exceptional.
 */
async function buildDeterministic(
  sessionId: string,
  fromStepKey: string,
  opts: { carryProfile: boolean }
): Promise<CarryOverContext> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      versionId: true,
      sensitivityLevel: true,
      sensitivityNotes: true,
      version: { select: { config: { select: { anonymousMode: true } } } },
    },
  });

  const fills = await prisma.appDataSlotFill.findMany({
    where: { sessionId },
    select: {
      value: true,
      paraphrase: true,
      confidence: true,
      provisional: true,
      dataSlot: { select: { key: true, name: true, theme: true, ordinal: true } },
    },
    orderBy: { dataSlot: { ordinal: 'asc' } },
  });

  // Provisional fills are best-effort inferences the pipeline recorded after giving up on a
  // re-ask. They are shown to the respondent as "may revisit", so carrying them into the NEXT
  // questionnaire's prompt as settled fact would launder a guess into a premise.
  const carried: CarryOverFill[] = fills
    .filter((f) => !f.provisional)
    .map((f) => ({
      key: f.dataSlot.key,
      name: f.dataSlot.name,
      theme: f.dataSlot.theme,
      paraphrase: f.paraphrase,
      value: f.value,
      confidence: f.confidence,
    }));

  // Anonymity is the SOURCE version's property, and it wins over the experience setting.
  const anonymous = session?.version?.config?.anonymousMode ?? false;
  let profile: Record<string, unknown> | null = null;
  if (opts.carryProfile && !anonymous) {
    const snapshot = await prisma.appRespondentProfileSnapshot.findUnique({
      where: { sessionId },
      select: { values: true },
    });
    profile = asRecord(snapshot?.values);
  }

  const score = await prisma.appRespondentScore.findFirst({
    where: { sessionId },
    select: { scores: true },
  });

  return {
    fromStepKey,
    fromSessionId: sessionId,
    fills: carried,
    profile,
    // Unconditional — see the module docblock. Narrowed rather than passed through: the column is
    // an append-only Json list, and a malformed entry must not reach an interviewer prompt.
    sensitivityLevel: narrowSeverity(session?.sensitivityLevel),
    sensitivityNotes: narrowSessionSensitivityNotes(session?.sensitivityNotes),
    scores: asRecord(score?.scores),
    briefing: null,
    openingLine: null,
    carriedThemes: [],
    builtAt: new Date().toISOString(),
  };
}

/**
 * The LLM layer. Returns null on any failure — the caller keeps the deterministic context.
 *
 * `nextStepTitle` and `nextStepPurpose` are supplied so the bridging line can actually bridge:
 * "I'd like to look at how your team coordinates" reads as continuity, where a generic "let's
 * continue" reads as a seam.
 */
async function summarise(
  context: CarryOverContext,
  next: { title: string; purpose: string | null }
): Promise<{
  briefing: string;
  openingLine: string;
  carriedThemes: string[];
  costUsd: number;
} | null> {
  if (context.fills.length === 0) return null;

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: EXPERIENCE_HANDOFF_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    logger.warn('experience handoff: agent not configured; carrying deterministic context only');
    return null;
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.warn('experience handoff: no provider resolved', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const digest = context.fills.map((f) => `- ${f.name}: ${fillPromptText(f, 400)}`).join('\n');

  const system = joinSections(
    section(
      'role',
      'A respondent has just finished one part of a multi-part conversation and is about to begin ' +
        'the next. Write the briefing the next interviewer needs, and the single sentence that ' +
        'opens the next part.'
    ),
    section(
      'rules',
      joinSections(
        `The briefing is at most ${HANDOFF_BRIEFING_MAX_WORDS} words, written for the interviewer, ` +
          "not the respondent. Say what this person's situation is and what matters to them — the " +
          'things that should shape how the next questions are asked.',
        'Carry only what the respondent actually said. Never infer a fact they did not state, and ' +
          'never soften or embellish a difficulty they described.',
        'The opening line is spoken TO the respondent, warmly and in one sentence. It should show ' +
          'you were listening — reference something specific they raised — and lead naturally into ' +
          'the next topic. Never mention that a decision was made about them, and never use jargon ' +
          'like "slots", "keys", or "routing".',
        '`carriedThemes` is 2–5 short labels (2–4 words each) naming the threads worth continuing.'
      )
    ),
    section('what_they_conveyed', digest),
    section(
      'what_comes_next',
      `Title: ${next.title}${next.purpose ? `\nPurpose: ${next.purpose}` : ''}`
    ),
    section(
      'output_format',
      'Reply with ONLY JSON: {"briefing":string,"openingLine":string,"carriedThemes":string[]}. ' +
        'No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof briefingSchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Write the handoff briefing now as JSON.' },
      ],
      maxTokens: HANDOFF_MAX_TOKENS,
      timeoutMs: HANDOFF_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = briefingSchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"briefing":string,"openingLine":string,"carriedThemes":string[]}.',
      onFinalFailure: () => new Error('Handoff briefing was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_experience_handoff' },
    }).catch((err: unknown) => {
      logger.error('experience handoff: logCost rejected', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const value = completion.value;
    const briefing = value.briefing.trim().slice(0, HANDOFF_BRIEFING_MAX_CHARS);
    const openingLine = value.openingLine.trim().slice(0, HANDOFF_OPENING_LINE_MAX_CHARS);
    // An empty briefing or opening line is a failed summarisation, not a valid one — fall back
    // rather than persisting a blank that would render as a missing greeting.
    if (briefing === '' || openingLine === '') return null;

    return {
      briefing,
      openingLine,
      carriedThemes: value.carriedThemes
        .map((t) => t.trim())
        .filter((t) => t !== '')
        .slice(0, 5),
      costUsd: completion.costUsd ?? 0,
    };
  } catch (err) {
    logger.warn('experience handoff: summarisation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface BuildCarryOverParams {
  sessionId: string;
  fromStepKey: string;
  /** Honour the experience's `carryProfile` setting (the source version's anonymity still wins). */
  carryProfile: boolean;
  /** Run the LLM compression pass. */
  summarise: boolean;
  /** The step being handed to — supplied so the bridging line can reference it. */
  next: { title: string; purpose: string | null } | null;
}

/** The context plus what the optional summarisation cost, so the caller can bill it to the run. */
export interface BuildCarryOverResult {
  context: CarryOverContext;
  costUsd: number;
}

/**
 * Build the carry-over payload for a handoff. Never throws — the deterministic layer always
 * produces a usable context, and the LLM layer is strictly additive.
 */
export async function buildCarryOver(params: BuildCarryOverParams): Promise<BuildCarryOverResult> {
  const context = await buildDeterministic(params.sessionId, params.fromStepKey, {
    carryProfile: params.carryProfile,
  });

  if (!params.summarise || !params.next) return { context, costUsd: 0 };

  const summary = await summarise(context, params.next);
  if (!summary) return { context, costUsd: 0 };

  return {
    context: {
      ...context,
      briefing: summary.briefing,
      openingLine: summary.openingLine,
      carriedThemes: summary.carriedThemes,
    },
    costUsd: summary.costUsd,
  };
}

/**
 * The carry-over a session should be run with, or null when it is not an experience leg.
 *
 * Mirrors `resolveSessionIntro` (`lib/app/questionnaire/intro/resolve.ts`): a single nullable
 * lookup that every existing session answers `null` to, so the prompt builder gains one optional
 * block and nothing else in the runtime changes.
 *
 * Reads the run's FROZEN payload rather than rebuilding — see the module docblock.
 */
export async function resolveSessionCarryOver(sessionId: string): Promise<CarryOverContext | null> {
  const leg = await prisma.appExperienceRunLeg.findUnique({
    where: { sessionId },
    select: { ordinal: true, run: { select: { carryOver: true } } },
  });
  // The entry leg has nothing carried into it, so it reads null just like a standalone session.
  if (!leg || leg.ordinal === 0) return null;

  // The column was written by this module, but a shape change between deploys is survivable:
  // an unreadable payload narrows to null ("no carry-over") rather than failing the turn.
  return narrowCarryOver(leg.run.carryOver);
}

/**
 * Render a carry-over context as the labelled prompt block the next leg's interviewer sees.
 *
 * Pure. Returns an empty string when there is nothing worth injecting, so the caller can append it
 * unconditionally.
 */
export function renderCarryOverBlock(context: CarryOverContext | null): string {
  if (!context) return '';

  const parts: string[] = [];

  if (context.briefing) {
    parts.push(context.briefing);
  } else if (context.fills.length > 0) {
    parts.push(
      'Earlier in this conversation they told you:\n' +
        context.fills.map((f) => `- ${f.name}: ${fillPromptText(f, 300)}`).join('\n')
    );
  }

  // Safeguarding notes last, so they are the most recent thing in the interviewer's context, and
  // framed as a handling instruction rather than a fact to acknowledge back at the respondent.
  if (context.sensitivityNotes.length > 0) {
    const notes = context.sensitivityNotes
      .map((n) => `- (${n.severity}) ${n.category}: ${n.summary}`)
      .join('\n');
    parts.push(
      `Handle with care. Earlier in this conversation they disclosed:\n${notes}\n` +
        'Do not raise any of this again unless they do. If they do, follow the same support ' +
        'guidance as before. Never repeat these summaries back to them.'
    );
  }

  if (parts.length === 0) return '';
  return section('earlier_in_this_conversation', parts.join('\n\n'));
}
