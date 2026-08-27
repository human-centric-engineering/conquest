# Respondent layouts

How the respondent surface is **arranged**, and the mechanism that guarantees a questionnaire
never loses a feature by choosing a different arrangement.

> **Orthogonal to `presentationMode`.** That setting decides _what_ the respondent completes —
> conversation, form, or both. A layout decides _where the parts sit_. Every combination is valid.

## The problem this solves

The respondent surface used to have exactly one arrangement, hard-coded into
`SessionWorkspace`: a lifecycle strip on top, the conversation left, the answer panel right. That
was fine while there was one. The moment a second exists, two things go wrong on their own:

1. Every layout re-derives the same gates, and the gates are subtle. A blocking capture form
   defers the opening LLM turn; releasing it one step early streams the first question behind the
   persona picker, in the wrong voice. A second derivation of that logic will drift from the first.
2. A layout quietly drops a feature. Nobody notices until a demo, because the feature still exists
   — it just has nowhere to render.

## The parts

| Part            | File                                                          | Role                                                           |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Slot vocabulary | `lib/app/questionnaire/layout/slots.ts`                       | The named parts, the placement types, the essential set        |
| Behaviour       | `lib/hooks/use-session-workspace.ts`                          | Every hook, gate and piece of session state. Headless.         |
| Container       | `components/app/questionnaire/session-workspace.tsx`          | Runs the hook, handles takeovers, builds slot nodes, delegates |
| Layouts         | `components/app/questionnaire/layouts/*-layout.tsx`           | Arrangement, and nothing else                                  |
| Registry        | `components/app/questionnaire/layouts/registry.ts`            | Name → definition, plus the placement declarations             |
| Shared pieces   | `layouts/surface-carousel.tsx`, `chat/conversation-frame.tsx` | Arrangement a layout reuses rather than re-derives             |

A layout receives `{ slots, state }` and returns JSX. It never constructs a feature, never touches
a hook, never learns what a session is. So it **cannot break a feature, only misplace one** — and
misplacement is visible, where a broken feature is not.

## How "every feature, every layout" is enforced

Three legs, because no single one is sufficient:

**1. The compiler.** `LAYOUT_REGISTRY` is `satisfies LayoutRegistry`, whose `placements` is
`Record<RespondentSlotKey, SlotPlacement>`. Adding a key to `RESPONDENT_SLOTS` does not build until
every layout says where that part goes. This is the same idiom, for the same reason, as
`SETTING_DESCRIPTORS satisfies Record<keyof QuestionnaireConfigShape, SettingDescriptor>` in
`settings-registry.ts` and the privacy export manifest: hand-maintained parallel lists had already
shipped silent omissions here.

**2. The essential set.** `ESSENTIAL_SLOTS` may never be `omitted`, by any layout. The test is not
"is this important" — everything is — but "can the respondent finish, correctly, without it".
`answersPanel` is deliberately **not** essential: `answerSlotPanelScope: 'hidden'` is a supported
configuration today, and a layout may legitimately move review behind a gesture. `transcript` and
`composer` both **are**, even though a layout could technically hide one behind a gesture: `overlay`
is legal for either, `omitted` is not, because a conversation with half of itself deleted is not an
arrangement.

**3. The tests.** A declaration can drift from the JSX beside it, and a declaration that drifts is
worse than none — it reads like a guarantee. `registry.test.tsx` renders each layout with a
sentinel per slot and asserts every `region`-placed part reaches the DOM, naming the layout, the
slot and the declared region on failure.

## Choosing one

`config.respondentLayout` on the questionnaire version — a `String` column defaulting to
`'classic'`, narrowed through `narrowToEnum` like every other enum here. The admin picks it in the
config editor's **Respondent experience** section, above presentation mode, as a card per layout
rather than a dropdown (the value is a _shape_; a name in a `<select>` conveys nothing).

Human copy for a layout lives in **one** place, `lib/app/questionnaire/layout/catalog.ts`, read by
the picker, the settings registry (and so the Questionnaire Pack's client-facing table) and the
layout registry alike. The codebase already shows the cost of not doing this —
`PRESENTATION_MODE_LABELS`, `ANSWER_SLOT_PANEL_SCOPE_LABELS` and `REASONING_PLACEMENT_LABELS` each
exist twice today, verbatim, with nothing linking the copies.

### The default is load-bearing

There is no backfill. Every questionnaire that predates the column keeps its appearance purely
because five separate layers all resolve an absent or unrecognised value to Classic:

| Layer            | Where                                    | Behaviour                          |
| ---------------- | ---------------------------------------- | ---------------------------------- |
| Column default   | the migration                            | `DEFAULT 'classic'`                |
| Config default   | `DEFAULT_QUESTIONNAIRE_CONFIG`           | `'classic'`                        |
| DB → view        | `asRespondentLayout` in `_lib/detail.ts` | unknown → default                  |
| Version read     | `resolveRespondentLayoutForVersion`      | absent config or unknown → default |
| View → component | `resolveLayout`                          | unknown → Classic definition       |

Note the asymmetry, which is intentional: the **write** boundary (`updateConfigSchema`) _rejects_ an
unknown layout, because an admin PATCHing one is a caller bug worth surfacing. Every **read**
boundary accepts it and falls back, because a stored unknown value is a rollback artefact a live
respondent has to survive. `tests/unit/lib/app/questionnaire/layout/respondent-layout-default.test.ts`
walks all of it in one file.

### The placement declaration is load-bearing too

It is not documentation. The container reads `placements.answersPanel.kind` to decide **three**
things at once — whether to build the panel node at all, whether the review trigger carries
`lg:hidden`, and whether the review _sheet_ retires at `lg` (`panelReturnsAtLg`) — so a layout that
changes its mind about the panel changes all of them together, and the declaration cannot drift
from the behaviour it describes.

That third reading was missing when Focus shipped, and the bug it caused is the argument for the
rule. The trigger's `lg:hidden` became conditional; the sheet's stayed hard-coded in
`AnswerReviewDrawer`. So on a desktop under Focus the trigger appeared, the Radix overlay dimmed
the page — the overlay has no breakpoint — and the content was `display: none`. A modal that opens
onto nothing, and the only route to the captured answers in that layout.

It survived a full phase because the obvious test cannot see it: jsdom applies no media queries, so
"click the trigger, assert a dialog appears" passes while the real respondent sees a dimmed page.
The assertions that catch it are on the class (`answer-review-drawer.test.tsx`) and on the prop the
container derives (`session-workspace.test.tsx`). **Any new behaviour keyed off a breakpoint needs
the same treatment** — assert the declaration, not just the interaction.

## Shared arrangement, and why it is not a violation

Two pieces of arrangement are declared once and reused by every layout that wants them:

- **`SurfaceCarousel`** (`layouts/surface-carousel.tsx`) — the sliding track the surfaces ride.
  Extracted at the third layout, not the second: two copies of a block this subtle are watchable,
  three is where one of them loses the `overflow-clip` and a stray `scrollIntoView` starts dragging
  the whole track sideways. A layout still supplies `surfaceFor`, so it owns everything visible.
- **`ConversationFrame`** (`chat/conversation-frame.tsx`) — the transcript and the composer stacked
  in one card, which is what `conversation` used to be. Classic, Focus and the read-only replay all
  want exactly that. It also owns the hairline seam between the two, because the seam belongs to the
  arrangement: a `border-t` is right in a shared card and wrong on a composer that is a card of its
  own in a rail. Drawn on a wrapper rather than passed to the composer as a class, so a `null`
  composer leaves no line hanging under nothing.

Neither builds a feature, fetches anything, or reads session state — they take ready-made nodes and
position them. That is arrangement, shared, and it is the opposite of the thing the contract
forbids (a layout constructing a feature for itself).

## The conversation is two slots

`transcript` and `composer`, since Broadsheet. They are the one pair that genuinely needs care,
because they share a clock:

> The composer must stay shut until **both** the HTTP stream has closed **and** the transcript's
> reveal queue has finished typing the reply in. Gating on `canSend` alone re-opens the box
> mid-reveal, letting a respondent answer a question they have not finished reading — or, during
> the opening burst, one still entirely hidden.

While the two lived in one component that gate was a local variable. Now a layout may place them
with no common ancestor between them, so the shared state rides `ConversationProvider`, mounted by
`SessionWorkspace` **above the whole layout** — for exactly the reason `--cq-chat-scale` is set
there: so no layout has to remember it.

The provider carries only what genuinely cannot be derived twice — the reveal cursor, `composerReady`,
`isTerminal` and the wait cue. Everything else stays a prop (`glossary` and the reasoning placement
belong to the transcript; the voice and attachment flags to the composer), because a context that
also carries those becomes a second, competing props channel and costs the type-checking that
catches a missing one. `useConversation` **throws** without a provider rather than defaulting: a
composer that silently decided it was ready would open mid-reveal, which is the precise failure the
queue exists to prevent.

`tests/unit/components/app/questionnaire/chat/conversation-split.test.tsx` mounts the two as
unrelated siblings and asserts the gate still crosses between them.

## Placement vocabulary

```ts
type SlotPlacement =
  | { kind: 'region'; region: string } // on screen, here
  | { kind: 'overlay'; via: 'sheet' | 'drawer' | 'modal' | 'gesture' } // reachable, one gesture away
  | { kind: 'omitted'; because: string }; // deliberate, and justified
```

- `region` is layout-local prose (`'margin'`, `'spine'`, `'lifecycle strip, trailing cluster'`).
  One value is reserved: **`'takeover'`** means the container renders this instead of the layout,
  full-surface. `complete` and `handoff` use it.
- `overlay` still counts as available. A sheet one tap away is a design decision, not a missing
  feature — counting it as missing would push every layout toward the same shape.
- `because` is required so that "we forgot" cannot masquerade as a choice, and a test asserts it
  is non-empty.

## Phases, and `phase` in particular

`useSessionWorkspace` returns `phase` first, and callers branch on it before anything else:

| `phase`    | What renders                           | Why it is a takeover                                          |
| ---------- | -------------------------------------- | ------------------------------------------------------------- |
| `readOnly` | The transcript alone                   | The admin session viewer holds no respondent credential       |
| `handoff`  | `StitchedContinuation` / `HandoffCard` | A completed _leg_ of an Experience is not the end of anything |
| `complete` | `SessionComplete`                      | Submitted; the report and download live here                  |
| `active`   | The chosen layout                      | The only case that reaches a layout at all                    |

The order matters and the cases overlap: a read-only replay of a _completed_ session shows its
conversation, not the respondent's completion screen.

## Adding a layout

1. Add its name to `RESPONDENT_LAYOUTS` in `lib/app/questionnaire/types.ts`. **The tuple grows only
   as layouts land** — a name with no entry in the registry is a compile error, which is exactly
   what stops a setting offering a blank surface. (`registry.test.tsx` and
   `respondent-layout-default.test.ts` each use the name of the _next_ designed layout as their
   "unknown value" example, so check whether the one you are adding is that name.)
2. Add its label + description to `lib/app/questionnaire/layout/catalog.ts`.
3. Write `components/app/questionnaire/layouts/<name>-layout.tsx`. Read `slots` and `state`; fetch
   nothing.
4. Add the registry entry, including a placement for **every** slot. The compiler will tell you
   what you missed.
5. Add a thumbnail to `components/admin/questionnaires/respondent-layout-picker.tsx`.
6. `npm test tests/unit/components/app/questionnaire/layouts tests/unit/lib/app/questionnaire/layout`
   — the declaration/JSX agreement test and the catalog-coverage test both pick your layout up
   automatically.

No schema change is needed: the column already exists and stores a plain string.

## Adding a feature

Add its slot key to `RESPONDENT_SLOTS`, build the node in the container, and the build breaks until
every layout has placed it. That break is the feature working, not a chore: it is the moment each
layout's author decides where the new thing goes, instead of discovering months later that one
layout never showed it.

## The layouts

### ConQuest Classic — the default

The conversation with the live answer panel beside it from `lg` up, the panel's bottom-sheet twin
below that. What every questionnaire has always looked like, extracted unchanged.

### Focus

One column at every width, with a deliberately tighter reading measure (`--cq-chat-measure: 38rem`,
a custom property `globals.css` already declares with a fallback and sets nowhere else). Suits a
phone, an embed, or a conversation the respondent should sit with rather than scan.

It exists as the second layout because of what it demonstrates: a layout may **relocate** a part
rather than drop it. `answersPanel` is `omitted` here, but the captured answers stay one tap away in
the review sheet at every width — which is exactly why the review trigger loses Classic's
`lg:hidden`, and why `answersPanel` is not in `ESSENTIAL_SLOTS` while the answers themselves
effectively are.

Distinct from `answerSlotPanelScope: 'hidden'`, a different decision at a different level: that
removes the answers surface altogether. The two compose — a Focus questionnaire with the scope
hidden simply has no review affordance, exactly as under Classic.

### Broadsheet

The conversation as a **document**, with the answer box held still in the **margin** beside it
rather than welded to the foot of the transcript. A fixed rail from `lg` up that does not move while
the document scrolls; below `lg` the rail folds underneath, and the composer stays a card of its own
rather than rejoining the transcript, so the layout reads the same way at every width.

It exists for questions long enough to _read_ — a policy consultation, a due-diligence pack —
where the respondent scrolls back to check what was asked three questions ago and, under Classic,
finds the box they were typing in has scrolled away with them. The measure goes the other way from
Focus for the same reason: `--cq-chat-measure: 52rem`, a document line rather than a chat line, from
the same one custom property.

Two placements are Broadsheet-specific and worth stating:

- **`completionOffer` is in the margin**, above the composer, rather than above the conversation.
  Answering and finishing are the two things the respondent _does_; the document is the thing they
  read.
- **`answersPanel` is `omitted`** — same outcome as Focus, different reason: there is exactly one
  margin and the composer is in it. Review stays one tap away in the sheet at every width, which is
  why the review trigger loses Classic's `lg:hidden` here too.

This is the layout the slot split was made for, and it could not have been written before it: not
without reaching inside `QuestionnaireChat` and re-deriving the reveal-queue gate — the second
derivation the whole contract exists to prevent.

## Known granularity limits

**The transcript is still one slot.** It covers the turns, reasoning traces, notices, question card
and correction strip together. A one-question-at-a-time layout (Horizon) needs the current turn
apart from the history behind it, so that split lands with Horizon — the same way `transcript` /
`composer` landed with Broadsheet rather than ahead of it. When it does, the `satisfies` gate forces
every existing layout to re-classify, which is the mechanism working rather than a migration to
dread.

**The lifecycle strip cannot yet be decomposed.** `lifecycleBar` is deliberately not essential so a
layout can omit it and place the atoms instead — but pause / resume and the lifecycle action errors
live only inside the composed strip and have no slot of their own. A layout that dropped the bar
today would drop them silently, so every layout so far renders it, Broadsheet included, and says so
in its placement map. The atoms land with the first layout that genuinely cannot use the strip.

**`brandBand` is declared but drawn elsewhere** — by the page's `BrandThemeProvider`, above the
workspace. Extracting it so a layout can substitute its own masthead belongs with the first layout
that needs a different one.

## Related

- `.context/app/questionnaire/respondent-layout.md` — the shared width/geometry constants
  (`RESPONDENT_SHELL`, `RESPONDENT_SPLIT`) and how the host pages use them
- `.context/app/questionnaire/demo-clients.md` — the brand tokens a layout paints with
- `.context/ui/surface-theming.md` — the `data-surface` seam the respondent canvas sits on
