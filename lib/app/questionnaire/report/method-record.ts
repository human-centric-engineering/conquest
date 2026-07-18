/**
 * Report method record — the durable, deterministic account of how one report was actually produced.
 *
 * Report generation is hand-rolled orchestration (`generate.ts`), not a workflow DAG, so it gets none
 * of the engine's `output.sources` provenance for free (see `.context/orchestration/provenance.md`).
 * Before this module the pipeline discarded nearly everything an explanation would need: retrieved KB
 * chunks were flattened to prose and their ids dropped, search queries were never returned, and no
 * stage recorded whether it ran. This module closes that gap.
 *
 * The contract that makes the respondent-facing explanation trustworthy: **every field here is
 * observed, never inferred**. A {@link MethodRecorder} is threaded through the generation core and each
 * stage reports what it did as it does it. The plain-English summary written on top (see
 * `method-summary.ts`) is grounded strictly in this record and cross-checked against it — the record is
 * the source of truth, the prose is a rendering of it.
 *
 * Pure — no I/O, no LLM calls. Safe to import from anywhere.
 */

import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  narrowToEnum,
  RESPONDENT_REPORT_MODES,
  type RespondentReportMode,
} from '@/lib/app/questionnaire/types';
import { validHttpUrl } from '@/lib/app/questionnaire/report/content';
import { isRecord } from '@/lib/utils';

/**
 * Bumped when the record's shape changes incompatibly. Stored alongside the record so a reader can
 * refuse to render something it doesn't understand rather than displaying a half-populated
 * explanation — the one failure mode this feature must not have.
 */
export const REPORT_METHOD_SCHEMA_VERSION = 1;

/** Every stage of the generation pipeline that is worth accounting for. */
export const REPORT_METHOD_STAGE_KEYS = [
  'answers',
  'coverage',
  'knowledge',
  'research_before',
  'write',
  'format',
  'research_after',
  'appendix',
] as const;

export type ReportMethodStageKey = (typeof REPORT_METHOD_STAGE_KEYS)[number];

/**
 * Why a stage didn't run. Distinguishing these matters for honesty: "the admin turned this off" and
 * "we tried and the backend was down" are different claims, and collapsing them into a bare "skipped"
 * would let the summary imply a capability was deliberately unused when it actually failed.
 */
export const REPORT_METHOD_SKIP_REASONS = [
  'disabled', // config toggle off
  'unavailable', // configured, but the dependency wasn't there (no client KB, no search backend)
  'not_applicable', // nothing to do (e.g. no unanswered questions, no findings to synthesise)
  'failed', // attempted and errored — degraded, not silent
] as const;

export type ReportMethodSkipReason = (typeof REPORT_METHOD_SKIP_REASONS)[number];

export interface ReportMethodStage {
  key: ReportMethodStageKey;
  ran: boolean;
  /** Present only when `ran` is false. */
  skipReason?: ReportMethodSkipReason;
}

/** Answer coverage as the writer saw it. */
export interface ReportMethodAnswers {
  answered: number;
  total: number;
  completionPct: number;
  /** How many unanswered questions were listed to the writer as explicit negative space. */
  unansweredListed: number;
  /** True when confidence scores were surfaced and low-confidence items down-weighted. */
  confidenceWeighted: boolean;
  /** True when contextual data-slot understanding fed the report. */
  usedDataSlots: boolean;
}

/** One knowledge-base document that actually contributed a retrieved snippet. */
export interface ReportMethodKnowledgeDocument {
  id: string;
  name: string;
  /** How many of the retrieved snippets came from this document. */
  snippets: number;
}

export interface ReportMethodKnowledge {
  /** True when the client KB was searched (regardless of whether it returned anything). */
  consulted: boolean;
  /** Documents in the client's corpus that were in scope for the search. */
  documentsInScope: number;
  /** Documents that actually contributed a snippet — the honest "what informed this" number. */
  documentsUsed: ReportMethodKnowledgeDocument[];
  snippetCount: number;
}

/** One web search the researcher agent actually issued. */
export interface ReportMethodSearch {
  phase: 'before' | 'after';
  query: string;
  /** Results returned by the backend for this query (before cross-round dedupe). */
  resultCount: number;
}

export interface ReportMethodResearch {
  ran: boolean;
  searches: ReportMethodSearch[];
  /** Deduped sources that survived into the report. */
  sources: { title: string; url: string }[];
  /** True when findings were allowed to inform the report prose (vs. listed as sources only). */
  informedNarrative: boolean;
  /**
   * True when the admin set the report's sources section to `hidden`. Frozen here at generation time
   * (like `RespondentReportResearch.display`) rather than re-read from config later, so the panel
   * honours the choice that was actually in force for THIS report.
   *
   * The respondent panel then shows the source COUNT but withholds the links: the admin's choice was
   * about what respondents see, so re-surfacing suppressed links on a second respondent-facing
   * surface would quietly override it. Admins always see the full list.
   */
  sourcesHiddenFromRespondent: boolean;
}

/** Model attribution — admin-only detail; never shown to respondents. */
export interface ReportMethodModel {
  provider: string;
  model: string;
  tier: string;
}

/**
 * The complete account of one generation run. Persisted as JSON on the report (and revision) row, so
 * every field must survive a JSON round-trip.
 */
export interface ReportMethodRecord {
  schemaVersion: number;
  mode: RespondentReportMode;
  /**
   * True when produced by the admin preview flow, which synthesises a sample respondent and forces KB
   * grounding and web search off. Recorded so a previewed record can never be mistaken for — or
   * described as — a real run.
   */
  preview: boolean;
  answers: ReportMethodAnswers;
  knowledge: ReportMethodKnowledge;
  research: ReportMethodResearch;
  /** Second passes that shaped or checked the output. */
  passes: {
    /** The unanswered-question fence was in the writer's prompt. */
    coverageFence: boolean;
    /** The Report Formatter pass produced the delivered prose. */
    formatter: boolean;
    /** A synthesised supporting appendix was added. */
    appendix: boolean;
  };
  stages: ReportMethodStage[];
  model: ReportMethodModel | null;
  costUsd: number;
  durationMs: number;
  /**
   * The plain-English explanation. `source: 'agent'` when the meta-agent wrote it and it passed the
   * grounding checks; `'template'` when it was rendered deterministically from this record (the agent
   * was unavailable, failed, or was rejected). Null only while a run is still in flight.
   */
  summary: { text: string; source: 'agent' | 'template' } | null;
}

/**
 * Mutable collector threaded through the generation core.
 *
 * A builder rather than a return value on purpose: the pipeline has eight stages across four modules
 * and widening every signature to carry provenance would be a far more invasive change to a hot path
 * than passing one optional recorder. Stages that receive no recorder behave exactly as before, which
 * keeps the preview and any future caller free to opt out.
 */
export class MethodRecorder {
  private readonly startedAt: number;
  private readonly stages = new Map<ReportMethodStageKey, ReportMethodStage>();
  private answers: ReportMethodAnswers = {
    answered: 0,
    total: 0,
    completionPct: 0,
    unansweredListed: 0,
    confidenceWeighted: false,
    usedDataSlots: false,
  };
  private knowledge: ReportMethodKnowledge = {
    consulted: false,
    documentsInScope: 0,
    documentsUsed: [],
    snippetCount: 0,
  };
  private research: ReportMethodResearch = {
    ran: false,
    searches: [],
    sources: [],
    informedNarrative: false,
    sourcesHiddenFromRespondent: false,
  };
  private passes = { coverageFence: false, formatter: false, appendix: false };
  private model: ReportMethodModel | null = null;
  private costUsd = 0;

  constructor(
    private readonly mode: RespondentReportMode,
    private readonly preview: boolean,
    /** Injected for testability — defaults to the wall clock. */
    private readonly now: () => number = () => Date.now()
  ) {
    this.startedAt = this.now();
  }

  stageRan(key: ReportMethodStageKey): void {
    this.stages.set(key, { key, ran: true });
  }

  stageSkipped(key: ReportMethodStageKey, skipReason: ReportMethodSkipReason): void {
    this.stages.set(key, { key, ran: false, skipReason });
  }

  recordAnswers(value: ReportMethodAnswers): void {
    this.answers = value;
  }

  recordKnowledge(value: ReportMethodKnowledge): void {
    this.knowledge = value;
  }

  /**
   * `searches` is tolerated as undefined: it arrives from `runReportResearch`, a best-effort module
   * that never throws, and provenance bookkeeping must not be the thing that fails an otherwise-good
   * report. A phase that reports nothing simply leaves `research.ran` false.
   */
  recordSearches(
    phase: 'before' | 'after',
    searches: { query: string; resultCount: number }[] | undefined
  ): void {
    if (!searches || searches.length === 0) return;
    this.research.ran = true;
    this.research.searches.push(...searches.map((s) => ({ phase, ...s })));
  }

  recordSources(
    sources: { title: string; url: string }[] | undefined,
    informedNarrative: boolean,
    sourcesHiddenFromRespondent = false
  ): void {
    this.research.sources = (sources ?? []).map((s) => ({ title: s.title, url: s.url }));
    this.research.informedNarrative = informedNarrative;
    this.research.sourcesHiddenFromRespondent = sourcesHiddenFromRespondent;
  }

  recordPass(pass: keyof ReportMethodRecord['passes'], value: boolean): void {
    this.passes[pass] = value;
  }

  recordModel(value: ReportMethodModel): void {
    this.model = value;
  }

  addCost(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.costUsd += usd;
  }

  /** Freeze the record. `summary` is attached separately once the meta-agent has run. */
  build(): ReportMethodRecord {
    return {
      schemaVersion: REPORT_METHOD_SCHEMA_VERSION,
      mode: this.mode,
      preview: this.preview,
      answers: this.answers,
      knowledge: this.knowledge,
      research: this.research,
      passes: { ...this.passes },
      // Stable pipeline order rather than insertion order, so the rendered list always reads as a
      // sequence even if a stage records out of order.
      stages: REPORT_METHOD_STAGE_KEYS.map((key) => this.stages.get(key)).filter(
        (s): s is ReportMethodStage => s !== undefined
      ),
      model: this.model,
      costUsd: Number(this.costUsd.toFixed(6)),
      durationMs: Math.max(0, this.now() - this.startedAt),
      summary: null,
    };
  }
}

/* ── Deterministic rendering ──────────────────────────────────────────────── */

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Render the record as plain-English prose without an LLM.
 *
 * This is both the fallback when the meta-agent is unavailable or rejected, and the reference the
 * agent's output is checked against. It is deliberately plain: it states only what the record holds,
 * in the order the pipeline ran, with no reassurance the facts don't earn.
 */
export function renderMethodSummaryTemplate(record: ReportMethodRecord): string {
  const parts: string[] = [];
  const { answers, knowledge, research, passes } = record;

  if (record.preview) {
    parts.push(
      'This is a sample report generated from a synthesised respondent, so no real answers, ' +
        'documents, or web sources were used.'
    );
  }

  if (answers.total > 0) {
    const covered =
      answers.answered === answers.total
        ? `We read all ${plural(answers.total, 'answer', 'answers')} you gave.`
        : `We read the ${plural(answers.answered, 'answer', 'answers')} you gave, out of ` +
          `${answers.total} questions.`;
    parts.push(covered);
    if (answers.unansweredListed > 0) {
      parts.push(
        `The ${plural(answers.unansweredListed, 'question', 'questions')} you did not answer were ` +
          'noted as gaps, so nothing was assumed about them.'
      );
    }
  }

  if (answers.usedDataSlots) {
    parts.push(
      'Background you shared during the conversation was taken into account alongside your answers.'
    );
  }
  if (answers.confidenceWeighted) {
    parts.push('Where an answer was less certain, it was given proportionally less weight.');
  }

  if (knowledge.consulted) {
    parts.push(
      knowledge.documentsUsed.length > 0
        ? `We drew on ${plural(knowledge.documentsUsed.length, 'document', 'documents')} from your ` +
            "organisation's library."
        : "We searched your organisation's document library, which returned nothing relevant."
    );
  }

  if (research.ran) {
    const searched = `We ran ${plural(research.searches.length, 'web search', 'web searches')}`;
    parts.push(
      research.sources.length > 0
        ? `${searched} and kept ${plural(research.sources.length, 'source', 'sources')}.`
        : `${searched}, which returned nothing worth citing.`
    );
  }

  if (passes.formatter) {
    parts.push('A separate pass tidied the wording and layout without changing the substance.');
  }
  if (passes.appendix) {
    parts.push('A short supporting appendix was added from those sources.');
  }

  return parts.join(' ');
}

/* ── Defensive read path ──────────────────────────────────────────────────── */

function asInt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asStr(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Project a stored `methodRecord` Json column onto a complete {@link ReportMethodRecord}, or `null`.
 *
 * Returns `null` — deliberately, rather than a defaulted husk — for anything absent, malformed, or
 * written by a future schema version. Every report generated before this feature shipped has no
 * record, and the surfaces treat `null` as "don't offer the explanation" (see the read-path decision
 * in `.context/app/questionnaire/respondent-report.md`). Fabricating a plausible-looking record for a
 * run we didn't observe is exactly the failure this feature exists to prevent.
 */
export function narrowMethodRecord(value: unknown): ReportMethodRecord | null {
  if (!isRecord(value)) return null;
  if (asInt(value.schemaVersion, -1) !== REPORT_METHOD_SCHEMA_VERSION) return null;

  const answers = isRecord(value.answers) ? value.answers : {};
  const knowledge = isRecord(value.knowledge) ? value.knowledge : {};
  const research = isRecord(value.research) ? value.research : {};
  const passes = isRecord(value.passes) ? value.passes : {};
  const model = isRecord(value.model) ? value.model : null;
  const summary = isRecord(value.summary) ? value.summary : null;

  const summaryText = summary ? asStr(summary.text, 4000) : '';

  return {
    schemaVersion: REPORT_METHOD_SCHEMA_VERSION,
    // Narrowed against the enum, not cast: this column is external data by the time we read it back,
    // and a bare cast would let a malformed or legacy row present an arbitrary string as a valid mode.
    mode: narrowToEnum(
      asStr(value.mode, 40),
      RESPONDENT_REPORT_MODES,
      DEFAULT_RESPONDENT_REPORT_SETTINGS.mode
    ),
    preview: asBool(value.preview),
    answers: {
      answered: asInt(answers.answered),
      total: asInt(answers.total),
      completionPct: asInt(answers.completionPct),
      unansweredListed: asInt(answers.unansweredListed),
      confidenceWeighted: asBool(answers.confidenceWeighted),
      usedDataSlots: asBool(answers.usedDataSlots),
    },
    knowledge: {
      consulted: asBool(knowledge.consulted),
      documentsInScope: asInt(knowledge.documentsInScope),
      documentsUsed: Array.isArray(knowledge.documentsUsed)
        ? knowledge.documentsUsed.filter(isRecord).map((d) => ({
            id: asStr(d.id, 60),
            name: asStr(d.name, 300),
            snippets: asInt(d.snippets),
          }))
        : [],
      snippetCount: asInt(knowledge.snippetCount),
    },
    research: {
      ran: asBool(research.ran),
      searches: Array.isArray(research.searches)
        ? research.searches.filter(isRecord).map((s) => ({
            phase: s.phase === 'after' ? ('after' as const) : ('before' as const),
            query: asStr(s.query, 500),
            resultCount: asInt(s.resultCount),
          }))
        : [],
      // Scheme-validated on READ, not merely non-empty: these render into an `href`, so a
      // `javascript:`/`data:` URL would be a DOM-XSS sink. Today every URL is filtered at ingestion
      // by the web-search capability, so this is unreachable — but it is the same guard the report
      // body's own sources get (`validateResearch`), and the write path is exactly what a second
      // search backend would change.
      sources: Array.isArray(research.sources)
        ? research.sources
            .filter(isRecord)
            .map((s) => ({ title: asStr(s.title, 300), url: validHttpUrl(s.url) }))
            .filter((s): s is { title: string; url: string } => s.url !== null)
        : [],
      informedNarrative: asBool(research.informedNarrative),
      sourcesHiddenFromRespondent: asBool(research.sourcesHiddenFromRespondent),
    },
    passes: {
      coverageFence: asBool(passes.coverageFence),
      formatter: asBool(passes.formatter),
      appendix: asBool(passes.appendix),
    },
    stages: Array.isArray(value.stages)
      ? value.stages
          .filter(isRecord)
          .filter((s) => (REPORT_METHOD_STAGE_KEYS as readonly unknown[]).includes(s.key))
          .map((s) => {
            const stage: ReportMethodStage = {
              key: s.key as ReportMethodStageKey,
              ran: asBool(s.ran),
            };
            // Membership-checked, and OMITTED when it isn't a known reason rather than defaulted:
            // defaulting would assert a reason for the skip that we never actually observed, which is
            // the specific kind of unearned claim this whole record exists to prevent.
            if (
              !stage.ran &&
              (REPORT_METHOD_SKIP_REASONS as readonly unknown[]).includes(s.skipReason)
            ) {
              stage.skipReason = s.skipReason as ReportMethodSkipReason;
            }
            return stage;
          })
      : [],
    model: model
      ? {
          provider: asStr(model.provider, 60),
          model: asStr(model.model, 120),
          tier: asStr(model.tier, 40),
        }
      : null,
    costUsd:
      typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) ? value.costUsd : 0,
    durationMs: asInt(value.durationMs),
    summary: summaryText
      ? { text: summaryText, source: summary?.source === 'agent' ? 'agent' : 'template' }
      : null,
  };
}
