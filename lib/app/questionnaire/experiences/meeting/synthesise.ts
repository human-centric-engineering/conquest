/**
 * The breakout synthesiser (P15.5) — turning a room's data slots into things a facilitator says.
 *
 * Reads {@link SynthesisMaterial} (fills, rationales, movement, questionnaire background — never
 * raw chat) and returns findings ordered for a walkthrough.
 *
 * ## The output is spoken, not filed
 *
 * Every other report in this system is read silently by one person about strangers. This one is
 * read ALOUD, by a facilitator, to the very people it describes, who are sitting together and
 * remember who said what. That single fact drives the whole design:
 *
 *  - `supportCount` is required on every finding, and the model is told to count honestly, because
 *    the k-anonymity gate runs on it afterwards. A model that inflates support would push an
 *    attributable finding through the gate.
 *  - The prompt forbids naming participants, quoting verbatim, and reconstructing who held what —
 *    and the gate is the backstop for when it does anyway.
 *  - Statements are written to be SAID. "Three of you felt the deadline was the real problem" is
 *    usable at the front of a room; "Sentiment analysis indicates negative valence toward
 *    timelines" is not.
 *
 * ## Never throws
 *
 * A facilitator standing in front of a room does not need an exception. Every failure returns an
 * empty list and logs; the console shows "no synthesis yet" and the facilitator can retry or carry
 * on. Mirrors the routing selector's contract for the same reason.
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
import {
  MEETING_SYNTHESIS_AGENT_SLUG,
  SYNTHESIS_MAX_INSIGHTS,
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_TIMEOUT_MS,
} from '@/lib/app/questionnaire/experiences/constants';
import { EXPERIENCE_INSIGHT_KINDS } from '@/lib/app/questionnaire/experiences/meeting/types';
import { applySupportGate } from '@/lib/app/questionnaire/experiences/meeting/anonymity';
import {
  hasEnoughToSynthesise,
  type MaterialSlot,
  type SynthesisMaterial,
} from '@/lib/app/questionnaire/experiences/meeting/synthesis-material';

/** One finding, as the model returns it. */
const insightSchema = z.object({
  kind: z.enum(EXPERIENCE_INSIGHT_KINDS),
  statement: z.string().min(1).max(500),
  detail: z.string().max(1_500).nullable().optional(),
  supportCount: z.number().int().min(0),
});

const synthesisSchema = z.object({
  insights: z.array(insightSchema).max(SYNTHESIS_MAX_INSIGHTS),
});

/** A synthesised finding, gated and ready to persist. */
export interface SynthesisedInsight {
  kind: (typeof EXPERIENCE_INSIGHT_KINDS)[number];
  statement: string;
  detail: string | null;
  supportCount: number;
  ordinal: number;
}

export interface SynthesisResult {
  insights: SynthesisedInsight[];
  /** How many findings the gate withheld — shown to the facilitator as a count only. */
  withheld: number;
  costUsd: number;
}

const EMPTY: SynthesisResult = { insights: [], withheld: 0, costUsd: 0 };

/** Render one slot's material for the prompt. */
function renderSlot(slot: MaterialSlot): string {
  const header = [
    `slot: ${slot.name}${slot.theme ? ` (theme: ${slot.theme})` : ''}`,
    slot.description ? `asks about: ${slot.description}` : null,
    `answered by ${slot.respondedCount} participant(s)`,
  ]
    .filter(Boolean)
    .join('\n');

  const positions = slot.positions.length
    ? slot.positions
        .map((p) => {
          const bits = [`${p.participant}: ${p.text}`];
          if (p.rationale) bits.push(`  why: ${p.rationale}`);
          if (p.inferred) bits.push('  (inferred by the system, not stated outright)');
          return bits.join('\n');
        })
        .join('\n')
    : '(nobody answered this)';

  // Movement is called out separately rather than mixed into positions: a position that CHANGED is
  // a different kind of fact from one that was simply held, and the model should be able to see
  // the shift as a shift.
  const movements = slot.movements.length
    ? slot.movements
        .map(
          (m) =>
            `${m.participant} moved from "${m.from}" to "${m.to}" — ${m.rationale}` +
            (m.confidenceBefore !== null && m.confidenceAfter !== null
              ? ` (certainty ${m.confidenceBefore} → ${m.confidenceAfter})`
              : '')
        )
        .join('\n')
    : '(nobody changed their position)';

  return `${header}\n\npositions:\n${positions}\n\nchanges during the conversation:\n${movements}`;
}

function renderMaterial(material: SynthesisMaterial): string {
  return material.slots.map(renderSlot).join('\n\n---\n\n');
}

/**
 * Synthesise one breakout.
 *
 * `minSupport` gates the result before it is returned, so a caller can never persist a finding the
 * gate would suppress. Returns an empty result — never throws — on any failure.
 */
export async function synthesiseBreakout(params: {
  material: SynthesisMaterial;
  /** The experience-level `insightMinSupport`, already narrowed. */
  minSupport: number;
  /** Experience-level `synthesisInstructions`; the breakout's own focus rides on the material. */
  synthesisInstructions: string;
  /** For logging only. */
  meetingId: string;
}): Promise<SynthesisResult> {
  const { material, minSupport, synthesisInstructions, meetingId } = params;

  // Below the floor the gate would suppress everything, so a model call would spend money to
  // produce nothing. Checked here as well as by the caller — this is the expensive door.
  if (!hasEnoughToSynthesise(material, minSupport)) {
    logger.info('meeting synthesis: not enough responses yet', { meetingId });
    return EMPTY;
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: MEETING_SYNTHESIS_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    logger.warn('meeting synthesis: agent not configured', { meetingId });
    return EMPTY;
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.warn('meeting synthesis: no provider resolved', {
      meetingId,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY;
  }

  const system = joinSections(
    section(
      'role',
      'A group has just spent a few minutes answering the same short questionnaire individually. ' +
        'You are reading what they collectively said, and writing the handful of findings the ' +
        'facilitator will read out to the room in a moment. You are writing for someone standing ' +
        'at the front of a room, about to speak.'
    ),
    section(
      'the_room',
      `${material.participantCount} participant(s) completed this breakout: "${material.background.breakoutTitle}".\n` +
        `The questionnaire is "${material.background.questionnaireTitle}".` +
        (material.background.goal ? `\nIts goal: ${material.background.goal}` : '') +
        (material.background.briefing
          ? `\nThe facilitator briefed the room: ${material.background.briefing}`
          : '')
    ),
    section(
      'rules',
      joinSections(
        'NEVER name or number a participant, and never quote anyone verbatim. The participant ' +
          'labels (P1, P2, …) are for your reasoning only — they must not appear in your output, ' +
          'and neither must anything that would let the room work out who said what. These people ' +
          'are sitting together and remember the conversation they just had.',
        'Count `supportCount` HONESTLY — how many participants genuinely hold this position. It is ' +
          'used to decide whether a finding is safe to say aloud at all, so inflating it would ' +
          'push an identifiable finding in front of the room. When unsure, count lower.',
        'Write each `statement` to be SPOKEN. "Three of you felt the deadline was the real problem" ' +
          'is usable at the front of a room. "Sentiment analysis indicates negative valence toward ' +
          'timelines" is not.',
        'Prefer findings that give the room something to DO or DISCUSS. A tension people can talk ' +
          'about is worth more than a tally they can only nod at.',
        'A position that CHANGED during the conversation is often the most interesting thing here. ' +
          'If several people moved the same way, say so and say what moved them.',
        'Treat an inferred position as weaker evidence than a stated one, and never report an ' +
          'inference back to the room as something they said.',
        'Order the findings the way you would say them: the thing most worth discussing first.',
        `Return at most ${SYNTHESIS_MAX_INSIGHTS} findings. Fewer, sharper findings beat a long list.`,
        'If the material genuinely does not support any finding, return an empty array. Saying ' +
          'nothing is better than manufacturing a pattern that is not there.'
      )
    ),
    section('what_the_room_said', renderMaterial(material)),
    ...(material.background.synthesisFocus
      ? [section('what_to_look_for_in_this_breakout', material.background.synthesisFocus)]
      : []),
    ...(synthesisInstructions
      ? [section('additional_guidance_from_the_administrator', synthesisInstructions)]
      : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"insights":[{"kind":"agreement"|"tension"|"outlier"|"theme"|"question",' +
        '"statement":string,"detail":string|null,"supportCount":number}]}. No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof synthesisSchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Write the findings now as JSON.' },
      ],
      maxTokens: SYNTHESIS_MAX_TOKENS,
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = synthesisSchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"insights":[{"kind":...,"statement":...,' +
        '"detail":...,"supportCount":number}]}.',
      onFinalFailure: () => new Error('Synthesis response was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
    });

    const raw = completion.value.insights;

    // A model cannot claim more support than there were people in the room. Clamped rather than
    // discarded: the finding may well be real and the count merely sloppy.
    //
    // Note what this does and does not do. It is an HONESTY guard on the number the facilitator
    // says out loud ("four of you"), not a second gate — clamping can never push a finding into
    // suppression, because the floor check guarantees some slot reached `minSupport`,
    // `respondedCount <= participantCount`, and so a clamped count is always >= the threshold.
    // The gate below is the only thing that suppresses.
    const clamped = raw.map((i) => ({
      kind: i.kind,
      statement: i.statement.trim(),
      detail: i.detail?.trim() || null,
      supportCount: Math.min(i.supportCount, material.participantCount),
    }));

    const gated = applySupportGate(clamped, minSupport);

    return {
      insights: gated.map((i, index) => ({ ...i, ordinal: index })),
      withheld: clamped.length - gated.length,
      costUsd: completion.costUsd,
    };
  } catch (err) {
    logger.error('meeting synthesis failed', {
      meetingId,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY;
  }
}
