/**
 * Chat-transcript export — DB read seam + model assembly (F7.6).
 *
 * Loads everything the transcript renderers need for one session in a single query — the
 * persisted turns (with their timestamps), the support reference, the version's
 * goal/audience and demo-client theme, the `anonymousMode` config, and the session's
 * timing/status. The respondent's display name is looked up only when the session is NOT
 * anonymous — anonymous mode never even queries identity (the speaker label stays the
 * generic "Respondent").
 *
 * {@link assembleTranscriptExportModel} runs after the route authorises: for the PDF it
 * best-effort fetches the brand logo (so a flaky remote image can't break rendering); the
 * text export skips the fetch. It stamps the generation time and hands the plain rows to
 * the pure {@link buildTranscriptExportModel}.
 *
 * Route-local DB seam — the `lib/app/questionnaire/export/**` module is Prisma-free.
 * Sibling to the F7.4 answers-export seam (`session-export.ts`).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  SESSION_STATUSES,
  narrowToEnum,
  type AudienceShape,
  type SessionStatus,
} from '@/lib/app/questionnaire/types';
import {
  buildTranscriptExportModel,
  type TranscriptExportInput,
  type TranscriptTurnInput,
} from '@/lib/app/questionnaire/export/build-transcript-export-model';
import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';
import { fetchLogoDataUri } from '@/app/api/v1/app/questionnaire-sessions/_lib/fetch-logo-data-uri';

/** Raw demo-client theme columns (or null when the questionnaire is unattributed). */
interface RawTheme {
  ctaColor: string | null;
  accentColor: string | null;
  logoUrl: string | null;
  welcomeCopy: string | null;
}

/** The access fields + everything the pure builder needs, minus the fetched logo. */
export interface LoadedTranscriptExport {
  /** Access fields for `resolveTurnAccess` (respondent owner OR anonymous token). */
  session: { id: string; respondentUserId: string | null };
  /** Owning questionnaire — the admin routes 404 when it doesn't match the URL's `:id`. */
  questionnaireId: string;
  questionnaireTitle: string;
  versionNumber: number;
  goal: string | null;
  audience: AudienceShape | null;
  refRaw: string | null;
  anonymous: boolean;
  respondentName: string | null;
  startedAt: string;
  completedAt: string | null;
  status: SessionStatus;
  theme: RawTheme;
  turns: TranscriptTurnInput[];
}

/** Cast a stored `audience` Json column to the structured shape (null when absent). */
function asAudience(value: unknown): AudienceShape | null {
  return value && typeof value === 'object' ? value : null;
}

/**
 * Load a session's transcript export state. `null` when the session doesn't exist.
 */
export async function loadTranscriptExport(
  sessionId: string
): Promise<LoadedTranscriptExport | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      respondentUserId: true,
      publicRef: true,
      createdAt: true,
      updatedAt: true,
      version: {
        select: {
          versionNumber: true,
          goal: true,
          audience: true,
          config: { select: { anonymousMode: true } },
          questionnaire: {
            select: {
              id: true,
              title: true,
              demoClient: {
                select: { ctaColor: true, accentColor: true, logoUrl: true, welcomeCopy: true },
              },
            },
          },
        },
      },
      // Verbatim conversation, oldest-first — the transcript body.
      turns: {
        orderBy: { ordinal: 'asc' },
        select: { userMessage: true, agentResponse: true, createdAt: true },
      },
      // Latest completion event → the completion timestamp for the header.
      events: {
        where: { toStatus: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  if (!row) return null;

  const status = narrowToEnum(row.status, SESSION_STATUSES, 'active');
  const anonymous = row.version.config?.anonymousMode ?? false;

  // Identity is only ever queried when NOT anonymous — anonymous mode never touches it.
  let respondentName: string | null = null;
  if (!anonymous && row.respondentUserId) {
    const user = await prisma.user.findUnique({
      where: { id: row.respondentUserId },
      select: { name: true },
    });
    respondentName = user?.name ?? null;
  }

  const completedAt =
    row.events[0]?.createdAt.toISOString() ??
    (status === 'completed' ? row.updatedAt.toISOString() : null);

  const demoClient = row.version.questionnaire.demoClient;

  return {
    session: { id: row.id, respondentUserId: row.respondentUserId },
    questionnaireId: row.version.questionnaire.id,
    questionnaireTitle: row.version.questionnaire.title,
    versionNumber: row.version.versionNumber,
    goal: row.version.goal,
    audience: asAudience(row.version.audience),
    refRaw: row.publicRef,
    anonymous,
    respondentName,
    startedAt: row.createdAt.toISOString(),
    completedAt,
    status,
    theme: {
      ctaColor: demoClient?.ctaColor ?? null,
      accentColor: demoClient?.accentColor ?? null,
      logoUrl: demoClient?.logoUrl ?? null,
      welcomeCopy: demoClient?.welcomeCopy ?? null,
    },
    turns: row.turns.map((t) => ({
      userMessage: t.userMessage,
      agentResponse: t.agentResponse,
      at: t.createdAt.toISOString(),
    })),
  };
}

/**
 * Assemble the transcript export model from loaded rows. For the PDF, best-effort fetches
 * the brand logo (so a flaky remote image can't break the render); the text export passes
 * `{ fetchLogo: false }` to skip it (text has no logo). Stamps `generatedAt`, then
 * delegates to the pure builder. Call after the route authorises.
 */
export async function assembleTranscriptExportModel(
  loaded: LoadedTranscriptExport,
  { fetchLogo }: { fetchLogo: boolean }
): Promise<TranscriptExportModel> {
  const logoDataUri = fetchLogo ? await fetchLogoDataUri(loaded.theme.logoUrl) : null;
  if (fetchLogo && loaded.theme.logoUrl && !logoDataUri) {
    logger.warn('Transcript export: brand logo unavailable, rendering without it', {
      sessionId: loaded.session.id,
    });
  }

  const input: TranscriptExportInput = {
    questionnaireTitle: loaded.questionnaireTitle,
    versionNumber: loaded.versionNumber,
    goal: loaded.goal,
    audience: loaded.audience,
    refRaw: loaded.refRaw,
    anonymous: loaded.anonymous,
    respondentName: loaded.respondentName,
    startedAt: loaded.startedAt,
    completedAt: loaded.completedAt,
    status: loaded.status,
    generatedAt: new Date().toISOString(),
    // Carry the (possibly null) logo data URI through; the document renders it only when present.
    theme: { ...loaded.theme, logoUrl: logoDataUri },
    turns: loaded.turns,
  };

  return buildTranscriptExportModel(input);
}
