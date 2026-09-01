/**
 * Sectioned interviews (P21) — the client-safe projection.
 *
 * What the respondent surface is allowed to know about the sections: a label, a position, a status,
 * how much of it is covered, and whether it can be moved to or finished. Deliberately NOT the
 * membership: shipping `questionKeys` would put the questions of a section they have not reached
 * into the browser, which is the same reasoning `answered_only` panel scope already applies to
 * pending prompts.
 *
 * Pure: no Prisma, no React.
 */

import type { SectionState } from '@/lib/app/questionnaire/sections/state';
import { sectionEntry } from '@/lib/app/questionnaire/sections/run';
import type { SectionStatus } from '@/lib/app/questionnaire/sections/types';

/** One tab. */
export interface SectionTabView {
  key: string;
  label: string;
  /** 1-based, for "part 2 of 5". */
  position: number;
  status: SectionStatus;
  /** True for the section the conversation is currently in. */
  isActive: boolean;
  /**
   * True when the respondent may move to this section right now.
   *
   * Under `free` navigation every section is available. Under `sequential` only the active one,
   * the ones already closed (the reopen right) and the next one still open are. A tab that is not
   * available is drawn locked rather than hidden, unless the version turned that off.
   */
  isAvailable: boolean;
  /** How many times it has been reopened. Drawn nowhere yet; carried for the admin timeline. */
  reopenCount: number;
}

/** The whole strip, plus what the close control needs. */
export interface SectionStripView {
  /** False when this interview is not sectioned. The surface renders no strip at all. */
  active: boolean;
  sections: SectionTabView[];
  activeKey: string | null;
  /** True when the "finish this section" control should be unlocked. */
  canClose: boolean;
  /**
   * True when the only thing holding the active section open is an unanswered required question.
   *
   * Surfaced separately from `canClose` because the copy has to name it. "Not yet" beside a control
   * that will never unlock is the state a respondent gets stuck in, and telling them there is one
   * thing still needed is the difference between a wait and a dead end.
   */
  blockedOnRequired: boolean;
  /** True when every section has been closed. */
  allClosed: boolean;
  /** Whether locked sections are drawn at all. */
  showLocked: boolean;
}

/** The empty strip. What every unsectioned interview returns. */
export const INERT_SECTION_STRIP: SectionStripView = {
  active: false,
  sections: [],
  activeKey: null,
  canClose: false,
  blockedOnRequired: false,
  allClosed: false,
  showLocked: true,
};

/**
 * Project the turn's section state for the client.
 *
 * `showLocked` rides on the view rather than being read from config by the surface, so a client
 * that renders the strip never has to hold a second copy of the settings to know what to draw.
 */
export function buildSectionStripView(
  state: SectionState,
  opts: { showLocked?: boolean; navigation?: 'sequential' | 'free' } = {}
): SectionStripView {
  if (!state.active || state.run === null) return INERT_SECTION_STRIP;

  const run = state.run;
  const navigation = opts.navigation ?? 'sequential';
  const activeKey = state.activeSection?.key ?? run.activeKey;

  // The first section that is not closed. Under `sequential` this is the only forward move
  // available, so it is resolved once rather than per tab.
  const nextOpenKey =
    state.sections.find((section) => sectionEntry(run, section.key)?.status !== 'closed')?.key ??
    null;

  const sections: SectionTabView[] = state.sections.map((section, index) => {
    const entry = sectionEntry(run, section.key);
    const status: SectionStatus = entry?.status ?? 'not_started';
    return {
      key: section.key,
      label: section.label,
      position: index + 1,
      status,
      isActive: section.key === activeKey,
      isAvailable:
        navigation === 'free' ||
        section.key === activeKey ||
        status === 'closed' ||
        section.key === nextOpenKey,
      reopenCount: entry?.reopenCount ?? 0,
    };
  });

  return {
    active: true,
    sections,
    activeKey,
    canClose: state.close?.canClose ?? false,
    blockedOnRequired: state.close?.blockedOnRequired ?? false,
    allClosed: state.allClosed,
    showLocked: opts.showLocked ?? true,
  };
}
