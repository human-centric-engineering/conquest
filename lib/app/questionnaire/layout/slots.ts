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
 * `conversation` was ONE slot until Broadsheet arrived and wanted the composer in the margin; it is
 * now `transcript` + `composer`, and the split landed with the layout that needed it rather than
 * speculatively ahead of it. Doing it that way was cheap exactly as designed: the `satisfies` gate
 * failed the build until Classic and Focus had each re-classified both halves, so no layout could
 * quietly inherit an arrangement nobody had thought about.
 *
 * The next candidate is the same shape. A one-question-at-a-time layout (Horizon) needs the
 * transcript itself divisible — the current turn apart from the history behind it — and that lands
 * with Horizon, not here.
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
  /**
   * The conversation as it reads: turns, reasoning traces, side-band notices, the question card and
   * the inline correction strip. Scrolls internally; draws no card chrome of its own, so whichever
   * layout places it supplies the frame.
   *
   * Note that the question card lives here rather than with `composer`, even though it is an
   * input: it belongs to the turn it answers, and moving it away from that turn would ask the
   * respondent to answer a question they can no longer see.
   */
  'transcript',
  /**
   * Where the respondent writes: the input, voice, attachments and send. A separate slot since
   * Broadsheet, which puts it in a margin beside the transcript rather than beneath it, so that it
   * stays put while the conversation scrolls.
   *
   * Stacking it back under the transcript is the common case and is NOT open-coded per layout —
   * `ConversationFrame` is the shared arrangement, and it owns the hairline seam between the two
   * (a `border-t` is right in a shared card and wrong on a composer that is a card of its own).
   */
  'composer',
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
 *                 `fills` says the region hands the slot its whole height rather than sizing to
 *                 its content — see below.
 *   - `overlay` — reachable, but not on screen until the respondent asks. Still counts as
 *                 available; a sheet one tap away is a design decision, not a missing feature.
 *   - `omitted` — deliberately absent, with the reason recorded. Illegal for {@link ESSENTIAL_SLOTS}.
 *                 `because` is required precisely so "we forgot" cannot masquerade as a choice.
 */
export type SlotPlacement =
  | {
      kind: 'region';
      region: string;
      /**
       * This region gives the slot its FULL height, rather than sizing to its content.
       *
       * Declared rather than styled from the layout because a layout places nodes it did not
       * build: it cannot reach inside the composer and tell the textarea to grow. The container
       * reads this the same way it reads `answersPanel.kind` — one declaration driving both the
       * arrangement and the node that has to cooperate with it.
       *
       * Broadsheet sets it on `composer`: the margin is a full-height column with nothing else in
       * it, so the answer box may as well BE the column and give the respondent room to talk. A
       * content-sized region (every stacked composer) leaves it unset and keeps the auto-grow
       * behaviour, where the box grows with what is typed up to a cap.
       */
      fills?: boolean;
    }
  | { kind: 'overlay'; via: 'sheet' | 'drawer' | 'modal' | 'gesture' }
  | { kind: 'omitted'; because: string };

/**
 * Slots no layout may omit.
 *
 * The test is not "is it important" — everything here is important — but "can the respondent
 * finish, correctly, without it". Without the transcript there is no question to read and without
 * the composer no way to answer it — and note that BOTH are required even though a layout could
 * technically hide one behind a gesture: `overlay` is legal for either, `omitted` is not, because a
 * conversation with half of itself deleted is not an arrangement, it is a broken session. Without
 * the completion offer they cannot submit; without the gates a blocking capture
 * or an intro the author configured silently never appears; without `complete` a finished session
 * has nowhere to land. `answersPanel` is NOT here: `answerSlotPanelScope: 'hidden'` is a supported
 * configuration today, and a layout may legitimately move review behind a gesture.
 *
 * A slot that is conditional on config (a splash only exists when the intro is enabled) still
 * belongs here: the rule is about the layout's willingness to place it, not about whether this
 * particular session has one.
 */
export const ESSENTIAL_SLOTS = [
  'transcript',
  'composer',
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
