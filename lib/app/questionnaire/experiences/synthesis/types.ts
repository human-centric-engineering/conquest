/**
 * Experience-wide synthesis (P15.8) — content contract and vocabularies.
 *
 * One view across a whole journey, written over FINISHED per-step outputs. Pure and client-safe:
 * no Prisma, no Next.
 *
 * ## What makes this different from a step report
 *
 * A step report answers "what did the people who reached this step say?". The experience-wide view
 * answers the question no single step can: **how did the journey behave as a whole** — where the
 * population divided, where two branches or two rooms disagreed, what held across all of them.
 * That is why {@link ExperienceSynthesisContent.divergences} is a first-class section rather than a
 * paragraph inside the narrative. Without it this feature is concatenated step reports with a new
 * heading, and there would be little reason to build it.
 *
 * ## Two fields the model does not get to write
 *
 * `coverage` and each finding's verified `sourceStepKeys` are computed SERVER-SIDE.
 *
 * Coverage is a fact about which reports existed at generation time — a model asked to describe its
 * own inputs will confabulate a tidy answer, and coverage is precisely the field a reader relies on
 * to judge how much to trust the rest. Citations are verified against the real step keys for the
 * same reason the meeting synthesiser recomputes support counts rather than trusting the model's:
 * ask for evidence, derive the conclusion yourself.
 */

/** Lifecycle of a synthesis row. Mirrors `COHORT_REPORT_STATUSES` so both surfaces read alike. */
export const EXPERIENCE_SYNTHESIS_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
export type ExperienceSynthesisStatus = (typeof EXPERIENCE_SYNTHESIS_STATUSES)[number];

/** Why a step did or did not contribute. Server-determined; never model output. */
export const SYNTHESIS_COVERAGE_REASONS = [
  'included',
  'no_report',
  'not_ready',
  'empty_report',
  'no_questionnaire',
  'no_insights',
] as const;
export type SynthesisCoverageReason = (typeof SYNTHESIS_COVERAGE_REASONS)[number];

/** Reader-facing wording for each reason. */
export const SYNTHESIS_COVERAGE_REASON_LABELS: Record<SynthesisCoverageReason, string> = {
  included: 'Included',
  no_report: 'No report generated yet',
  not_ready: 'Report still generating',
  empty_report: 'Report has no content yet',
  no_questionnaire: 'No questionnaire attached',
  no_insights: 'No findings above the support threshold',
};

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

export const SYNTHESIS_NARRATIVE_MAX = 6_000;
export const SYNTHESIS_STATEMENT_MAX = 500;
export const SYNTHESIS_DETAIL_MAX = 2_000;
export const SYNTHESIS_CAVEAT_MAX = 1_000;
export const SYNTHESIS_MAX_FINDINGS = 16;
export const SYNTHESIS_MAX_DIVERGENCES = 10;
export const SYNTHESIS_MAX_CAVEATS = 8;
export const SYNTHESIS_MAX_SOURCE_KEYS = 24;

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

/** One thing the journey showed, with the steps that back it. */
export interface ExperienceSynthesisFinding {
  statement: string;
  detail: string | null;
  /** Step keys, already verified to exist and to have contributed. May be empty. */
  sourceStepKeys: string[];
}

/**
 * Where the journey disagreed with itself.
 *
 * Separate from a finding because it carries the opposite burden of proof: a finding wants
 * consistent support, a divergence wants at least two sources that point different ways. Merging
 * them would let a one-sided claim be dressed as a contrast.
 */
export interface ExperienceSynthesisDivergence {
  statement: string;
  detail: string | null;
  sourceStepKeys: string[];
}

/** Whether one step contributed, and why. Server-computed. */
export interface ExperienceSynthesisCoverage {
  stepKey: string;
  stepTitle: string;
  included: boolean;
  reason: SynthesisCoverageReason;
}

export interface ExperienceSynthesisContent {
  narrative: string;
  findings: ExperienceSynthesisFinding[];
  divergences: ExperienceSynthesisDivergence[];
  /** Server-computed, one entry per eligible step. Never written by the model. */
  coverage: ExperienceSynthesisCoverage[];
  caveats: string[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function nullableText(value: unknown, max: number): string | null {
  const out = text(value, max);
  return out === '' ? null : out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const t = text(item, itemMax);
    if (t !== '') out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function claimList(
  value: unknown,
  max: number
): Array<{ statement: string; detail: string | null; sourceStepKeys: string[] }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ statement: string; detail: string | null; sourceStepKeys: string[] }> = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const statement = text(raw.statement, SYNTHESIS_STATEMENT_MAX);
    // A claim with no statement is not a claim — drop rather than render an empty bullet.
    if (statement === '') continue;
    out.push({
      statement,
      detail: nullableText(raw.detail, SYNTHESIS_DETAIL_MAX),
      sourceStepKeys: stringList(raw.sourceStepKeys, SYNTHESIS_MAX_SOURCE_KEYS, 64),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Coerce an opaque persisted blob into a complete {@link ExperienceSynthesisContent}.
 *
 * Never throws — the column is Json we wrote, but it may be from an older shape or hand-edited, and
 * a report page that 500s on one bad row is worse than one that renders what it can.
 */
export function validateExperienceSynthesisContent(raw: unknown): ExperienceSynthesisContent {
  const obj = isRecord(raw) ? raw : {};

  const coverage: ExperienceSynthesisCoverage[] = Array.isArray(obj.coverage)
    ? obj.coverage.flatMap((entry): ExperienceSynthesisCoverage[] => {
        if (!isRecord(entry)) return [];
        const stepKey = text(entry.stepKey, 64);
        if (stepKey === '') return [];
        const reason = SYNTHESIS_COVERAGE_REASONS.includes(entry.reason as SynthesisCoverageReason)
          ? (entry.reason as SynthesisCoverageReason)
          : 'no_report';
        return [
          {
            stepKey,
            stepTitle: text(entry.stepTitle, 200) || stepKey,
            included: entry.included === true,
            reason,
          },
        ];
      })
    : [];

  return {
    narrative: text(obj.narrative, SYNTHESIS_NARRATIVE_MAX),
    findings: claimList(obj.findings, SYNTHESIS_MAX_FINDINGS),
    divergences: claimList(obj.divergences, SYNTHESIS_MAX_DIVERGENCES),
    coverage,
    caveats: stringList(obj.caveats, SYNTHESIS_MAX_CAVEATS, SYNTHESIS_CAVEAT_MAX),
  };
}

/**
 * Did generation actually produce something worth showing?
 *
 * A narrative alone counts: a journey where every step agreed has no divergences, and saying so is
 * a legitimate result rather than a failure.
 */
export function isUsableSynthesisContent(content: ExperienceSynthesisContent): boolean {
  return content.narrative !== '' || content.findings.length > 0;
}
