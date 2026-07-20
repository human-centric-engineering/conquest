/**
 * Experience-wide synthesis (P15.8) — the agent call.
 *
 * Takes the assembled material (finished step reports, or gated breakout insights) and writes one
 * view across the journey: a narrative, findings that cite the steps behind them, and the
 * divergences only a cross-step view can see.
 *
 * ## Citations are verified, not trusted
 *
 * The model returns `sourceStepKeys` on every claim. Those are matched server-side against the step
 * keys that ACTUALLY contributed, and unknown keys are dropped — the same evidence-not-conclusion
 * discipline the breakout synthesiser uses for support counts. A citation is the reader's route
 * back to the underlying report, so a hallucinated key is worse than none: it sends someone to
 * check a source that never said it, and it makes an unsupported claim look sourced.
 *
 * Note the prompt does not tell the model its citations are checked. A prompt is not where this is
 * enforced, and announcing the check would only teach an injected instruction what it has to forge.
 */

import { z } from 'zod';

import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import {
  EXPERIENCE_SYNTHESIS_AGENT_SLUG,
  EXPERIENCE_SYNTHESIS_MAX_TOKENS,
  EXPERIENCE_SYNTHESIS_TIMEOUT_MS,
} from '@/lib/app/questionnaire/experiences/constants';
import type { SynthesisMaterial } from '@/lib/app/questionnaire/experiences/synthesis/material';
import {
  SYNTHESIS_DETAIL_MAX,
  SYNTHESIS_MAX_DIVERGENCES,
  SYNTHESIS_MAX_FINDINGS,
  SYNTHESIS_MAX_SOURCE_KEYS,
  SYNTHESIS_NARRATIVE_MAX,
  SYNTHESIS_STATEMENT_MAX,
  isUsableSynthesisContent,
  validateExperienceSynthesisContent,
  type ExperienceSynthesisContent,
} from '@/lib/app/questionnaire/experiences/synthesis/types';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';

export interface GeneratedSynthesis {
  content: ExperienceSynthesisContent;
  costUsd: number;
}

const claimSchema = z.object({
  statement: z.string().min(1).max(SYNTHESIS_STATEMENT_MAX),
  detail: z.string().max(SYNTHESIS_DETAIL_MAX).nullable().optional(),
  sourceStepKeys: z.array(z.string()).max(SYNTHESIS_MAX_SOURCE_KEYS),
});

const synthesisSchema = z.object({
  narrative: z.string().max(SYNTHESIS_NARRATIVE_MAX),
  findings: z.array(claimSchema).max(SYNTHESIS_MAX_FINDINGS),
  divergences: z.array(claimSchema).max(SYNTHESIS_MAX_DIVERGENCES),
  caveats: z.array(z.string()).max(8).optional(),
});

/**
 * Keep only citations naming a step that genuinely contributed.
 *
 * Case-insensitive and trimmed, like the breakout synthesiser's label matching — a model that
 * returns `"Intake"` for the key `intake` has cited the right thing in the wrong case, and
 * discarding that would lose a real citation to a formatting difference.
 */
export function verifyStepKeys(
  claimed: readonly string[],
  contributed: ReadonlySet<string>
): string[] {
  const byLower = new Map([...contributed].map((key) => [key.toLowerCase(), key]));
  const out: string[] = [];
  for (const raw of claimed) {
    const match = byLower.get(raw.trim().toLowerCase());
    if (match && !out.includes(match)) out.push(match);
  }
  return out;
}

function renderBlocks(material: SynthesisMaterial): string {
  return material.blocks
    .map(
      (block) =>
        `## Step "${block.stepKey}" — ${block.stepTitle} (${block.stepKind})\n\n${block.body}`
    )
    .join('\n\n---\n\n');
}

function renderRouting(material: SynthesisMaterial): string {
  const lines = material.routing
    .map((entry) => {
      const pct =
        material.concludedRuns > 0
          ? ` (${Math.round((entry.runs / material.concludedRuns) * 100)}%)`
          : '';
      return `• "${entry.stepKey}" — ${entry.stepTitle}: ${entry.runs} of ${material.concludedRuns} completed runs${pct}`;
    })
    .join('\n');
  return `How the population actually divided across the journey:\n${lines}`;
}

const MEETING_ROLE =
  'You are writing the across-the-whole-meeting view for a facilitator. Each breakout below has ' +
  'already been synthesised on its own; your job is the layer above — what holds across the ' +
  'breakouts, and where they pulled apart.';

const SWITCHER_ROLE =
  'You are writing the across-the-whole-journey view for an administrator. Each step below already ' +
  'has its own report covering the people who reached it; your job is the layer above — what holds ' +
  'across the steps, and where they disagree.';

/**
 * Write the synthesis.
 *
 * Throws on a missing agent, an unresolvable provider, or an unparseable response after one retry —
 * the caller marks the row failed. Unlike the breakout synthesiser (which returns empty so a live
 * meeting is never blocked by it), a failure here is worth surfacing: an admin pressed a button and
 * is waiting for an answer.
 */
export async function generateExperienceSynthesis(
  material: SynthesisMaterial
): Promise<GeneratedSynthesis> {
  if (material.blocks.length === 0) {
    throw new Error('Nothing to synthesise — no step has a finished report yet');
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: EXPERIENCE_SYNTHESIS_AGENT_SLUG },
  });
  if (!agent) throw new Error(`Agent ${EXPERIENCE_SYNTHESIS_AGENT_SLUG} is not configured`);

  const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
  if (!resolved) throw new Error('No provider resolved for the experience synthesiser');
  const { providerSlug, model } = resolved;

  const isMeeting = material.experienceKind === 'facilitated_meeting';
  const unitWord = isMeeting ? 'breakout' : 'step';

  const system = joinSections(
    section('role', isMeeting ? MEETING_ROLE : SWITCHER_ROLE),
    section(
      'the_journey',
      `The experience is "${material.experienceTitle}". ` +
        `${material.blocks.length} ${unitWord}(s) contributed to this view.` +
        (material.concludedRuns > 0 ? ` ${material.concludedRuns} run(s) have been completed.` : '')
    ),
    section(
      'rules',
      joinSections(
        `Write the NARRATIVE first: what happened across the whole ${isMeeting ? 'meeting' : 'journey'}, ` +
          'in a few short paragraphs. It should be readable on its own by someone who has not ' +
          `opened a single ${unitWord} report.`,
        'Then give FINDINGS: things the journey as a whole showed. A finding is only worth ' +
          `including if it needed more than one ${unitWord} to see, or if it holds so consistently ` +
          `across ${unitWord}s that the consistency is itself the point. Anything visible in a ` +
          `single ${unitWord} report belongs in that report, not here.`,
        'Then give DIVERGENCES: where the journey disagreed with itself. Two ' +
          `${unitWord}s pointing opposite ways, a group that broke from the rest, a theme that ` +
          'reversed. This is the section only a cross-cutting view can write, so do not pad it — ' +
          'but do not skip a real one because it is uncomfortable either. An empty array is a ' +
          `legitimate answer when the ${unitWord}s genuinely agreed.`,
        // The keys are checkable against the material and a paraphrase is not.
        'On every finding and divergence, list in `sourceStepKeys` the step keys it rests on — ' +
          'the quoted keys in the headings below, exactly as written, and only the ones whose ' +
          'material actually supports the claim.',
        'Never invent a number. If you give a count or a proportion, it must appear in the ' +
          'material below.',
        isMeeting
          ? 'The findings below have already been filtered so that nothing resting on too few ' +
              'people is shown. Do not try to reconstruct who said what, do not name or number ' +
              'anyone, and do not narrow a finding down to an individual.'
          : 'These reports describe groups, not individuals. Keep it that way — never write a ' +
              'sentence that would identify one respondent.',
        'Use CAVEATS for anything that should temper how the reader takes this: thin coverage, a ' +
          'lopsided split, one report clearly much richer than the rest.',
        'If the material genuinely does not support a cross-cutting view, say so plainly in the ' +
          'narrative and return empty arrays. A short honest answer beats a manufactured pattern.'
      )
    ),
    section(
      isMeeting ? 'what_each_breakout_found' : 'what_each_step_reported',
      renderBlocks(material)
    ),
    ...(material.routing.length > 0
      ? [section('routing_distribution', renderRouting(material))]
      : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"narrative":string,"findings":[{"statement":string,' +
        '"detail":string|null,"sourceStepKeys":string[]}],"divergences":[{...same shape...}],' +
        '"caveats":string[]}. No prose, no markdown fences.'
    )
  );

  const provider = await getProvider(providerSlug);
  const completion = await runStructuredCompletion<z.infer<typeof synthesisSchema>>({
    provider,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'Write the synthesis now as JSON.' },
    ],
    maxTokens: EXPERIENCE_SYNTHESIS_MAX_TOKENS,
    timeoutMs: EXPERIENCE_SYNTHESIS_TIMEOUT_MS,
    parse: (raw) =>
      tryParseJson(raw, (parsed: unknown) => {
        const r = synthesisSchema.safeParse(parsed);
        if (!r.success) return null;
        // Shape-valid is not the same as usable: the schema puts no floor on `narrative` or the
        // arrays, so `{"narrative":"","findings":[],"divergences":[]}` would parse and be stored
        // `ready` — an admin pays for the call and gets a coverage list with nothing above it and
        // no error. Rejecting here is what earns the retry, then the hard failure, matching
        // `cohort-report/generate.ts`. Probing through the validator first so a whitespace-only
        // narrative (which clears `z.string()`) is judged on its trimmed value.
        const probe = validateExperienceSynthesisContent({ ...r.data, coverage: [] });
        return isUsableSynthesisContent(probe) ? r.data : null;
      }),
    retryUserMessage:
      'That response was unusable — it was either not valid JSON, or it carried no narrative and ' +
      'no findings. Reply with ONLY {"narrative":string,"findings":[{"statement":' +
      'string,"detail":string|null,"sourceStepKeys":["step-key",...]}],"divergences":[...],' +
      '"caveats":[...]}, and say plainly in the narrative if the steps simply agreed.',
    onFinalFailure: () =>
      new Error('Synthesis response was not valid or carried no content after one retry'),
  });

  // `versionId` is null — an experience spans steps across versions by definition, so no single
  // questionnaire version is in scope. Without this row the spend is invisible to `cost-reports.ts`
  // AND the synthesiser agent's seeded `monthlyBudgetUsd` ceiling can never fire, since
  // `checkBudget` aggregates `AiCostLog` by `agentId`. The per-row `costUsd` stored on the
  // synthesis is display-only and is overwritten on every regeneration, so it is not an aggregate.
  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: completion.tokenUsage,
    capability: 'app_experience_synthesis',
    versionId: null,
  });

  const contributed = new Set(material.blocks.map((b) => b.stepKey));
  const verifyClaims = (
    claims: readonly z.infer<typeof claimSchema>[]
  ): Array<{ statement: string; detail: string | null; sourceStepKeys: string[] }> =>
    claims.map((claim) => ({
      statement: claim.statement,
      detail: claim.detail ?? null,
      sourceStepKeys: verifyStepKeys(claim.sourceStepKeys, contributed),
    }));

  const parsed = completion.value;
  const findings = verifyClaims(parsed.findings);
  const divergences = verifyClaims(parsed.divergences);

  const countKeys = (claims: ReadonlyArray<{ sourceStepKeys: string[] }>): number =>
    claims.reduce((total, claim) => total + claim.sourceStepKeys.length, 0);

  const dropped =
    countKeys(parsed.findings) +
    countKeys(parsed.divergences) -
    countKeys(findings) -
    countKeys(divergences);
  if (dropped > 0) {
    logger.warn('experience synthesis: model cited step keys that did not contribute', {
      dropped,
      contributed: [...contributed],
    });
  }

  // Coverage is stamped by the caller from the material — never from the model.
  const content = validateExperienceSynthesisContent({
    narrative: parsed.narrative,
    findings,
    divergences,
    coverage: material.coverage,
    caveats: parsed.caveats ?? [],
  });

  return { content, costUsd: completion.costUsd ?? 0 };
}
