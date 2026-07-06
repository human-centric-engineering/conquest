# Selectable interviewer personas (F-persona)

Lets a **respondent choose which interviewer they talk with** — a cynical curmudgeon, a warm
encourager, a stand-up comedian, a reflective philosopher, a get-to-the-point director, a sceptical
realist, or the neutral coach — when the admin opts a questionnaire in. It builds directly on
[interviewer-tone](./interviewer-tone.md): a persona _is_ a named `ToneSettings`, so a chosen persona
flows through the exact same phraser pipeline (`buildToneInstructions`) with no new prompt machinery.

The persona set is **fixed** — the seven built-in personas, hard-coded in code, not editable config.
The admin controls only _whether_ respondents may choose and _which_ built-in is the default. An admin
who wants a bespoke voice tunes the version's own [interviewer-tone](./interviewer-tone.md) block
instead.

> A respondent-experience feature, **config block + platform flag** (both required), like
> [presentation-mode](./presentation-mode.md) and the tone/strategy siblings. Dark-launched behind
> `APP_QUESTIONNAIRES_PERSONA_SELECTION_ENABLED`; **off by default**, so an untouched questionnaire is
> unchanged.

## The model

One stored setting on `AppQuestionnaireConfig`, plus one column on the session:

- **`personaSelection`** — `{ enabled, defaultPersonaKey, switcher }`: whether respondents may choose,
  which built-in persona applies when they don't, and how they switch (see below). `defaultPersonaKey`
  must be a built-in key (validated in `config-schema.ts` against `BUILT_IN_PERSONA_KEYS`).
- **`AppQuestionnaireSession.selectedPersonaKey`** — the respondent's choice (null ⇒ default applies).
- **`personas`** — a **legacy** `Json` column, always `[]` and **ignored**. `narrowPersonas`
  disregards it and always returns the fixed built-in library. Kept only to avoid a migration.

The **library is fixed and hard-coded**: `BUILT_IN_PERSONAS`
(`lib/app/questionnaire/persona/presets.ts`) — the `neutral-coach` default (a calm, objective
coach/consultant grounded in human & organisational psychology) plus six characters. Each is a
`PersonaOption` (`{ key, label, description, tone: ToneSettings }`) whose `tone` block holds the whole
voice (prose in `tone.persona.text`, character in the dimension levels). The admin cannot edit or
extend the set — every questionnaire uses the same seven.

## How a choice takes effect

The menu (which personas exist + the default) lives on the **version config**; the choice lives on the
**session**. They meet at turn time:

1. **Admin** flips "let respondents choose" and picks the default persona on the **Settings →
   Interviewer personas** card (`persona-library-panel.tsx`, gated by the `personaSelection` workspace
   flag). The card is a dropdown (the current default pinned first, tagged _Default_) + a **read-only
   preview** of the selected persona — name (badged _Default_), respondent-facing description, persona
   prompt, and its active tone dials — no editing. Only `personaSelection` is saved, through the same
   config PATCH as tone.
2. **Respondent** picks via the **switcher** the admin chose (`personaSelection.switcher`) — see the
   next section. The default persona leads the picker grid, badged _Default_. The choice PATCHes
   `…/questionnaire-sessions/:id/persona` (fail-soft).
3. **Turn time** — the `/messages` route resolves the effective tone with `resolveEffectiveTone`
   (`persona/settings.ts`): when `personaSelection.enabled` (AND the platform flag), the chosen
   persona's `tone` **replaces** `config.tone` for that session; otherwise `config.tone` flows through
   **byte-for-byte unchanged**. Everything downstream (`buildToneInstructions`, verbosity/mimicry
   handling) is untouched.

```
config.personas ─┐
config.personaSelection ─┼─▶ resolveEffectiveTone ─▶ toneConfig ─▶ buildToneInstructions ─▶ prompt
session.selectedPersonaKey ─┘   (falls back to config.tone when selection is off)
```

## Switcher presentation (`personaSelection.switcher`)

The admin chooses how the picker reaches the respondent (Settings → Interviewer personas → "How
respondents switch interviewer"). All three run off the same `PersonaPicker` grid + the same PATCH:

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
server-side. The GET `…/persona` route returns this menu; `enabled` additionally requires ≥2 personas.

## Where things live

| Concern             | File                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Types + defaults    | `lib/app/questionnaire/types.ts` (`PersonaOption`, `PersonaSelectionSettings`)                                   |
| Built-in library    | `lib/app/questionnaire/persona/presets.ts`                                                                       |
| Narrow + resolve    | `lib/app/questionnaire/persona/settings.ts` (`resolveEffectiveTone`)                                             |
| Session menu (DB)   | `lib/app/questionnaire/persona/resolve.ts`                                                                       |
| Zod validation      | `lib/app/questionnaire/authoring/config-schema.ts` (`personaSelectionSchema`)                                    |
| Read/write config   | `_lib/detail.ts` (`toConfigView`), `…/versions/[vid]/config/route.ts`                                            |
| Turn-time injection | `app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`                                                   |
| Session persona API | `app/api/v1/app/questionnaire-sessions/[id]/persona/route.ts` (GET/PATCH)                                        |
| Admin control       | `components/admin/questionnaires/persona-library-panel.tsx` (toggle + default + switcher + preview)              |
| Respondent picker   | `components/app/questionnaire/persona/persona-picker.tsx`; carousel in `session-workspace.tsx`                   |
| In-chat switcher    | `components/app/questionnaire/persona/interviewer-switcher.tsx` (chip + modal); wired in `session-workspace.tsx` |
| Flag                | `APP_QUESTIONNAIRES_PERSONA_SELECTION_ENABLED` (`feature-flag.ts`, seed `063-…`)                                 |
