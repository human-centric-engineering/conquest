# Interviewer strategy (questioning approach)

A per-questionnaire setting that, when enabled, **overrides the default questioning-approach prompt**
— how the agent asks (open/general vs targeted/specific, and how that shifts across the session).
Off by default: existing questionnaires keep today's open, conversational voice unchanged.

It is the questioning-approach sibling of **interviewer tone & persona** (`tone.ts`) — same JSON-config
shape, same narrow-on-read + render-into-prompt pattern. Tone controls _voice_; strategy controls
_approach_.

## The model

One openness **approach** (the session-level arc) plus additive **tactics** that combine with any
approach. Stored as `AppQuestionnaireConfig.interviewerStrategy` (Json), shape
{@link InterviewerStrategySettings}:

```
{ enabled, approach: 'funnel' | 'open' | 'targeted', probeDepth, reflect, batchRelated }
```

**Approaches:**

- **funnel** — open/general first ("Tell me about…") so people ramble and fill several slots at
  once; keeps probing openly while productive; narrows to targeted to close gaps as coverage builds.
  Adaptive: goes targeted **sooner** when the respondent is terse, and re-opens as the form fills.
- **open** — broad and exploratory throughout, loosely guided by remaining gaps.
- **targeted** — one specific, concrete question at a time; efficient.

**Tactics (mix into any approach):**

- **probeDepth** — dig into a shallow/low-confidence answer with one follow-up before moving on.
- **reflect** — briefly play back the captured point before the next question (also corroborates,
  feeding the confidence loop).
- **batchRelated** — invite a few closely-related gaps together rather than strictly one at a time.

## Where each piece lives

| Concern                        | Code                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types + default                | `lib/app/questionnaire/types.ts` (`INTERVIEWER_APPROACHES`, `InterviewerStrategySettings`, `DEFAULT_INTERVIEWER_STRATEGY`)                                                                    |
| Narrow (read) + prompt builder | `lib/app/questionnaire/chat/interviewer-strategy.ts` (`narrowInterviewerStrategy`, `funnelPhase`, `buildInterviewerStrategyInstructions`)                                                     |
| Prompt injection               | `app/api/v1/app/questionnaire-sessions/_lib/question-stream.ts` — an `interviewer_strategy` section placed AFTER `rules`/`this_turn` so it governs (later sections win, like tone)            |
| Progress signals               | the messages route computes `coverage` (answered/total) + `respondentTerse` (short latest reply) once per turn and threads them into both phrasing call sites                                 |
| Config plumbing                | Prisma `interviewerStrategy Json @default("{}")`; Zod `interviewerStrategySchema` in `config-schema.ts`; `detail.ts` select/view (narrowed); `config-editor.tsx` Settings-tab group           |
| Import / export                | **automatic** — `config-export.ts` derives keys from `DEFAULT_QUESTIONNAIRE_CONFIG`, value-validates via `updateConfigSchema`; both now include the field, so no per-setting wiring is needed |

## The funnel phase

`funnelPhase()` resolves `open` / `mixed` / `targeted` from **coverage** (`<0.4` open, `<0.75` mixed,
else targeted), falling back to the **selection round** when coverage is unknown. A terse respondent
steps the phase one notch toward targeted — broad invitations aren't paying off, so it gets specific
sooner.

## Anti-patterns

- **Don't** gate this on a platform flag — it's a per-questionnaire setting, off by default; `enabled`
  is the only gate.
- **Don't** place the strategy section before `rules` in the prompt — it must come AFTER so it
  overrides the default open-invitation guidance (the prompt convention is later-section-wins).
- **Don't** hand-wire import/export for a new config field — add it to `DEFAULT_QUESTIONNAIRE_CONFIG`
  - `updateConfigSchema` and it flows automatically.
