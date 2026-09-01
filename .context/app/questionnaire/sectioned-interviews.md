# Sectioned interviews

**P21.** Whether the conversation is one continuous run over the whole
instrument, or bounded to one section at a time with a strip the respondent
moves between and a per-section "finish and move on".

Off by default, and inert by construction when off. Every questionnaire in the
field before this shipped runs byte-identically.

> Sibling to [`conditional-topics.md`](./conditional-topics.md), and the
> distinction is load-bearing: Conditional Topics decides **which** parts of a
> questionnaire apply to this respondent. Sections decide the **order** they
> meet them in, and the **boundary** the interviewer stays inside. Sections can
> narrow what a scope already allowed; they can never put back a key scope left
> out.

The as-planned record, with the alternatives that were rejected, is
[`.context/app/planning/features/f21-sectioned-interviews.md`](../planning/features/f21-sectioned-interviews.md).
This file is the as-built reference.

---

## The one invariant

**An interview is sectioned only when the version opted in AND at least two
sections resolve.**

`resolveInterviewSections` returns the empty list in three cases:

1. `settings.enabled` is false,
2. no grouping supplies anything, or
3. fewer than `MIN_RESOLVED_SECTIONS` (2) sections survive.

Every caller reads `[]` as "not sectioned". Returning `[]` rather than
`[theOnlySection]` for case 3 is why no caller has to remember a length check: a
one-section interview is the whole questionnaire with a tab strip above it and a
"move on" control that goes nowhere.

Downstream, `buildSectionState` returns `INERT_SECTION_STATE` and every filter
that reads it becomes a no-op.

---

## Where the sections come from

`resolveSectionSource` walks a three-rung ladder, in this order:

| Source     | Available when                                    | Section key    | Members                                        |
| ---------- | ------------------------------------------------- | -------------- | ---------------------------------------------- |
| `topics`   | Conditional Topics is on and the version has some | the topic key  | the topic's question keys and slot keys        |
| `themes`   | some data slot has a non-blank `theme`            | the theme slug | the theme's slots, plus their mapped questions |
| `document` | the version has document sections with questions  | the section id | that section's questions                       |

`source: 'auto'` (the default) walks the ladder. An explicit pin is honoured
**only when that grouping can actually supply sections**, then falls through to
the ladder. That is deliberate: an author who pinned `topics` and later switched
Conditional Topics off gets a working sectioned interview, not an unsectioned
one that silently ignores the rest of their settings.

Two ordering rules worth knowing:

- **Topic-sourced sections order by phase first** (`opening`, then `core` and
  `conditional` by ordinal, then `closing`), because the phase is an ordering
  statement the author already made and the topic `ordinal` need not agree
  with it.
- **Theme-sourced sections order by the lowest slot ordinal each theme holds.**

A document section with no questions is dropped before the scope filter, for the
same reason `planSeededTopics` skips one: it can never be worked through, so
offering it as a tab is offering a dead end.

`ordinal` is renumbered contiguously **after** the scope filter, so anything
rendering "part 3 of 7" never shows a gap.

---

## Configuration

One Json blob, `AppQuestionnaireConfig.sections`, read through
`narrowSectionedInterviewSettings` and never destructured raw. Edited on the
**Settings tab** of the config editor (see
[`settings-on-settings-tab`](./configuration.md)), under "Work through it in
sections".

| Field                | Default        | What it does                                                                                                                           |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `false`        | The master switch. While false nothing else here is read.                                                                              |
| `source`             | `'auto'`       | `auto` walks the ladder; `topics` / `themes` / `document` pin it.                                                                      |
| `navigation`         | `'sequential'` | `sequential` = a section must be finished before the next opens. `free` = a menu.                                                      |
| `tangentPolicy`      | `'capture'`    | `capture` records an out-of-section answer against the section it belongs to but keeps the interviewer where it is. `stay` ignores it. |
| `closeCoverage`      | `1`            | Fraction of the section's in-scope questions that must be answered before the "move on" control unlocks. Edited as a whole percent.    |
| `closeMinAnswered`   | `0`            | A second bar applied **on top of** the percentage, not instead of it. `0` is off.                                                      |
| `maxTurnsPerSection` | `0`            | Turn cap that releases a stuck respondent. `0` is off.                                                                                 |
| `agentOffersClose`   | `true`         | Whether the interviewer offers the move, as well as the respondent having the control.                                                 |
| `showLockedSections` | `true`         | Whether sections not yet reachable are drawn locked or hidden entirely.                                                                |

A malformed blob degrades to "feature off". That is the only safe direction for
a setting deciding how a respondent moves through an instrument: a half-read
blob must never leave someone bounded to a section by a rule nobody wrote.

**Set `maxTurnsPerSection` if you run `sequential`.** A section holding a
required question the respondent will not answer can never satisfy the bars, and
with no cap they can neither finish it nor leave it. The cap is the only escape.

---

## Data model

Three nullable additions, no backfill. Every pre-P21 row reads correctly as-is.

| Column                                 | Type    | Null means                                  |
| -------------------------------------- | ------- | ------------------------------------------- |
| `app_questionnaire_config.sections`    | `JSONB` | (defaults to `{}`, narrowed to feature-off) |
| `app_questionnaire_session.sectionRun` | `JSONB` | not sectioned, or no turn has landed yet    |
| `app_questionnaire_turn.sectionKey`    | `TEXT`  | this exchange belongs to no section         |

`SectionRun` is `{ v: 1, activeKey, sections: SectionRunEntry[] }`, and each
entry is `{ key, status, openedAtTurn, closedAtTurn, closeReason, reopenCount,
turnsSpent }`. Read through `narrowSectionRun`.

`turnsSpent` is **counted, not derived** from `openedAtTurn` and the current
ordinal. Under `free` navigation a respondent's turns in a section are not
contiguous, so deriving it would charge section 3's turns to section 1's budget.
It is what `maxTurnsPerSection` measures against.

`activeKey` is nullable rather than defaulting to the first section, because
"the run has not started" and "the run is in its first section" are different
states, and the difference decides whether the next turn is an opening.

A Json column rather than a table, for the same reason as `interviewPlan`: it is
read every turn from a row already loaded, and never queried across sessions.

---

## Runtime

### One seam, read every turn

`buildTurnContext` calls `buildSectionState`, which:

1. resolves the sections (over the session's already-resolved scope),
2. returns `INERT_SECTION_STATE` if none,
3. **reconciles** the stored run against the resolved sections,
4. picks the active section, and
5. assesses whether it may be closed.

Reconciliation runs **every turn**, not just at the start. Conditional Topics
seats new topics when the plan lands and a respondent amendment can add one
later still, so sections genuinely appear mid-interview. An entry whose section
stopped resolving is **kept and appended** rather than dropped, so the turns
already tagged with it are not orphaned.

Choosing the active section here, rather than requiring the route to have
written one, is what lets a session predating the feature simply start at the
beginning.

### What a turn does

`POST /questionnaire-sessions/:id/messages` spreads a `section` block into the
phraser input (label, 1-based position, total, `isOpening`, and `nextLabel` when
there is a next one), and tags the persisted turn with `sectionKey` plus the
banked `sectionRun` with the turn charged to the section's budget. Both are
omitted entirely when unsectioned, so the columns stay null and every reader
falls back to the flat view.

`isSectionOpening` is true only when no turn has yet been charged to the section.
On a **reopened** section it is true only if nothing was ever said there, which
is the honest reading: an opening question for ground already worked would repeat
the conversation back at the respondent.

### When a section runs out of questions

The selector is handed the ACTIVE section's questions, so its terminal verdict is a verdict about
the SECTION, not the interview. Reading it as the latter is the one mistake this path must not
make: it told the respondent "that's everything we need" at the end of part one, on default
settings, with every later part still to come.

`runTurn` separates the two by asking `terminalDecision` over the WHOLE interview. `null` there
means the interview genuinely is not finished, so the only thing that ended was the part being
worked, and the reply becomes a `section_covered` response rather than `complete` or `none`.
Asking the whole-interview question rather than trusting "we are sectioned" alone is what keeps
`maxQuestionsPerSession` working: a session that hit its cap terminates for real.

The data-slot orchestrator has the same boundary. When the active section's slots are all filled
and its questions all answered, it reports the part covered instead of sweeping a question out of
a part the respondent has not reached and tagging the turn with the part they are in.

`agentOffersClose` shapes that message and nothing else:

| Setting | Not the last section                              | Last section               |
| ------- | ------------------------------------------------- | -------------------------- |
| `true`  | "That's everything for X. Ready to move on to Y?" | "That's everything for X." |
| `false` | "That's everything for X."                        | "That's everything for X." |

The last section never offers a move whatever the setting says: there is nowhere to move on to,
and the whole-interview completion offer is the affordance that matters there. With
`agentOffersClose` off the interviewer reports the fact and leaves the move to the respondent's own
control, which is what an author running a facilitated session wants: an interviewer that keeps
proposing the move is pressure.

### Closing a section

`assessSectionCompletion` is a **thin wrapper over F4.5's `assessCompletion`**,
not a second implementation. It narrows the questions to the section's members
and the answers to those questions' row ids, substitutes the section thresholds
for the version ones, and delegates. That is what keeps four things from
drifting: the gate ordering (cap, then required, then thresholds), the
per-question confidence floor, `COVERAGE_EPSILON`, and `capReached`.

It adds two things the raw assessment does not carry:

- `canClose`, true when the section has no questions, the turn cap is reached,
  or the assessment says `offer`.
- `blockedOnRequired`, true when the **only** thing holding the section open is
  an unanswered required question, and the cap has **not** run out. Surfaced
  separately because the copy has to name it; a generic "not yet" beside a
  control that will never unlock is where a respondent gets stuck.

A cap that has run out is deliberately not reported as blocked: the respondent
can move on, they simply did not satisfy the requirement. Reporting both would
put "one thing still needed" beside an unlocked control.

---

## The API

`GET|POST /api/v1/app/questionnaire-sessions/:id/sections`

Respondent-facing, authorised through `resolveTurnAccess` (an authenticated
owner **or** a valid `X-Session-Token`), exactly as `/messages` and `/answers`
are. `withAuth` cannot serve the no-login surface, and a respondent who can
answer a section can obviously read and move between them.

No per-flow rate-limit sub-cap: a single-row read and a single-row update,
neither spending an LLM call. They inherit the platform's automatic 100/min
section cap from `proxy.ts`.

**GET** returns the strip view. Deliberately **not** status-gated: a paused or
completed session still has a strip to draw, exactly as `/answers` still returns
its answers.

**POST** takes `{ action: 'open' | 'close', key }` and **is** status-gated, since
moving between sections changes what the interview asks next. Its error codes:

| Code                 | Status | When                                               |
| -------------------- | ------ | -------------------------------------------------- |
| `NOT_FOUND`          | 404    | no such session                                    |
| `SESSION_NOT_ACTIVE` | 409    | the session is paused, completed or abandoned      |
| `NOT_SECTIONED`      | 409    | this questionnaire is not run in sections          |
| `SECTION_NOT_FOUND`  | 404    | the key names no resolved section                  |
| `SECTION_LOCKED`     | 409    | `open` refused under `sequential`                  |
| `SECTION_NOT_ACTIVE` | 409    | `close` aimed at a section you are not in          |
| `SECTION_BLOCKED`    | 409    | `close` refused: a required question is unanswered |
| `SECTION_NOT_READY`  | 409    | `close` refused: the bars are not met              |

**`close` re-asserts the gate server-side.** The client already knows whether the
control is unlocked, because this same assessment told it so on the last turn. It
re-asserts anyway, for the reason `/submit` does: a stale client (the section
widened under them) or a forged one must not walk past a required question. The
client's copy is for drawing a button, never for deciding.

A close is recorded with `closeReason` `'cap'` when the turn budget released it
and `'respondent'` when the bars were satisfied. That is a materially different
thing to read off a session timeline later.

---

## The client-safe projection

`buildSectionStripView` (`lib/app/questionnaire/sections/view.ts`) is what the
respondent surface is allowed to know: a label, a position, a status, whether it
is active, and whether it can be moved to.

**Deliberately not the membership.** Shipping `questionKeys` would put the
questions of a section they have not reached into the browser, which is the same
reasoning `answered_only` panel scope already applies to pending prompts.

`isAvailable` under `sequential` is: the active section, any closed one (the
reopen right), and the next still-open one. Under `free`, everything.

`showLocked` rides on the view rather than being read from config by the surface,
so a client rendering the strip never holds a second copy of the settings.

---

## The respondent surface

Two slots in `RESPONDENT_SLOTS`, both in `ESSENTIAL_SLOTS`:

- **`sectionTabs`**, the strip, in a `strip` or a compact `menu` variant.
- **`sectionClose`**, "finish this section and move on".

Both are essential on the same test: can the respondent finish, correctly,
without it? Under `sequential` navigation `sectionClose` is the **only** way past
section one.

| Layout     | `sectionTabs`                                           | `sectionClose`                               |
| ---------- | ------------------------------------------------------- | -------------------------------------------- |
| Classic    | region, above the conversation card                     | region, foot of the card beside the composer |
| Focus      | region, lifecycle strip trailing cluster (compact menu) | region, beneath the composer                 |
| Broadsheet | region, the margin above the completion offer           | region, the margin with the composer         |
| Horizon    | **overlay**, behind a gesture                           | region, above the stage                      |

Horizon puts the tabs behind a gesture for the reason it folds the history away:
a permanent list of seven areas is precisely the accumulated wall it exists to
remove. `overlay` is availability, not omission. `sectionClose` stays on screen
even there, because it is an action on the current question rather than a record
of past ones, and folding it away would fold away the way forward.

`useSectionStrip` (`lib/hooks/use-section-strip.ts`) reads and writes the
endpoint. Modelled on `useAnswerPanel`: one hook for both access modes, refetched
when a turn settles, and inert when the surface has no credential to read it with
(the admin read-only viewer). Deliberately **not** part of the messages stream,
whose frames stay `start | content | warning | done | error`, F7.2 already
established that a panel reads its own endpoint rather than widening that
contract.

Both fetch failures **fail quiet**. An unreachable strip leaves the last good one
on screen; collapsing the tabs mid-conversation reads as the interview losing its
shape. A refused move leaves the strip as it was, because the server is the
authority and the controls it refused were drawn from that same view.

---

## What else reads a section

- **The answers panel** follows the conversation: when sectioned it shows the
  answers for the **active** section, not the whole instrument. Once **every**
  section is closed the filter is dropped entirely, because someone reviewing a
  finished interview wants their whole record.
- **The transcript export** resolves `sectionKey` to a heading. Resolved from the
  version's **current** topics and sections rather than snapshotted per turn: an
  export taken today should read by the names the questionnaire has today. An
  unresolvable key falls back to the key itself, which is at least a stable
  divider; dropping the heading would silently merge two sections into one block.
  Topics win over document sections on a shared key, and both queries are skipped
  entirely when no turn carries a key.

---

## The artefacts

Three things a sectioned interview leaves behind, all of which read as the flat
artefact when nothing was sectioned.

### The transcript, in both formats

`withSectionHeadings` is the shared rule, read by the plain-text serialiser and
the React-PDF document alike, so a download taken in either format divides the
conversation identically. Copy-to-clipboard rides the text endpoint and gets it
for free.

The rule is **not** a group-by, and the difference is load-bearing: a heading is
emitted whenever a line's label differs from the last one **printed**. Under
`free` navigation a respondent may work in part one, move to part three, and come
back — two genuine visits, minutes apart. A grouping would merge them into one
block and misreport when things were said. The heading repeats because the visit
repeated.

An unlabelled line emits nothing and does not clear the tracker, so a session
that turned sections on part-way through does not re-announce the section its
early turns interrupted.

### The report, in chapters

`buildReportChapters` turns the resolved sections plus the run into an ordered
list, and three things follow from it:

1. The **answer transcript** the writer reads is bucketed by chapter rather than
   by document section, and emitted in **chapter order** — a respondent may
   answer part three before part one, and a report that followed the panel's
   order would present the interview in an order nobody experienced. As with the
   slots below, a section set carrying no question membership at all (a
   data-slot-mode topic set; a `themes` set whose slots have no mapped questions)
   is ignored rather than bucketed against, so the document titles survive.
2. The **data-slot context** is re-bucketed the same way. Under a
   `themes`-sourced section set this is a no-op by construction. A section set
   that carries no slot membership at all — every `document`-sourced one, since
   `fromDocument` groups questions only — is left alone rather than swept into
   the catch-all, because chapters that know nothing about the slots have
   nothing to say about them.
3. The writer is told the **shape** and asked to follow it, and is explicitly
   licensed to merge two parts or drop one it has nothing to say about. A chapter
   written to fill a heading is worse than no chapter.

**A part never reached is a third kind of gap**, and the prompt states it next to
the other two so the writer can keep them apart. A question the respondent
SKIPPED was put to them and declined. An area Conditional Topics EXCLUDED was
judged not to apply and the respondent was told so. A part NEVER REACHED applied,
was offered, and the interview stopped before it — which licenses a sentence
neither of the others does: it is worth coming back to. Left unstated, a report
over a half-finished sectioned interview reads as a complete assessment of a
smaller instrument.

Reached but unfinished counts as **covered**. The respondent was there and their
answers are in hand, so the honest result is a thin chapter, not an absent one.

Content belonging to no chapter is kept under a trailing "Other answers" heading
rather than dropped. This is not defensive tidiness: a `themes`- or
`document`-sourced section set groups only what its grouping knows about, so a
question in no theme genuinely belongs to no part of the run, and its answers are
still the respondent's.

### The admin session timeline

`SectionTimelineCard` sits beside the interview plan on the session viewer, and
answers the question the transcript cannot: where did this run get stuck. Opened,
finished, came-back-to, turns spent, and spend per section.

Turns come from the run's **counted** `turnsSpent`, because that is the figure
`maxTurnsPerSection` measures against and therefore the one that explains why a
capped section released when it did. Spend comes from the **turn rows**, because
the run has no notion of cost — and a section whose turns predate cost capture
reads as unknown rather than as zero, since "we did not record it" and "it was
free" are different claims.

A section the version no longer carries is shown, marked, rather than dropped.
Turns were tagged with it, and hiding the row would leave them belonging to
nothing while the timeline claimed to account for the whole run.

**Whether a section was opened is read off its STATUS, never off `openedAtTurn`.**
The runtime stamps that field with `selectionRound`, which counts the turns
_before_ the one being written, while turn rows carry a 1-based `ordinal` — so
the section every respondent starts in is stamped 0 while its first exchange is
turn 1. A card testing `openedAtTurn > 0` therefore reported a finished section
with six turns and recorded spend as "never opened". The status carries no such
arithmetic. A zero stamp is described in words rather than printed, because the
one number the row must not claim is "turn 0".

For the same reason the "where it stopped" marker is withheld from a part whose
status is `not_started`. `buildSectionState` SYNTHESISES an active key when the
stored run carries none (`run.activeKey ?? nextOpenSectionKey(...)`), so a
session that banked a run without taking a turn resolves its first section as
active — and marking it would put "Not reached" and "Where it stopped" on one
row.

### Both artefacts are gated on the stored blob, not on the resolver

Resolving a session's sections after the fact goes through `buildTurnContext`,
which is not cheap. Both callers therefore read `sectionRun` — null on every
unsectioned session — from a row they were already loading, and only pay for the
resolution when there is something to resolve. This is the same defect phase C
found on the respondent strip, which fetched on mount to be told the feature was
off, and it is worth stating as a rule: **never pay to be told the feature is
off.**

The rule has a second edge. `loadAdminSessionView` takes a
`{ sectionTimeline }` option because the admin transcript route calls it for the
ownership check and the redaction fields alone and never returns a timeline —
resolving one would buy a turn-context build per download and discard it. The
option defaults to TRUE rather than false: a default of false would silently
empty the viewer the first time someone forgot to ask, and a wasted read is a
cheaper mistake than a missing panel.

---

## Explicitly not built

- **No section grouping on the raw answer appendix.** The questions-and-answers
  recap appended beneath a report renders the panel's own sections. That is what
  the respondent saw in the panel, and regrouping it would mean carrying the
  chapter list on the stored report row and through the PDF. Recorded as a
  decision, not an oversight; the AI chapters above it already follow the run.
- **No chapters on the run-level (journey) report.** A run spans several legs,
  each of which may be sectioned differently or not at all. Merging their chapter
  lists would collide keys and impose an order no respondent experienced. That
  report keeps its per-leg headings.
- No section-level analytics or cohort aggregation.
- No author-drawn sections. Sections are always derived from a grouping the
  version already has; there is no editor for them.
- No cross-device resume of the active section beyond what
  [`experience-continuity.md`](./experience-continuity.md) already provides.

---

## Related

- [`conditional-topics.md`](./conditional-topics.md), which parts apply
- [`completion-logic.md`](./completion-logic.md), the gate this wraps
- [`respondent-layouts.md`](./respondent-layouts.md), the slot system
- [`answer-slot-panel.md`](./answer-slot-panel.md), the panel that follows the section
- [`transcript-export.md`](./transcript-export.md), where the headings land
