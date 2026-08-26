/**
 * Interviewer opening questions — suggestion pass.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/opening-examples/suggest
 *   Admin-only. Reads the version (subject, goal, audience, section titles, a sample of questions
 *   and its defined terms) and returns a few proposed opening questions, each with a reason the
 *   admin can judge.
 *
 *   Gate order: withAdminAuth → per-admin suggest sub-cap → load + scope the version → suggest.
 *
 *   **Read-only by design.** There is no apply endpoint: the admin accepts the proposals they want
 *   into the editor and the ordinary config PATCH saves them, audited like any other settings
 *   change. An opener the admin never read would be the first thing a real respondent is asked.
 *
 *   The run IS recorded (`recordAiRun`, kind `opening_examples_suggest`), on the same grounds as
 *   the house-rules assistant: a one-shot analysis whose proposals a human adjudicates into durable
 *   config that shapes what real respondents are asked.
 *
 * @see lib/app/questionnaire/opening-examples/suggest.ts — the analysis behind the proposals
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';

import { narrowInterviewerStrategy } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import {
  MAX_QUESTIONS_IN_PROMPT,
  MAX_SECTIONS_IN_PROMPT,
  suggestOpeningExamples,
} from '@/lib/app/questionnaire/opening-examples/suggest';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { openingExamplesSuggestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { isRecord } from '@/lib/utils';

/** Defined terms sampled in. A long glossary adds little beyond the first handful. */
const MAX_TERMS = 20;

/**
 * Pull the three audience fields the assistant uses out of the version's `audience` Json. Missing or
 * malformed entries are simply absent — a partial audience still makes for a useful prompt.
 */
function readAudience(value: unknown): {
  role?: string;
  expertiseLevel?: string;
  sensitivity?: string;
} {
  if (!isRecord(value)) return {};
  const out: { role?: string; expertiseLevel?: string; sensitivity?: string } = {};
  for (const key of ['role', 'expertiseLevel', 'sensitivity'] as const) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim();
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const handleSuggest = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const adminId = session.user.id;
    const { id, vid } = await params;

    const rl = openingExamplesSuggestLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Opening examples suggest rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    // `questionnaireId: id` scopes the version to the questionnaire in the URL — a cross-version id
    // is a 404, not a silent read of someone else's questionnaire.
    const version = await prisma.appQuestionnaireVersion.findFirst({
      where: { id: vid, questionnaireId: id },
      select: {
        id: true,
        goal: true,
        audience: true,
        questionnaire: { select: { title: true } },
        config: {
          select: {
            sensitivityAwareness: true,
            interviewerStrategy: true,
          },
        },
        sections: {
          orderBy: { ordinal: 'asc' },
          take: MAX_SECTIONS_IN_PROMPT,
          select: {
            title: true,
            // `take` per section, so a 500-question instrument doesn't load 500 prompts to use 40.
            // The flattened list is capped again below — sections can't know the running total.
            questions: {
              orderBy: { ordinal: 'asc' },
              take: MAX_QUESTIONS_IN_PROMPT,
              select: { prompt: true },
            },
          },
        },
        glossaryTerms: {
          where: { status: 'accepted' },
          orderBy: { ordinal: 'asc' },
          take: MAX_TERMS,
          select: { term: true },
        },
      },
    });

    if (!version) {
      return errorResponse('Questionnaire version not found', {
        code: 'NOT_FOUND',
        status: 404,
      });
    }

    const questions = version.sections
      .flatMap((s) => s.questions.map((q) => q.prompt))
      .slice(0, MAX_QUESTIONS_IN_PROMPT);
    const sectionTitles = version.sections
      .map((s) => s.title)
      .filter((title) => title.trim() !== '');
    // Narrowed, so the assistant is told about the same examples the runtime would actually use —
    // a whitespace row the editor has not saved yet is not an opener to avoid restating.
    const strategy = narrowInterviewerStrategy(version.config?.interviewerStrategy);

    const startedAt = Date.now();
    try {
      const result = await suggestOpeningExamples({
        versionId: vid,
        context: {
          title: version.questionnaire.title,
          goal: version.goal ?? '',
          audience: readAudience(version.audience),
          sectionTitles,
          questions,
          glossaryTerms: version.glossaryTerms.map((t) => t.term),
          sensitivityAwareness: version.config?.sensitivityAwareness ?? false,
          existingExamples: strategy.openingExamples,
        },
      });

      // Kept even when it proposes nothing: "we ran it and it had nothing to add for this
      // questionnaire" is a real answer, and losing it means paying to learn the same thing twice.
      void recordAiRun({
        subjectKind: 'version',
        subjectId: vid,
        versionId: vid,
        kind: 'opening_examples_suggest',
        provider: result.provider,
        model: result.model,
        outputSnapshot: result.suggestions,
        costUsd: result.costUsd,
        durationMs: Date.now() - startedAt,
        detail: {
          count: result.suggestions.length,
          existingCount: strategy.openingExamples.length,
          approach: strategy.approach,
        },
        triggeredByUserId: adminId,
      });

      log.info('Opening examples suggested', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        count: result.suggestions.length,
      });

      return successResponse({ suggestions: result.suggestions });
    } catch (err) {
      void recordAiRun({
        subjectKind: 'version',
        subjectId: vid,
        versionId: vid,
        kind: 'opening_examples_suggest',
        status: 'failed',
        // Correct as-is: this is the failure path, so no model served the call. The SUCCESS path
        // above already records the resolved binding (`result.provider` / `result.model`).
        provider: 'n/a',
        model: 'n/a',
        durationMs: Date.now() - startedAt,
        error: errorMessage(err),
        triggeredByUserId: adminId,
      });
      logger.error('Opening examples suggest failed', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        error: errorMessage(err),
      });
      return errorResponse('Could not suggest opening questions right now. Please try again.', {
        code: 'OPENING_EXAMPLES_SUGGEST_FAILED',
        status: 502,
      });
    }
  }
);

export const POST = handleSuggest;
