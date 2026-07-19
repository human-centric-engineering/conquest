/**
 * Report formatting — a best-effort second pass over a generated report. `report/generate.ts`
 * always invokes it; "optional" means it degrades, not that it is gated: on any failure it
 * returns the original content with `formatted: false`.
 *
 * The report WRITER agent (`report/generate.ts`) is responsible for grounded substance; this pass is
 * responsible for FORM only. It re-paragraphs the prose at natural boundaries, converts inline
 * dash-runs / enumerations into bullet lists, and strips AI-isms (em-dash overuse, flowery filler) —
 * the things a content agent is poor at self-policing mid-generation, and that the deterministic
 * `splitReportParagraphs` fallback can only approximate with a blunt sentence count.
 *
 * Report-kind-agnostic: it operates on the shared `summary / sections[{heading,body}] / actions` core,
 * so the Cohort Report can reuse it later (passing `format: 'markdown'`, since its bodies are markdown
 * before the `markdownToHtml` conversion). This pass touches ONLY prose; `actions` pass through
 * verbatim.
 *
 * Load-bearing safety property: a fidelity guard defends against *structural* loss and gross deletion.
 * It requires the formatter's output to keep the same sections, headings, and action count, keep every
 * block non-empty, and retain at least {@link MIN_PROSE_RATIO} of the original prose length (a coarse
 * backstop against a section body being largely truncated). On any drift, parse failure, timeout, or
 * provider error it returns the ORIGINAL content unchanged with `formatted: false`, so the caller
 * stores it as un-trusted and the renderers apply the deterministic split exactly as before.
 *
 * It CANNOT verify semantic fidelity within a body — a formatter that reworded or dropped a single
 * sentence while keeping the heading, count, and enough length passes the guard. That is delegated to
 * the strict "preserve meaning exactly" prompt contract, not machine-checked here; the guard is a
 * structural + volume safety net, not a semantic diff.
 *
 * Pure orchestration around mockable seams (prisma, the agent resolver, the provider). Server-side only.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { REPORT_FORMATTER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import {
  validateRespondentReportContent,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';

/** Output prose convention the formatter should emit. */
export type ReportFormatKind = 'plaintext' | 'markdown';

export interface FormatReportOptions {
  /**
   * `plaintext` (respondent report) — blank-line-separated paragraphs and `- ` bullet lines, no
   * markdown emphasis. `markdown` (cohort report, pre-`markdownToHtml`) — full Markdown.
   */
  format: ReportFormatKind;
}

/** Result of one formatting pass. `formatted` is false when the guard fell back to the original. */
export interface FormattedReport {
  content: RespondentReportContent;
  costUsd: number;
  formatted: boolean;
}

/** Formatter tuning — a near-length-preserving reshape; 60s ceiling like generation. */
const FORMAT_MAX_TOKENS = 4096;
const FORMAT_TIMEOUT_MS = 60_000;

/**
 * Minimum fraction of the original prose length the reformatted output must retain. Legitimate
 * de-slopping + bullet conversion trims maybe 10–30%; dropping below half means a body was largely
 * truncated (content loss), so the guard rejects it and falls back to the unformatted content. Coarse
 * by design — it cannot catch a single dropped sentence, only gross deletion.
 */
const MIN_PROSE_RATIO = 0.5;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatConvention(format: ReportFormatKind): string {
  return format === 'markdown'
    ? 'Output Markdown: a blank line between paragraphs, and "- " at the start of each bullet-list line.'
    : 'Output plain text (no Markdown emphasis, no headings syntax): separate paragraphs with a blank ' +
        'line, and start each bullet-list line with "- ".';
}

/** Assemble the formatter agent's system + user messages. */
function buildFormatMessages(opts: {
  agentInstructions: string;
  format: ReportFormatKind;
  content: RespondentReportContent;
}): LlmMessage[] {
  const { agentInstructions, format, content } = opts;

  const system: string[] = [];
  if (agentInstructions.trim()) system.push(agentInstructions.trim());
  system.push(
    'Reformat the report below. Improve ONLY its form: re-paragraph the `summary` and each section ' +
      '`body` at natural, meaningful boundaries (one idea per paragraph — never a single wall of text, ' +
      'nor lots of tiny uniform fragments); where a passage genuinely enumerates items, options, ' +
      'factors, or steps, turn it into a bullet list; and strip AI-isms — reduce over-used em dashes ' +
      '(rewrite them as commas, full stops, or parentheses) and cut flowery or filler words and ' +
      'needless hedging.'
  );
  system.push(
    'PRESERVE MEANING EXACTLY. Do not add, remove, merge, split, or reword any fact, claim, heading, ' +
      'section, or action beyond this formatting. Keep every section and return its heading verbatim. ' +
      'Keep the same number of sections and actions. Return the `actions` array unchanged. Keep the ' +
      'second-person voice. Never introduce information that was not already present.'
  );
  system.push(formatConvention(format));
  system.push(
    'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
      '{"summary": string, "sections": [{"heading": string, "body": string}], "actions": [string]}'
  );

  return [
    { role: 'system', content: system.join('\n\n') },
    {
      role: 'user',
      content: `Report to reformat (JSON):\n\n${JSON.stringify(content)}\n\nReturn the reformatted JSON now.`,
    },
  ];
}

/** Total prose length of a report — the summary plus every section body (headings/actions excluded). */
function proseLength(content: RespondentReportContent): number {
  return content.summary.length + content.sections.reduce((sum, s) => sum + s.body.length, 0);
}

/**
 * Verify the formatter's output is safe to trust as a drop-in replacement for the original: same
 * section count and headings (order + text), same action count, and at least {@link MIN_PROSE_RATIO}
 * of the original prose length retained (a coarse backstop against a body being largely truncated —
 * it cannot catch a single dropped sentence). `validateRespondentReportContent` has already enforced
 * non-empty blocks and caps. A false here means "fall back to the original".
 */
function preservesStructure(
  original: RespondentReportContent,
  formatted: RespondentReportContent
): boolean {
  if (formatted.sections.length !== original.sections.length) return false;
  if (formatted.actions.length !== original.actions.length) return false;
  if (proseLength(formatted) < proseLength(original) * MIN_PROSE_RATIO) return false;
  return original.sections.every(
    (section, i) => formatted.sections[i]?.heading === section.heading
  );
}

/**
 * Run the formatting pass over a report's content. On success returns the reformatted content with
 * `formatted: true`; on any failure or structural drift returns the original content unchanged with
 * `formatted: false`. `costUsd` reflects whatever the pass spent (0 when the call threw before
 * returning a cost). Never throws — formatting is best-effort polish on top of an already-valid report.
 */
export async function formatReportContent(
  content: RespondentReportContent,
  opts: FormatReportOptions
): Promise<FormattedReport> {
  const fallback = (costUsd = 0): FormattedReport => ({ content, costUsd, formatted: false });

  try {
    // The agent lookup is inside the try: a transient DB error here must fall back to the
    // unformatted content, never propagate up and fail an already-valid, already-paid-for report.
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: REPORT_FORMATTER_AGENT_SLUG },
      select: {
        id: true,
        provider: true,
        model: true,
        fallbackProviders: true,
        systemInstructions: true,
        temperature: true,
        maxTokens: true,
      },
    });
    if (!agent) {
      // Formatter not seeded — treat as disabled rather than failing the report.
      logger.warn('report formatter: agent not seeded; skipping formatting pass');
      return fallback();
    }

    const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'chat');
    const provider = await getProvider(providerSlug);
    const messages = buildFormatMessages({
      agentInstructions: agent.systemInstructions,
      format: opts.format,
      content,
    });

    const result = await runStructuredCompletion<RespondentReportContent>({
      provider,
      model,
      messages,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens || FORMAT_MAX_TOKENS,
      timeoutMs: FORMAT_TIMEOUT_MS,
      parse: (raw) => tryParseJson(raw, validateRespondentReportContent),
      retryUserMessage:
        'Respond with ONLY the JSON object {"summary","sections":[{"heading","body"}],"actions":[]} — no prose, no code fence.',
    });

    // Logged before the fidelity guard: a rejected reformat still spent the tokens.
    // `versionId` is null — the formatter is handed content + a format, never the version.
    logAppLlmCost({
      agentId: agent.id,
      provider: providerSlug,
      model,
      tokenUsage: result.tokenUsage,
      capability: 'app_report_format',
      versionId: null,
      extra: { format: opts.format },
    });

    if (!preservesStructure(content, result.value)) {
      logger.warn(
        'report formatter: output changed report structure; keeping unformatted content',
        {
          originalSections: content.sections.length,
          formattedSections: result.value.sections.length,
          originalActions: content.actions.length,
          formattedActions: result.value.actions.length,
        }
      );
      return fallback(result.costUsd);
    }

    // Actions pass through verbatim — the formatter is told to leave them unchanged, and the renderers
    // already lay them out as list items; using the original removes any risk of a reworded action.
    return {
      content: {
        summary: result.value.summary,
        sections: result.value.sections,
        actions: content.actions,
      },
      costUsd: result.costUsd,
      formatted: true,
    };
  } catch (err) {
    logger.warn('report formatter: formatting pass failed; keeping unformatted content', {
      error: errorMessage(err),
    });
    return fallback();
  }
}
