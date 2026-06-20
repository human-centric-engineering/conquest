/**
 * Respondent intro / splash — runtime resolution (DB seam).
 *
 * Resolves the effective intro for a session: the per-version {@link IntroSettings} (enabled +
 * admin background + button label), with the background optionally REPLACED by the session's cohort
 * (`AppCohort.introBackground`), plus the derived {@link IntroCopy} (how it works / what you'll get /
 * good to know). The cohort override mirrors the theming fallback precedent
 * (`lib/app/questionnaire/chat/theme.ts`): walk `session → cohortMember → cohort`.
 *
 * Server-only (reads Prisma). The `lib/app/questionnaire/intro` copy + narrow helpers are pure; this
 * is the only file in the module that touches the database.
 */

import { prisma } from '@/lib/db/client';
import {
  PRESENTATION_MODES,
  narrowToEnum,
  type PresentationMode,
} from '@/lib/app/questionnaire/types';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import { narrowIntroSettings } from '@/lib/app/questionnaire/intro/settings';
import { buildIntroCopy, type IntroCopy } from '@/lib/app/questionnaire/intro/copy';

/** The fully-resolved intro a respondent surface needs to render the splash. */
export interface ResolvedSessionIntro {
  /** Whether the splash should be shown for this version (the per-version toggle). */
  enabled: boolean;
  /** The questionnaire title (splash heading). */
  questionnaireTitle: string;
  /** The effective background markdown (cohort override replaces version-level); `''` when none. */
  background: string;
  /** Derived copy (how it works / what you'll get / good to know / button label). */
  copy: IntroCopy;
}

/**
 * Resolve the intro for an existing session. Returns `null` when the session id doesn't resolve
 * (caller maps that to "no splash"). When the version has the intro toggled off, returns
 * `enabled: false` with complete copy so callers can branch uniformly without a second query.
 */
export async function resolveSessionIntro(sessionId: string): Promise<ResolvedSessionIntro | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      cohortMemberId: true,
      version: {
        select: {
          questionnaire: { select: { title: true } },
          config: {
            select: {
              intro: true,
              presentationMode: true,
              respondentReport: true,
              anonymousMode: true,
              voiceEnabled: true,
            },
          },
        },
      },
    },
  });
  if (!session) return null;

  const config = session.version.config;
  const intro = narrowIntroSettings(config?.intro);
  const report = narrowRespondentReportSettings(config?.respondentReport);
  const presentationMode: PresentationMode = narrowToEnum(
    config?.presentationMode ?? '',
    PRESENTATION_MODES,
    'chat'
  );

  const background = await resolveBackground(intro.background, session.cohortMemberId);

  return {
    enabled: intro.enabled,
    questionnaireTitle: session.version.questionnaire.title,
    background,
    copy: buildIntroCopy({
      presentationMode,
      report,
      anonymousMode: config?.anonymousMode ?? false,
      voiceEnabled: config?.voiceEnabled ?? false,
      buttonLabelOverride: intro.buttonLabel,
    }),
  };
}

/**
 * Apply the cohort override: a non-empty `AppCohort.introBackground` REPLACES the version-level
 * background for that cohort's respondents; an empty/absent override inherits the version text.
 */
async function resolveBackground(
  versionBackground: string,
  cohortMemberId: string | null
): Promise<string> {
  if (!cohortMemberId) return versionBackground;
  const member = await prisma.appCohortMember.findUnique({
    where: { id: cohortMemberId },
    select: { cohort: { select: { introBackground: true } } },
  });
  const override = member?.cohort.introBackground?.trim();
  return override ? override : versionBackground;
}
