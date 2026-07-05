# Interviewer tone & persona (F-tone)

Per-version control over **how** the live conversational interviewer responds to answers — not what
it asks (that's the structure), but its _voice_. An admin sets nine independent tone sliders plus a
free-text persona on the **Settings** tab; the live phraser folds the enabled ones into its system
prompt at turn time. Everything is **off by default**, so an untouched questionnaire keeps the
neutral baseline voice (see "Empathy owns emotional warmth" below), and the whole feature is
dark-launched behind a platform flag.

> Sits beside [presentation-mode](./presentation-mode.md), [reasoning-stream](./reasoning-stream.md)
> and [sensitivity-awareness](./sensitivity-awareness.md) as a respondent-experience feature. Like
> them it's a **config block + platform flag**, both required to take effect.
>
> **Built on by [interviewer-personas](./interviewer-personas.md) (F-persona):** a respondent-selectable
> library where each persona _is_ a `ToneSettings`, swapped in via `resolveEffectiveTone` at turn time.

## The settings (`ToneSettings`)

One JSON column `tone` on `AppQuestionnaireConfig`, shaped as `ToneSettings`
(`lib/app/questionnaire/types.ts` — the single source of truth, `TONE_DIMENSION_KEYS` +
`DEFAULT_TONE_SETTINGS`). Each dimension is `{ enabled: boolean; level: 1–5 }`; `persona` is
`{ enabled: boolean; text: string }` (≤ 400 chars).

| Key                 | Kind     | `1` ⟷ `5`                                          |
| ------------------- | -------- | -------------------------------------------------- |
| `empathy`           | bipolar  | dispassionate / clinical ⟷ highly empathetic       |
| `mirroring`         | unipolar | minimal ⟷ always reflect answers back, reframed    |
| `formality`         | bipolar  | casual / informal ⟷ formal / professional          |
| `mimicry`           | unipolar | own voice ⟷ strongly adopt the respondent's words  |
| `verbosity`         | bipolar  | terse ⟷ expansive                                  |
| `warmth`            | unipolar | neutral ⟷ very encouraging / affirming             |
| `curiosity`         | unipolar | take at face value ⟷ probe deeply with follow-ups  |
| `readingComplexity` | bipolar  | plain language ⟷ sophisticated vocabulary          |
| `humour`            | bipolar  | strictly earnest ⟷ playful                         |
| `persona`           | text     | free-text role, e.g. "You are a supportive coach." |

**Bipolar** dimensions treat `3` as neutral (no instruction emitted even when enabled); **unipolar**
intensity dimensions always emit when enabled (`1` = minimal is still a directive). The per-dimension
toggle is the real off switch — a disabled dimension contributes nothing.

## How it reaches the prompt

The voice lives entirely in the turn-time phraser, not in any seeded agent instruction:

1. **Read** — `toConfigView` (`_lib/detail.ts`) narrows the opaque `tone` Json with
   `narrowToneSettings` (`lib/app/questionnaire/chat/tone.ts`): every dimension present, `level`
   clamped to 1–5, persona trimmed/capped. A null/legacy/`{}` column resolves to all-off defaults.
2. **Gate** — the `/messages` route reads the resolved block off `loaded.base.config.tone` and ANDs
   the platform flag (`isToneEnabled()`) with "at least one dimension or the persona enabled". Only
   then is `tone` forwarded into the phraser input (`QuestionComposeInput.tone`); otherwise it's
   omitted and the default voice is unchanged. (Unlike goal/audience — which live only on `TurnMeta`
   — tone is a config field, so it reaches the phraser straight from config.)
3. **Render** — `buildToneInstructions(tone)` (pure) turns the **enabled** dimensions into imperative
   clauses, spliced into `buildStreamingQuestionPrompt`'s system prompt. Persona leads the block.

Three interactions with the existing default phrasing:

- **Mimicry owns tone-matching.** When `mimicry.enabled`, the hard-coded "Match the respondent's
  tone." line is dropped and the mimicry clause governs; otherwise that baseline line stays.
- **Verbosity owns later-turn length.** When `verbosity.enabled`, the default "keep it concise" line
  is replaced by the verbosity clause — but the opening-question "keep it VERY short" floor is always
  kept, so the first asks stay effortless regardless.
- **Empathy owns emotional warmth.** The hard-coded baseline (`role` + `rules` in
  `question-stream.ts`) is **emotionally neutral**: the interviewer is curious and attentive but
  must not perform feelings of its own (no "I'm really glad we have the chance to chat", "I'd love
  to hear", etc.) — only genuine curiosity is welcome by default. Setting `empathy` high (level 4–5)
  re-authorizes first-person warmth via its tone clause; because the `<tone>` section is rendered
  after `<rules>`, the empathy clause governs over the neutral-register guard. Level 1–2 reinforces
  the clinical/matter-of-fact end; level 3 (or disabled) leaves the neutral baseline untouched.

`buildToneInstructions` returns `''` for the all-off default → zero added prompt/cost when nothing is
configured.

## Flag

`APP_QUESTIONNAIRES_TONE_ENABLED` (`APP_QUESTIONNAIRES_TONE_FLAG`), seeded **disabled** by
`prisma/seeds/app-questionnaire/040-tone-flag.ts`. `isToneEnabled()`
(`lib/app/questionnaire/feature-flag.ts`) ANDs it with the master app flag and live-sessions (tone
only matters inside the `/messages` turn loop). See [feature-flags.md](./feature-flags.md).

## UI

The **Interviewer tone & persona** group in `ConfigEditor` (`components/admin/questionnaires/config-editor.tsx`):
a persona toggle + textarea, then nine dimension rows (enable `Switch`, and when on a 1–5 `Slider`
with pole captions). The group always renders; a note flags that the platform tone flag is also
required. The whole block is sent on save and validated by `toneSettingsSchema`
(`authoring/config-schema.ts`, `.strict()` — unknown keys and out-of-range levels are rejected).
