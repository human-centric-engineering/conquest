/**
 * Session PDF export — DB read seam + model assembly (F7.4).
 *
 * Loads everything the PDF needs for one session in a single query — the version's
 * section/slot structure, the captured answers, the per-turn ordinals (so refinement
 * history can resolve a turn index), plus the export-only header metadata the panel
 * read doesn't need: questionnaire title, version number, goal/audience, the
 * `anonymousMode` config, and the demo-client theme columns. The respondent's display
 * name is looked up only when the session is NOT anonymous — anonymous mode never even
 * queries identity.
 *
 * {@link buildSessionExportPdfModel} runs after the route authorises: it best-effort
 * fetches the brand logo (so a flaky remote image can't break rendering) and hands the
 * plain rows to the pure {@link buildSessionExportModel}.
 *
 * Route-local DB seam — the `lib/app/questionnaire/export/**` module is Prisma-free.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  SESSION_STATUSES,
  narrowToEnum,
  type AudienceShape,
  type SessionStatus,
} from '@/lib/app/questionnaire/types';
import type {
  PanelAnswerInput,
  PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import type { PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';
import {
  buildSessionExportModel,
  type SessionExportInput,
} from '@/lib/app/questionnaire/export/build-session-export-model';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

/** Raw demo-client theme columns (or null when the questionnaire is unattributed). */
interface RawTheme {
  ctaColor: string | null;
  accentColor: string | null;
  logoUrl: string | null;
  welcomeCopy: string | null;
}

/** The access fields + everything the pure builder needs, minus the fetched logo. */
export interface LoadedSessionExport {
  /** Access fields for `resolveTurnAccess` (respondent) / ownership (admin). */
  session: { id: string; respondentUserId: string | null };
  /** The questionnaire id the session's version belongs to (admin ownership check). */
  questionnaireId: string;
  questionnaireTitle: string;
  versionNumber: number;
  goal: string | null;
  audience: AudienceShape | null;
  anonymous: boolean;
  respondentName: string | null;
  completedAt: string | null;
  theme: RawTheme;
  status: SessionStatus;
  sections: PanelSectionInput[];
  answers: PanelAnswerInput[];
}

/** Cast a stored `refinementHistory` Json column back to our entry array. */
function asRefinementHistory(value: unknown): PanelRefinementEntry[] {
  return Array.isArray(value) ? (value as PanelRefinementEntry[]) : [];
}

/** Cast a stored `audience` Json column to the structured shape (null when absent). */
function asAudience(value: unknown): AudienceShape | null {
  return value && typeof value === 'object' ? value : null;
}

/**
 * Load a session's export state. `null` when the session doesn't exist. Mirrors the
 * answer-panel loader's query and extends it with the export-only header metadata.
 */
export async function loadSessionExport(sessionId: string): Promise<LoadedSessionExport | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      respondentUserId: true,
      updatedAt: true,
      version: {
        select: {
          versionNumber: true,
          goal: true,
          audience: true,
          questionnaireId: true,
          config: { select: { anonymousMode: true } },
          questionnaire: {
            select: {
              title: true,
              demoClient: {
                select: { ctaColor: true, accentColor: true, logoUrl: true, welcomeCopy: true },
              },
            },
          },
          sections: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              title: true,
              questions: {
                orderBy: { ordinal: 'asc' },
                select: { key: true, prompt: true, type: true, required: true },
              },
            },
          },
        },
      },
      answers: {
        select: {
          value: true,
          confidence: true,
          provenanceLabel: true,
          rationale: true,
          lastUpdatedTurnId: true,
          refinementHistory: true,
          questionSlot: { select: { key: true } },
        },
      },
      turns: { select: { id: true, ordinal: true } },
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

  // Completion timestamp: the latest `completed` event, else the row's updatedAt when the
  // session is completed, else null (an in-progress session has no completion date).
  const completedAt =
    row.events[0]?.createdAt.toISOString() ??
    (status === 'completed' ? row.updatedAt.toISOString() : null);

  const turnOrdinal = new Map(row.turns.map((t) => [t.id, t.ordinal]));

  const sections: PanelSectionInput[] = row.version.sections.map((s) => ({
    sectionId: s.id,
    title: s.title,
    slots: s.questions.map((q) => ({
      slotKey: q.key,
      prompt: q.prompt,
      type: q.type,
      required: q.required,
    })),
  }));

  const answers: PanelAnswerInput[] = row.answers.map((a) => ({
    slotKey: a.questionSlot.key,
    value: a.value,
    provenance: a.provenanceLabel,
    confidence: a.confidence,
    rationale: a.rationale,
    answeredAtTurnIndex:
      a.lastUpdatedTurnId != null ? (turnOrdinal.get(a.lastUpdatedTurnId) ?? null) : null,
    refinementHistory: asRefinementHistory(a.refinementHistory),
  }));

  const demoClient = row.version.questionnaire.demoClient;

  return {
    session: { id: row.id, respondentUserId: row.respondentUserId },
    questionnaireId: row.version.questionnaireId,
    questionnaireTitle: row.version.questionnaire.title,
    versionNumber: row.version.versionNumber,
    goal: row.version.goal,
    audience: asAudience(row.version.audience),
    anonymous,
    respondentName,
    completedAt,
    theme: {
      ctaColor: demoClient?.ctaColor ?? null,
      accentColor: demoClient?.accentColor ?? null,
      logoUrl: demoClient?.logoUrl ?? null,
      welcomeCopy: demoClient?.welcomeCopy ?? null,
    },
    status,
    sections,
    answers,
  };
}

/** How long to wait for the brand logo before rendering without it. */
const LOGO_FETCH_TIMEOUT_MS = 3000;
/** Cap the logo we embed (a runaway image shouldn't bloat the PDF / memory). */
const LOGO_MAX_BYTES = 1_000_000;

/**
 * Best-effort fetch of a brand logo as a base64 `data:` URI. Returns null on any failure
 * (absent URL, non-image, oversize, timeout, network error) so the document renders with
 * no logo rather than throwing mid-render. Only https URLs are fetched (the theme write
 * boundary already validates this; re-checked here as defence in depth).
 */
async function fetchLogoDataUri(url: string | null): Promise<string | null> {
  if (!url || !url.startsWith('https://')) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > LOGO_MAX_BYTES) return null;
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Assemble the export model from loaded rows — fetches the brand logo (best-effort) and
 * stamps the generation time, then delegates to the pure builder. Call after the route
 * authorises, so the logo fetch never runs for an unauthorised request.
 */
export async function buildSessionExportPdfModel(
  loaded: LoadedSessionExport
): Promise<SessionExportModel> {
  const logoDataUri = await fetchLogoDataUri(loaded.theme.logoUrl);
  if (loaded.theme.logoUrl && !logoDataUri) {
    logger.warn('Session export: brand logo unavailable, rendering without it', {
      sessionId: loaded.session.id,
    });
  }

  const input: SessionExportInput = {
    questionnaireTitle: loaded.questionnaireTitle,
    versionNumber: loaded.versionNumber,
    goal: loaded.goal,
    audience: loaded.audience,
    anonymous: loaded.anonymous,
    respondentName: loaded.respondentName,
    completedAt: loaded.completedAt,
    generatedAt: new Date().toISOString(),
    // Carry the (possibly null) logo data URI through as the theme's logoUrl — the
    // document renders `<Image src={logoUrl}>` only when present.
    theme: { ...loaded.theme, logoUrl: logoDataUri },
    status: loaded.status,
    sections: loaded.sections,
    answers: loaded.answers,
  };

  return buildSessionExportModel(input);
}
