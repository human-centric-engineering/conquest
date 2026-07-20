# Facilitated meetings

**A meeting is one live occurrence of a facilitated experience** — a group of people doing this
together, right now. Shipped in F15.5a; rooms in F15.5b.

Admin: the experience workspace **Meetings** tab and `/admin/experiences/:id/meetings/:meetingId`
(the console). Participants: `/m/<joinRef>`. Code: `lib/app/questionnaire/experiences/meeting/**`,
`app/api/v1/app/experiences/_lib/meeting-service.ts`.

## A breakout is a period of TIME, not a place

Participants go and have their own chats against a questionnaire; the answers are then aggregated
and synthesised for the facilitator to walk the room through. A breakout step is an **agenda item**,
and `ordinal` is the agenda order.

Rooms (F15.5b) are the optional refinement _within_ a breakout — not the definition of one.

## Why a meeting is not a run

`AppExperienceRun` is ONE respondent's journey. A meeting is the shared fact that a group is doing
this together, so it owns what belongs to the occurrence: which breakout is live, and its clock.
Runs attach via a nullable `meetingId` (null for a switcher run, which travels alone).

**Duration lives on the STEP; the clock lives on the MEETING.** The step says "this is meant to take
12 minutes"; the meeting says "it started at 14:03". The facilitator picks the actual length when
starting — the room in front of them decides whether twelve minutes is right today.

`breakoutEndsAt`, `breakoutDurationSeconds` and `breakoutGraceSeconds` are all **frozen at start**,
never derived on read: a room mid-sentence must not lose seconds because somebody edited a setting.

## The three-phase clock

```
running → grace → closed
```

`grace` (default 30s) exists because the clock ending and the room being done are not the same
moment. During it a participant may **finish and submit** what they are mid-way through but not
begin something new — an answer started after the bell will not be part of the conversation the
room is about to have, while cutting both off at once loses answers people had already written.

`participantWindow` therefore returns `canAnswer` and `canSubmit` **separately**. A single boolean
cannot express "keep what you have, start nothing new".

Boundaries favour the participant: exactly AT the clock is still `running`, exactly at the grace
boundary is still `grace`. An unparseable clock **fails open** (treated as untimed) rather than
silently shutting a room out.

**The facilitator drives; the clock only advises.** A timer never ends a breakout. `isOverrunning`
is display-only. Ending never _extends_ a clock — if the deadline has passed, `endBreakout` keeps it
rather than handing the room grace it already used.

## k-anonymity is structural here

A meeting synthesis is read **aloud, to the people it describes**, who are sitting together and
remember who said what. Unlike every other report in this system, the audience and the subjects are
the same people.

- `meetsSupportThreshold` refuses any threshold below **2**, whatever the setting says — it arrives
  from a hand-editable Json blob.
- `supportCount` is stored so the gate re-applies on **read**: raising `insightMinSupport` after a
  meeting makes the existing synthesis safer without regenerating it.
- `visibleToRespondents` can **never** override the gate. A facilitator ticking "show this" on a
  two-person tension shows nobody anything.
- Suppression reports a **count** to the facilitator, never the statements. They must know their
  synthesis was thinned — otherwise they read the gaps as "everyone agreed" — but being able to read
  the withheld findings would be reading exactly the attributable ones the gate exists to prevent.
- Clamping support to the room size is an **honesty guard, not a second gate**: it cannot suppress
  anything, because the floor check guarantees some slot reached `minSupport` and
  `respondedCount <= participantCount`. The gate is the only thing that suppresses.

### What the floor counts: `supportBasis`

The floor is always the same; the **unit** it counts is not. `SynthesisMaterial.supportBasis` says
which, and defaults to `per-session` when absent so an omission never widens the gate.

| Basis            | Used by                      | The floor is applied to                   |
| ---------------- | ---------------------------- | ----------------------------------------- |
| `per-session`    | `individual` rooms, no rooms | distinct sessions that answered some slot |
| `room-occupancy` | `scribe` rooms               | the room's occupancy                      |

A scribe room has **exactly one session by design**, so counting sessions reported a room of six as
a room of one and put every scribe room permanently below the floor — no scribe room could ever be
synthesised. Occupancy is the honest count there: those people chose the room and had the
conversation the pen wrote down. It is a different unit, **never a lower bar** — a scribe room of
one still does not synthesise, `meetsSupportThreshold` still refuses anything under 2, and the
room-size clamp caps every finding at occupancy, so a one-person room could not carry a finding past
the floor even if the check were bypassed.

Occupancy has **one definition** (`roomOccupancy` in `meeting-service.ts`, grouping runs by
`currentRoomId`), shared by the picker, the console and the support basis — a room cannot report one
number to the facilitator and another to the k-anonymity floor.

The basis also changes the **prompt**: a scribe room's material holds one written record, and a
model left to read that as one person returns `supportCount: 1` and the gate suppresses everything
anyway. It is told the record belongs to all N in the room — and told to count _down_ for dissent
the record itself notes, so the number stays honest.

None of this reaches the **read** path. `loadMeetingInsights` gates on the stored `supportCount` and
knows nothing of rooms or bases.

## What the synthesiser reads

**Data slots, rationales, movement, and questionnaire background — never raw chat.** The data-slot
layer is the semantic answer vocabulary, already normalised away from individual phrasing, so
de-identification is a structural property of the input rather than a filtering problem.

`refinementHistory` makes **movement** first-class: `previousValue → newValue`, why it changed, and
the confidence either side. A position that moved is often the most interesting thing in a room.

Participants are `P1`, `P2`, … local to one breakout. The synthesiser must be able to tell two
positions came from the same person — otherwise it cannot distinguish a genuine split from one
person contradicting themselves — but never sees a name, email or session id.

The denominator is who **completed** the breakout, not who answered a given slot; deriving it from
fills would inflate every proportion into "everyone agreed" when half the room said nothing.

Below the support floor, **no model call is made at all**.

## Rooms (F15.5b)

Optional. A separate table, so the roomless common case stays untouched and nothing reads
"roomId is null" as a mode. A room's questionnaire is optional — null inherits the step's.

| Mode         | Sessions                                  |
| ------------ | ----------------------------------------- |
| `individual` | one per participant; the room groups them |
| `scribe`     | ONE for the whole room; the rest watch    |

Scribe mode exists because a room that talks an answer through together has one answer, not six —
and six near-identical copies would make the support counts meaningless. **The pen is first-come**;
a room deciding who types is friction a timed breakout cannot afford.

The flip side is that a scribe room's support cannot be counted in sessions — see `supportBasis`
above. One session is the whole point of the mode, not a small room.

`currentRoomId` sits on the RUN as well as `roomId` on the leg, because a participant watching a
scribe has no leg and the facilitator still needs to see them placed.

**Rooms are synthesised separately** — they may have answered different questionnaires, so combining
them would be the same cross-vocabulary mistake per-step report scoping exists to prevent.

You **cannot** choose a room during grace: arriving with seconds left, to a questionnaire not yet
started, is worse than being told you missed it.

## Surfaces

`consoleDisplayMode` (`standard` | `presentation`) and `respondentInsightDisplay`
(`none` | `tab` | `modal`) are **settings, not device guesses** — the console may be a private
laptop, a projector, or the only surface on a Zoom call, and nothing about a viewport says which.

`respondentInsightDisplay` defaults to `none`: a room looking at one thing together is a different
meeting from forty people looking down at phones.

The console polls at 3s for the room's numbers and ticks locally at 1s for the countdown; a dropped
poll keeps the last known state rather than replacing a facilitator's numbers with an error.

## Gotchas

**Synthesis is fire-and-forget from every write path.** The facilitator pressing "pull them back" is
standing in front of a room; the room's attention is the scarce resource.

**Regenerating REPLACES insights.** A synthesis is a snapshot; running it again after more people
finish should give the current picture, not accrete stale findings. `covered` marks are lost, which
is honest — they referred to findings that no longer exist.

**Joining and answering are separate.** A participant gets a run on arrival (so the count is true
during the introduction) and a session only once a breakout runs.

## Related

- `.context/app/planning/features/f15.5a.md`, `f15.5b.md`
- `.context/app/questionnaire/experiences.md` — the model
- `.context/app/planning/features/f15-followups.md` — everything still open across P15
