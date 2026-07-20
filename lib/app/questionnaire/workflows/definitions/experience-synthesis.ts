/**
 * Workflow diagram: Experience-wide synthesis.
 *
 * Documents `lib/app/questionnaire/experiences/synthesis/**` — the view across a whole journey.
 *
 * The diagram earns its place by making one thing visible that the code can only assert in a
 * comment: **the inputs are finished reports, not sessions.** Every other reporting pipeline in
 * ConQuest starts by building a dataset from respondent rows. This one deliberately does not, and
 * the reason is a silent-failure trap — `buildCohortDataset` resolves by a single `versionId` and
 * joins fills by `dataSlotId`, so a fill from another version finds no bucket and disappears with
 * no error. An experience spans versions by definition. Drawing "ready step reports" as the entry
 * node is the clearest way to stop someone reaching for the dataset builder.
 *
 * The two kinds diverge at the very first step and never rejoin until the writer, because they
 * produce different things: a switcher has cohort reports, a meeting has k-anonymity-gated
 * breakout insights.
 */

import { EXPERIENCE_SYNTHESIS_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

export const experienceSynthesisWorkflow = diagram({
  slug: 'experience-synthesis',
  title: 'Experience-wide synthesis',
  description:
    'One view across a whole journey — what held throughout, and where the steps disagreed. Written over finished per-step outputs, never by re-reading responses.',
  sourceModule: 'lib/app/questionnaire/experiences/synthesis/generate.ts',
  entryStepId: 'kind',
  steps: [
    node({
      id: 'kind',
      name: 'Which kind?',
      type: 'route',
      x: 0,
      y: 160,
      description:
        'The two experience kinds produce different per-step output, so they are read differently. A switcher has one cohort report per step; a facilitated meeting has breakout findings and usually no step reports at all.',
      config: { routes: [{ label: 'Switcher' }, { label: 'Meeting' }] },
      meta: { note: 'The inputs differ because the outputs differ. They rejoin at the writer.' },
      next: [
        { targetStepId: 'step-reports', condition: 'Switcher' },
        { targetStepId: 'insights', condition: 'Meeting' },
      ],
    }),
    node({
      id: 'step-reports',
      name: 'Ready step reports',
      type: 'tool_call',
      x: 230,
      y: 60,
      description:
        'Load the latest revision of every per-step cohort report whose status is ready. A step with no report, an unfinished one, or an empty one is recorded in coverage and skipped — an honest partial view beats a blocked one.',
      meta: {
        note: 'FINISHED reports only. Never `buildCohortDataset` — cross-version fills would vanish silently.',
      },
      next: ['flatten'],
    }),
    node({
      id: 'insights',
      name: 'Gated breakout findings',
      type: 'guard',
      x: 230,
      y: 280,
      description:
        'Load the meeting’s insights and re-apply the k-anonymity support gate at the experience’s CURRENT threshold. Re-applying on read rather than trusting write time means raising the threshold after a meeting immediately narrows what any later synthesis can see.',
      meta: {
        note: 'Anything below the floor never enters the material, so the writer cannot surface it.',
        settings: [
          {
            key: 'insightMinSupport',
            label: 'Minimum support',
            effect:
              'Findings resting on fewer respondents than this are withheld from the synthesis as well as from the console.',
            scope: 'experience',
          },
        ],
      },
      next: ['flatten'],
    }),
    node({
      id: 'flatten',
      name: 'Flatten to prose',
      type: 'tool_call',
      x: 460,
      y: 160,
      description:
        'Strip the stored HTML back to text and label each block with its step key. The keys are what the writer cites and what the server later verifies those citations against.',
      meta: {
        note: 'Section bodies are persisted as HTML; tags would waste tokens and invite markup back.',
      },
      next: ['routing'],
    }),
    node({
      id: 'routing',
      name: 'Routing distribution',
      type: 'tool_call',
      x: 690,
      y: 160,
      description:
        'Switcher only: count completed runs per step, so the writer can say how the population actually divided. The one genuinely cross-step fact that exists nowhere in an individual step report.',
      meta: {
        note: 'Each step counted once per run — a revisited leg would otherwise inflate its share.',
      },
      next: ['write'],
    }),
    node({
      id: 'write',
      name: 'Write the synthesis',
      type: 'agent_call',
      x: 920,
      y: 160,
      description:
        'A narrative across the journey, findings that each cite the steps behind them, and divergences — where two steps or two rooms pointed different ways. Nobody is waiting mid-conversation, so this runs unhurried at the reasoning tier.',
      meta: {
        agentSlug: EXPERIENCE_SYNTHESIS_AGENT_SLUG,
        note: 'Asked for citable step keys, not for conclusions about its own inputs.',
      },
      next: ['verify'],
    }),
    node({
      id: 'verify',
      name: 'Verify citations',
      type: 'guard',
      x: 1150,
      y: 160,
      description:
        'Match every cited step key against the steps that actually contributed, case-insensitively, and drop the rest. A hallucinated citation is worse than none: it sends a reader to check a source that never said it, and makes an unsupported claim look sourced. The same evidence-not-conclusion discipline the breakout synthesiser applies to support counts.',
      meta: {
        note: 'Server-side. The prompt never mentions the check — that would only teach a forger.',
      },
      next: ['stamp'],
    }),
    node({
      id: 'stamp',
      name: 'Stamp coverage',
      type: 'tool_call',
      x: 1380,
      y: 160,
      description:
        'Attach the server-computed coverage — which steps contributed and why the rest did not. Never taken from the model: coverage is the field a reader leans on to judge how far to trust everything else, and a model asked to describe its own inputs will produce a tidy answer rather than a true one.',
      meta: { note: 'A fact about the inputs, so it is derived, not generated.' },
      next: ['store'],
    }),
    node({
      id: 'store',
      name: 'Store',
      type: 'report',
      x: 1610,
      y: 160,
      description:
        'One row per experience, replaced on regeneration. No revision chain, deliberately: a synthesis reads a moving target — its input reports are themselves regenerated and edited — so a history would imply a stability it does not have. A failed regeneration keeps the previous synthesis rather than destroying it.',
      meta: { note: 'Replace, not append. Failure preserves what the admin already had.' },
    }),
  ],
  applicability: () =>
    applies(
      'Experiences compose whole questionnaires, so this pipeline is not scoped to any single version.'
    ),
});
