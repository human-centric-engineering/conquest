---
feature: F15-followups
title: P15 Experiences — everything deferred, open, or deliberately not built
phase: P15 — Experiences
status: open
owner: TBD
opened: 2026-07-20
docs: .context/app/questionnaire/experiences.md
---

# P15 follow-ups

Everything left open when P15.1–P15.5b shipped. Consolidated here so a follow-up does not have to
reconstruct it by reading six trackers.

**Nothing below is blocking.** The shipped phases work end to end without any of it.

Ordered roughly by value. Each heading carries a rough size, so a follow-up can tell a half-hour
job from a phase without reading the whole entry.

---

## 1. Erasure gap — free-text survives `eraseUser()` · **needs a product decision**

**Status:** open, user-acknowledged, deliberately not half-fixed.

`AppRespondentProfileSnapshot` is the ONE app table with a modelled `User` FK, so `eraseUser()`
removes the structured PII and nothing else. Questionnaire sessions, answers, **transcripts** and
report prose are all retained — `respondentUserId` is a plain String with no FK, and no erasure
hook is registered anywhere in app code.

For structured answers that is a defensible "retain de-identified research data" posture. It does
not hold for the two free-text surfaces:

- `AppQuestionnaireTurn` holds raw conversation. Respondents commonly say their own name in it, and
  per F15.2's own notes, raw safeguarding disclosures live there specifically because they are
  deliberately not copied into carry-over.
- Report `content` is LLM prose generated from the profile and answers, so it can embed the same
  details.

Removing the snapshot de-identifies neither.

**The decision inside this**, which is why it was not just implemented: delete the answers entirely,
or keep them and redact the free text? That is a research-value-versus-privacy call, not an
engineering one.

**When done, it needs:** an erasure hook (`lib/privacy/erasure-hooks.ts` — the seam exists and is
unused by app code), and a decision recorded in `.context/privacy/data-erasure.md`, whose
"ConQuest exception" section currently describes only the snapshot.

---

## 2. F15.6 `merged` continuity · **probably never build this**

**Status:** not built, deliberately.

`merged` is the only continuity mode that genuinely changes persistence — a synthetic version
combining two questionnaires, run as one session. `experiences.md` already records the judgement:
`stitched` "delivers most of the perceived value at a fraction of the cost", and F15.1 flagged the
mode as _may never ship_.

It was left unbuilt on purpose rather than overlooked. Building a whole synthetic-version pipeline
speculatively, against that documented advice, would add the one mode with real migration and
report-scoping consequences for a benefit `stitched` already delivers.

**Revisit only if** a concrete requirement appears that `stitched` genuinely cannot meet. If one
does, note that `EXPERIENCE_CONTINUITY_MODES` already contains `merged` and the admin selector
deliberately edits an unknown value down to `linked`, so nothing breaks while it stays unbuilt.

---

## 3. Cross-device resume for `/x/<publicRef>` · **~half a day**

The run credential is an httpOnly cookie and deliberately **cannot travel with a copied link** —
that is the security posture, not an oversight (see `experience-continuity.md`). The cost is that a
respondent opening their journey on a second device, or after clearing cookies, gets an explanatory
notice and no way back in.

**The shape:** a run-level resume-by-code, the equivalent of the questionnaire surface's
`ResumeByRefEntry`. `AppExperienceRun.publicRef` already exists and is already quotable.

**The catch worth thinking about before starting:** a code that re-mints the credential is a
credential. Whatever it is, it must not be the `publicRef` alone, since that is printable, guessable
and already on screen.

---

## 4. Converge the authenticated surface on `/x/` · **~a day**

The authenticated respondent surface still addresses sessions individually
(`/questionnaires/<sessionId>`), so a `stitched` journey there changes URL between legs even though
the conversation reads as continuous. The no-login surface does not, because `/x/<publicRef>` is
stable.

Not urgent — the conversation is visually continuous either way, and Back lands somewhere coherent.
It is a consistency and polish item.

**Watch for:** `router.push` is a no-op on a stable address, so continuing must `router.refresh()`.
`HandoffCard` and `StitchedContinuation` already take an `onContinue` callback rather than an href
precisely so this change is possible without touching them.

---

## 5. Experience-wide report synthesis · **a phase**

A view across a whole journey, synthesised over **ready per-step reports**.

**The hard constraint, and the reason this is not simply "add a scope":** it must NOT become a
cross-version re-aggregation. `buildCohortDataset` resolves everything by a single `versionId` and
`buildDataSlots` joins fills by `dataSlotId` — the row id, not the key — so fills from another
version find no bucket and are **silently dropped**. An experience spans versions by definition, so
a naive cross-step scope would emit a confident, well-formatted report over a fraction of the data,
with no error and no warning.

Anything built here must read finished step reports as its input, never raw sessions across steps.

---

## 6. Per-section AI assist on step reports · **~half a day**

`ReportApi.refineUrl` is optional and only the ROUND owner exposes a refine route today, so the
step-report panel hides the AI-assist affordance. Version-scoped reports have the same gap — this
is not specific to experiences.

**The shape:** mirror `app/api/v1/app/rounds/[id]/cohort-report/refine` for the step (and version)
owners, then populate `refineUrl` in `stepReportApi` / `versionReportApi`.

---

## 7. Hand the scribe pen mid-breakout · **~half a day**

In a `scribe` room the first participant in claims the pen and the rest watch. There is currently no
way to hand it over — if the scribe's device dies, the room is stuck watching a session nobody can
drive.

**The catch:** the pen is currently implicit (whoever owns the leg for that room). Handing it over
means moving a leg between runs, or making the scribe an explicit field. The second is cleaner and
probably what a follow-up should do.

---

## 8. Rooms: reordering and questionnaire selection in the editor · **~half a day**

`BreakoutRoomsEditor` supports add, remove and mode. The API supports `ordinal` and per-room
`questionnaireId` / `versionId`, but the editor exposes neither, so a room running its own
questionnaire must be configured through the API.

---

## 9. `report` step kind is selectable but inert · **needs a product decision**

Found while drawing the journey for F15.7 — a flat list hid it, a diagram did not.

`report` is in `EXPERIENCE_STEP_KINDS`, has a label in `EXPERIENCE_STEP_KIND_LABELS`, and is offered
by `kindsFor()` in the step form for **both** experience kinds. But no runtime module reads it: the
run report is enqueued from `concludeRun` (F15.4b), `routableSteps()` selects only `branch`, and
`experienceBlockers()` never checks it. A grep for a consumer returns nothing.

So an author can add a "Report" step, save it, and it does nothing at all. The live diagram
currently labels such a node "Authored marker only — the run report is produced when the run
concludes, not by this step", which is honest but is not a fix.

**Either** give it a runtime role (an explicit terminal step that pins which version's report
settings apply, say), **or** drop it from `kindsFor()` and the enum. Selectable-but-inert is the
worst of the three states — it invites an author to build something that silently has no effect.

---

## Known flake, not reproduced

Two tests in `tests/integration/app/admin/orchestration/agents/edit-page.test.tsx` failed on one
full-suite run during F15.4b and have passed on every run since — in isolation, alongside their
siblings, and in several full runs. A stashed run without the branch's changes was also green, so it
cannot be attributed cleanly either way. The file is untouched by P15.

Recorded so a future recurrence is recognised as a repeat rather than a new problem.

---

## Bugs found in review, fixed, worth remembering

These were caught reviewing the P15 branch and are already fixed. Listed because each represents a
class of mistake that is easy to repeat.

- **`role === 'admin'` vs `'ADMIN'`.** `User.role` is persisted uppercase
  (`lib/auth/account.ts`, `humanAdminWhere`). A lowercase comparison in `canReadRun` made the admin
  bypass dead code — it type-checks, passes a naive test, and silently never matches.
  `run-access.test.ts` now pins the casing explicitly.
- **A docblock that described a gate nobody implemented.** The meeting join route claimed access was
  "decided by the experience's `accessMode`" while doing no such check. Prose asserting a security
  property is not a security property.
- **`remainingRunBudget` returning 0.** The comment claimed 0 reads as an immediate hard cap; in
  fact `classifyCostCap` treats any non-positive cap as _no cap at all_. Two opposite conventions
  meeting at one number. The doc now says so, and names `mustConcludeForBudget` as the real gate.
- **A legless run is NORMAL on the meeting path.** A participant has a run from the moment they
  join and no leg until a breakout starts, so refusing a legless run would have locked meeting
  participants out. `canReadRun` checks the run credential before the leg-based proofs.

## Related

- `.context/app/planning/features/f15.1.md` … `f15.5b.md` — per-phase decisions
- `.context/app/questionnaire/experiences.md` — the model
- `.context/app/questionnaire/experience-continuity.md` — journey addressing and the credential
- `.context/app/questionnaire/experience-reports.md` — report scoping
- `.context/app/questionnaire/experience-meetings.md` — meetings, the clock, rooms
