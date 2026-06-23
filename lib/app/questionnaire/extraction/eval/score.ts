/**
 * Calibration scorer for the answer extractor (golden-set eval).
 *
 * Pure and DB-free: given a fixture's EXPECTED labels and the extractor's actual
 * {@link AnswerExtraction} output, it scores three axes the diagnosis identified as the places
 * extraction goes wrong —
 *
 *   1. **provenance** — was a STATED position labelled `direct` (not dragged to `inferred`)?
 *   2. **band** — did a clear answer land in the `clear` confidence band (not under-scored)?
 *   3. **covered** — would the downstream coverage rule treat it as answered (so it isn't re-asked
 *      / parked)? This is the operational consequence of (1) and (2).
 *
 * Confidence is scored as a COARSE BAND, never an exact float: LLMs don't emit calibrated
 * probabilities, so a battery that asserted `0.82` would be noise. Three bands keep the contract
 * auditable. The `covered` rule mirrors the data-slot orchestrator's {@link isCovered} (`direct`
 * OR confidence ≥ threshold), imported so the eval and the runtime can't drift.
 *
 * The scorer is the verification substrate for the calibration work: the golden set encodes what a
 * correctly-calibrated extractor returns, this scores any output against it, and `scripts/eval/`
 * runs the real model over the set to produce a scorecard. No LLM here — fully unit-testable.
 */

import { DATA_SLOT_FILLED_THRESHOLD } from '@/lib/app/questionnaire/orchestrator';
import type { AnswerExtraction } from '@/lib/app/questionnaire/extraction/extraction-schema';
import type {
  GoldenExpectation,
  GoldenFixture,
} from '@/lib/app/questionnaire/extraction/eval/golden-set';

/**
 * Coarse confidence bands — the only resolution an LLM-emitted confidence can be trusted at.
 * Three bands deliberately, not the finer extraction rubric's four anchors: the model emits noisy
 * floats, so a battery asserting the 0.85 line between "clear-direct" and "direct-and-backed" would
 * be measuring noise. The bands that MATTER for calibration are the ones with operational
 * consequence: `clear` (covered, not re-asked), `partial` (a terse/vague reading worth deepening),
 * `unclear` (a tangential inference). Under the finer rubric (0.3–1.0 by directness × elaboration ×
 * certainty): direct/backed (0.9–1.0) and clear-direct (0.75–0.85) both land `clear`; a terse
 * answer (0.45–0.6) lands `partial`; a tangential inference (0.3–0.45) lands `unclear`.
 */
export type ConfidenceBand = 'clear' | 'partial' | 'unclear';

/** Lower bound of the `clear` band: a clear, direct answer (no elaboration needed). */
export const CLEAR_BAND_MIN = 0.7;
/**
 * Lower bound of the `partial` band: a terse/vague but usable reading. Below it is `unclear` — a
 * tangential inference. Set at 0.45 to sit on the rubric's terse(0.45–0.6) / tangential(0.3–0.45)
 * seam, so the eval distinguishes "worth deepening" from "barely there".
 */
export const PARTIAL_BAND_MIN = 0.45;

/** Bucket a raw 0–1 confidence into its coarse band. */
export function classifyBand(confidence: number): ConfidenceBand {
  if (confidence >= CLEAR_BAND_MIN) return 'clear';
  if (confidence >= PARTIAL_BAND_MIN) return 'partial';
  return 'unclear';
}

/**
 * The downstream coverage rule, in one place: a slot is "covered" (not re-asked, not parked) when
 * the respondent STATED it (`direct`) or the confidence cleared the fill threshold. Mirrors
 * `data-slot-orchestrator.isCovered` for a freshly-emitted fill.
 */
export function isCoveredOutput(provenance: string, confidence: number): boolean {
  return provenance === 'direct' || confidence >= DATA_SLOT_FILLED_THRESHOLD;
}

/** One expectation's outcome against the model output. */
export interface ExpectationResult {
  key: string;
  kind: GoldenExpectation['kind'];
  /** The model emitted an entry for this key at all. */
  found: boolean;
  provenanceMatch: boolean;
  bandMatch: boolean;
  coveredMatch: boolean;
  /** All axes matched (and the entry was found). */
  pass: boolean;
  /** The model's actual provenance / band / confidence, for the scorecard (undefined when absent). */
  actualProvenance?: string;
  actualBand?: ConfidenceBand;
  actualConfidence?: number;
}

/** One fixture's outcome: per-expectation results, forbidden-key violations, and a roll-up. */
export interface FixtureResult {
  id: string;
  knownGap: boolean;
  expectations: ExpectationResult[];
  /** Keys the fixture said must NOT be emitted (a non-answer) that the model emitted anyway. */
  forbiddenEmitted: string[];
  /** Every expectation passed AND no forbidden key was emitted. */
  pass: boolean;
}

/** Aggregate accuracy across a scored run. */
export interface Scorecard {
  fixtures: number;
  fixturesPassed: number;
  expectations: number;
  provenanceAccuracy: number;
  bandAccuracy: number;
  coveredAccuracy: number;
  /** Fraction of expectations matching on ALL axes. */
  overallAccuracy: number;
  /** Forbidden-key (false-positive) emissions across all fixtures. */
  forbiddenEmissions: number;
  /** ids of fixtures that failed, split by whether they were flagged as known gaps. */
  failedKnownGaps: string[];
  failedRegressions: string[];
}

/** Find the model's entry for an expectation by its key + kind. */
function findOutput(
  output: AnswerExtraction,
  exp: GoldenExpectation
): { provenance: string; confidence: number } | undefined {
  if (exp.kind === 'dataSlotFill') {
    const fill = (output.dataSlotFills ?? []).find((f) => f.dataSlotKey === exp.key);
    return fill ? { provenance: fill.provenance, confidence: fill.confidence } : undefined;
  }
  const answer = output.answers.find((a) => a.slotKey === exp.key);
  return answer ? { provenance: answer.provenance, confidence: answer.confidence } : undefined;
}

/** Score one expectation against the model output. */
function scoreExpectation(output: AnswerExtraction, exp: GoldenExpectation): ExpectationResult {
  const actual = findOutput(output, exp);
  if (!actual) {
    return {
      key: exp.key,
      kind: exp.kind,
      found: false,
      provenanceMatch: false,
      bandMatch: false,
      coveredMatch: false,
      pass: false,
    };
  }
  const actualBand = classifyBand(actual.confidence);
  const provenanceMatch = actual.provenance === exp.provenance;
  const bandMatch = actualBand === exp.band;
  const coveredMatch = isCoveredOutput(actual.provenance, actual.confidence) === exp.covered;
  return {
    key: exp.key,
    kind: exp.kind,
    found: true,
    provenanceMatch,
    bandMatch,
    coveredMatch,
    pass: provenanceMatch && bandMatch && coveredMatch,
    actualProvenance: actual.provenance,
    actualBand,
    actualConfidence: actual.confidence,
  };
}

/** Score one fixture's expectations + forbidden keys against the extractor's output. */
export function scoreFixture(fixture: GoldenFixture, output: AnswerExtraction): FixtureResult {
  const expectations = fixture.expectations.map((exp) => scoreExpectation(output, exp));
  const emittedKeys = new Set<string>([
    ...output.answers.map((a) => a.slotKey),
    ...(output.dataSlotFills ?? []).map((f) => f.dataSlotKey),
  ]);
  const forbiddenEmitted = (fixture.forbiddenKeys ?? []).filter((k) => emittedKeys.has(k));
  return {
    id: fixture.id,
    knownGap: fixture.knownGap ?? false,
    expectations,
    forbiddenEmitted,
    pass: expectations.every((e) => e.pass) && forbiddenEmitted.length === 0,
  };
}

/** Roll fixture results up into a scorecard. Safe on an empty run (accuracies report 1). */
export function aggregate(results: FixtureResult[]): Scorecard {
  const allExp = results.flatMap((r) => r.expectations);
  const n = allExp.length;
  const rate = (count: number): number => (n === 0 ? 1 : count / n);
  return {
    fixtures: results.length,
    fixturesPassed: results.filter((r) => r.pass).length,
    expectations: n,
    provenanceAccuracy: rate(allExp.filter((e) => e.provenanceMatch).length),
    bandAccuracy: rate(allExp.filter((e) => e.bandMatch).length),
    coveredAccuracy: rate(allExp.filter((e) => e.coveredMatch).length),
    overallAccuracy: rate(allExp.filter((e) => e.pass).length),
    forbiddenEmissions: results.reduce((sum, r) => sum + r.forbiddenEmitted.length, 0),
    failedKnownGaps: results.filter((r) => !r.pass && r.knownGap).map((r) => r.id),
    failedRegressions: results.filter((r) => !r.pass && !r.knownGap).map((r) => r.id),
  };
}
