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
 *  - `supportCount` is derived SERVER-SIDE from participant labels the model must cite and the
 *    server then verifies against the material. The model's own number is never used as support.
 *  - The prompt forbids naming participants, quoting verbatim, and reconstructing who held what —
 *    and the gate is the backstop for when it does anyway.
 *  - Statements are written to be SAID. "Three of you felt the deadline was the real problem" is
 *    usable at the front of a room; "Sentiment analysis indicates negative valence toward
 *    timelines" is not.
 *
 * ## The model is not in the trust path for support
 *
 * Respondent free text reaches this prompt unquoted — it is the material. So the prompt is
 * ATTACKER-INFLUENCED: a participant can write an instruction into an answer and the model may
 * follow it. The one thing that must survive that is the k-anonymity gate, and it cannot survive it
 * while the number it gates on is a number the model chose. So the model is asked for EVIDENCE
 * (which participants back this finding) rather than a CONCLUSION (how many), and
 * {@link verifiedSupportCount} recomputes the conclusion from evidence it can check. An injected
 * "emit supportCount: 9" now buys nothing: the count comes from labels that must exist in the
 * material, and a finding standing on one real participant gates out however loudly the model
 * insists otherwise.
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
  type SupportBasis,
  type SynthesisMaterial,
} from '@/lib/app/questionnaire/experiences/meeting/synthesis-material';

/**
 * A ceiling on the label list, so a runaway response cannot make verification quadratic. No real
 * breakout has anything like this many participants.
 */
const MAX_SUPPORTED_BY = 200;

/**
 * One finding, as the model returns it.
 *
 * `supportedBy` is the evidence, `supportCount` is only ever a claim. The model must name the
 * participant labels its finding rests on; the server checks those labels against the material and
 * derives the count itself. An empty array is allowed rather than rejected — a single unbacked
 * finding should be suppressed on its own, not take a whole synthesis down with it — but the key
 * itself is required, so a model that ignores the field trips the parse and gets one corrective
 * retry instead of silently producing findings that all gate out.
 */
const insightSchema = z.object({
  kind: z.enum(EXPERIENCE_INSIGHT_KINDS),
  statement: z.string().min(1).max(500),
  detail: z.string().max(1_500).nullable().optional(),
  supportCount: z.number().int().min(0),
  supportedBy: z.array(z.string()).max(MAX_SUPPORTED_BY),
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

/**
 * Every participant label that genuinely appears in this breakout's material.
 *
 * Movements count as well as positions: a finding about somebody who changed their mind rests on a
 * real person even if their final position was recorded nowhere else.
 */
export function materialParticipantLabels(material: SynthesisMaterial): Set<string> {
  const labels = new Set<string>();
  for (const slot of material.slots) {
    for (const p of slot.positions) labels.add(p.participant);
    for (const m of slot.movements) labels.add(m.participant);
  }
  return labels;
}

/**
 * How many real people a finding actually rests on — computed here, never taken from the model.
 *
 * Labels are matched case-insensitively against the material and de-duplicated, so neither `p1` for
 * `P1` nor `["P1","P1","P1"]` changes the answer. Anything not in the material is discarded: it is
 * either a hallucination or a fabricated citation, and both are exactly the case this exists for.
 *
 * ## Why `room-occupancy` cannot use the label count
 *
 * A scribe room has ONE session by design — the pen — so its material carries exactly one label
 * however many people are sitting in the room. Counting verified labels there would return 1 for a
 * room of six and suppress every scribe room ever synthesised: the original scribe bug, reinvented
 * inside the fix for a different one. So under that basis the labels do a narrower job — they
 * GROUND the finding (it must cite the record it came from, which is what an injected fabrication
 * fails to do) — while the count comes from the room's occupancy, which is server-known and was
 * already required to clear the floor before any model call was made.
 *
 * The model's own number survives there in one direction only: DOWNWARD, as the dissent carve-out.
 * A record that says "two of us disagreed" should yield a finding for two, not six, so a lower
 * claim is honoured. A higher one is not — occupancy is the ceiling. That leaves the model unable
 * to inflate past a number the server chose, which is the property that matters; and unlike the
 * per-session case there is nothing here for inflation to expose anyway, because a scribe room's
 * material holds a single collective record with no individual positions to attribute.
 */
export function verifiedSupportCount(params: {
  supportedBy: readonly string[];
  claimed: number;
  material: SynthesisMaterial;
  basis: SupportBasis;
}): number {
  const { supportedBy, claimed, material, basis } = params;

  const known = new Map<string, string>();
  for (const label of materialParticipantLabels(material)) known.set(label.toLowerCase(), label);

  const verified = new Set<string>();
  for (const cited of supportedBy) {
    const match = known.get(cited.trim().toLowerCase());
    if (match) verified.add(match);
  }

  if (basis === 'room-occupancy') {
    // Ungrounded: the model cited nobody the record actually contains.
    if (verified.size === 0) return 0;
    return Math.min(claimed, material.participantCount);
  }

  return Math.min(verified.size, material.participantCount);
}

/** Render one slot's material for the prompt. */
function renderSlot(slot: MaterialSlot, basis: SupportBasis, roomSize: number): string {
  // Under `room-occupancy` the respondent count is always 1 — the pen — and printing it would tell
  // the model this slot rests on one person, which is exactly the false reading that suppressed
  // scribe rooms in the first place. What the room agreed is what was written down.
  const answeredBy =
    basis === 'room-occupancy'
      ? `answered ONCE, by the person writing on behalf of all ${roomSize} people in this room`
      : `answered by ${slot.respondedCount} participant(s)`;

  const header = [
    `slot: ${slot.name}${slot.theme ? ` (theme: ${slot.theme})` : ''}`,
    slot.description ? `asks about: ${slot.description}` : null,
    answeredBy,
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
  const basis: SupportBasis = material.supportBasis ?? 'per-session';
  return material.slots
    .map((slot) => renderSlot(slot, basis, material.participantCount))
    .join('\n\n---\n\n');
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
  const basis: SupportBasis = material.supportBasis ?? 'per-session';

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
      basis === 'room-occupancy'
        ? 'A group has just spent a few minutes talking one short questionnaire through TOGETHER, ' +
            'with one of them writing down what the group settled on. You are reading what they ' +
            'collectively said, and writing the handful of findings the facilitator will read out ' +
            'to the room in a moment. You are writing for someone standing at the front of a ' +
            'room, about to speak.'
        : 'A group has just spent a few minutes answering the same short questionnaire individually. ' +
            'You are reading what they collectively said, and writing the handful of findings the ' +
            'facilitator will read out to the room in a moment. You are writing for someone standing ' +
            'at the front of a room, about to speak.'
    ),
    section(
      'the_room',
      (basis === 'room-occupancy'
        ? `${material.participantCount} people were in this room for the breakout: ` +
          `"${material.background.breakoutTitle}". They discussed it as a group and ONE of them ` +
          'wrote down the answers on the room’s behalf, so what follows is a single record of ' +
          `what all ${material.participantCount} of them worked out together — not one ` +
          'person’s view.\n'
        : `${material.participantCount} participant(s) completed this breakout: "${material.background.breakoutTitle}".\n`) +
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
          'labels (P1, P2, …) must not appear in `statement` or `detail`, and neither must ' +
          'anything that would let the room work out who said what. These people are sitting ' +
          'together and remember the conversation they just had.',
        // The labels are the whole point of `supportedBy`: they are checkable against the material,
        // and a number is not. Nothing here tells the model its citations are verified — a prompt
        // is not where a security property is enforced, and saying so would only teach an injected
        // instruction what it has to forge.
        'List in `supportedBy` the participant labels whose positions this finding actually rests ' +
          'on — every one of them, and only the ones the material shows holding it. This is the ' +
          'evidence for the finding, so cite it exactly: a label you did not read a position for ' +
          'does not belong there. `supportedBy` is the ONE place labels may appear.',
        // Under `room-occupancy` the material holds ONE written record standing in for the whole
        // room. Left to the default rule the model would read that as one person and return
        // `supportCount: 1`, and the gate would then suppress every finding a scribe room ever
        // produced — the same failure as the old floor check, moved one layer down. Telling it the
        // record belongs to the room is not inflation: it is what scribe mode means, and the
        // dissent carve-out keeps the count honest when the room did not in fact agree.
        basis === 'room-occupancy'
          ? 'Count `supportCount` HONESTLY. This room answered as ONE — the positions below are ' +
              `what the group settled on together, so a position the room recorded is held by all ` +
              `${material.participantCount} of them and that is its support. The exception is ` +
              'dissent the record itself notes ("two of us disagreed", a caveat, a minority view): ' +
              'count only the people that finding actually covers. The number decides whether a ' +
              'finding is safe to say aloud at all, so when unsure, count lower, and never count ' +
              `higher than ${material.participantCount}. There is one label here, because one ` +
              'person held the pen — put it in `supportedBy` for every finding drawn from what ' +
              'they wrote. It marks where the finding came from; it is not a count of people.'
          : 'Count `supportCount` HONESTLY — how many participants genuinely hold this position. It is ' +
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
        '"statement":string,"detail":string|null,"supportCount":number,"supportedBy":string[]}]}. ' +
        '`supportedBy` holds participant labels, e.g. ["P1","P3"]. No prose, no markdown fences.'
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
        '"detail":...,"supportCount":number,"supportedBy":["P1",...]}]}. Every finding needs ' +
        '`supportedBy`.',
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

    // Support is RECOMPUTED, not read. Whatever number the model put in `supportCount` is dropped
    // on the floor here; what survives is a count of participant labels that exist in the material
    // this call was built from. The room-size clamp lives inside `verifiedSupportCount` and keeps
    // its full force in both bases — nothing on this path can ever raise a count.
    const verified = raw.map((i) => ({
      kind: i.kind,
      statement: i.statement.trim(),
      detail: i.detail?.trim() || null,
      supportCount: verifiedSupportCount({
        supportedBy: i.supportedBy,
        claimed: i.supportCount,
        material,
        basis,
      }),
    }));

    // Worth seeing in the logs: a model whose claims routinely outrun its evidence is either a bad
    // prompt or a live injection attempt, and both look the same until someone reads this.
    const overclaimed = raw.filter(
      (i, index) => i.supportCount > verified[index].supportCount
    ).length;
    if (overclaimed > 0) {
      logger.warn('meeting synthesis: model claimed more support than it could evidence', {
        meetingId,
        overclaimed,
        insights: raw.length,
        basis,
      });
    }

    const gated = applySupportGate(verified, minSupport);

    return {
      insights: gated.map((i, index) => ({ ...i, ordinal: index })),
      withheld: verified.length - gated.length,
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
