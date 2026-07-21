# Respondent chat text size

A respondent-owned reading preference: a two-button stepper on the session lifecycle
strip that scales the conversation text, remembered across visits and across
questionnaires.

**Not a config knob.** Deliberately absent from `AppQuestionnaireConfig` — an admin
cannot know a given respondent's eyesight, screen or viewing distance, so this is the
respondent's call, on every questionnaire they take. That is the same reasoning behind
the storage key being global rather than session- or version-scoped (below), and it is
why there is no admin toggle to disable it: an accessibility affordance that an author
can switch off is not an accessibility affordance.

## Where it's wired

| Concern             | Location                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Step ladder (pure)  | `lib/app/questionnaire/chat/text-scale.ts`                                                           |
| Control             | `components/app/questionnaire/chat/chat-text-size.tsx`                                               |
| State + persistence | `components/app/questionnaire/session-workspace.tsx` (`useLocalStorage`, sets `--cq-chat-scale`)     |
| Rendering           | `app/globals.css` → `.cq-chat-scale` utility                                                         |
| Transcript wrapper  | `components/app/questionnaire/chat/questionnaire-chat.tsx` (the `cq-chat-scale` div)                 |
| Ladder tests        | `tests/unit/lib/app/questionnaire/chat/text-scale.test.ts`                                           |
| Control tests       | `tests/unit/components/app/questionnaire/chat/chat-text-size.test.tsx`                               |
| Wiring tests        | `tests/unit/components/app/questionnaire/session-workspace.test.tsx` (the `chat text size` describe) |

## The ladder

`CHAT_TEXT_SCALES = [0.9, 1, 1.15, 1.3]`, labelled Small / Default / Large / Largest.
The stored value is the **index**, not the multiplier, so the ladder can be retuned
without rewriting what respondents already have.

`1` is the default and reproduces the historical `text-sm`, so a session where nobody
touches the control renders exactly as it did before this feature.

Two invariants, both tested:

- **`stepScaleIndex` clamps, it does not wrap.** Pressing "larger" at the top must hold.
  Wrapping to the smallest size at the moment someone is straining to read reads as a
  bug, not a cycle.
- **`normalizeScaleIndex` treats storage as untrusted.** It absorbs a stale index from an
  older ladder, a string, `null`, `NaN` or another tab's write and falls back to Default.
  A `NaN` reaching the `calc()` would drop the transcript's `font-size` declaration
  entirely, blanking the size for the whole conversation.

Because normalisation _resets_ out-of-range values rather than clamping them, callers
must step via `stepScaleIndex` and never compute `index ± 1` themselves — off the end,
"unrecognised" becomes Default, which shrinks the text on a press of "larger". The
control emits a `'up' | 'down'` direction rather than an index for exactly this reason.

## How the size is applied

One inherited CSS custom property, not a class swap per element:

```
SessionWorkspace root   style={{ '--cq-chat-scale': 1.15 }}
  └─ transcript wrapper .cq-chat-scale  →  font-size: calc(0.875rem * var(--cq-chat-scale, 1))
       ├─ UserBubble          (no font-size class — inherits)
       ├─ typewriter <p>      (no font-size class — inherits)
       └─ .prose .prose-sm    (font-size: inherit, see below)
```

The var is set on the `SessionWorkspace` root because that is the common ancestor of the
strip control and the chat. Only the transcript opts in, so the strip's own `text-xs`
chrome stays fixed — the control never resizes itself out from under the pointer.

**Why the bubbles carry no size class.** They inherit. Adding `text-sm` back to
`UserBubble` or to the mid-typewriter `<p>` silently pins them and the preference stops
working for that element. The typewriter `<p>` in particular must match the settled
Markdown it becomes, or the reply jumps size the instant typing finishes.

**Why `.prose` needs an explicit rule.** Tailwind Typography's `prose-sm` pins its own
root `font-size`, which would override the inherited value. `.cq-chat-scale :is(.prose)
{ font-size: inherit }` re-inherits it; the plugin sizes children in `em`, so headings,
lists and code scale proportionally from that one value. The descendant selector (0,2,0)
deliberately out-specifies `.prose-sm` (0,1,0) so it holds regardless of layer order.

## Persistence

`useLocalStorage(CHAT_TEXT_SCALE_STORAGE_KEY, DEFAULT_CHAT_TEXT_SCALE_INDEX)` — key
`cq-chat-text-scale.v1`.

- **Global, not per session.** Someone who needs larger text needs it in the next leg of
  an Experience too, and on the next questionnaire. They should set it once.
- **Versioned key.** `.v1` lets a future change to the ladder ignore stale indices rather
  than mapping a stale number onto the wrong size.
- **Hydrates after mount.** `useLocalStorage` is SSR-safe and starts from the initial
  value, so first paint is Default and settles to the stored size. That is a `font-size`
  change only — no layout shift beyond reflow — which is why the preference is applied as
  a custom property rather than by swapping classes or rendering a different tree.

## Accessibility

The two glyphs (a small "A" and a large "A") are `aria-hidden`; the buttons are named by
`aria-label` (Decrease/Increase text size) and grouped under `role="group"
aria-label="Text size"`.

A `role="status" aria-live="polite"` node announces the resulting size ("Text size:
Large"). This is load-bearing rather than decorative: pressing a button that then
disables itself moves focus nowhere and produces no other cue a non-sighted user can
perceive.

At the ends of the ladder the buttons carry `aria-disabled`, **not** the native `disabled`
attribute, and their handlers are guarded so the press is a no-op. A native `disabled`
button leaves the tab order the instant it is pressed, dropping focus to `<body>`; a
keyboard user stepping to the smallest or largest size would lose their place mid-
adjustment and have to tab in again from the top of the strip. `aria-disabled` announces
the same state while keeping focus put. `stepScaleIndex` remains the model-level backstop.

## Scope

The stepper rides the **chat surface only** (`activeView === 'chat'`). On the form, intro
and persona pages there is no transcript for it to act on, and a visible control that
appears to do nothing is worse than an absent one. The form surface has its own type
sizing and is not affected.
