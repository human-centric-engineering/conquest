# Respondent chat text size

A respondent-owned reading preference: a two-button stepper on the session lifecycle
strip that scales the conversation text, remembered across visits and across
questionnaires.

**The respondent's setting; the questionnaire's starting point.** An admin cannot know a
given respondent's eyesight, screen or viewing distance, so the size itself is the
respondent's call on every questionnaire they take. That is the reasoning behind the
storage key being global rather than session- or version-scoped (below), and it is why
there is no admin toggle to disable the stepper: an accessibility affordance that an
author can switch off is not an accessibility affordance.

What a questionnaire _does_ own is where the ladder **opens**: `config.chatTextSize`
names the rung a respondent who has never touched the stepper starts on. A demo shown on
a boardroom screen opens at Largest; a dense instrument read on a laptop opens at Small.

The two coexist because of one ordering, and only that ordering — the authored rung is
passed as `useLocalStorage`'s `initial`, which storage supersedes the moment anything is
stored. So:

- nobody has stepped → the questionnaire's rung;
- anybody has ever stepped, on this questionnaire or any other → their own rung, and the
  authored value is never consulted for them again.

An author therefore cannot pin, cap, or reset a respondent's accessibility preference —
they can only choose what a first-time reader sees. Inverting that (authored value wins
per session) was rejected: a respondent who had set larger text would have it silently
taken away by every new questionnaire, which is worse than having no setting at all.

## Where it's wired

| Concern             | Location                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Step ladder (pure)  | `lib/app/questionnaire/chat/text-scale.ts`                                                            |
| Named rungs         | `lib/app/questionnaire/chat/text-scale.ts` (`CHAT_TEXT_SIZES`, `indexForTextSize`)                    |
| Authored rung (DB)  | `AppQuestionnaireConfig.chatTextSize` (`prisma/schema/app-questionnaire.prisma`)                      |
| Admin control       | `components/admin/questionnaires/config-editor.tsx` → Settings tab, _Respondent experience_           |
| Version resolvers   | `chat/anonymity.ts` (`resolveChatTextScaleIndexForVersion`) · `session/resolve-respondent-surface.ts` |
| Control             | `components/app/questionnaire/chat/chat-text-size.tsx`                                                |
| State + persistence | `components/app/questionnaire/session-workspace.tsx` (`useLocalStorage`, sets `--cq-chat-scale`)      |
| Rendering           | `app/globals.css` → `.cq-chat-scale` utility                                                          |
| Viewport factor     | `app/globals.css` → `.cq-respondent-shell` media queries (`--cq-chat-viewport-scale`)                 |
| Transcript wrapper  | `components/app/questionnaire/chat/questionnaire-chat.tsx` (the `cq-chat-scale` div)                  |
| Ladder tests        | `tests/unit/lib/app/questionnaire/chat/text-scale.test.ts`                                            |
| Control tests       | `tests/unit/components/app/questionnaire/chat/chat-text-size.test.tsx`                                |
| Wiring tests        | `tests/unit/components/app/questionnaire/session-workspace.test.tsx` (the `chat text size` describe)  |

## The ladder

`CHAT_TEXT_SCALES = [0.9, 1, 1.15, 1.3]`, labelled Small / Standard / Large / Largest.
The stored value is the **index**, not the multiplier, so the ladder can be retuned
without rewriting what respondents already have.

`1` is the default and reproduces the historical `text-sm`, so a session where nobody
touches the control renders exactly as it did before this feature.

**Two representations, one ladder.** `CHAT_TEXT_SIZES = ['small', 'standard', 'large',
'largest']` is index-aligned with the multipliers, and `indexForTextSize` /
`textSizeForIndex` convert between them. localStorage keeps the **index** (cheap, and the
`.v1` key lets a retune discard stale ones); `config.chatTextSize` keeps the **name**,
because an authored value has no versioned key to fall back on — a stored `2` would
quietly mean a different size after a retune, where a stored `large` still means the large
one. The alignment is what makes both true at once, so the ladder tests assert it rather
than assume it.

`indexForTextSize` is forgiving in the same way `resolveFontPairing` is: the column is
plain TEXT, so a rollback, a seed, or a newer deploy's rung name can all reach it, and
anything unrecognised opens at Standard. It must never return `-1` — that would arrive at
the `calc()` as a `NaN` and drop the transcript's `font-size` declaration entirely.

Two invariants, both tested:

- **`stepScaleIndex` clamps, it does not wrap.** Pressing "larger" at the top must hold.
  Wrapping to the smallest size at the moment someone is straining to read reads as a
  bug, not a cycle.
- **`normalizeScaleIndex` treats storage as untrusted.** It absorbs a stale index from an
  older ladder, a string, `null`, `NaN` or another tab's write and falls back to Standard.
  A `NaN` reaching the `calc()` would drop the transcript's `font-size` declaration
  entirely, blanking the size for the whole conversation.

Because normalisation _resets_ out-of-range values rather than clamping them, callers
must step via `stepScaleIndex` and never compute `index ± 1` themselves — off the end,
"unrecognised" becomes Standard, which shrinks the text on a press of "larger". The
control emits a `'up' | 'down'` direction rather than an index for exactly this reason.

## How the size is applied

One inherited CSS custom property, not a class swap per element:

```
respondent shell        .cq-respondent-shell  →  --cq-chat-viewport-scale: 1 | 1.08 | 1.16 | 1.22
  └─ SessionWorkspace root   style={{ '--cq-chat-scale': 1.15 }}
       └─ transcript wrapper .cq-chat-scale
              font-size: calc(0.875rem * var(--cq-chat-scale) * var(--cq-chat-viewport-scale))
            ├─ UserBubble          (no font-size class — inherits)
            ├─ typewriter <p>      (no font-size class — inherits)
            └─ .prose .prose-sm    (font-size: inherit, see below)
```

**Two factors, deliberately multiplied rather than merged.** `--cq-chat-scale` is what
the respondent asked for; `--cq-chat-viewport-scale` is what the display calls for (see
[`respondent-layout.md`](./respondent-layout.md)). Multiplying them means someone who
bumped the size up on a laptop keeps that same _relative_ bump when they open the same
journey on a 27" monitor — neither setting silently overrides the other. Below 1536px
the viewport factor is `1`, so on every laptop and tablet this formula is byte-identical
to the original single-factor one.

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

`useLocalStorage(CHAT_TEXT_SCALE_STORAGE_KEY, normalizeScaleIndex(chatTextScaleIndex))` —
key `cq-chat-text-scale.v1`, initial value the questionnaire's authored rung (see above).

The `initial` is normalised on the way in because the prop crosses a wire on the meeting
surface (`RespondentSurfaceConfig.chatTextScaleIndex`, over the boot payload), and an
out-of-range index there would otherwise be the one path into the `calc()` that
normalisation does not already cover.

- **Global, not per session.** Someone who needs larger text needs it in the next leg of
  an Experience too, and on the next questionnaire. They should set it once — and, as
  above, this is exactly why the authored rung cannot override it on the next arrival.
- **Versioned key.** `.v1` lets a future change to the ladder ignore stale indices rather
  than mapping a stale number onto the wrong size.
- **Hydrates after mount.** `useLocalStorage` is SSR-safe and starts from the initial
  value, so first paint is the questionnaire's authored rung and settles to the stored size. That is a `font-size`
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
