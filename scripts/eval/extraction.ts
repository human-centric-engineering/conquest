/**
 * Answer-extraction calibration runner (golden-set eval).
 *
 * Runs the REAL answer extractor over the {@link GOLDEN_FIXTURES} and prints a scorecard for the
 * three calibration axes — provenance, confidence band, coverage. This is the measurement loop the
 * extractor never had: instead of tuning the prompt by anecdote, run this before and after a prompt
 * / model change and watch the numbers. Known-gap fixtures (cases the current chat-tier prompt is
 * expected to fail) are reported apart from genuine regressions, so closing them is visible.
 *
 * It resolves the same way the live capability does — an empty agent binding → the system-default
 * `chat` tier — and builds the prompt with `buildAnswerExtractionPrompt`, so it measures exactly
 * what production runs. Needs the dev DB + provider keys (like the smoke scripts).
 *
 * LLM output is non-deterministic: a single failing fixture is a signal, not a verdict. Pass
 * `EVAL_REPEAT=3` to run each fixture N times and see how stable the labels are.
 *
 * Run with:
 *   npm run eval:extraction
 *   # or:
 *   EVAL_REPEAT=3 npx tsx --env-file=.env.local scripts/eval/extraction.ts
 */

import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';
import {
  buildAnswerExtractionPrompt,
  buildAnswerExtractionRetryMessage,
} from '@/lib/app/questionnaire/extraction/extraction-prompt';
import {
  validateAnswerExtraction,
  type AnswerExtraction,
} from '@/lib/app/questionnaire/extraction/extraction-schema';
import { GOLDEN_FIXTURES } from '@/lib/app/questionnaire/extraction/eval/golden-set';
import {
  aggregate,
  scoreFixture,
  type FixtureResult,
} from '@/lib/app/questionnaire/extraction/eval/score';

const EMPTY_BINDING: ResolvableAgent = { provider: '', model: '', fallbackProviders: [] };
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/** One run of one fixture against the live model. */
async function runFixture(
  fixtureId: string,
  provider: Awaited<ReturnType<typeof getProvider>>,
  model: string
): Promise<{ result: FixtureResult; costUsd: number } | null> {
  const fixture = GOLDEN_FIXTURES.find((f) => f.id === fixtureId)!;
  const messages = buildAnswerExtractionPrompt(fixture.context);
  try {
    const completion = await runStructuredCompletion<AnswerExtraction>({
      provider,
      model,
      messages,
      maxTokens: 4_000,
      timeoutMs: 30_000,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const v = validateAnswerExtraction(parsed);
          return v.ok ? v.value : null;
        }),
      retryUserMessage: buildAnswerExtractionRetryMessage([]),
      onFinalFailure: () => new Error('schema-invalid after retry'),
    });
    return { result: scoreFixture(fixture, completion.value), costUsd: completion.costUsd };
  } catch (err) {
    console.error(
      `  ✗ ${fixtureId}: extraction failed —`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Print a one-line diagnosis for a failing fixture (which axes, on which key). */
function explainFailure(result: FixtureResult): void {
  for (const e of result.expectations) {
    if (e.pass) continue;
    if (!e.found) {
      console.log(`     · ${e.key} (${e.kind}): NOT EMITTED`);
      continue;
    }
    const misses = [
      e.provenanceMatch ? '' : `provenance=${e.actualProvenance}`,
      e.bandMatch ? '' : `band=${e.actualBand}`,
      e.coveredMatch ? '' : `covered=${isCoveredLabel(e.actualProvenance, e.actualConfidence)}`,
    ].filter(Boolean);
    console.log(`     · ${e.key} (${e.kind}): ${misses.join(', ')} [conf ${e.actualConfidence}]`);
  }
  for (const key of result.forbiddenEmitted) {
    console.log(`     · ${key}: emitted a fill for a genuine non-answer`);
  }
}

function isCoveredLabel(provenance: string | undefined, confidence: number | undefined): string {
  return provenance === 'direct' || (confidence ?? 0) >= 0.5 ? 'yes' : 'no';
}

async function main(): Promise<void> {
  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 1) || 1);
  const { providerSlug, model } = await resolveAgentProviderAndModel(EMPTY_BINDING, 'chat');
  const provider = await getProvider(providerSlug);
  console.log(`\n════ Extraction calibration — ${providerSlug}/${model}, ${repeat}× each ════\n`);

  const results: FixtureResult[] = [];
  let totalCost = 0;
  for (const fixture of GOLDEN_FIXTURES) {
    for (let i = 0; i < repeat; i++) {
      const run = await runFixture(fixture.id, provider, model);
      if (!run) continue;
      results.push(run.result);
      totalCost += run.costUsd;
      const tag = run.result.knownGap ? ' (known gap)' : '';
      console.log(`  ${run.result.pass ? '✓' : '✗'} ${fixture.id}${tag}`);
      if (!run.result.pass) explainFailure(run.result);
    }
  }

  const card = aggregate(results);
  console.log(`\n════ Scorecard ════`);
  console.log(`  fixtures passed   ${card.fixturesPassed}/${card.fixtures}`);
  console.log(`  provenance acc.   ${pct(card.provenanceAccuracy)}`);
  console.log(`  band acc.         ${pct(card.bandAccuracy)}`);
  console.log(`  covered acc.      ${pct(card.coveredAccuracy)}`);
  console.log(`  overall (all 3)   ${pct(card.overallAccuracy)}`);
  console.log(`  false positives   ${card.forbiddenEmissions}`);
  if (card.failedRegressions.length > 0) {
    console.log(`  ⚠ regressions     ${card.failedRegressions.join(', ')}`);
  }
  if (card.failedKnownGaps.length > 0) {
    console.log(`  known gaps open   ${card.failedKnownGaps.join(', ')}`);
  }
  console.log(`  est. cost         $${totalCost.toFixed(4)}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('eval:extraction failed —', err);
    process.exit(1);
  });
