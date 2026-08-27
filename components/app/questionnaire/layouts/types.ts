/**
 * The contract between the respondent workspace and a layout.
 *
 * `SessionWorkspace` builds every part as a ready-to-render node and hands the whole set to
 * whichever layout the questionnaire chose. A layout therefore never constructs a feature, never
 * touches a hook, and never learns what a session is — it decides *where things go*, and that is
 * all it can decide. Two consequences worth stating, because they are the point:
 *
 *   - A layout cannot accidentally break a feature, only misplace it.
 *   - A new feature reaches every layout at once. It arrives as a new slot key, and
 *     `lib/app/questionnaire/layout/slots.ts` makes that key's absence a compile error in each
 *     layout's placement map.
 *
 * See `.context/app/questionnaire/respondent-layouts.md` for how to add one.
 */

import type { ReactNode } from 'react';

import type { RespondentSlotKey, SlotPlacement } from '@/lib/app/questionnaire/layout/slots';
import type { SessionWorkspaceState } from '@/lib/hooks/use-session-workspace';
import type { RespondentLayout } from '@/lib/app/questionnaire/types';

/**
 * Every part, rendered and ready to place. A `null` means "this session doesn't have one" (the
 * intro is disabled, the panel is hidden, there is no held probe) — NOT "this layout dropped it".
 * A layout renders what it is given and places `null` harmlessly.
 *
 * `complete` and `handoff` are the exception: they are whole-surface takeovers rendered by the
 * container instead of the layout, so they are always `null` while the layout is on screen. They
 * remain slot keys because a layout still has to declare that it accepts that treatment — see
 * the `takeover` region in {@link SlotPlacement}.
 */
export type RespondentSlots = Record<RespondentSlotKey, ReactNode>;

export interface RespondentLayoutProps {
  slots: RespondentSlots;
  /**
   * The live workspace. A layout reads from it (which surface is active, whether the carousel has
   * more than one page, the swipe handlers) and calls its navigation functions; it must not
   * duplicate the derivations already on it.
   */
  state: SessionWorkspaceState;
}

export type RespondentLayoutComponent = (props: RespondentLayoutProps) => ReactNode;

export interface LayoutDefinition {
  /** Shown in the admin picker. */
  label: string;
  /** One line, in the admin's language, on what this arrangement is *for*. */
  description: string;
  Component: RespondentLayoutComponent;
  /**
   * Where this layout puts every part. Declared rather than inferred, because the compiler can
   * check a declaration and cannot check a component's JSX. Tests close the remaining gap by
   * rendering the layout and asserting each `region`-placed slot reaches the DOM.
   */
  placements: Record<RespondentSlotKey, SlotPlacement>;
}

export type LayoutRegistry = Record<RespondentLayout, LayoutDefinition>;
