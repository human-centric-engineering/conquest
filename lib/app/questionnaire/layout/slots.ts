/**
 * The respondent slot contract — the named parts every layout must account for.
 *
 * The respondent surface used to have exactly one arrangement, hard-coded into
 * `SessionWorkspace`. Alternative layouts (F-layouts) rearrange the same parts rather than
 * reimplementing them, and the promise that matters commercially is: **whichever layout a
 * questionnaire picks, every feature is still reachable.** A promise in a docblock decays;
 * this module makes it a compile error instead.
 *
 * Each layout in `components/app/questionnaire/layouts/registry.ts` declares a
 * {@link SlotPlacement} for every {@link RespondentSlotKey}, via
 * `satisfies Record<RespondentSlotKey, SlotPlacement>` — so **adding a slot key below does not
 * build until every layout says where that part goes**. Same idiom, and the same reasoning, as
 * `SETTING_DESCRIPTORS satisfies Record<keyof QuestionnaireConfigShape, SettingDescriptor>`
 * (`lib/app/questionnaire/settings-registry.ts`) and the privacy export manifest: hand-maintained
 * parallel lists had already shipped silent omissions.
 *
 * What the compiler can and cannot check, stated plainly so nobody over-trusts this:
 *   - The compiler enforces that every layout CLASSIFIES every slot.
 *   - It cannot enforce that a layout's component then RENDERS what it classified. Tests do
 *     that instead — `tests/unit/components/app/questionnaire/layouts/*` render each layout with
 *     a sentinel per slot and assert every `region`-placed slot reaches the DOM.
 *   - {@link ESSENTIAL_SLOTS} is the third leg: those may never be `omitted`, in any layout, at
 *     any granularity. A layout that cannot show them is not a layout, it is a broken session.
 *
 * Pure: no React, no Prisma, no DOM. The keys are a vocabulary, not components.
 *
 * GRANULARITY NOTE. The keys below describe the parts as they are *actually composable today*.
 * `conversation` is one slot because `QuestionnaireChat` owns its transcript, notices, question
 * card, correction strip and composer together. Splitting it into `transcript` + `composer` is
 * real work, wanted by the Broadsheet layout (composer in the margin) and required by Horizon
 * (no transcript at all) — so it lands with them, not speculatively here. When it does, the
 * `satisfies` gate forces every existing layout to re-classify. That is the mechanism working,
 * not a migration to dread.
 */

/**
 * Every part of the respondent surface a layout has to place.
 *
 * Grouped by role rather than alphabetically — the groups are how a layout author thinks about
 * the page. Order here is also the order the registry's placement maps are written in, so a
 * reviewer can diff two layouts side by side.
 */
export const RESPONDENT_SLOTS = [
  /* ── Identity ─────────────────────────────────────────────────────────────── */
  /** The client's masthead: banner, or logo + title + round window + anonymity note. */
  'brandBand',

  /* ── Session chrome ───────────────────────────────────────────────────────── */
  /**
   * The pre-composed lifecycle strip (progress, pause/resume, budget hint, action errors, plus
   * the `leading` / `download` / `trailing` slots). A convenience, NOT a universal: a layout that
   * wants progress somewhere else entirely decomposes it and omits this, placing the atoms below.
   * Deliberately absent from {@link ESSENTIAL_SLOTS} for exactly that reason.
   */
  'lifecycleBar',
  /** Weighted-coverage bar on its own, for layouts that don't render {@link RESPONDENT_SLOTS} `lifecycleBar`. */
  'progress',
  /** Cross-device "already started? enter your code" entry. */
  'sessionRef',
  /** Download the conversation so far. */
  'transcriptDownload',
  /** The surface carousel's segmented control (intro / details / interviewer / chat / form). */
  'modeToggle',
  /** Respondent-owned transcript text-size stepper. */
  'textSize',
  /** The below-`lg` "Review answers" affordance that opens {@link RESPONDENT_SLOTS} `answersDrawer`. */
  'reviewTrigger',
  /** In-chat "Interviewer: {name} · Change" chip. */
  'interviewerChip',

  /* ── Pre-conversation gates ───────────────────────────────────────────────── */
  /** The intro splash: background, how it works, what you'll get, begin. */
  'splash',
  /** Blocking profile-capture form. Blocking, so it can never be merely decorative. */
  'captureGate',
  /** "Choose your interviewer" page. */
  'personaPicker',

  /* ── The work itself ──────────────────────────────────────────────────────── */
  /** The conversation: transcript, reasoning, question card, correction strip, notices, composer. */
  'conversation',
  /** The raw form surface (`presentationMode` `form` / `both`). */
  'formView',
  /** The live captured-answers panel. */
  'answersPanel',
  /** The below-`lg` twin of the panel, as a bottom sheet. */
  'answersDrawer',

  /* ── Finishing ────────────────────────────────────────────────────────────── */
  /** Submit, or the early-finish escape hatch — whichever the lifecycle currently offers. */
  'completionOffer',
  /** The held-contradiction final-check modal. */
  'finalCheck',
  /** The completion confirmation, shown in place of the whole surface. */
  'complete',
  /** Experience handoff / stitched continuation, likewise a whole-surface takeover. */
  'handoff',
  /** The `indicator`-switcher's interviewer modal. */
  'personaSwitcher',
] as const;

export type RespondentSlotKey = (typeof RESPONDENT_SLOTS)[number];

/**
 * Where a layout puts a slot.
 *
 * Three kinds, and the distinction is the whole point of the contract:
 *   - `region`  — on screen, in a named area of this layout. `region` is layout-local prose
 *                 ('margin', 'spine', 'foot'), except `takeover`, which is reserved: it means the
 *                 container renders this instead of the layout, full-surface (see `complete`).
 *   - `overlay` — reachable, but not on screen until the respondent asks. Still counts as
 *                 available; a sheet one tap away is a design decision, not a missing feature.
 *   - `omitted` — deliberately absent, with the reason recorded. Illegal for {@link ESSENTIAL_SLOTS}.
 *                 `because` is required precisely so "we forgot" cannot masquerade as a choice.
 */
export type SlotPlacement =
  | { kind: 'region'; region: string }
  | { kind: 'overlay'; via: 'sheet' | 'drawer' | 'modal' | 'gesture' }
  | { kind: 'omitted'; because: string };

/**
 * Slots no layout may omit.
 *
 * The test is not "is it important" — everything here is important — but "can the respondent
 * finish, correctly, without it". Without the conversation or the composer there is nothing to
 * answer; without the completion offer they cannot submit; without the gates a blocking capture
 * or an intro the author configured silently never appears; without `complete` a finished session
 * has nowhere to land. `answersPanel` is NOT here: `answerSlotPanelScope: 'hidden'` is a supported
 * configuration today, and a layout may legitimately move review behind a gesture.
 *
 * A slot that is conditional on config (a splash only exists when the intro is enabled) still
 * belongs here: the rule is about the layout's willingness to place it, not about whether this
 * particular session has one.
 */
export const ESSENTIAL_SLOTS = [
  'conversation',
  'formView',
  'completionOffer',
  'finalCheck',
  'complete',
  'handoff',
  'splash',
  'captureGate',
  'personaPicker',
] as const satisfies readonly RespondentSlotKey[];

export type EssentialSlotKey = (typeof ESSENTIAL_SLOTS)[number];

/** True when this placement means "the respondent can get to it", i.e. anything but `omitted`. */
export function isAvailable(placement: SlotPlacement): boolean {
  return placement.kind !== 'omitted';
}

/**
 * The essential slots a placement map fails to offer. Empty is the only passing result.
 *
 * Exported (rather than inlined in the test) so the registry can assert it in development too —
 * a layout added in a hurry fails loudly at import time rather than at review time.
 */
export function missingEssentialSlots(
  placements: Record<RespondentSlotKey, SlotPlacement>
): EssentialSlotKey[] {
  return ESSENTIAL_SLOTS.filter((key) => !isAvailable(placements[key]));
}
