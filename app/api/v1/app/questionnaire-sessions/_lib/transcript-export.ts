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
import { DEMO_CLIENT_THEME_SELECT } from '@/lib/app/questionnaire/theming';

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
      // P21: resolving the section headings needs the version the session ran on.
      versionId: true,
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
                select: DEMO_CLIENT_THEME_SELECT,
              },
            },
          },
        },
      },
      // Verbatim conversation, oldest-first — the transcript body.
      turns: {
        orderBy: { ordinal: 'asc' },
        select: {
          userMessage: true,
          agentResponse: true,
          createdAt: true,
          // Sectioned interviews (P21): resolved to a label below, so the download reads as one
          // conversation per section. Null on every unsectioned session.
          sectionKey: true,
        },
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

  // P21: section key → respondent-facing label, for the transcript's section headings.
  //
  // Resolved from the version's CURRENT topics and sections rather than snapshotted per turn: an
  // export taken today should read by the names the questionnaire has today. An unresolvable key
  // falls back to the key itself, which is at least a stable divider — dropping the heading would
  // silently merge two sections into one block.
  //
  // Two queries, and only when a turn actually carries a key, so an unsectioned session pays
  // nothing at all.
  const sectionLabels = new Map<string, string>();
  if (row.turns.some((t) => t.sectionKey)) {
    const [topics, docSections] = await Promise.all([
      prisma.appQuestionnaireTopic.findMany({
        where: { versionId: row.versionId },
        select: { key: true, label: true },
      }),
      prisma.appQuestionnaireSection.findMany({
        where: { versionId: row.versionId },
        select: { id: true, title: true },
      }),
    ]);
    for (const topic of topics) sectionLabels.set(topic.key, topic.label);
    // Document-sourced sections key on the section id. Added second and only where the key is free,
    // so a topic never loses to a section that happens to share an identifier.
    for (const sec of docSections)
      if (!sectionLabels.has(sec.id)) sectionLabels.set(sec.id, sec.title);
  }

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
      // The stored key resolved to the section's label. Deliberately resolved from the version's
      // CURRENT topics rather than snapshotted per turn: a renamed section should read by its
      // current name in an export taken today. An unresolvable key falls back to the key itself,
      // which is at least a stable divider, rather than dropping the heading entirely.
      ...(t.sectionKey ? { sectionLabel: sectionLabels.get(t.sectionKey) ?? t.sectionKey } : {}),
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
