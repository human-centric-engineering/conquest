# Built-in interviewer personas (F-persona)

Hands the interviewer to a **built-in persona** — a neutral coach, a non-leading field researcher, a
structured consultant, a discreet HR partner, an unhurried counsellor, a deadpan curmudgeon, and a
dozen more — and optionally lets the **respondent switch** between them. It builds
directly on [interviewer-tone](./interviewer-tone.md): a persona _is_ a named `ToneSettings`, so a
chosen persona flows through the exact same phraser pipeline (`buildToneInstructions`) with no new
prompt machinery.

**Either/or with the custom tone.** A version's interviewer voice is _one of two things_, never both:
either the hand-tuned custom [interviewer-tone](./interviewer-tone.md) block **or** a built-in persona.
`personaSelection.enabled` is the discriminator — on ⇒ a built-in persona governs (replacing
`config.tone`), off ⇒ the custom tone applies. The Settings UI enforces this with a **mode toggle**
("Custom voice" vs "Built-in persona"); only the chosen mode's editor is shown, so an admin can't
configure both at once.

The persona set is **fixed** — the built-in personas are hard-coded in code, not editable config.
In built-in mode the admin ticks _which_ of them this questionnaire offers, pins _which_ of those
governs, and says _whether_ respondents may switch between them. An admin who wants a bespoke voice
picks "Custom voice" and tunes the [interviewer-tone](./interviewer-tone.md) block instead.

> A respondent-experience feature, like [presentation-mode](./presentation-mode.md) and the
> tone/strategy siblings. **Always on** as a platform capability; which voice governs is the
> per-version `personaSelection.enabled` toggle, and its default depends on where the value comes
> from. A version with **no stored config row** takes `DEFAULT_PERSONA_SELECTION`, which is
> **`enabled: true`** — built-in mode on, pinned to The Coach, switching off — so a never-configured
> questionnaire is interviewed by The Coach, not by the bare baseline tone. A version that **has** a
> config row whose `personaSelection` predates this feature reads as **off**
> (`narrowPersonaSelection` requires a literal `enabled === true`), so it keeps its custom tone
> untouched.

## The model

One stored setting on `AppQuestionnaireConfig`, plus one column on the session:

- **`personaSelection`** — `{ enabled, defaultPersonaKey, availableKeys, allowRespondentSwitch, switcher }`:
  - `enabled` — built-in persona mode on (the either/or discriminator against `config.tone`).
  - `defaultPersonaKey` — the **pinned** persona that governs for everyone (and the default the picker
    pre-selects when switching is allowed). Must be a built-in key (validated in `config-schema.ts`
    against `BUILT_IN_PERSONA_KEYS`) **and** one of `availableKeys`.
  - `availableKeys` — **which built-ins this questionnaire offers** (see below). `[]` means _all of
    them_, never _none_.
  - `allowRespondentSwitch` — opt-in: when on, respondents may switch among the offered personas via
    `switcher`; when off, everyone gets the pinned persona and **no picker/switcher renders**. Inert
    when only one persona is offered — there is nothing to switch to.
  - `switcher` — how respondents switch, when allowed (see below).
- **`AppQuestionnaireSession.selectedPersonaKey`** — the respondent's choice (null ⇒ default applies).
- **`personas`** — a **legacy** `Json` column, always `[]` and **ignored**. `narrowPersonas`
  disregards it and always returns the fixed built-in library. Kept only to avoid a migration.

## Which personas a questionnaire offers (`availableKeys`)

The library is global; the **offer is per-version**. The Settings panel shows a **tick-box per
built-in persona** — "Interviewers available" — with **Select all** / **Deselect all**. Only ticked
personas reach a respondent, and only a ticked persona can be the pinned default.

Two invariants hold it together. They're enforced in the panel, re-checked in Zod
(`config-schema.ts`), and re-applied defensively on the read path (`narrowPersonaSelection`), so a
hand-crafted PATCH or a legacy row can't break them:

1. **At least one persona is always offered.** The last ticked box can't be un-ticked, and "Deselect
   all" falls back to the pinned default alone. A questionnaire with no interviewer has no voice.
2. **The pinned default is always one of the offered personas.** Un-ticking it re-pins the first
   survivor — so ticking **exactly one** persona makes _that_ persona the default automatically,
   with nothing for the admin to pin. With one offered persona the default dropdown and the
   "let respondents switch" toggle both go inert (disabled), and no picker ever renders
   (`resolveSessionPersonas` needs **two** offered personas to enable it).

`[]` is the **"offer everything"** shape, not "offer nothing": it's what an untouched/legacy row
reads as, and what the panel saves when every box is ticked — so a questionnaire that offers the
whole library keeps offering it if the library ever grows. `narrowPersonaSelection` drops unknown
keys and returns the survivors in library order, so the offer reads the same everywhere.

At turn time `resolveEffectiveTone` confines the choice to the offered set: a `selectedPersonaKey`
chosen before the admin un-ticked it is stale and falls back to the pinned default, exactly like any
other unknown key.

## The library, and what each voice is for

The **library is fixed and hard-coded**: `BUILT_IN_PERSONAS`
(`lib/app/questionnaire/persona/presets.ts`), led by the `neutral-coach` default (a calm, objective
coach/consultant grounded in human & organisational psychology). Each is a `PersonaOption`
(`{ key, category, label, description, tone: ToneSettings }`) whose `tone` block holds the whole
voice (prose in `tone.persona.text`, character in the dimension levels). The admin cannot edit or
extend the set — every questionnaire draws on the same library.

Every persona declares the **situation it was written for** (`PersonaCategory`), which groups the
admin tick-boxes so somebody running an HR review doesn't have to read twenty descriptions to find
the two that fit:

| Category (`PersonaCategory`)                    | Personas                                                                                    | The job                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `general` — General purpose                     | The Coach (default), The Interviewer                                                        | Balanced, or entirely characterless when the instrument should be the star         |
| `research` — Research and discovery             | The Realist, The Field Researcher, The Analyst                                              | Pressure-test a tidy story, avoid leading the witness, turn "often" into a number  |
| `corporate` — Corporate and consulting          | The Director, The Consultant, The Facilitator                                               | Respect an exec's time, frame a problem top-down, stay neutral in a contested room |
| `customer` — Customer experience                | The Concierge, The Advocate                                                                 | Never argue with an experience; capture a complaint well enough to act on          |
| `hr` — HR and people                            | The People Partner, The Mentor                                                              | Behaviour over blame, no pressure to name a colleague; strengths and what's next   |
| `advisory` — Advisory and professional services | The Advisor, The Auditor                                                                    | Establish the position before advising; leave no question half-answered            |
| `wellbeing` — Wellbeing and sensitive topics    | The Encourager, The Counsellor                                                              | Make candour feel safe; move at the respondent's pace and never push               |
| `character` — Character and engagement          | The Confidant, The Comedian, The Hipster, The Philosopher, The Psychologist, The Curmudgeon | Personality-led, for engagement rather than a professional setting                 |

The category is an **admin browsing aid only**: it never reaches a respondent (the client menu is
`key`/`label`/`description`) and never changes how a persona behaves. The library is stored in
category order (default first) because both the tick-boxes and the respondent picker render in
library order — a presets test asserts each category stays contiguous.

**Copy rules.** A `description` is respondent-facing, so it stays free of em dashes and reads as one
or two plain sentences (asserted in the presets test). A `tone.persona.text` prompt is system-only,
written as instructions _to_ the interviewer, never as a claim of qualification — "you are a
person-centred counsellor" describes a manner to adopt, and nothing downstream presents it as
credentials to a respondent.

## How a choice takes effect

The menu (which personas exist + the default) lives on the **version config**; the choice lives on the
**session**. They meet at turn time:

Each tick-box carries the persona's **respondent-facing description verbatim** — an admin choosing
who to offer should be reading what the respondent will read. Everything else about a voice (the
system-prompt prose that briefs the interviewer, and its tone dials) sits behind a per-persona
**"More about {name}"** toggle that opens one detail at a time. There is no separate preview of the
pinned persona: it is a row like any other, marked _· default_.

1. **Admin** picks **"Built-in persona"** mode on the merged **Settings → Interviewer tone & persona**
   group (the mode toggle flips `personaSelection.enabled`), ticks which interviewers the
   questionnaire offers, pins the default among them, and — optionally — turns on **"Let respondents
   switch interviewer"** (`allowRespondentSwitch`) + a switcher style (`persona-library-panel.tsx`,
   gated by the `personaSelection.enabled` config toggle). The panel is the availability tick-boxes,
   grouped by category and each carrying its respondent-facing description (with select/deselect all
   and a per-persona detail toggle), plus a default dropdown over the offered personas (the pinned
   one first, tagged _Selected_). Nothing here is editable — the library is fixed. Only
   `personaSelection` is saved, through the same config PATCH as tone.
2. **Respondent** — only when `allowRespondentSwitch` and ≥2 offered personas — picks via the **switcher** the admin chose
   (`personaSelection.switcher`); see the next section. The pinned persona leads the picker grid,
   badged _Default_. The choice PATCHes `…/questionnaire-sessions/:id/persona` (fail-soft). With
   switching off there is no picker — the pinned persona simply governs.
3. **Turn time** — the `/messages` route resolves the effective tone with `resolveEffectiveTone`
   (`persona/settings.ts`): when `personaSelection.enabled`, the pinned/chosen
   persona's `tone` **replaces** `config.tone` for that session; otherwise `config.tone` flows through
   **byte-for-byte unchanged**. Everything downstream (`buildToneInstructions`, verbosity/mimicry
   handling) is untouched. Note `resolveEffectiveTone` keys off `enabled` alone — `allowRespondentSwitch`
   gates the _picker_, not which voice governs, so a pinned persona applies with or without switching.

```
config.personas ─┐
config.personaSelection ─┼─▶ availablePersonas ─▶ resolveEffectiveTone ─▶ toneConfig ─▶ buildToneInstructions ─▶ prompt
session.selectedPersonaKey ─┘   (falls back to config.tone when selection is off)
```

## Switcher presentation (`personaSelection.switcher`)

Shown only when `allowRespondentSwitch` is on. The admin chooses how the picker reaches the respondent
(Settings → Interviewer tone & persona → Built-in persona → "How respondents switch interviewer"). All
three run off the same `PersonaPicker` grid + the same PATCH:

- **`page`** (default — today's behaviour): a pre-chat **"Choose your interviewer"** carousel gate
  (`persona-picker.tsx`), like the intro, that defers the opening LLM turn until the respondent moves
  past it so their choice is in place first. The ModeToggle's "Interviewer" segment reopens it mid-run.
- **`indicator`**: **no** pre-chat gate — the session opens on the default persona, and an in-chat
  **"Interviewer: {name} · Change"** chip (`interviewer-switcher.tsx`, on the lifecycle strip) opens a
  **modal** (`PersonaSwitcherModal` — the same grid in a Dialog) to switch anytime.
- **`both`**: the pre-chat page **and** the chip; the chip's "Change" slides the carousel back to the
  page rather than opening a modal.

`showPersona` (carousel page) is on for `page`/`both`; the chip is on for `indicator`/`both`.
Fail-soft: an unknown/missing switcher on the wire falls back to `page` (`narrowPersonaSelection`,
and the client boot schema's `.catch('page')`).

## Precedence — a chosen persona fully governs

When selection is on, the persona **replaces** the version's tone/persona (one clear source of voice);
it does not layer on top. Even the `neutral-coach` default is a seeded persona (objective coach
prompt + gentle dials), so choosing it applies that voice — it is not the bare baseline.

## Client safety

`resolveSessionPersonas` (`persona/resolve.ts`) returns a **tone-free** menu of the **offered**
personas only — `{ key, label, description }` each. The persona prompt prose (`tone.persona.text`) is a system
prompt and is **never shipped to the respondent client**; it only ever drives the interviewer
server-side. The GET `…/persona` route returns this menu; the menu's `enabled` (show the picker)
requires built-in mode on **AND** `allowRespondentSwitch` **AND** ≥2 _offered_ personas. The PATCH `…/persona`
route likewise 422s a choice when the menu isn't `enabled`, so a crafted request can't override the
pinned persona.

## Where things live

| Concern             | File                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Types + defaults    | `lib/app/questionnaire/types.ts` (`PersonaOption`, `PersonaSelectionSettings`)                                                  |
| Built-in library    | `lib/app/questionnaire/persona/presets.ts`                                                                                      |
| Narrow + resolve    | `lib/app/questionnaire/persona/settings.ts` (`narrowPersonaSelection`, `availablePersonas`, `resolveEffectiveTone`)             |
| Session menu (DB)   | `lib/app/questionnaire/persona/resolve.ts`                                                                                      |
| Zod validation      | `lib/app/questionnaire/authoring/config-schema.ts` (`personaSelectionSchema`)                                                   |
| Read/write config   | `_lib/detail.ts` (`toConfigView`), `…/versions/[vid]/config/route.ts`                                                           |
| Turn-time injection | `app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`                                                                  |
| Session persona API | `app/api/v1/app/questionnaire-sessions/[id]/persona/route.ts` (GET/PATCH)                                                       |
| Admin control       | `config-editor.tsx` (`VoiceModeToggle` either/or) + `persona-library-panel.tsx` (offer + pin + switch + preview)                |
| Respondent picker   | `components/app/questionnaire/persona/persona-picker.tsx`; carousel in `session-workspace.tsx`                                  |
| In-chat switcher    | `components/app/questionnaire/persona/interviewer-switcher.tsx` (chip + modal); wired in `session-workspace.tsx`                |
| Gate                | Per-version `personaSelection.enabled` config toggle (no platform flag — always on; see [feature-flags.md](./feature-flags.md)) |
