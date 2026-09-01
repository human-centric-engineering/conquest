---
feature: F21
title: Sectioned interviews, one section at a time
phase: P21, Sectioned interviews
status: proposed, planned before the code. Phases A to E below; needs sign-off on §3 (the resolver ladder) and §9 (the close gate defaults)
owner: TBD
opened: 2026-09-01
docs: .context/app/questionnaire/sectioned-interviews.md (to be written in phase E)
---

# Sectioned interviews

A ConQuest interview is one continuous conversation over the whole instrument: one
`AppQuestionnaireSession`, one linear transcript of `AppQuestionnaireTurn` rows, one answer panel
showing everything at once, one report, one transcript download. The data-slot orchestrator lingers
in a theme and bridges out when the area is exhausted, but nothing bounds the conversation, nothing
marks where one area ended, and the respondent has no way to see or steer which part of the
instrument they are in.

This spec makes sections a first-class runtime concept: a bounded conversation per section, a tab
strip to navigate between them, a per-section close gate with an explicit "move on" affordance, a
fresh opening question at the top of each section, and section-aware artefacts.

## 1. Why

A 70-question diagnostic (Merlin5 is the live example) is experienced as an undifferentiated
20-minute stretch. Three specific failures:

1. **The respondent cannot act on progress.** The top bar says 43%. It does not say which areas are
   done, so there is nothing to decide and nothing to feel finished about.
2. **There is no place to stop.** Session pause exists, but it parks the whole interview. A
   respondent who has twelve minutes wants to finish an area, not suspend mid-thought.
3. **An admin cannot say "settle this before moving on".** The instrument may have a genuine order
   (context, then problem, then appetite) and the product has no way to hold it.

The mechanism this adds is a boundary plus a close gate. Everything else follows from those two.

## 2. The one-line architecture

**Sections are resolved from groupings that already exist, intersected with the session's resolved
scope, and used to filter the candidate pool that both orchestrators already take.**

No new grouping model, no new scope mechanism, no change to what "done" means for a session.

## 3. What a section IS: the resolver

Three parallel groupings over the same questions already exist, and none is the answer alone:

| Grouping          | Model                     | Has                                                                                                                                                               | Lacks                                               |
| ----------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Document sections | `AppQuestionnaireSection` | Order, admin CRUD, the document's own shape                                                                                                                       | No data-slot membership; slots cross section lines  |
| **Topics**        | `AppQuestionnaireTopic`   | `label` (documented as "admin- and respondent-facing name"), `ordinal`, `phase`, `members: {questionKeys, dataSlotKeys}`, an admin editor, per-respondent scoping | Only meaningful once seeded or authored             |
| Data-slot themes  | `AppDataSlot.theme`       | What the respondent panel already groups by; what the orchestrator already lingers within                                                                         | Free-text label, no ordinal, no question membership |

`resolveInterviewSections()` picks by a ladder. Config `source: 'auto'` is the default:

```
topics    → conditionalTopics.enabled AND the version has >= 1 topic
themes    → the version has >= 1 data slot carrying a theme      (the common case)
document  → otherwise: AppQuestionnaireSection, questions only
```

`'topics' | 'themes' | 'document'` are also selectable explicitly, so an admin can pin the grouping
when the ladder picks wrong.

**Why topics win when they are available.** `planSeededTopics` (`scope/seed.ts`) already creates one
`core` topic per extracted section on every ingest, carrying that section's question keys, with data
slots attached afterwards by `planDataSlotAttachment` (majority of mapped questions, additive only,
never a move). The topic set is therefore already the document's sections plus the data-slot
membership those sections lack, which is exactly the union a runtime section needs. It is addressed
by key, so it forks with the version with no re-linking.

**Why this composes with Conditional Topics for free.** `resolveScope()` already returns
`topicByQuestionKey`, `topicByDataSlotKey` and `depthByTopicKey`. Its own docblock says the maps are
"for grouping a report by topic", and it populates them **even at full scope, with the feature off**.
So the tab strip is the in-scope topic set: a respondent gets tabs only for the areas their plan
seated, new tabs appear when the plan lands mid-interview (the F17.33 widening story, already
solved), and `PlannedTopic.respondentReason` is already the sentence to caption a newly-appeared tab
with.

The resolved shape, `lib/app/questionnaire/sections/types.ts`, pure and client-safe:

```ts
export type SectionSource = 'topics' | 'themes' | 'document';

export interface InterviewSection {
  key: string; // topic key | slugified theme | section id; stable per version
  label: string; // respondent-facing
  ordinal: number;
  source: SectionSource;
  questionKeys: readonly string[];
  dataSlotKeys: readonly string[];
  /** Only ever set on a topic-sourced section: 'opening' pins first, 'closing' pins last. */
  phase?: TopicPhase;
}
```

Theme ordering is `min(AppDataSlot.ordinal)` within the theme, which is deterministic and needs no
new column. Topic ordering is `ordinal`, with `opening` hoisted and `closing` pinned last
(`ALWAYS_PHASES` already encodes that intent). A section with no members is dropped, exactly as
`planSeededTopics` drops an empty section.

## 4. What this is NOT: the invariants that keep it safe

1. **Off by default, inert by construction.** With `sections.enabled` false, or when fewer than two
   sections resolve, `buildSectionState` returns `active: null` and every downstream branch is
   skipped. Both orchestrators see exactly the inputs they see today. This is a tested gate, not a
   hope: the phase B merge is blocked on a test asserting byte-identical turn context, panel view and
   transcript against `main`.
2. **Sections do not redefine done.** `assessCompletion` and `POST .../submit` stay version-wide. A
   session is submittable exactly when it is today. Sectioning changes the route through the
   instrument, never the definition of the destination.
3. **Sections are not a second scope mechanism.** They decide order and boundary. Conditional Topics
   alone decides what applies to this respondent. A section outside the plan is not shown at all, and
   sectioned mode can never widen an interview.
4. **The whole-session progress figure is untouched.** The top bar keeps showing whole-session
   weighted coverage, and the `progressFloorPct` ratchet (capped at 99) stays whole-session so it
   cannot go backwards when a section is reopened. Per-section progress lives on the tabs. Two
   figures answering two questions, as `coverage` and `displayCoverage` already are.

## 5. Configuration

A Json block on `AppQuestionnaireConfig`, following `conditionalTopics`, `houseRules` and
`respondentReport`: one coherent feature with a dozen knobs, not a dozen scalar columns.

```ts
export interface SectionedInterviewSettings {
  /** Master switch. FALSE by default. While false nothing below is read. */
  enabled: boolean;
  source: 'auto' | SectionSource; // 'auto'
  navigation: 'sequential' | 'free'; // 'sequential'
  /** What happens to an answer that informs a section other than the active one. */
  tangentPolicy: 'stay' | 'capture'; // 'capture'
  /** Fraction of the section's in-scope questions answered before "move on" unlocks. */
  closeCoverage: number; // 1.0
  /** Answered-count bar; 0 means not a criterion. Applied WITH the coverage bar, not instead of it. */
  closeMinAnswered: number; // 0
  /** Hard cap on turns in one section; 0 is off. Always unlocks the close, like maxQuestionsPerSession. */
  maxTurnsPerSection: number; // 0
  /** The interviewer offers the move as well as the button appearing. */
  agentOffersClose: boolean; // true
  /** Sequential mode still shows what is coming, greyed and unclickable. */
  showLockedSections: boolean; // true
}
```

`tangentPolicy` is the "can a tangential answer fill a slot outside the current section" dial, and
it is deliberately capture-but-never-chase:

- **`capture` (default).** The extractor may still fill an out-of-section slot, so the existing
  VOLUNTEERED TOPICS rule in `extraction-prompt.ts` keeps working and nothing a respondent says is
  thrown away. But **targeting never leaves the active section**: the deepen-a-tangent re-surfacing
  in `runDataSlotTurn` is suppressed for out-of-section keys, and the interviewer prompt is told the
  boundary. An out-of-section capture shows on that section's tab as progress made in advance.
- **`stay`.** Out-of-section fills and answers are dropped in `persistTurn` before the write. The
  strictest reading of "bounded by that section". It costs the respondent's volunteered signal, which
  is why it is not the default.

Wiring follows the documented config path, which is partly compiler-enforced:

| Step | File                                                           | Note                                                                      |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | `prisma/schema/app-questionnaire.prisma`                       | `sections Json @default("{}")` on `AppQuestionnaireConfig`                |
| 2    | `lib/app/questionnaire/types.ts`                               | field on `QuestionnaireConfigShape` plus `DEFAULT_QUESTIONNAIRE_CONFIG`   |
| 3    | `lib/app/questionnaire/sections/settings.ts`                   | `narrowSectionedInterviewSettings` plus Zod, mirroring `scope/schemas.ts` |
| 4    | `.../[vid]/config/route.ts`, sibling of `_lib/topic-routes.ts` | `patchSectionedInterviewSettings`: a Json block merges, it does not PUT   |
| 5    | `_lib/detail.ts`                                               | `CONFIG_SELECT` plus a `toConfigView` narrower                            |
| 6    | `lib/app/questionnaire/settings-registry.ts`                   | **compile error until added** (`satisfies Record<keyof ...>`)             |
| 7    | `components/admin/questionnaires/config-editor.tsx`            | new group, `<FieldHelp>` on every field                                   |
| 8    | `copyVersionGraph`                                             | a Json column needs an explicit `jsonInput()` line; scalars ride free     |

Two parity tests (`settings-registry.test.ts`, `config-export.test.ts`) fail until steps 2 and 6
agree, which is the intended tripwire.

`authoring/config-conflicts.ts` gains two entries: sectioned mode with
`answerSlotPanelScope: 'hidden'` (the tab strip is the panel's chrome, so warn rather than block),
and `navigation: 'sequential'` with `allowEarlyFinish` (compatible, but the warning has to say that
early finish ends the whole interview, not the section).

## 6. Data model

Two additive, nullable columns. No new table.

- **`AppQuestionnaireSession.sectionRun Json?`**, narrowed on read like `interviewPlan`:

  ```ts
  interface SectionRun {
    v: 1;
    activeKey: string | null;
    sections: Array<{
      key: string;
      status: 'not_started' | 'in_progress' | 'closed';
      openedAtTurn: number;
      closedAtTurn: number | null;
      closeReason: 'respondent' | 'agent_offer' | 'cap' | 'auto' | null;
      reopenCount: number;
    }>;
  }
  ```

  A blob rather than a table, matching `interviewPlan`, `raisedMilestones` and `rescannedTopicKeys`:
  it is read every turn from a row already loaded, and it is never queried across sessions.

- **`AppQuestionnaireTurn.sectionKey String?`**: which section this exchange belongs to. Null on
  every pre-feature turn and on every unsectioned session, which is what makes the transcript, the
  inspector and the report chapters degrade to today's behaviour by construction rather than by a
  branch someone has to remember.

> **Migration discipline, because this repo bites here.** Generate with
> `prisma migrate dev --create-only`, then strip the phantom pgvector DDL before applying: a plain
> `migrate dev` drops the five platform vector indexes. Recreate and verify the indexes afterwards,
> and restart `npm run dev` before verifying anything live, because a running dev server holds a
> stale Prisma client.

## 7. Runtime: where the boundary is enforced

`buildTurnContext` is already the single choke point that calls `buildSessionScope` then
`resolveScope`. It gains a sibling, `buildSectionState`, which resolves the section list, intersects
it with `ResolvedScope`, reads `sectionRun`, and returns `{ sections, active, closeAssessment }`.
Nothing else resolves sections, and the new section-filtered loaders must satisfy the existing scope
leak-guard test (`tests/unit/lib/app/questionnaire/scope/leak-guard.test.ts` reads source and fails
on an unscoped loader).

### The bound is a SECOND list, never a narrowing of the first

This is the sharpest thing the build turned up, and it was a real defect before it was a rule.

The obvious implementation is to narrow `base.questions` and `base.dataSlots` at the choke point and
let everything downstream inherit the bound. That is wrong, and it breaks invariant 2 immediately:
those two lists are read by the **submit gate**, the weighted coverage, the progress bar and the
milestone ledger as well as by targeting. Narrowed, a session offers to submit the moment its FIRST
section is covered, and the bar reads 100% with six sections still to come.

So `buildTurnContext` carries `sectionQuestions` / `sectionDataSlots` **alongside** the scoped lists,
absent (not empty) when the interview is not sectioned. The rule for a reader is one line:

> Read the section list where a question is being **chosen**. Read the full list wherever completion,
> coverage or progress is being **measured**.

- **Data-slot mode** (`runDataSlotTurn`): the targeting pool, the **late-stage sweep** and the
  **must-ask hoist** read the section pool, so a `must_ask` waiting in section 3 cannot interrupt
  section 1, which is the same promise the hoist already makes within a theme, applied one level up. The
  submit gate (`allQuestionsAnswered`) and the coverage figure keep reading the whole interview.
- **Question mode** (`runTurn`): only the `invokers.selectNext(...)` call is handed the section pool,
  so all four strategies inherit the boundary for free (`adaptive` included, whose pgvector ranking
  then runs over that pool). `assessCompletion` above it is untouched.
- **Extraction**: `dataSlotCandidates` still carry the whole version under `capture`; under `stay`
  the out-of-section results are dropped in `persistTurn`.
- **Not bounded at all**: `answered`, `existingAnswers` and `recentMessages`. What the respondent
  already said does not stop being true because they moved on, and the extractor needs the whole
  picture to read a correction against.

## 8. A fresh opening question per section

`buildStreamingQuestionPrompt` already keys the opening off `isOpening = state.selectionRound === 0`,
and `usesOpenOpening` / `usesGuidedOpening` already demote the selected question to "the AREA to
explore" and instruct a broad invitation instead of asking the item.

The change is small and precise: **`isOpening` becomes true on the first turn of every section**
(`sectionTurnIndex === 0`), and the prompt's `this_turn` block names the section being opened. Each
section therefore starts with a genuine opening question in the questionnaire's own configured
style, rather than the interviewer walking into new territory mid-stride.

The funnel arc (`funnelPhase`, `paceProfile`) restarts per section. An arc that narrows across twenty
minutes makes no sense when the subject changes. `AppQuestionnaireTurn.funnelPhase` already records
the phase per turn, so every admin surface stays honest with no change.

## 9. Closing a section, and reopening one

This mirrors the two-layer split F4.5 established, and reuses it rather than reimplementing it.

1. **The gate is deterministic and pure.** `assessSectionCompletion()`
   (`lib/app/questionnaire/sections/close.ts`) calls the existing `assessCompletion` over a
   `CompletionContext` narrowed to the section's questions, with `closeCoverage` and
   `closeMinAnswered` standing in for the version-level thresholds. **They are ANDed**, inherited
   rather than restated: they are the section-scale twins of `coverageThreshold` +
   `minQuestionsAnswered`, not of the early-finish pair, whose OR is right for a respondent's right
   to leave and wrong for an author's statement about coverage. `maxTurnsPerSection` sits outside
   the wrapped gate entirely, because it counts TURNS while that gate's own cap counts ANSWERS.
   It inherits, for free, the
   ordering that is already load-bearing (cap, then the **required gate**, then thresholds), the
   `answerConfidenceFloor` filtering that keeps a tentative capture from counting, and the
   `COVERAGE_EPSILON` guard. A section holding an unanswered **required** question is
   `blocked_on_required` and cannot be closed.
2. **The phrasing is the model's.** With `agentOffersClose` on, once the gate says the section is
   done the reply is composed by the existing completion agent through `streamOfferMessage` with a
   section-scoped brief. It never decides whether, only how to say it.

The button is the respondent's parallel right, exactly as `EarlyFinishControl` is: a persistent,
clearly visible "done with this section, move on" that unlocks the moment the gate clears.

**The route**: `POST /api/v1/app/questionnaire-sessions/[id]/sections`, body
`{ action: 'close' | 'open', key }`.

- Gate order copies `/messages`: load session, `resolveTurnAccess` (authenticated owner or a valid
  anonymous `X-Session-Token`), status must be `active`, then validate.
- `close` re-asserts `assessSectionCompletion` server-side, for the same reason `/submit` re-asserts
  its own gate: a stale or forged client must not be able to skip a required question. It stamps
  `closedAtTurn` and advances `activeKey` to the next open section in order.
- `open` is the tab click. Legal for a `closed` section (**reopen**: sets `in_progress`, bumps
  `reopenCount`), and for a `not_started` section only under `navigation: 'free'`.
- The next turn on a newly-opened section runs with `isOpening` true, so the agent opens it.
- No per-flow sub-cap: a single-row transaction inherits the automatic 100/min section cap.

**Reopening is deliberately ordinary here**, unlike the session-level reopen, which needed
`isReopenEligible` and its own seam because it crosses a terminal status. A section has no terminal
status: `closed` is a position in a run, not an end state, so reopening it is a plain write.

## 10. The respondent surface, across every layout

The surface is not one arrangement any more. `RESPONDENT_LAYOUTS` carries four
(`classic`, `focus`, `broadsheet`, `horizon`), each a `LayoutDefinition` in
`components/app/questionnaire/layouts/registry.ts`, and the sections UI has to work in all of them
rather than assuming Classic. Two facts drive the whole design of this section, and both were found
by reading the registry rather than assumed:

1. **Three of the four layouts omit `answersPanel` entirely.** Focus, Broadsheet and Horizon each
   record a different reason, and all three relocate review into the `answersDrawer` sheet at every
   width. So "the data-slot area scrolls into focus when you switch section" is literally true on
   Classic only. See §10.3.
2. **The contract is compile-enforced, and that is the mechanism to use.**
   `LAYOUT_REGISTRY ... satisfies LayoutRegistry` resolves to
   `Record<RespondentSlotKey, SlotPlacement>` per layout, so **adding a key to `RESPONDENT_SLOTS`
   does not build until all four layouts declare where that part goes**. A `SlotPlacement` is
   `region` (on screen, with layout-local prose naming the area), `overlay`
   (`sheet | drawer | modal | gesture`, reachable on request), or `omitted` (with a required
   `because`, so "we forgot" cannot masquerade as a choice).

### 10.1 The two new slots, and why both are essential

- **`sectionTabs`**, rendered by `components/app/questionnaire/sections/section-tab-strip.tsx`.
  One tab per in-scope section: label, per-section progress, a tick when closed, greyed and
  unclickable when locked, hidden when `showLockedSections` is off. Scrollable inside its own
  `overflow-x` container, because a twelve-section instrument must not widen the shell.
- **`sectionClose`**: the move-on control. The full `CompletionOffer` still takes precedence when
  the whole session is done.

Both go into `ESSENTIAL_SLOTS`. The test that list applies is "can the respondent finish, correctly,
without it", and in sectioned mode the answer is no for each: without `sectionClose` a sequential run
cannot advance past section one, and without `sectionTabs` a free-navigation run has no route to
another section. Note what this does and does not forbid, which is the same distinction `history`
already lives with: `overlay` stays legal, so a layout may fold either behind a gesture; `omitted`
does not, so no layout can quietly delete the only way through the instrument.

The consequence is that adding these keys **breaks the build until all four layouts have
re-classified them**. That break is the mechanism working, exactly as it was when `conversation`
split for Broadsheet and `transcript` split for Horizon.

### 10.2 Where each layout puts them

Placements are proposed, not settled; each layout owner reserves the right to argue. What is settled
is that each one has to say something, and that nothing may be `omitted`.

| Layout         | `sectionTabs`                                                                                          | `sectionClose`                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **Classic**    | `region`: strip above the conversation card, below the lifecycle strip                                 | `region`: foot of the conversation card, beside the composer     |
| **Focus**      | `region`: a compact "section 3 of 7" control in the lifecycle strip's trailing cluster, opening a menu | `region`: foot of the conversation card, beneath the composer    |
| **Broadsheet** | `region`: the margin, above the completion offer                                                       | `region`: the margin, with the composer and the completion offer |
| **Horizon**    | `overlay via gesture`: a section menu off the stage header, alongside the folded history               | `region`: above the stage, with the completion offer             |

The reasoning is each layout's own, not a house rule copied four times:

- **Classic** has room and a two-column split. Tabs are chrome and belong with the chrome.
- **Focus** strips chrome deliberately. A full tab strip would reintroduce exactly what the layout
  exists to remove, so the tabs collapse into the trailing cluster beside the review trigger, which
  is already the pattern that layout uses for anything it will not put on screen permanently.
- **Broadsheet** has one margin, and it already holds the two things the respondent DOES (answer,
  and finish). Choosing which area to work in is a third such thing, so it joins them there rather
  than floating above the document, which is the thing they read.
- **Horizon** folds everything that is not the current question. A permanent strip listing seven
  areas is precisely the accumulated wall it exists to put away, so the tabs go behind the same kind
  of gesture the history does. `sectionClose` is the exception and stays on screen, because it is an
  action on the current question, not a record of past ones.

### 10.3 Focusing the answers when the section changes, on a layout with no panel

The requested behaviour is that switching section brings the captured answers for that section into
focus. On Classic that is the literal scroll-and-pulse. On the other three there is nothing on screen
to scroll.

The container resolves this by **reading the placement**, which is the idiom the registry already
establishes twice (`reviewTrigger` drops Classic's `lg:hidden` on the three panel-less layouts by
reading `answersPanel.kind`, and `composer` reads `fills` / `prominent` the same way). So:

- `placements.answersPanel.kind === 'region'` (Classic): scroll the panel to the section's first
  slot and pulse it, reusing `panelSlotDomId()` and the existing after-turn stepper machinery, which
  already scrolls the panel's own container rather than the window, respects
  `usePrefersReducedMotion`, and moves focus with an `aria-live` announcement.
- otherwise (Focus, Broadsheet, Horizon): **do not auto-open the sheet.** Opening a bottom sheet on
  every tab click is an unrequested takeover, and it fights the explicit reason each of those three
  layouts gives for folding review away. Instead mark the `reviewTrigger` as having new content for
  this section, and when the drawer IS already open, scroll and pulse inside it exactly as Classic
  does in the panel. The drawer and the panel render the same component, so this is one code path
  with two hosts, not two implementations.

This is a deliberate softening of the original requirement, and it is recorded here rather than
silently implemented: on three of four layouts the answers come into focus **when the respondent
looks at them**, not the instant the section changes.

### 10.4 The strip is resolved server-side, not discovered by fetching

`sectioned` is resolved on the server (`resolveSectionedForVersion`, off the already-cached surface
row) and passed to `SessionWorkspace` as a prop, exactly as `answerPanelScope` is, for the reason
that setting records: the layout differs from the first paint, and a tab strip that appears a moment
after the conversation reads as a glitch.

It also means the strip's own endpoint is called ONLY by a surface that has sections to draw. The
first build had the hook fetch on mount unconditionally, which put an extra round-trip on every
respondent session of every questionnaire, to be told the feature was off. The existing
`session-workspace` tests caught it by asserting an exact fetch count, and the right fix was the
cause rather than the assertion.

### 10.5 The rest of the switch

Switching sections is one client action in `useSessionWorkspace`, which already owns every hook and
gate: POST the open action, refetch the panel and the tab model, run the focus gesture above, swap
the transcript to that section's turns, and fire the kickoff turn if the section has none yet.

- **Chat** renders only the active section's turns. `loadTranscript` gains an optional `sectionKey`
  filter; the client already holds the full turn list, so switching is a local filter with no
  refetch. This works unchanged in every layout, including Horizon, where `history` is behind a
  gesture and `currentExchange` is on the stage: filtering happens before the two are split.
- **Panel and drawer** filter to the active section's slots. In data-slot mode the theme grouping
  survives inside the section, since a section may hold several themes; in question mode
  `PanelSectionView` is filtered rather than regrouped. The minimap and the breadth meter need no
  change, because they measure whatever list is rendered.
- **Inspector**: `TurnInspectorDrawer` follows the active section for free once the transcript is
  filtered. Its header gains the section name.

### 10.6 What the layout tests must gain

`tests/unit/components/app/questionnaire/layouts/registry.test.tsx` already renders each layout with
a sentinel per slot and asserts every `region`-placed slot reaches the DOM, and
`missingEssentialSlots` already refuses a layout that omits an essential. Both pick the new slots up
automatically once the keys exist, which is the point of adding them to the shared vocabulary rather
than threading props. The one test to write by hand is the placement-driven focus branch in §10.3,
because that is container logic reading a declaration, and no layout renders it.

## 11. Artefacts

- **Transcript.** `build-transcript-text.ts`, `transcript-pdf-document.tsx` and the copy action group
  turns by `sectionKey` under a section heading, in section order. Turns carrying a null key render
  flat exactly as today. This is the "one chat per section in the transcript download".
- **Respondent report: one artefact, chapters per section.** `generateReportFromInputs` gains a
  section dimension on its input assembly: content is bucketed by section (via `resolveScope`'s
  `topicByQuestionKey` and `topicByDataSlotKey` for topic sections, or the theme map otherwise) and
  the formatter emits one chapter per section in order. `mode: 'raw'` gets it deterministically for
  free. A section that was **never opened** is reported as not covered, not as no answer: the same
  distinction `NotAssessedTopic` already draws between "we looked lightly" and "we did not look", and
  for the same reason, since a report that blurs them overstates its own coverage.
- **Admin session viewer** shows the section timeline: opened, closed, reopened, with turns and cost
  per section. This is where a stalled section becomes visible to an operator.
- **Questionnaire pack and definition export** pick the settings up automatically once
  `SETTING_DESCRIPTORS` carries the entry.

## 12. Explicitly out of scope

- **No per-section report row and no per-section notification.** One report, chapters. A standalone
  report per section is plausible later; it multiplies both LLM spend and reporting surface, and
  nothing yet asks for it.
- **No new grouping model.** If the ladder resolves badly for a questionnaire, the fix is authoring
  its topics or its slot themes, both of which have admin surfaces already.
- **No cross-device section resume beyond what session resume already does.** `sectionRun` rides the
  session row, so resume gets it for free. Nothing new is needed and nothing new is promised.
- **No per-section cost cap or budget.** `costBudgetUsd` and `sessionBudgetSeconds` stay
  session-level. Splitting a budget across sections needs a policy for what happens when one section
  overruns, and there is no evidence yet about which policy is right.

## 13. Consequences to accept, stated plainly

- **A sectioned interview will usually be longer**, because a bounded conversation cannot
  opportunistically finish three areas from one rich answer. `tangentPolicy: 'capture'` recovers most
  of that, but not all of it. This is the trade the feature is: structure costs some efficiency.
- **The tab strip shows the respondent how much is left**, which is honest and occasionally
  discouraging. That is preferable to the current state, where the same fact is hidden behind a
  percentage they cannot act on.
- **Two progress figures now exist on screen** (whole-session on the bar, per-section on the tabs).
  They will occasionally look inconsistent to someone reading carelessly. The alternative, making the
  bar section-local, is worse: it would reset visibly at every boundary.
- **A theme-sourced section set inherits the generator's labels.** They were written to group a
  panel, not to head a chapter. Some will read oddly as tab labels until an admin edits them.
- **The answer panel's own header counts the section it is showing, and does not yet say so.**
  Question mode reads "3 of 5 answered" over the active section's rows while the top bar reads the
  whole interview, so the two figures can look inconsistent to a careless reader. This is the same
  two-figures trade as the tabs, one level down, and it is the honest count of what is on screen.
  Left as-is deliberately rather than half-fixed: the copy change ("3 of 5 in this section") is a
  wording decision, and inventing one mid-build is how a surface ends up with three ways of saying
  the same thing. Recorded so it is picked up on purpose.

## 14. Validation and tests

**Unit, pure, no DB and no LLM**

- `sections/resolve.test.ts`: the ladder in all four states; theme ordering by `min(ordinal)`; empty
  sections dropped; fewer than two sections resolving to unsectioned; `opening` and `closing`
  pinning; intersection with a `ResolvedScope` that excludes topics.
- `sections/close.test.ts`: the gate order (cap, required, thresholds) scoped to a section; a
  below-floor tentative answer not counting; both bars required; the turn cap releasing a section
  blocked on a required question; answers and questions from OTHER sections not counting toward
  this one.
- `sections/settings.test.ts`: the narrower on `{}`, on garbage, and on a partial blob. A malformed
  blob must degrade to feature off, the only safe direction for a setting that decides what a
  respondent is asked.
- The two config parity tests, and the scope leak-guard test with the new loaders.

**Integration**

- `POST .../sections`: close blocked on a required question (a refusal, never a silent close); close
  advancing `activeKey`; reopen from `closed`; `open` on a `not_started` section refused under
  `sequential` and allowed under `free`; anonymous access via `X-Session-Token`; a non-active session
  refused.
- `/messages`: targeting never leaving the active section in either orchestrator; `isOpening` true on
  the first turn of section 2; `tangentPolicy: 'stay'` dropping an out-of-section fill.
- **The inert gate**: a version with `sections.enabled` false producing byte-identical turn context,
  panel view and transcript to `main`. This test must exist before phase B merges.

**By hand, once**

Migrate, recreate and verify the five pgvector indexes, restart dev. Enable sectioned mode on
Merlin5 with `source: 'auto'` and `navigation: 'sequential'`. Run a preview session: confirm the tab
strip, a genuine opening question in section 1, the agent staying in section 1, the move-on control
locked until the gate clears, section 2 opening with a **new** opening question, and a reopened
section 1 scrolling and pulsing the panel. Flip to `free` and confirm forward jumps. Download the
transcript in both formats. Submit and read the report.

## 15. Phasing

Each phase is committed on its own, with its tests and its docs in the same commit.

| Phase | Scope                                                                                                                                                                                                                                                  | Rough size                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **A** | The pure section model (`sections/{types,resolve,settings,close}.ts`), the ladder, `resolveScope` composition, the config block end to end plus the Settings UI. **Nothing reads it at runtime.**                                                      | medium: pure code plus the eight-step config path |
| **B** | Runtime: the two columns, `buildSectionState`, section-bounded targeting in both orchestrators, per-section opening and arc reset, `assessSectionCompletion`, the `/sections` route, reopen.                                                           | large: the real work                              |
| **C** | Respondent surface: `sectionTabs` and `sectionClose` added to `RESPONDENT_SLOTS` and `ESSENTIAL_SLOTS`, placed in all four layouts (§10.2), the placement-driven focus branch (§10.3), transcript filtering, sequential locking, the inspector header. | large                                             |
| **D** | Artefacts: transcript grouping (text, PDF, copy), report chapters, the admin session-viewer timeline.                                                                                                                                                  | medium, mostly mechanical                         |
| **E** | The domain doc plus its README index row, the per-phase trackers, and `scripts/smoke/sectioned-interview.ts`.                                                                                                                                          | small                                             |

Per-phase `f21.N.md` trackers are written **after** each phase's code lands, in the same branch, and
this file's phasing row is then edited to `Shipped, see [F21.1](./f21.1.md)`.

## 16. Risks

| Risk                                                                                                                                                                                           | Mitigation                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A theme-sourced section set is incoherent.** Themes are free-text generator labels, so a version may resolve to fourteen one-slot sections.                                                  | The resolver drops empty sections and falls back to unsectioned below two. Add a launch-checklist row, "sections resolve", showing the resolved list and count, so an admin sees what respondents will see before launching rather than after.                                                                |
| **Bounding the conversation makes it feel like a form**, which is the one thing ConQuest is not.                                                                                               | `tangentPolicy: 'capture'` is the default, so volunteered signal is still captured and only targeting is bounded. The per-section opening question and the arc reset are what keep a section reading as a conversation rather than a queue.                                                                   |
| **Sequential mode plus a `blocked_on_required` section is a dead end.** The respondent can neither close it nor leave it.                                                                      | `maxTurnsPerSection` always unlocks the close, via the `capReached` path `assessCompletion` already has. The editor's guidance should steer to a non-zero value even though the field defaults to `0`, and the UI copy has to name the block: "one thing still needed here".                                  |
| **Reopening churns the report and the progress figures.**                                                                                                                                      | Progress stays whole-session and ratcheted; the report is generated at submit, from final state. `reopenCount` feeds the admin timeline and nothing analytic.                                                                                                                                                 |
| **The migration drops the platform's pgvector indexes.**                                                                                                                                       | `--create-only`, strip the phantom DDL, recreate and verify the five indexes, restart dev before verifying.                                                                                                                                                                                                   |
| **Four layouts times two new slots is where a slot gets forgotten.**                                                                                                                           | It cannot be forgotten. `satisfies LayoutRegistry` makes an unplaced slot a compile error, `missingEssentialSlots` refuses an omission, and the registry test renders a sentinel per slot. The residual risk is a layout that CLASSIFIES a slot and never renders it, which is exactly what that test covers. |
| **The focus gesture is a no-op on three of the four layouts**, because Focus, Broadsheet and Horizon all omit `answersPanel`. Built naively it would look broken on everything except Classic. | §10.3: the container branches on `placements.answersPanel.kind`, the idiom `reviewTrigger` already uses. The softened behaviour on panel-less layouts is recorded as a decision rather than discovered as a bug.                                                                                              |

## 17. Related

- [`conditional-topics.md`](../../questionnaire/conditional-topics.md): topics, `resolveScope`, and
  the plan this composes with rather than duplicates.
- [`completion-logic.md`](../../questionnaire/completion-logic.md): F4.5, whose `assessCompletion`
  ordering and two-layer gate/phrasing split the section close reuses wholesale.
- [`data-slots.md`](../../questionnaire/data-slots.md): the theme grouping that is the fallback
  section source, and the targeting rhythm the boundary now contains.
- [`answer-slot-panel.md`](../../questionnaire/answer-slot-panel.md): the scroll, pulse and stepper
  machinery the section switch reuses.
- [`respondent-layouts.md`](../../questionnaire/respondent-layouts.md): the compile-checked slot
  registry the two new slots enter through.
