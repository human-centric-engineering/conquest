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
   * the ones already VISITED (closed, or left in progress), the next one still open, and — once the
   * active section can be finished — the section finishing it hands the run to. A tab that is not
   * available is drawn locked rather than hidden, unless the version turned that off.
   *
   * Deliberately the same rule `canOpenSection` enforces server-side, including the visited clause:
   * a list offering a move the server refuses is the same defect in the other direction.
   */
  isAvailable: boolean;
  /**
   * True when picking this section FINISHES the active one on the way.
   *
   * Set on exactly one tab, and only under `sequential` navigation with the close gate already
   * met: the section that "Move on to X" would hand the run to. Sequential navigation has no plain
   * move onto that ground — `open` on it is refused server-side, because the way forward is
   * through the current section rather than around it — so a surface that draws it as reachable
   * has to make the same move the close control makes, not an ordinary one.
   *
   * It exists because the alternative was the state a respondent actually met: a control offering
   * "Move on to Growth Strategy" with Growth Strategy drawn locked in the list beside it. Both
   * were telling the truth about their own rule and the pair of them was incoherent.
   *
   * Never set under `free` navigation. There, moving to the next section without finishing this
   * one is a move the respondent is entitled to, and the close control beside the list is the
   * affordance for the other one.
   */
  finishesActive: boolean;
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
  /**
   * True when this list can still gain sections mid-interview.
   *
   * Only Conditional Topics can do that: it seats new topics when the plan lands, and a respondent
   * amendment can seat one later still, so `buildSectionState` reconciles the run every turn rather
   * than once. On a fixed instrument the list is settled from the first turn.
   *
   * On the view rather than derived by the surface for the same reason as `showLocked`: a client
   * drawing the list should not have to hold a second copy of the settings to know what to say
   * about it. What it buys is the difference between an honest note ("more may be added, if they
   * turn out to be relevant") and a promise a fixed questionnaire cannot keep.
   */
  canGrow: boolean;
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
  canGrow: false,
};

/**
 * Where the interview CONTINUES: the first section that is not finished.
 *
 * Under `free` navigation (and under `sequential`, via the reopen right) a respondent can move the
 * conversation into a section they have already closed, or ahead of one they have not. Both leave
 * them somewhere other than the place the interview would otherwise carry on from, with nothing on
 * screen saying so — they went back to add a line to an earlier section and the way forward is a
 * menu they have to reason about.
 *
 * Deliberately the same rule the view builder uses for `isAvailable`'s `nextOpenKey`, and exported
 * rather than re-derived on the surface so the two cannot drift on what "where we were" means.
 *
 * `null` when every section is closed: there is nothing to return to, and the completion offer is
 * the affordance that matters then.
 */
export function resumeSectionKey(view: SectionStripView): string | null {
  return view.sections.find((section) => section.status !== 'closed')?.key ?? null;
}

/**
 * The section a sectioned interview BEGINS in — the first resolved one.
 *
 * Where everything said once, at the head of the conversation, belongs: the greeting the surface
 * builds on the client, the pre-release recording notice, and any turn recorded before this session
 * was sectioned. `null` on an unsectioned interview, which is what puts all of it back on the flat
 * path.
 */
export function openingSectionKey(view: SectionStripView): string | null {
  return view.active ? (view.sections[0]?.key ?? null) : null;
}

/**
 * Is the conversation still at its beginning?
 *
 * True on every unsectioned interview, and on a sectioned one while the opening section is the
 * active one. What is said ONCE at the head of a conversation is placed by this: a disclosure that
 * reappears above every section is not a disclosure, it is a nag, and it takes the top of a section
 * whose own opening question was the thing to read.
 *
 * A null `activeKey` — before the first section opens, and once every one is closed — counts as the
 * opening: there is no section to be somewhere else in.
 */
export function isInOpeningSection(view: SectionStripView): boolean {
  const opening = openingSectionKey(view);
  return opening === null || view.activeKey === null || view.activeKey === opening;
}

/**
 * Where the interview goes NEXT when the active section is finished.
 *
 * The first section that is neither the active one nor already closed — deliberately the rule
 * `closeSection` applies on the server (`nextOpenSectionKey` over a run whose active section has
 * just been stamped closed), so the label on the close control names the section the respondent
 * will actually land in.
 *
 * Not `position + 1`, which is what the close control used to use and which is wrong the moment a
 * section has been reopened out of order: it would name a section that is already finished and
 * that closing this one skips straight past.
 *
 * `null` when there is nowhere onward — the active section is the last one still open, and
 * finishing it completes the run.
 */
export function onwardSectionKey(sections: readonly SectionTabView[]): string | null {
  return sections.find((section) => !section.isActive && section.status !== 'closed')?.key ?? null;
}

/**
 * Project the turn's section state for the client.
 *
 * `showLocked` rides on the view rather than being read from config by the surface, so a client
 * that renders the strip never has to hold a second copy of the settings to know what to draw.
 */
export function buildSectionStripView(
  state: SectionState,
  opts: {
    showLocked?: boolean;
    navigation?: 'sequential' | 'free';
    /** `conditionalTopics.enabled` — the only thing that can add a section mid-interview. */
    canGrow?: boolean;
  } = {}
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

  const tabs: SectionTabView[] = state.sections.map((section, index) => {
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
        // Visited: closed, or in progress and left. Returning to it skips nothing, because being
        // opened at all meant it was permitted then.
        status !== 'not_started' ||
        section.key === nextOpenKey,
      finishesActive: false,
      reopenCount: entry?.reopenCount ?? 0,
    };
  });

  // The onward section, once the active one can actually be finished. Derived from the tabs rather
  // than from `state` so it cannot drift from what the close control reads off the same view.
  const canClose = state.close?.canClose ?? false;
  const onwardKey = canClose && navigation === 'sequential' ? onwardSectionKey(tabs) : null;
  const sections =
    onwardKey === null
      ? tabs
      : tabs.map((tab) =>
          tab.key === onwardKey ? { ...tab, isAvailable: true, finishesActive: true } : tab
        );

  return {
    active: true,
    sections,
    activeKey,
    canClose,
    blockedOnRequired: state.close?.blockedOnRequired ?? false,
    allClosed: state.allClosed,
    showLocked: opts.showLocked ?? true,
    canGrow: opts.canGrow ?? false,
  };
}
