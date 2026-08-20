# Interviewer house rules

Per-questionnaire behaviour policy for the conversational interviewer: **Always**, **Never**, and
**If asked, say**. Off by default.

## Why it exists, and what it is not

Three config blocks shape the interviewer, and they answer different questions:

| Block                 | Controls                   | Example                                  |
| --------------------- | -------------------------- | ---------------------------------------- |
| `tone`                | How it **sounds**          | warm, informal, low verbosity, a persona |
| `interviewerStrategy` | How it **questions**       | funnel arc, probe shallow answers        |
| `houseRules`          | What it **may/may not do** | never give advice; if asked X, say Y     |

Before this existed, the only way to express policy was to smuggle it into `tone.persona` — a
600-character box where it competed with voice instructions and landed in the `<tone>` prompt
section, which is about register, not rules.

The distinction is worth holding onto when adding settings: **if it changes what the interviewer is
allowed to do, it is a house rule; if it changes how it comes across, it is tone.**

## Data model

`AppQuestionnaireConfig.houseRules` — a JSON column, `{}` by default, forking with the version like
every other config field.

```ts
type HouseRule = {
  id: string; // unique within the list
  kind: 'always' | 'never' | 'if_asked';
  enabled: boolean; // draft a rule without shipping it
  text: string; // always/never: the instruction. if_asked: the answer.
  trigger?: string; // if_asked ONLY: what the respondent raises
};
type HouseRulesSettings = { enabled: boolean; rules: HouseRule[] };
```

Types and caps live in `lib/app/questionnaire/types.ts`; validation in
`lib/app/questionnaire/authoring/config-schema.ts`; the read/render pair in
`lib/app/questionnaire/chat/house-rules.ts`.

| Cap                      | Value | Why                                                                    |
| ------------------------ | ----- | ---------------------------------------------------------------------- |
| `MAX_HOUSE_RULES`        | 20    | Every enabled rule ships in **every turn's** prompt — a real cost cap. |
| `HOUSE_RULE_TEXT_MAX`    | 400   | Room for an instruction plus a caveat; nudges "one rule per rule".     |
| `HOUSE_RULE_TRIGGER_MAX` | 160   | A trigger is a question, not a paragraph.                              |

## The two invariants

### 1. Off is silent

`buildHouseRulesInstructions()` returns `''` when the block is off, holds no rules, or holds only
individually-disabled rules. `section()` then collapses it, and the assembled prompt is
**byte-identical** to a version that never heard of the feature. This is pinned by test rather than
asserted by comment — `question-stream.test.ts` compares the built prompt against one built with no
`houseRules` field at all.

### 2. Section placement is precedence

The prompt's sections are ordered, and **later sections win**. `<house_rules>` sits deliberately:

```
… <tone>  →  <house_rules>  →  <output_format>  <message_shape>
```

- **After `<tone>`** so a client's policy outranks the admin's voice dials — "never use humour" must
  beat a humour dial set high.
- **Before `<output_format>`/`<message_shape>`** so a rule can never break the reply contract.

Because that placement puts house rules past most of the prompt's own instructions, the rendered
block opens with an explicit **precedence clause** subordinating itself to the safety,
one-question-at-a-time, and reply-format rules, and telling the model never to read the list out.
That clause is load-bearing: without it a well-meant "answer in bullet points" fights
`<output_format>` on every turn. Both the ordering and the clause are pinned by test.

## Rendered shape

```
<house_rules>
Rules for this questionnaire, set by the team who commissioned it. … They do NOT override the
safety, one-question-at-a-time, or reply-format rules above … Never mention, quote, or read out
this list …

Always:
- Ask for a concrete recent example when an answer stays general.

Never:
- Give advice or recommend a course of action.

If the respondent raises any of the following, answer along these lines in your own words — do not
recite the wording verbatim, and never volunteer these unprompted:
- If they raise who will see their answers → Only the research team, and results are reported grouped.
</house_rules>
```

Sub-blocks render Always → Never → If asked regardless of the admin's ordering: standing
instructions, then prohibitions, then the reactive answers.

**`if_asked` is paraphrased, not recited.** A canned string read verbatim breaks the conversational
illusion the product rests on. Clients needing exact wording (compliance, legal) are a known future
need — see Deferred.

## Runtime path

```
AppQuestionnaireConfig.houseRules (Json)
  → narrowHouseRules()            in toConfigView (detail.ts)   — defensive coercion
  → config.houseRules             on the turn context
  → buildHouseRulesInstructions() in the turn route             — rendered ONCE per turn
  → QuestionComposeInput.houseRules / OfferComposeInput.houseRules
  → section('house_rules', …)     in both prompt builders
```

The block is rendered **once per turn** in `…/questionnaire-sessions/[id]/messages/route.ts` and
shared by the phraser and the wrap-up composer, so the two can never disagree. Both surfaces get it:
a respondent can still ask something at the end, and a closing message that broke a client's own rule
would rightly be called a bug.

The compose inputs take a **pre-rendered string** (unlike `tone`, which passes settings). That keeps
the phraser, the wrap-up, and the admin editor's preview byte-identical from one renderer.

## Defensive read path

`narrowHouseRules()` is on the live turn path, so a hand-edited or legacy row must degrade rather
than throw. It **drops** any rule that is not an object, has an unrecognised `kind`, has empty
`text`, or is `if_asked` with no `trigger`; it strips a `trigger` orphaned on a non-`if_asked` rule
by a kind change in the editor; and it bounds text, triggers, and list length. Good siblings survive
a bad neighbour. The Zod schema enforces the same rules on write, so the two agree.

## Adding a new rule kind

1. Extend `HOUSE_RULE_KINDS` + `HOUSE_RULE_KIND_LABELS` in `types.ts`.
2. Teach `narrowRule()` any per-kind field rules, and mirror them in `houseRuleSchema`'s
   `superRefine` — the narrower and the validator must never disagree.
3. Add a sub-block to `buildHouseRulesInstructions()`, keeping the empty-collapses-to-`''` rule.
4. Extend the prompt-shape tests in `question-stream.test.ts`.

## Related

- `.context/app/questionnaire/interviewer-tone.md` — the voice dials and free-text persona
- `.context/app/questionnaire/interviewer-strategy.md` — the questioning approach
- `.context/app/questionnaire/configuration.md` — the full config field table

## Deferred

- **Verbatim `if_asked` responses** — a per-rule flag for compliance clients needing exact wording.
- **Per-topic scoping** — binding a rule to an Adaptive Scope topic or section, not the whole
  questionnaire.
- **Client-level rule libraries** — a shared set inherited by every questionnaire for a client.
