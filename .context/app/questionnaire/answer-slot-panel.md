# Answer-slot panel (F7.2)

The live panel beside the respondent chat that shows the questionnaire's answer slots
as the conversation fills them in — confidence, provenance, refinement history, and a
per-slot "Revisit". Pure consumer UI on top of **one new read endpoint**. Always on,
like the chat surface it sits beside.

`// DEMO-ONLY:` everything here is questionnaire-domain — a non-questionnaire fork
strips the `panel/` directory and the `answers` route and keeps the generic chat.

## The data seam

The F6.1 streaming route (`POST …/questionnaire-sessions/:id/messages`) emits only
`start | content | warning | done | error` — **no answer-slot events**; answers are
persisted server-side (`persistTurn`) just before `done`. So the panel reads its own
endpoint and refetches when each turn settles, rather than the chat stream carrying
slot updates. This keeps the streaming contract untouched.

### `GET /api/v1/app/questionnaire-sessions/:id/answers`

Returns `{ success: true, data: AnswerPanelView }`. Gate order mirrors the messages
route: **load session → `resolveTurnAccess` (401/403) → respond**. It reuses
`resolveTurnAccess` (an authenticated owner OR a valid
anonymous `X-Session-Token`), so it serves both respondent kinds; `withAuth` can't. No
status gate — a paused or completed session still shows its answers. No extra rate
limiter (a read inherits the automatic 100/min on `/api/v1/**`).

`AnswerPanelView` (the client-safe projection):

```
{ status, scope, sections: [{ sectionId, title, slots: [PanelSlotView] }], answeredCount, totalCount }
```

`PanelSlotView` carries `slotKey` (the stable per-version slug, never the cuid),
`prompt`, `type`, `required`, `answered`, and — when answered — `value`, `provenance`,
`confidence` (0–1, null = unscored), `rationale`, `answeredAtTurnIndex`, and
`refinementHistory`. Authoring internals (`weight`, tags, config) are **not** projected.

## Scope (admin config)

The version's `answerSlotPanelScope` config field (configuration.md) decides what the
endpoint returns:

- `full_progress` (default) — every slot, grouped by section; the panel header reads
  "X of N answered".
- `answered_only` — only captured answers; the pure builder omits pending slots and
  drops sections left empty, so the **pending prompts are never sent to the client**.
  `totalCount` still reflects the whole version, so the header reads "N captured"
  honestly.

The filter lives in the pure builder, not the route — see below.

## Code map

| Concern                           | File                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| Pure view contracts               | `lib/app/questionnaire/panel/types.ts`                                                |
| Pure join + scope filter + counts | `lib/app/questionnaire/panel/answer-panel.ts` (`buildAnswerPanelView`)                |
| Confidence band mapping           | `lib/app/questionnaire/panel/confidence.ts`                                           |
| Newly-filled diff + slot DOM ids  | `lib/app/questionnaire/panel/newly-filled.ts`                                         |
| Minimap geometry (pure)           | `lib/app/questionnaire/panel/minimap.ts` (`computeMiniMapModel`)                      |
| Minimap (data-slot mode)          | `components/app/questionnaire/panel/slot-minimap.tsx` (`SlotMiniMap`)                 |
| Breadth meter (data-slot mode)    | `components/app/questionnaire/panel/slot-breadth-meter.tsx` (`SlotBreadthMeter`)      |
| Edit-history dialog (data-slot)   | `components/app/questionnaire/panel/slot-history-dialog.tsx` (`SlotHistoryDialog`)    |
| DB read seam (one query)          | `app/api/v1/app/questionnaire-sessions/_lib/answer-panel.ts` (`loadAnswerPanelState`) |
| Route                             | `app/api/v1/app/questionnaire-sessions/[id]/answers/route.ts`                         |
| Live fetch hook                   | `lib/hooks/use-answer-panel.ts`                                                       |
| Shared parent (chat + panel)      | `components/app/questionnaire/session-workspace.tsx`                                  |
| Panel components                  | `components/app/questionnaire/panel/*`                                                |

The pure core stays Prisma-free; the read seam loads plain rows (including a turn-id →
ordinal map so `lastUpdatedTurnId` becomes `answeredAtTurnIndex`) and hands them to
`buildAnswerPanelView`.

## Live update + Revisit wiring

`SessionWorkspace` owns the single `useQuestionnaireSessionStream` instance **and** the
`useAnswerPanel` fetch, then renders `QuestionnaireChat` and `AnswerSlotPanel` side by
side. Two consequences:

- **Live refresh:** the stream hook gained an additive `onTurnSettled` option, fired
  once a turn settles cleanly to `idle` (not on error/abort). `SessionWorkspace` routes
  it to **both** `panel.refetch` and the F7.3 lifecycle-status refetch, so the answer
  panel and the Submit affordance update off the same settle. (F7.3 also lifted a third
  hook, `useSessionLifecycle`, into `SessionWorkspace` — see
  [`session-lifecycle.md`](./session-lifecycle.md).)
- **Revisit:** because the chat and panel share one stream, the panel's confirm-gated
  "Revisit" button calls `stream.sendMessage("I'd like to revisit my answer to: …")`,
  re-asking the question through the same turn loop. Disabled while `!stream.canSend`.
- **"Incorrect?" (data-slot mode):** each **filled** `DataSlotRow` carries a quiet refine
  affordance — a small flag-icon "Incorrect?" button (tooltip _"Click to refine"_) revealed on
  `group-hover/slot` / `group-focus-within/slot`. It lives **at the end of the confidence line**
  (inside the `NoticeWhy` wrap cluster, after the score / "Inferred" / "Why?"), reading as a quiet
  challenge to the confidence beside it — deliberately **not** in the title row, where it would
  fight the name + "Edited" pill for width and squash the title; the `flex-wrap` cluster lets it
  drop to its own line instead. Clicking calls `SessionWorkspace.handleRefine`, which sends a
  steering turn (`stream.sendMessage("I don't think “<name>” is quite right. Right now you have it
as: “…”. Could you ask me a more detailed question …")`) so the agent **probes deeper into that
  one slot** instead of moving on. Threaded as `AnswerSlotPanel`'s `onRefine` prop (and through the
  mobile `AnswerReviewDrawer`, which closes on use); only rendered when a turn can be sent
  (`canRevisit` / `stream.canSend`).

`QuestionnaireChat` was refactored to **receive the stream as a `stream` prop** (the
hook call moved up to `SessionWorkspace`); its rendering is otherwise unchanged and it
stays a single readable column.

## Inline answer correction (Variant B)

`Revisit` re-asks a question via a fresh chat turn; **inline correction** is the lighter
alternative — fix what the latest turn just captured _in place_, without spending a turn.
Gated by the per-version `inlineCorrectionEnabled` config (default on) — a respondent-facing
UX toggle. Two surfaces, one shared editor:

- **Chat strip** (`components/.../chat/correction-strip.tsx`): rendered beneath the transcript
  once the latest reply has settled (`composerReady`), listing what the turn recorded
  ("`<prompt>` → `<value>`") with a per-item "Fix". The targets are resolved upstream in
  `SessionWorkspace` from the panel view + the keys the latest turn filled
  (`buildCorrectionTargets` over `lastTurnFilledKeys`).
- **Panel rows**: `AnswerSlotItem` gains an "Edit answer" action in its expanded detail (beside
  Revisit); `DataSlotRow` gains an "Edit" link when the slot has mapped questions.

The shared `InlineAnswerEditor` (`components/.../panel/inline-answer-editor.tsx`) always edits
**question** slots, reusing `QuestionField` for the per-type control, and saves through
`useInlineCorrection` → `PUT …/answers` — the same form-edit path, so the write records a `manual`
refinement entry, flips the slot to `refined` + `respondentEdited`, and (data-slot mode) reconciles
the reading. Crucially it **bypasses the turn pipeline**, so a correction never runs extraction or
contradiction detection — that's the whole point: a corrective chat turn risks a false same-slot
contradiction warning; an inline fix can't.

- **Question mode:** the target is the slot itself (one editable question).
- **Data-slot mode:** the target's editable questions are the slot's _mapped_ questions, surfaced
  via `coverage.questions` (now enriched with `key`/`type`/`typeConfig`/`value`, populated when
  `showSlotQuestions` **or** `inlineCorrectionEnabled`). A fix edits those questions and the PUT's
  reconciliation recomputes the reading; a slot with **no** mapped questions shows no gesture.

`SessionWorkspace` computes the just-filled keys for the chat strip in both modes: data-slot mode
reuses `diffNewlyFilled`; question mode uses the new `diffNewlyFilledQuestions` (the panel's own
scroll/stepper stays data-slot-only — unchanged). The gesture is hidden when the session is blocked
(the `PUT` rejects a non-active session anyway) and in the read-only admin viewer.

## Layout

Both respondent pages render `SessionWorkspace` inside the existing
`BrandThemeProvider`, so the panel inherits the brand CSS vars (`--app-accent-color`,
`--app-cta-color`) with no prop-drilling. The grid is
`lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_26rem]`; below `lg` the panel is
`hidden lg:flex`, so small screens get the full-width chat (the F7.1 experience). The
authenticated page SSR-seeds the panel via `loadAnswerPanelState` (the owner is already
verified); the anonymous page can't (the token is client-only), so its panel shows a
brief skeleton before the first fetch.

## Confidence language

`confidence.ts` maps a 0–1 confidence to a quiet, semantic band. Four scored bands (not the
earlier three) track the finer extraction rubric (0.3–1.0 by directness × elaboration ×
certainty): **high** ≥0.85 ("Confident"), **moderate** ≥0.65 ("Fairly sure"), **tentative**
≥0.45 ("Tentative"), **low** <0.45 ("Unsure"), plus **unscored** ("Captured"). This deliberately
**decouples** the respondent panel from the admin eval chips (`evaluation-metric-chips.tsx`, still
two-cut at 0.85/0.6) — the panel needs the extra resolution to make the new nuance legible.

The respondent sees a tinted dot (`ConfidenceIndicator`) **and** the label + raw percentage
(`ConfidenceScore`, e.g. "Fairly sure · 62%") on every captured slot — by product decision the
nuanced 30–100% range is shown, not collapsed to a band word. The panel header pairs completion
with the **average confidence** across all filled slots (an honest mean — a tangential, low-confidence
fill drags it down by design), computed server-side in `_lib/answer-panel.ts` and carried on
`AnswerPanelView.averageConfidence`.

## Breadth — coverage of a slot's background questions (data-slot mode)

A data slot maps to one-or-more questions (`AppDataSlotQuestion`, M:N). The fill's `confidence` is
the agent's **certainty about the captured position** — it says nothing about how many of the slot's
background questions are actually answered. **Breadth** is that second, orthogonal axis: it makes the
2×2 legible (a slot can read "Confident" yet cover only 2 of 5 questions). Confidence stays the pure
quality signal; breadth is purely additive (`confidence.ts` is untouched).

Each `DataSlotPanelSlot` carries `coverage: { total, answered, questions[] }`, computed in the read
seam from the slot's mapped question keys ∩ the session's answers. The panel renders it via
`SlotBreadthMeter`:

- **Always** — a neutral, **hue-free segmented pip meter** (`▰▰▰▱▱`) + "N of M questions", in every
  presentation mode. The pips deliberately use a different visual grammar from the confidence dot
  (count vs. quality hue), so the two never read as duplicate signals. Past `MAX_PIPS` (6) the pips
  drop and the fraction shows alone, so a many-question slot never sprawls.
- **`both` mode only** — the meter becomes a disclosure button that itemises the mapped questions,
  each with a tick / empty state and its **own** confidence dot. Gated on `presentationMode === 'both'`
  (where the respondent also sees the form), carried as `AnswerPanelView.showSlotQuestions`. In
  chat/form-only the raw prompts are **never shipped** (`coverage.questions` is `[]`) — the count
  summary alone preserves the chat-mode abstraction. Question order follows the questionnaire's own
  order, not the M:N join's insertion order.

## Answer evolution — the "Edited" history dialog (data-slot mode)

When a respondent changes a captured position (e.g. _25-year-old male → female_), the prior reading
isn't silently overwritten: each change pushes a step onto the fill's refinement history, and
`upsertDataSlotFill` (`_lib/data-slot-fills.ts`) snapshots `previousValue / previousParaphrase /
previousConfidence / previousRationale` plus a `changedAt` ISO stamp. The read seam projects those
onto `DataSlotPanelSlot.history` (oldest-first; `rationale`/`changedAt` are `null` on steps recorded
before per-change capture existed).

A step is pushed **only when the captured `value` actually changed**, compared **canonically**
(`canonicalValueKey` — object keys sorted recursively, string leaves trimmed; arrays stay
order-sensitive, types are not coerced). This matters because the extractor re-emits **every** slot
each turn as a "superset" re-write (see the extraction prompt's RE-SCAN rule), so a re-emit that only
rewords the paraphrase/rationale, reorders keys, or nudges confidence must **not** append a spurious
revision. A reworded paraphrase of the same value, or a soft confidence bump from corroboration,
updates the row in place without a new history step.

The row surfaces this as a quiet **"N Edit(s)" pill** rather than the old inline strikethrough list,
which crowded the row. Opening it (`SlotHistoryDialog`) reveals the full evolution as a **newest-first
timeline** — the current reading on top, then each prior step with its paraphrase, confidence, the
agent's rationale at the time (or an explicit _"Reason not recorded"_ when absent), and a compact
locale stamp (invalid/absent → _"Earlier"_). Steps that never carried a reading are filtered out, and
the dialog renders **nothing** when no prior states remain — so a once-and-done slot shows no pill.
Read-only display; inherits the brand CSS vars from the panel's `BrandThemeProvider`.

## Navigation aids for long questionnaires (data-slot mode)

A questionnaire with many data slots scrolls off-screen, so the respondent can't see overall
coverage and can miss a slot the latest turn filled below the fold. Two **data-slot-mode-only** aids
address this (question mode is unchanged):

- **Minimap** (`SlotMiniMap`) — a floating, vertical, scaled-down mirror of the scroll area (like the
  workflow-canvas minimap), pinned to the left edge of the list. One thin bar per slot, **sized and
  positioned proportional to the real rows** (so it's a true mini-render, not an even grid), tinted by
  confidence band when filled (`bg-emerald/amber/orange/red-500/80`) and a faint sliver when not. A
  **viewport window** rectangle overlays what's currently on screen and follows the list as it
  scrolls; click or drag the track to scrub the list (`onScrubToFraction`). No theme headers, no
  legend, no raw numbers — purely a graphic. Geometry is measured from the live DOM (`scrollHeight`,
  row rects) in `AnswerSlotPanel` and projected to percentages by the pure `computeMiniMapModel`
  (`minimap.ts`); re-measured on content change + `ResizeObserver`, while a scroll only updates the
  cheap `viewportTop`. Renders only past a slot-count floor (`OVERVIEW_MIN_SLOTS = 10`) **and** when
  the content actually overflows. `aria-hidden` (the list + stepper carry keyboard/SR navigation).
- **After-turn stepper** — when a turn fills slots, the panel scrolls to the topmost one, pulses it,
  and (if more than one) a footer on the focused row reads "2 more answers recorded →"; clicking
  steps down through each ("1 more slot was answered" on the last hop). Scrolling targets the panel's
  **own** container (`scrollTo`, never the window), respects reduced motion
  (`usePrefersReducedMotion`), and moves focus + an `aria-live` announcement so keyboard/SR users
  follow the jump.
- **Previous-turn highlight** — the slots the **most recent fill-turn** captured briefly **pulse** in
  every surface, then **settle** to a static marker (a ring / resting tint) that stays until a newer
  turn fills something, so they remain identifiable after being viewed **without flashing
  indefinitely**. "Most recent fill-turn" = the slots whose `answeredAtTurnIndex` equals the maximum,
  via `recentlyFilledByLatestTurn` (`newly-filled.ts`) — deliberately **decoupled** from the
  diff-based `newlyFilledKeys` (which drives the one-shot stepper and clears on a no-fill turn).
  Animations are **one-shot** variants (a few cycles, then settle) so the minimap — which doubles as
  the scroll affordance — doesn't breathe forever:
  - **Data-slot list rows** → `cq-fill-glow-once` (a soft accent background that pulses a few times,
    then rests on the muted tint; non-dimming).
  - **Minimap bars** → `ring-primary` + `cq-livedot-once` (a brief opacity/scale pulse that keeps the
    confidence colour, then settles to a static ring).
  - **Form view** (`SectionNavigator` + `QuestionnaireForm`) — the navigator dots for those questions
    → `cq-livedot-once`; the filled answer block → `cq-fill-glow-once`. The form computes its own
    recently-filled set from `view.sections[].slots[].answeredAtTurnIndex` (no workspace plumbing).

  The infinite `cq-livedot` / `cq-fill-glow` still exist for true _live_ indicators (e.g. the cohort
  live dot); the `-once` variants are the recently-filled emphasis. All carry a
  `prefers-reduced-motion` fallback (`cq-fill-glow*` keeps a resting tint; `cq-livedot*` falls back to
  full opacity), defined in `app/globals.css`.

**How "newly filled" is known** (`newly-filled.ts`): the messages stream never tells the client a
turn ordinal, so `SessionWorkspace` keeps the previous `AnswerPanelView` and **diffs** it against
each new snapshot (`diffNewlyFilled`) — a slot counts as filled-this-turn when it went unfilled→filled
**or** its `answeredAtTurnIndex` advanced (a refinement / value change / provisional→confident). The
first (SSR/seed) view seeds the baseline silently and never auto-scrolls. The ordered keys flow into
`AnswerSlotPanel`'s `newlyFilledKeys`; each slot row carries a stable `panelSlotDomId(key)` anchor.
For this, `DataSlotPanelSlot` now also carries `answeredAtTurnIndex` (resolved in the read seam from
the fill's `lastUpdatedTurnId`, like question slots).

**`lastUpdatedTurnId` is stamped only for fills that materially changed this turn.** Because the
extractor re-emits every slot each turn, stamping every upserted fill made `answeredAtTurnIndex`
advance for the whole set, so `recentlyFilledByLatestTurn` flashed **everything** even on a turn that
revealed nothing tangible. `upsertDataSlotFill` now returns `{ id, changed }` (`changed` = created, or
the canonical value or `provisional` state changed); `persistTurn` (`_lib/turn-run.ts`) adds the id to
`sideEffectDataSlotIds` — the set `recordTurn` back-stamps — **only when `changed`**. The fill row
still updates either way (new paraphrase/confidence land); it just doesn't re-flash. The gap-filler's
ids are always included (it only ever creates fresh fills).

## Not here

Read-only display, so no `<FieldHelp>` (that's for form inputs). Session-lifecycle UX
(pause/resume controls, completion prompt) is **F7.3**; PDF export is **F7.4**.
