# Built-in interviewer personas (F-persona)

Hands the interviewer to a **built-in persona** — a cynical curmudgeon, a warm encourager, a casual
confidant, a stand-up comedian, a reflective philosopher, a get-to-the-point director, a sceptical
realist, or the neutral coach — and optionally lets the **respondent switch** between them. It builds
directly on [interviewer-tone](./interviewer-tone.md): a persona _is_ a named `ToneSettings`, so a
chosen persona flows through the exact same phraser pipeline (`buildToneInstructions`) with no new
prompt machinery.

**Either/or with the custom tone.** A version's interviewer voice is _one of two things_, never both:
either the hand-tuned custom [interviewer-tone](./interviewer-tone.md) block **or** a built-in persona.
`personaSelection.enabled` is the discriminator — on ⇒ a built-in persona governs (replacing
`config.tone`), off ⇒ the custom tone applies. The Settings UI enforces this with a **mode toggle**
("Custom voice" vs "Built-in persona"); only the chosen mode's editor is shown, so an admin can't
configure both at once.

The persona set is **fixed** — the ten built-in personas, hard-coded in code, not editable config.
In built-in mode the admin pins _which_ persona governs and _whether_ respondents may switch. An admin
who wants a bespoke voice picks "Custom voice" and tunes the
[interviewer-tone](./interviewer-tone.md) block instead.

> A respondent-experience feature, like [presentation-mode](./presentation-mode.md) and the
> tone/strategy siblings. **Always on**; the remaining gate is the per-version `personaSelection.enabled`
> config toggle, which is **off by default**, so an untouched questionnaire is unchanged.

## The model

One stored setting on `AppQuestionnaireConfig`, plus one column on the session:

- **`personaSelection`** — `{ enabled, defaultPersonaKey, allowRespondentSwitch, switcher }`:
  - `enabled` — built-in persona mode on (the either/or discriminator against `config.tone`).
  - `defaultPersonaKey` — the **pinned** persona that governs for everyone (and the default the picker
    pre-selects when switching is allowed). Must be a built-in key (validated in `config-schema.ts`
    against `BUILT_IN_PERSONA_KEYS`).
  - `allowRespondentSwitch` — opt-in: when on, respondents may switch among the library via `switcher`;
    when off, everyone gets the pinned persona and **no picker/switcher renders**.
  - `switcher` — how respondents switch, when allowed (see below).
- **`AppQuestionnaireSession.selectedPersonaKey`** — the respondent's choice (null ⇒ default applies).
- **`personas`** — a **legacy** `Json` column, always `[]` and **ignored**. `narrowPersonas`
  disregards it and always returns the fixed built-in library. Kept only to avoid a migration.

The **library is fixed and hard-coded**: `BUILT_IN_PERSONAS`
(`lib/app/questionnaire/persona/presets.ts`) — the `neutral-coach` default (a calm, objective
coach/consultant grounded in human & organisational psychology) plus seven characters. Each is a
`PersonaOption` (`{ key, label, description, tone: ToneSettings }`) whose `tone` block holds the whole
voice (prose in `tone.persona.text`, character in the dimension levels). The admin cannot edit or
extend the set — every questionnaire uses the same ten.

## How a choice takes effect

The menu (which personas exist + the default) lives on the **version config**; the choice lives on the
**session**. They meet at turn time:

1. **Admin** picks **"Built-in persona"** mode on the merged **Settings → Interviewer tone & persona**
   group (the mode toggle flips `personaSelection.enabled`), then pins the persona and — optionally —
   turns on **"Let respondents switch interviewer"** (`allowRespondentSwitch`) + a switcher style
   (`persona-library-panel.tsx`, gated by the `personaSelection.enabled` config toggle). The panel is a
   dropdown (the pinned persona first, tagged _Selected_) + a **read-only preview** — name (badged
   _Selected_), respondent-facing description, persona prompt, and its active tone dials — no editing.
   Only `personaSelection` is saved, through the same config PATCH as tone.
2. **Respondent** — only when `allowRespondentSwitch` — picks via the **switcher** the admin chose
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
config.personaSelection ─┼─▶ resolveEffectiveTone ─▶ toneConfig ─▶ buildToneInstructions ─▶ prompt
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

`resolveSessionPersonas` (`persona/resolve.ts`) returns a **tone-free** menu — only
`{ key, label, description }` per persona. The persona prompt prose (`tone.persona.text`) is a system
prompt and is **never shipped to the respondent client**; it only ever drives the interviewer
server-side. The GET `…/persona` route returns this menu; the menu's `enabled` (show the picker)
requires built-in mode on **AND** `allowRespondentSwitch` **AND** ≥2 personas. The PATCH `…/persona`
route likewise 422s a choice when the menu isn't `enabled`, so a crafted request can't override the
pinned persona.

## Where things live

| Concern             | File                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Types + defaults    | `lib/app/questionnaire/types.ts` (`PersonaOption`, `PersonaSelectionSettings`)                                                  |
| Built-in library    | `lib/app/questionnaire/persona/presets.ts`                                                                                      |
| Narrow + resolve    | `lib/app/questionnaire/persona/settings.ts` (`resolveEffectiveTone`)                                                            |
| Session menu (DB)   | `lib/app/questionnaire/persona/resolve.ts`                                                                                      |
| Zod validation      | `lib/app/questionnaire/authoring/config-schema.ts` (`personaSelectionSchema`)                                                   |
| Read/write config   | `_lib/detail.ts` (`toConfigView`), `…/versions/[vid]/config/route.ts`                                                           |
| Turn-time injection | `app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`                                                                  |
| Session persona API | `app/api/v1/app/questionnaire-sessions/[id]/persona/route.ts` (GET/PATCH)                                                       |
| Admin control       | `config-editor.tsx` (`VoiceModeToggle` either/or) + `persona-library-panel.tsx` (pin + switch + preview)                        |
| Respondent picker   | `components/app/questionnaire/persona/persona-picker.tsx`; carousel in `session-workspace.tsx`                                  |
| In-chat switcher    | `components/app/questionnaire/persona/interviewer-switcher.tsx` (chip + modal); wired in `session-workspace.tsx`                |
| Gate                | Per-version `personaSelection.enabled` config toggle (no platform flag — always on; see [feature-flags.md](./feature-flags.md)) |
