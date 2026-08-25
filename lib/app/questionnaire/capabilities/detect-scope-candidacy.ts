/**
 * Adaptive Scope ingestion-time candidacy check (P17.19).
 *
 * A `BaseCapability` that runs ONE cheap, fast structured LLM call over a freshly-uploaded
 * document and decides whether it is worth flagging as an Adaptive Scope candidate — NOT the
 * Routing Analyst (`analyse-routing.ts`), which does the actual topic/rule proposal and only runs
 * automatically once this check fires.
 *
 * Modelled on `verify-extraction-structure.ts`: provider-agnostic `runStructuredCompletion`
 * (call → parse → retry-once-at-temp-0 → cost-sum), the agent's binding read from the dispatch
 * context (`entityContext.candidacyAgent`). Unlike the verifier and the analyst, this resolves the
 * `routing` tier, not `reasoning` — this runs on every fresh ingestion, so it must stay cheap.
 *
 * Since F17.22 Phase 3 it reads a COMPOSED excerpt (head + tail + routing-language windows, see
 * `candidacy-excerpt.ts`) rather than the document's first 20k characters, plus the extracted
 * section titles and question wordings — a role- or segment-shaped instrument states its routing
 * in its titles, and those may sit nowhere near the part of the text an excerpt can afford.
 *
 * It sees the uploaded document's text (which may carry examples or PII), so `processesPii = true`
 * with a redacted provenance form. Boundary: lives under `lib/app/**` — no Prisma, no Next.js.
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { z } from 'zod';

import { redactedString } from '@/lib/security/redact';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type { CapabilityContext, CapabilityResult } from '@/lib/orchestration/capabilities/types';
import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

import { DETECT_SCOPE_CANDIDACY_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import {
  validateScopeCandidacy,
  type ScopeCandidacyResult,
} from '@/lib/app/questionnaire/scope/candidacy-schema';
import {
  buildScopeCandidacyPrompt,
  buildScopeCandidacyRetryMessage,
} from '@/lib/app/questionnaire/scope/candidacy-prompt';

const SLUG = DETECT_SCOPE_CANDIDACY_FUNCTION_DEFINITION.name;

/** A verdict, up to 8 short signals, one summary — small output for a cheap check. */
const CANDIDACY_MAX_TOKENS = 1_024;

/**
 * One check; short because this runs on EVERY fresh ingestion and the admin is already watching
 * the extraction progress — it must not meaningfully add to that wait. Far below the analyst's
 * 180s: this is a yes/no triage read, not an exhaustive one.
 */
const CANDIDACY_TIMEOUT_MS = 20_000;

/**
 * Caps on the extracted structure. Generous enough for a real instrument (the pilot workbook runs
 * to 70 questions across 16 sections) and firm enough that a pathological upload cannot make the
 * triage read expensive. A truncated list is still evidence — routing-shaped titles cluster at the
 * front, where the sections that decide eligibility live.
 */
const MAX_SECTION_TITLES = 120;
const MAX_QUESTION_PROMPTS = 300;

const argsSchema = z.object({
  documentText: z.string().min(1),
  documentFileName: z.string().optional(),
  versionId: z.string().optional(),
  /**
   * The extracted structure (F17.22 Phase 3) — section titles and question wordings, in document
   * order. Capped here rather than only at the caller, because the caps are what keep this a cheap
   * read: an instrument with 900 questions must not quietly turn a triage call into a long one.
   */
  sectionTitles: z.array(z.string()).max(MAX_SECTION_TITLES).optional(),
  questionPrompts: z.array(z.string()).max(MAX_QUESTION_PROMPTS).optional(),
});

export type DetectScopeCandidacyArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the check's verdict. Nothing is persisted here. */
export interface DetectScopeCandidacyData {
  result: ScopeCandidacyResult;
}

/** Read the dispatched check agent's binding from the dispatch context (empty → system default). */
function readCandidacyAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.candidacyAgent;
  if (isRecord(raw)) {
    return {
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      fallbackProviders: Array.isArray(raw.fallbackProviders)
        ? raw.fallbackProviders.filter((value): value is string => typeof value === 'string')
        : [],
    };
  }
  return { provider: '', model: '', fallbackProviders: [] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AppDetectScopeCandidacyCapability extends BaseCapability<
  DetectScopeCandidacyArgs,
  DetectScopeCandidacyData
> {
  readonly slug = SLUG;
  readonly processesPii = true;
  readonly functionDefinition = DETECT_SCOPE_CANDIDACY_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  /**
   * Args carry the uploaded document's text (PII); the result's signals may echo spans of it.
   * Persist a safe audit form: the file name and verdict counts only — never the document text or
   * a quoted signal.
   */
  redactProvenance(
    args: DetectScopeCandidacyArgs,
    result: CapabilityResult<DetectScopeCandidacyData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      ...(args.documentFileName !== undefined ? { documentFileName: args.documentFileName } : {}),
      documentText: redactedString('documentText'),
      // Counts, never the text. The extracted structure is authored instrument content rather than
      // respondent data, but it is still lifted verbatim out of the upload — the same posture the
      // document text gets, for the same reason.
      ...(args.sectionTitles ? { sectionTitleCount: args.sectionTitles.length } : {}),
      ...(args.questionPrompts ? { questionPromptCount: args.questionPrompts.length } : {}),
    };
    const preview =
      result.success && result.data
        ? JSON.stringify({
            success: true,
            data: {
              isCandidate: result.data.result.isCandidate,
              confidence: result.data.result.confidence,
              signalCount: result.data.result.signals.length,
            },
          })
        : JSON.stringify(result);
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: DetectScopeCandidacyArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<DetectScopeCandidacyData>> {
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readCandidacyAgentBinding(context.entityContext),
        // The routing tier, not reasoning: this runs on every fresh ingestion and must stay cheap.
        'routing'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('detect_scope_candidacy: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('detect_scope_candidacy: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildScopeCandidacyPrompt({
      documentText: args.documentText,
      ...(args.documentFileName ? { documentFileName: args.documentFileName } : {}),
      ...(args.sectionTitles?.length ? { sectionTitles: args.sectionTitles } : {}),
      ...(args.questionPrompts?.length ? { questionPrompts: args.questionPrompts } : {}),
    });

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<ScopeCandidacyResult>;
    try {
      completion = await runStructuredCompletion<ScopeCandidacyResult>({
        provider,
        model,
        messages,
        maxTokens: CANDIDACY_MAX_TOKENS,
        timeoutMs: CANDIDACY_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateScopeCandidacy(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildScopeCandidacyRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Candidacy check response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('detect_scope_candidacy: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'candidacy_check_failed');
    }

    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: {
        capability: SLUG,
        ...(args.versionId ? { versionId: args.versionId } : {}),
      },
    }).catch((err) => {
      logger.error('detect_scope_candidacy: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({ result: completion.value });
  }
}
