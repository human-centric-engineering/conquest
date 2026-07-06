# Selectable interviewer personas (F-persona)

Lets a **respondent choose which interviewer they talk with** — a cynical curmudgeon, a warm
encourager, a stand-up comedian, a reflective philosopher, a get-to-the-point director, a sceptical
realist, or the neutral coach — when the admin opts a questionnaire in. It builds directly on
[interviewer-tone](./interviewer-tone.md): a persona _is_ a named `ToneSettings`, so a chosen persona
flows through the exact same phraser pipeline (`buildToneInstructions`) with no new prompt machinery.

> A respondent-experience feature, **config block + platform flag** (both required), like
> [presentation-mode](./presentation-mode.md) and the tone/strategy siblings. Dark-launched behind
> `APP_QUESTIONNAIRES_PERSONA_SELECTION_ENABLED`; **off by default**, so an untouched questionnaire is
> unchanged.

## The model

Two new JSON columns on `AppQuestionnaireConfig`, plus one column on the session:

- **`personas`** — `PersonaOption[]` (`lib/app/questionnaire/types.ts`): each
  `{ key, label, description, tone: ToneSettings }`. The `tone` block holds the persona's whole voice
  (its prose lives in `tone.persona.text`, its character in the dimension levels). Empty column ⇒ the
  read path fills in the **built-in library** (`narrowPersonas`).
- **`personaSelection`** — `{ enabled, defaultPersonaKey }`: whether respondents may choose, and which
  persona applies when they don't.
- **`AppQuestionnaireSession.selectedPersonaKey`** — the respondent's choice (null ⇒ default applies).

The **built-in library** is seeded, not stored: `BUILT_IN_PERSONAS`
(`lib/app/questionnaire/persona/presets.ts`) — the `neutral-coach` default (a calm, objective
coach/consultant grounded in human & organisational psychology) plus six characters. **Every persona
ships fully seeded** — a persona prompt _and_ tone dials — so an admin opening the library sees each
one pre-filled. The admin may edit/extend the list per questionnaire; an unconfigured questionnaire
shows the built-ins.

## How a choice takes effect

The menu (which personas exist + the default) lives on the **version config**; the choice lives on the
**session**. They meet at turn time:

1. **Admin** authors the library on the **Settings → Interviewer personas** card
   (`persona-library-panel.tsx`, gated by the `personaSelection` workspace flag) and flips "let
   respondents choose". Saved whole through the same config PATCH as tone.
2. **Respondent** picks on the **"Choose your interviewer"** carousel step
   (`persona-picker.tsx`) — a pre-chat gate, like the intro, that defers the opening LLM turn until
   they reach the conversation so their choice is in place first. The ModeToggle's "Interviewer"
   segment doubles as the mid-run switcher. The choice PATCHes
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

| Concern             | File                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Types + defaults    | `lib/app/questionnaire/types.ts` (`PersonaOption`, `PersonaSelectionSettings`)                 |
| Built-in library    | `lib/app/questionnaire/persona/presets.ts`                                                     |
| Narrow + resolve    | `lib/app/questionnaire/persona/settings.ts` (`resolveEffectiveTone`)                           |
| Session menu (DB)   | `lib/app/questionnaire/persona/resolve.ts`                                                     |
| Zod validation      | `lib/app/questionnaire/authoring/config-schema.ts` (`personaOptionSchema`)                     |
| Read/write config   | `_lib/detail.ts` (`toConfigView`), `…/versions/[vid]/config/route.ts`                          |
| Turn-time injection | `app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`                                 |
| Session persona API | `app/api/v1/app/questionnaire-sessions/[id]/persona/route.ts` (GET/PATCH)                      |
| Admin editor        | `components/admin/questionnaires/persona-library-panel.tsx`                                    |
| Respondent picker   | `components/app/questionnaire/persona/persona-picker.tsx`; carousel in `session-workspace.tsx` |
| Flag                | `APP_QUESTIONNAIRES_PERSONA_SELECTION_ENABLED` (`feature-flag.ts`, seed `063-…`)               |
