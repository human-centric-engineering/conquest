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

## Opening framings (open phase)

The first couple of asks (`OPENING_WINDOW = 2`) in an **open phase** — the `open` approach (always),
or `funnel` while `funnelPhase()` reads `open` — get a richer, more subtle opener than the ongoing
broad clause. The `openingClause` invites the respondent to talk freely and broadly **before** any
specific question: breadth before detail, experiences as much as opinions, no leading language, and
explicit permission to speak at length (no right/wrong answers, take their time, follow tangents). It
mentions the questionnaire is completed quietly in the background — without making that the focus.

Variety is **model-driven**: the clause offers a menu of framings (broad & conversational,
story-first, reflection-first, very-open, blank-page, appreciative & critical) and tells the agent to
pick one and make it its own rather than recite a script — so different respondents get different
openings. The **second** ask follows the respondent's lead: if their first answer was terse it widens
again; if it surfaced something that matters it probes that thread deeper (uses `respondentTerse` as
a hint). Past the window, the open phase reverts to the ongoing broad invitation.

`usesOpenOpening(settings, ctx)` is the **single source of truth** for "is this an open opening". The
phraser (`question-stream.ts`) uses it in two places: (1) it **relaxes the brevity floor** — the
opening may run two to three sentences instead of the usual single-sentence clamp, so the
permission-giving invitation fits; and (2) it **swaps the `<this_turn>` opening guidance** so it
defers to the broad invitation. That second point matters: the default opening guidance tells the
model to "ease straight into this first question with a single, light ask", which — being the most
specific opening directive — otherwise wins over the `<interviewer_strategy>` clause and produces a
narrow first question. On an open opening it instead points the model AT the broad invitation.

Two further anchors had to be defused so the model actually broadens (it otherwise latches onto the
concrete inputs): the opening clause explicitly forbids asking/naming/bolding the specific topic and
tells the model to take the broadest sensible framing (the whole area, or wider — the questionnaire's
subject); and the phraser **reframes the user message** on an open opening so the detailed slot prompt
is demoted to "for your awareness only — the AREA to explore" rather than presented as "the question
to ask". Without that, the precise prompt in the user turn out-anchors the system guidance.

## Anti-patterns

- **Don't** gate this on a platform flag — it's a per-questionnaire setting, off by default; `enabled`
  is the only gate.
- **Don't** place the strategy section before `rules` in the prompt — it must come AFTER so it
  overrides the default open-invitation guidance (the prompt convention is later-section-wins).
- **Don't** hand-wire import/export for a new config field — add it to `DEFAULT_QUESTIONNAIRE_CONFIG`
  - `updateConfigSchema` and it flows automatically.
