/**
 * ONE per-request read of everything the respondent surface needs off a version (P16 perf).
 *
 * The respondent pages (`/q/[versionId]`, `/x/[publicRef]`, the admin session viewer) each need a
 * dozen-odd independent facts about a launched version: its title, its brand client, and one
 * config switch per affordance. Resolved one-at-a-time that was 15 round trips per page load —
 * every new config switch adding another — so they all now project off this single `cache()`d row.
 *
 * `cache()` is what makes the collapse automatic: the individual `resolve*ForVersion` helpers keep
 * their narrow signatures and stay independently callable, but within one request they share this
 * query rather than each firing their own. Callers need no coordination and no page rewrites.
 *
 * DELIBERATELY NARROW. This selects the surface's scalar switches only — NOT the config's heavy
 * JSON columns (`tone`, `personas`, `interviewerStrategy`, `respondentReport`, `cohortReport`,
 * `intro`, `profileFields`), which the respondent surface never reads. The full read view is
 * `CONFIG_SELECT` in `app/api/v1/app/questionnaires/_lib/detail.ts`; use that one when you need
 * the authored content, this one when you need the surface's behaviour.
 *
 * The glossary is deliberately NOT folded in here — see `glossary/resolve.ts` for why (it has a
 * fail-soft contract this row must not inherit).
 *
 * Server-only.
 */

import { cache } from 'react';

import { prisma } from '@/lib/db/client';

/**
 * The config columns the respondent surface projects. Scalars only, by design — see the module
 * docblock. Adding a switch here costs nothing at runtime; adding a JSON column costs every load.
 */
export const SURFACE_CONFIG_SELECT = {
  anonymousMode: true,
  accessMode: true,
  voiceEnabled: true,
  attachmentsEnabled: true,
  presentationMode: true,
  respondentLayout: true,
  answerSlotPanelScope: true,
  inlineCorrectionEnabled: true,
  sessionResumeEnabled: true,
  showProgressPercentText: true,
  reasoningStreamEnabled: true,
  reasoningStreamPlacement: true,
  reasoningStreamDwellMs: true,
  reasoningStreamPerItemMs: true,
} as const;

/** The shape {@link loadVersionSurface} resolves to; `null` when the version doesn't exist. */
export interface VersionSurface {
  questionnaireId: string;
  versionNumber: number;
  status: string;
  questionnaire: { title: string; demoClientId: string | null };
  /** Config is 1:1 and LAZY — an absent row means "every default", not "no questionnaire". */
  config: {
    anonymousMode: boolean;
    accessMode: string;
    voiceEnabled: boolean;
    attachmentsEnabled: boolean;
    presentationMode: string;
    respondentLayout: string;
    answerSlotPanelScope: string;
    inlineCorrectionEnabled: boolean;
    sessionResumeEnabled: boolean;
    showProgressPercentText: boolean;
    reasoningStreamEnabled: boolean;
    reasoningStreamPlacement: string;
    reasoningStreamDwellMs: number;
    reasoningStreamPerItemMs: number;
  } | null;
}

/**
 * Load a version's respondent-surface row, or `null` when the version doesn't exist.
 *
 * `cache()`-wrapped, so the many `resolve*ForVersion` projections that call it during one request
 * share a single query. Outside a request scope (a worker, a test) `cache()` simply doesn't
 * memoise — every caller still gets a correct answer, just without the dedupe.
 */
export const loadVersionSurface = cache(
  async (versionId: string): Promise<VersionSurface | null> => {
    return prisma.appQuestionnaireVersion.findUnique({
      where: { id: versionId },
      select: {
        // Version-level identity: what the admin preview banner names, and what the brand band
        // titles itself with. All on the version row, so they ride along for free.
        questionnaireId: true,
        versionNumber: true,
        status: true,
        questionnaire: { select: { title: true, demoClientId: true } },
        config: { select: SURFACE_CONFIG_SELECT },
      },
    });
  }
);
