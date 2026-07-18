/**
 * Report method record → the client-safe view behind the "How this report was created" panel.
 *
 * One record, two audiences. The respondent sees the plain-English summary, the headline counts, and
 * the web sources — enough to understand and check what shaped their report. An admin additionally
 * sees the operational detail (model, timings, cost, the exact search queries, which documents
 * contributed, and every stage including the ones that were skipped and why).
 *
 * The split is enforced here rather than in the components, so a respondent-facing surface cannot
 * accidentally render an admin field: `admin` is simply absent from a respondent view.
 *
 * Pure — no I/O. The sibling of `view.ts` for the report itself.
 */

import {
  renderMethodSummaryTemplate,
  type ReportMethodRecord,
  type ReportMethodStage,
} from '@/lib/app/questionnaire/report/method-record';

/** A headline count rendered in the "What went into it" panel. */
export interface ReportMethodFact {
  key: string;
  label: string;
  /** Pre-formatted for display (e.g. "34 of 40") — the record holds the raw numbers. */
  value: string;
}

/** Operational detail — admin surfaces only. */
export interface ReportMethodAdminDetail {
  model: { provider: string; model: string; tier: string } | null;
  costUsd: number;
  durationMs: number;
  /** Every search issued, in order, with the query text. */
  searches: { phase: 'before' | 'after'; query: string; resultCount: number }[];
  /** Documents that contributed a retrieved passage. */
  documents: { id: string; name: string; snippets: number }[];
  /** Every pipeline stage, including skipped ones and why. */
  stages: ReportMethodStage[];
  /** Whether the respondent-facing prose was agent-written or the deterministic fallback. */
  summarySource: 'agent' | 'template';
}

export interface ReportMethodClientView {
  /** Plain-English explanation. Never empty — falls back to the deterministic template. */
  summary: string;
  /** True when this record describes a synthesised sample rather than a real respondent's run. */
  preview: boolean;
  facts: ReportMethodFact[];
  /**
   * Web sources kept, for the respondent to check. Empty when no research ran — and also when the
   * admin hid the report's sources section and this is the respondent projection (the `sources`
   * COUNT still appears in `facts`, so the panel stays honest about what informed the report).
   */
  sources: { title: string; url: string }[];
  /** Short statements of the checks applied, rendered as a list. */
  checks: string[];
  /** Present only for `audience: 'admin'`. */
  admin?: ReportMethodAdminDetail;
}

export type ReportMethodAudience = 'respondent' | 'admin';

/**
 * Project a stored record onto the panel view for one audience.
 *
 * The summary falls back to {@link renderMethodSummaryTemplate} whenever the stored one is absent —
 * which is the normal case for reports generated while `delivery.explainMethod` was off (the record is
 * always captured; only the agent-written prose is gated). That keeps a later opt-in truthful with no
 * regeneration and no backfill.
 */
export function buildReportMethodView(
  record: ReportMethodRecord,
  audience: ReportMethodAudience
): ReportMethodClientView {
  const { answers, knowledge, research, passes } = record;

  const facts: ReportMethodFact[] = [];
  if (answers.total > 0) {
    facts.push({
      key: 'answers',
      label: 'Your answers',
      value:
        answers.answered === answers.total
          ? `All ${answers.total}`
          : `${answers.answered} of ${answers.total}`,
    });
  }
  if (answers.unansweredListed > 0) {
    facts.push({
      key: 'gaps',
      label: 'Questions noted as unanswered',
      value: String(answers.unansweredListed),
    });
  }
  if (knowledge.consulted) {
    facts.push({
      key: 'documents',
      label: 'Organisation documents used',
      value: String(knowledge.documentsUsed.length),
    });
  }
  if (research.ran) {
    facts.push({
      key: 'searches',
      label: 'Web searches run',
      value: String(research.searches.length),
    });
    facts.push({
      key: 'sources',
      label: 'Web sources kept',
      value: String(research.sources.length),
    });
  }

  // Only checks that actually ran. A check listed because it was *configured* would be exactly the
  // kind of unearned reassurance this panel exists to avoid.
  const checks: string[] = [];
  if (passes.coverageFence) {
    checks.push(
      'Questions you did not answer were listed as gaps, so nothing was assumed about them.'
    );
  }
  if (answers.confidenceWeighted) {
    checks.push('Less certain answers were given proportionally less weight.');
  }
  // Gated on sources SURVIVING, not merely on research having run: a search round that returned
  // nothing would otherwise render "web sources were used…" beneath a panel showing zero sources.
  if (research.ran && research.sources.length > 0) {
    checks.push(
      research.informedNarrative
        ? 'Web sources were used as general background only, never treated as facts about you.'
        : 'Web sources were listed for reference and did not shape the writing.'
    );
  }
  if (passes.formatter) {
    checks.push('A separate pass reviewed the wording and layout without changing the substance.');
  }

  // The admin set the report's sources section to "Don't show", so the respondent gets the COUNT
  // (the panel must not under-report what shaped their report) but not the links — re-surfacing
  // suppressed links here would quietly override a choice the admin made about respondents.
  // Operators always see the full list; the counts and checks above are unaffected either way.
  const withholdLinks = audience === 'respondent' && research.sourcesHiddenFromRespondent;

  const view: ReportMethodClientView = {
    summary: record.summary?.text || renderMethodSummaryTemplate(record),
    preview: record.preview,
    facts,
    sources: withholdLinks ? [] : research.sources,
    checks,
  };

  if (audience === 'admin') {
    view.admin = {
      model: record.model,
      costUsd: record.costUsd,
      durationMs: record.durationMs,
      searches: research.searches,
      documents: knowledge.documentsUsed,
      stages: record.stages,
      summarySource: record.summary?.source ?? 'template',
    };
  }

  return view;
}
