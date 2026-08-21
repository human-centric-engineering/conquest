# Interviewer strategy (questioning approach)

A per-questionnaire setting that, when enabled, **overrides the default questioning-approach prompt**
— how the agent asks (open/general vs targeted/specific, and how that shifts across the session).

**On by default for new questionnaires** (a balanced funnel arc with `probeDepth` + `batchRelated`),
via the column default set by migration `20260721103000_interviewer_strategy_funnel_default`.
Questionnaires created before that migration still store `{}` and so read back as **off** — the
narrower fails safe to all-off rather than to the config default, deliberately, so an existing
questionnaire never silently acquires a new questioning approach.

It is the questioning-approach sibling of **interviewer tone & persona** (`tone.ts`) — same JSON-config
shape, same narrow-on-read + render-into-prompt pattern. Tone controls _voice_; strategy controls
_approach_. Both are **session-level**; the per-question counterpart is
[question fidelity](./question-fidelity.md), which decides how faithfully ONE question must be put to
the respondent.

## The model

One openness **approach** (the session-level arc) plus additive **tactics** that combine with any
approach. Stored as `AppQuestionnaireConfig.interviewerStrategy` (Json), shape
{@link InterviewerStrategySettings}:

```
{ enabled,
  approach: 'funnel' | 'open' | 'targeted',
  pace: 'gradual' | 'balanced' | 'brisk',
  openingMode: 'auto' | 'examples',
  openingExamples: string[],
  probeDepth, reflect, batchRelated }
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
  feeding the confidence loop). The playback is a **statement**, never a confirming question — the
  clause explicitly bans "is that right?"-style tags and question marks, because `rules` already
  requires every turn to end with the real question, and a confirming tag makes it two questions in
  one turn.
- **batchRelated** — invite a few closely-related gaps together rather than strictly one at a time.

## Where each piece lives

| Concern                        | Code                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types + default                | `lib/app/questionnaire/types.ts` (`INTERVIEWER_APPROACHES`, `FUNNEL_PACES`, `INTERVIEWER_OPENING_MODES`, `InterviewerStrategySettings`, `DEFAULT_INTERVIEWER_STRATEGY`)                        |
| Narrow (read) + prompt builder | `lib/app/questionnaire/chat/interviewer-strategy.ts` (`narrowInterviewerStrategy`, `FUNNEL_PACE_PROFILES`, `paceProfile`, `funnelPhase`, `buildInterviewerStrategyInstructions`)               |
| Free-text sanitisation         | `lib/app/questionnaire/chat/prompt-text.ts` (`narrowPromptText`) — the single choke point every admin-authored prompt string flows through, shared with house rules                            |
| Prompt injection               | `app/api/v1/app/questionnaire-sessions/_lib/question-stream.ts` — an `interviewer_strategy` section placed AFTER `rules`/`this_turn` so it governs (later sections win, like tone)             |
| Progress signals               | the messages route computes `coverage` (answered/total) + `respondentTerse` (short latest reply) once per turn and threads them into both phrasing call sites                                  |
| Config plumbing                | Prisma `interviewerStrategy Json` (column default carries the full shape); Zod `interviewerStrategySchema` in `config-schema.ts`; `detail.ts` select/view (narrowed); `config-editor.tsx`      |
| Admin editor                   | `components/admin/questionnaires/interviewer-strategy-panel.tsx` — the whole group, including `FunnelArcExplainer`; `config-editor.tsx` keeps only the `SettingsGroup` shell, state and save   |
| Conflict lints                 | `config-conflicts.ts` checks 8–9, anchored `sectionId: 'interviewer-strategy'`; label in `components/admin/questionnaires/config-conflicts.tsx`                                                |
| Pack / audit summary           | `settings-registry.ts` — approach, Funnel pace (funnel only), Opening questions (counted, never reprinted), tactics                                                                            |
| Opening-examples suggester     | `lib/app/questionnaire/opening-examples/suggest.ts` + `…/[vid]/opening-examples/suggest/route.ts` + `opening-examples-suggest.tsx`; agent seed `094`, `openingExamplesSuggestLimiter` (20/min) |
| Import / export                | **automatic** — `config-export.ts` derives keys from `DEFAULT_QUESTIONNAIRE_CONFIG`, value-validates via `updateConfigSchema`; both now include the field, so no per-setting wiring is needed  |

## The funnel phase

`funnelPhase()` resolves `open` / `mixed` / `targeted` from **coverage**, falling back to the
**selection round** when coverage is unknown. A terse respondent steps the phase one notch toward
targeted — broad invitations aren't paying off, so it gets specific sooner.

## Pace

The four numbers that define the arc — the opening window, the two coverage thresholds, and the
no-coverage round fallback — are not independently meaningful, so they move together as one
**pace** dial rather than four fields. An admin who widened the open band but left the opening
window at one ask would get an arc that contradicts itself.

| pace                         | opening window | open below | targeted above | open rounds | targeted rounds |
| ---------------------------- | -------------- | ---------- | -------------- | ----------- | --------------- |
| `gradual` (Stay open longer) | 3              | 0.55       | 0.85           | 5           | 12              |
| `balanced` (Balanced)        | 2              | 0.40       | 0.75           | 3           | 8               |
| `brisk` (Narrow quickly)     | 1              | 0.25       | 0.55           | 2           | 5               |

**`balanced` is the arc's original hard-coded constants, boundary for boundary.** That is what makes
the dial a provable no-op for every questionnaire that never touches it, and it is pinned by a test
(`balanced reproduces the original hard-coded boundaries exactly`) rather than left to good
intentions.

`paceProfile(settings)` honours the stored pace for **`funnel` only** — `open` and `targeted` always
read `balanced`. The editor shows the dial only for `funnel`, so letting a stored pace quietly
reshape an `open` session's opening window would be an effect with no visible cause.

## Showing the arc, not describing it

`FunnelArcExplainer` renders the bands as a small table under the approach select, derived from the
**same `FUNNEL_PACE_PROFILES` the runtime reads**. This is the house-rules preview trick applied to a
table instead of prompt text: a hard-coded explainer that drifted from the profile would be worse
than the vague prose it replaced, because the admin would have no reason to doubt it.

It exists because the previous help text ("as coverage builds it steers toward the specific points
still missing") could not answer the question admins actually ask — _is the openness a two-question
preamble, or a gradual descent?_ It is both, and the only honest way to say so is to show the bands.
Three variants: the four-band table for `funnel` (plus footnotes for the terse bias and the
round fallback), a two-band one for `open`, and nothing at all for `targeted`, which has no arc.

Percentages go through `Math.round` — `0.55 * 100` is `55.00000000000001` in IEEE floats, and
`brisk` is the pace that exposes it. A test pins that no percentage ever renders a decimal point.

## Opening framings (open phase)

The first few asks (the pace profile's `openingWindow`) in an **open phase** — the `open` approach
(always), or `funnel` while `funnelPhase()` reads `open` — get a richer, more subtle opener than the ongoing
broad clause. The `openingClause` invites the respondent to talk freely and broadly **before** any
specific question: breadth before detail, experiences as much as opinions, no leading language, and
explicit permission to speak at length (no right/wrong answers, take their time, follow tangents). It
mentions the questionnaire is completed quietly in the background — without making that the focus.

Where the opener's **framing** comes from is `openingMode`, rendered by `framingClause()`:

- **`auto`** (default) — variety is model-driven: the clause offers a menu of framings (broad &
  conversational, story-first, reflection-first, very-open, blank-page, appreciative & critical) and
  tells the agent to pick one and make it its own rather than recite a script.
- **`examples`** — the admin's own `openingExamples` (1–5, capped at `OPENING_EXAMPLE_MAX` chars)
  replace that menu as **guidance**: match their breadth, register and spirit, write your own opener
  in the same vein, and vary it between respondents. The clause bans reproducing one verbatim
  **explicitly** — the word "example" alone does not stop a model reciting a quoted list, and a
  recited list would hand every respondent the same opener, which is the exact failure the menu
  exists to avoid.

Two scope rules keep `examples` honest:

- **`usesGuidedOpening()` requires a usable example.** `examples` mode with an empty or
  all-whitespace list falls back to the `auto` menu rather than rendering an examples block with no
  examples in it. The editor uses the same predicate to warn that the mode is currently doing
  nothing.
- **They govern the opening window only** — not the whole open phase, and never the mixed/targeted
  phases or the `targeted` approach. An "example opening question" that quietly governed question 12
  would surprise the admin who wrote it.

The **second** ask follows the respondent's lead: if their first answer was terse it widens
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

## The opening-questions assistant

A **one-shot analyst**, structurally identical to the house-rules suggester and sharing its whole
skeleton: `withAdminAuth` → per-admin 20/min sub-cap → scoped `findFirst` with a capped context
select → `buildSuggestMessages` (pure, separately tested) → `validateSuggestResult` (a **narrower**,
not a Zod parse — it drops bad entries and returns `null` only on a broken envelope, which is what
earns `runStructuredCompletion`'s retry) → `recordAiRun` on success **and** failure.

**Read-only.** There is no apply endpoint. Proposals land in a dialog, the admin accepts the ones
they want into editor state, and the ordinary config PATCH saves them — audited like any other
settings change. The opening is the first thing a real respondent is ever asked, so an opener
nobody read is precisely what the propose-then-accept shape exists to prevent.

Four prompt decisions carry the quality, and each is asserted in the unit tests rather than trusted:

- It is told the examples are **guidance the interviewer riffs on, not a script it reads**. Without
  that it writes safe, ready-to-recite lines instead of strong models of a register.
- It anchors on the questionnaire's **subject**, and is explicitly forbidden from naming, quoting or
  paraphrasing an individual question — the opening deliberately comes before all of them. The same
  warning rides the question list in the user message, where it is hardest to ignore.
- It is given the **failure modes** (leading, yes/no-able, double-barrelled, jargon) that otherwise
  survive a plausible-looking first draft.
- It is told to **vary** the openers, so the admin gets a real choice of registers rather than one
  question rephrased five ways. The seed sets `temperature: 0.7` for the same reason — the
  house-rules assistant's 0.4 returns near-duplicates here.

Two smaller choices: the narrower **de-duplicates** case-insensitively (two identical openers in the
panel read as a UI bug, not a model quirk), and accepting a suggestion **fills a blank row** if one
exists rather than appending below it, so an admin who clicked "Add an example" first is not left
with an empty row that trips the panel's own "nothing written yet" warning.

The limiter is its **own** bucket, not shared with the house-rules assistant: two assistants on one
Settings tab sharing a cap would let a burst of one lock out the other, which the admin would
experience as an unrelated feature breaking.

## Anti-patterns

- **Don't** gate this on a platform flag — it's a per-questionnaire setting, off by default; `enabled`
  is the only gate.
- **Don't** place the strategy section before `rules` in the prompt — it must come AFTER so it
  overrides the default open-invitation guidance (the prompt convention is later-section-wins).
- **Don't** hand-wire import/export for a new config field — add it to `DEFAULT_QUESTIONNAIRE_CONFIG`
  - `updateConfigSchema` and it flows automatically.
- **Don't** make a newly-added key inside `interviewerStrategySchema` required. The block is
  `strict()`, so a settings export or questionnaire definition written before the key existed would
  fail to import. Give it a `.default()` whose value reproduces the pre-feature behaviour — that is
  what `pace`, `openingMode` and `openingExamples` do.
- **Don't** change what `balanced` resolves to. It is the compatibility anchor, not a tuning knob;
  retune `gradual`/`brisk` instead.
- **Don't** splice admin free text into a prompt without `narrowPromptText` — it neutralises the
  angle brackets that would otherwise let stored text forge a prompt section.
- **Don't** hard-code the arc's numbers into admin copy. `FunnelArcExplainer` reads
  `FUNNEL_PACE_PROFILES`; a duplicated table is a lie waiting to happen.
- **Don't** let the editor and `usesGuidedOpening()` disagree about what counts as a usable example.
  The panel's amber warning, the `opening-examples-empty` lint and the runtime fallback all mean
  "at least one non-whitespace entry", and all three are tested against that same definition.
