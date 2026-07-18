/**
 * The report method summary — a plain-English explanation of how one report was produced, written by
 * a meta-agent and grounded strictly in the observed {@link ReportMethodRecord}.
 *
 * The point of this surface is to reassure a respondent that the process was rigorous. That makes it
 * uniquely dangerous: an explanation of a process is exactly the kind of prose an LLM can write
 * fluently and confidently from nothing, and a fabricated reassurance ("we cross-checked 12 clinical
 * sources") is worse than no explanation at all — it converts an honest gap into a false claim about
 * the system's own diligence.
 *
 * So the agent here is deliberately hemmed in. It sees ONLY the record (never the report, the answers,
 * or the sources themselves), it is told to describe and not to praise, and its output is machine-
 * checked before it is trusted:
 *
 *  1. **Numeric grounding** — every number in the prose must appear in the record. This is the load-
 *     bearing check: invented rigour almost always shows up as an invented count.
 *  2. **No citations** — the prose may not contain URLs or bracketed citation markers; sources are
 *     rendered deterministically from the record beneath it, not narrated.
 *  3. **Length** — a short explanation, not an essay that pads with unverifiable process claims.
 *
 * On any failure — agent unseeded, provider error, timeout, or a rejected check — this falls back to
 * {@link renderMethodSummaryTemplate}, the deterministic rendering of the same record. The respondent
 * always gets a truthful explanation; the agent only ever changes how warmly it reads.
 *
 * Best-effort by contract: never throws. A report must never fail because its explanation did.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import { REPORT_METHOD_EXPLAINER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import {
  renderMethodSummaryTemplate,
  type ReportMethodRecord,
} from '@/lib/app/questionnaire/report/method-record';

/** Summary tuning — a few sentences, so a tight budget and a snappy ceiling. */
const SUMMARY_MAX_TOKENS = 400;
const SUMMARY_TIMEOUT_MS = 20_000;

/** Hard cap on the stored summary. Comfortably above a good answer, well below an essay. */
export const REPORT_METHOD_SUMMARY_MAX = 1200;

export interface MethodSummaryResult {
  text: string;
  source: 'agent' | 'template';
  costUsd: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The set of numbers the summary is allowed to state — every count the record actually observed.
 *
 * Percentages are included as their own value, and each count is also admitted as a percentage-free
 * bare integer. Anything outside this set means the agent produced a quantity nobody measured.
 */
export function allowedNumbers(record: ReportMethodRecord): Set<number> {
  const { answers, knowledge, research } = record;
  return new Set<number>([
    answers.answered,
    answers.total,
    answers.completionPct,
    answers.unansweredListed,
    knowledge.documentsInScope,
    knowledge.documentsUsed.length,
    knowledge.snippetCount,
    research.searches.length,
    research.sources.length,
  ]);
}

/**
 * Reject a summary that states a number the record doesn't contain, cites a source, or runs long.
 *
 * Returns the reason for rejection, or `null` when the text is safe to trust. Exported for tests —
 * this is the check the whole feature's honesty rests on, so it is unit-tested directly rather than
 * only through the agent path.
 */
export function rejectSummary(text: string, record: ReportMethodRecord): string | null {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > REPORT_METHOD_SUMMARY_MAX) return 'too_long';

  // Sources are rendered from the record, never narrated — a URL in the prose is either an invention
  // or a duplication of data we already display verifiably.
  if (/https?:\/\//i.test(trimmed) || /\[\d+\]/.test(trimmed)) return 'contains_citation';

  const allowed = allowedNumbers(record);
  // Digit runs only. Number-words ("all", "a few") carry no falsifiable count, and the prompt asks for
  // plain language, so this check targets precisely the failure mode that matters: fabricated tallies.
  for (const match of trimmed.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const raw = match[0].replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value)) return 'unparseable_number';
    if (!allowed.has(value)) return `ungrounded_number:${raw}`;
  }

  return null;
}

/**
 * The record as the agent sees it — counts and flags only.
 *
 * Note what is withheld: search queries, document names, and source URLs. The agent doesn't need them
 * to describe the process, and handing it retrieved third-party text (search queries and titles are
 * attacker-influenceable) would put untrusted content into a prompt whose output we then show to a
 * respondent as a statement about our own system.
 */
function recordDigest(record: ReportMethodRecord): string {
  const { answers, knowledge, research, passes } = record;
  return JSON.stringify(
    {
      isSampleNotRealRespondent: record.preview,
      answers: {
        questionsAnswered: answers.answered,
        questionsTotal: answers.total,
        unansweredQuestionsShownAsGaps: answers.unansweredListed,
        usedBackgroundFromConversation: answers.usedDataSlots,
        lowConfidenceAnswersDownWeighted: answers.confidenceWeighted,
      },
      organisationDocuments: {
        searched: knowledge.consulted,
        documentsAvailable: knowledge.documentsInScope,
        documentsThatContributed: knowledge.documentsUsed.length,
        passagesUsed: knowledge.snippetCount,
      },
      webResearch: {
        ran: research.ran,
        searchesPerformed: research.searches.length,
        sourcesKept: research.sources.length,
        sourcesInformedTheWriting: research.informedNarrative,
      },
      checks: {
        unansweredQuestionsFencedOffSoNothingWasAssumed: passes.coverageFence,
        separateWordingAndLayoutPass: passes.formatter,
        supportingAppendixAdded: passes.appendix,
      },
    },
    null,
    2
  );
}

const SUMMARY_RULES =
  'Write a short, plain-English explanation of how this report was produced, addressed to the person ' +
  'who completed the questionnaire ("you", "your answers"). 2 to 4 sentences, one paragraph, no ' +
  'headings, no bullet points, no markdown.\n\n' +
  'HARD RULES:\n' +
  '- Describe ONLY what the record below says happened. Never mention a step whose flag is false or ' +
  'absent, and never imply a check, review, or safeguard that is not recorded.\n' +
  '- Every number you write MUST appear in the record. Do not compute new numbers, do not estimate, ' +
  'do not round, and prefer words ("all of your answers") where the record makes a count unnecessary.\n' +
  '- Do not include URLs, source names, citations, or bracketed markers.\n' +
  "- Do not describe the report's findings or content — only how it was made.\n" +
  '- Avoid jargon: no "RAG", "vector search", "embeddings", "LLM", "model", "agent", "pipeline", ' +
  '"tokens", or "prompt". Say "your answers", "your organisation\'s documents", "web sources", ' +
  '"a separate check".\n' +
  '- Be factual and calm. Do NOT oversell, and do not use words like "rigorous", "thorough", ' +
  '"comprehensive", or "exhaustive" — describe what was done and let it speak for itself.';

/**
 * Produce the plain-English method summary for a finished run.
 *
 * Always returns usable text: the agent's version when it passed every check, otherwise the
 * deterministic template. `costUsd` is whatever the attempt spent (0 when it never reached a provider).
 */
export async function summariseReportMethod(
  record: ReportMethodRecord
): Promise<MethodSummaryResult> {
  const fallback = (costUsd = 0, reason?: string): MethodSummaryResult => {
    if (reason) {
      logger.warn('report method summary: falling back to deterministic template', { reason });
    }
    return { text: renderMethodSummaryTemplate(record), source: 'template', costUsd };
  };

  // Preview runs never go to the agent. The digest flags a synthesised respondent, but instruction-
  // following is not a guarantee: in live testing the agent read a preview record and wrote "based on
  // all of your answers to the 12 questions you completed" — describing a made-up sample as the
  // reader's own answers, the single most misleading thing this panel could say. The deterministic
  // template leads with the disclaimer by construction, and warm prose buys nothing on an admin-facing
  // sample, so this short-circuits rather than paying for a call that can only get it wrong.
  if (record.preview) return fallback();

  try {
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: REPORT_METHOD_EXPLAINER_AGENT_SLUG },
      select: {
        provider: true,
        model: true,
        fallbackProviders: true,
        systemInstructions: true,
        temperature: true,
        maxTokens: true,
      },
    });
    if (!agent) return fallback(0, 'agent_not_seeded');

    // Chat tier: this is a short, constrained rewrite of a structured digest, not reasoning work.
    const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'chat');
    const provider = await getProvider(providerSlug);

    const system = [agent.systemInstructions.trim(), SUMMARY_RULES].filter(Boolean).join('\n\n');
    const response = await provider.chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Record of how this report was produced:\n\n${recordDigest(record)}\n\nWrite the explanation now.`,
        },
      ],
      {
        model,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens || SUMMARY_MAX_TOKENS,
        timeoutMs: SUMMARY_TIMEOUT_MS,
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      }
    );

    const costUsd = calculateCost(
      model,
      response.usage.inputTokens,
      response.usage.outputTokens
    ).totalCostUsd;

    const text = typeof response.content === 'string' ? response.content.trim() : '';
    const rejection = rejectSummary(text, record);
    if (rejection) return fallback(costUsd, rejection);

    return { text, source: 'agent', costUsd };
  } catch (err) {
    return fallback(0, `error:${errorMessage(err)}`);
  }
}
