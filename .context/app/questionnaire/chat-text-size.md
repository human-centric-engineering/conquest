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

What a questionnaire _does_ own is the size it **opens at**: `config.chatTextSize`. A demo
shown on a boardroom screen opens at Largest; a dense instrument read on a laptop opens at
Small.

The two coexist under one rule: **an explicitly authored rung is adopted once per authored
value.**

- The author left it at Standard (the column default, indistinguishable from "never set")
  → nothing is imposed; the respondent's own rung carries over from whatever they last set,
  on this questionnaire or any other.
- The author named Small / Large / Largest → the respondent moves to it on arrival, _even
  if they have stepped before_, and `cq-chat-text-authored.v1` records what was adopted.
- They step away from it → their rung stands on every later visit, because the marker still
  matches the authored value.
- The author moves the setting again → the marker no longer matches, so it is adopted once
  more.

An author can therefore say how the conversation opens and correct it later, but cannot pin
or cap a size, cannot repeatedly reset one, and cannot take the stepper away.

**Why not `initial` alone.** The first cut passed the authored rung as `useLocalStorage`'s
`initial`, which storage supersedes the moment anything is stored. That read well — an
author can never touch an accessibility preference — but it made the setting inert for
anyone who had ever used the stepper, starting with the author previewing their own choice.
A setting whose author cannot see it working is not a setting. The marker key is the
narrowest thing that fixes it: the authored rung wins the arrival, the respondent wins
everything after.

## Where it's wired

| Concern             | Location                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Step ladder (pure)  | `lib/app/questionnaire/chat/text-scale.ts`                                                            |
| Named rungs         | `lib/app/questionnaire/chat/text-scale.ts` (`CHAT_TEXT_SIZES`, `indexForTextSize`)                    |
| Authored rung (DB)  | `AppQuestionnaireConfig.chatTextSize` (`prisma/schema/app-questionnaire.prisma`)                      |
| Admin control       | `components/admin/questionnaires/config-editor.tsx` → Settings tab, _Respondent experience_           |
| Version resolvers   | `chat/anonymity.ts` (`resolveChatTextScaleIndexForVersion`) · `session/resolve-respondent-surface.ts` |
| Control             | `components/app/questionnaire/chat/chat-text-size.tsx`                                                |
| State + persistence | `lib/hooks/use-session-workspace.ts` (`useLocalStorage`, the adoption effect, `--cq-chat-scale`)      |
| Rendering           | `app/globals.css` → `.cq-chat-scale` utility                                                          |
| Viewport factor     | `app/globals.css` → `.cq-respondent-shell` media queries (`--cq-chat-viewport-scale`)                 |
| Narrow-screen notch | `lib/hooks/use-session-workspace.ts` (`NARROW_CHAT_VIEWPORT_QUERY`)                                   |
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

## The automatic notch below `lg`

Below `1024px` — the width at which the answers panel appears beside the
conversation — the transcript renders **one rung larger than the respondent's own**.
A questionnaire read on a phone through a column sized for a laptop-with-a-panel
was the case the stepper was most often being used to correct, and a respondent
should not have to correct it by hand.

Three things it deliberately is not:

- **Not a change to what the respondent set.** The stored index is untouched, so the
  stepper still shows and edits their own rung, nothing follows them back to a
  laptop, and rotating a tablet moves the text and moves it back.
- **Not a multiplier.** It is a step along the same ladder the stepper walks, via
  `stepScaleIndex`, which is what makes "one notch" mean the notch they would have
  pressed. That function clamps, so **Largest stays Largest**: someone who has
  already asked for the biggest text is not handed something bigger still. A
  multiplier could not express that.
- **Not `--cq-chat-viewport-scale`'s business.** That factor answers the same
  question at the other end of the range (1536px and up). The two ranges cannot
  overlap, so a size is only ever adjusted for the display once.

`useMediaQuery` returns `false` on the server and the first client render, so the
notch lands with the same post-mount settle the stored rung already has — a
font-size change, no layout shift beyond reflow.

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

Two keys, both in `lib/hooks/use-session-workspace.ts`:

| Key                        | Holds                                                  |
| -------------------------- | ------------------------------------------------------ |
| `cq-chat-text-scale.v1`    | the respondent's current rung (the ladder **index**)   |
| `cq-chat-text-authored.v1` | the authored rung this browser has **already adopted** |

`useLocalStorage(CHAT_TEXT_SCALE_STORAGE_KEY, normalizeScaleIndex(chatTextScaleIndex))`
holds the first. The `initial` is normalised on the way in because the prop crosses a wire
on the meeting surface (`RespondentSurfaceConfig.chatTextScaleIndex`, over the boot
payload), and an out-of-range index there would otherwise be the one path into the
`calc()` that normalisation does not already cover.

The second is read and written by the adoption effect, directly rather than through
`useLocalStorage`: it must be read **once, after** the stored rung has hydrated, and a
second `useLocalStorage` would hydrate in the same pass and race it.

- **Effect ordering is load-bearing.** The adoption effect is declared _after_ the
  `useLocalStorage` call, so React queues it second and the authored rung lands last. Move
  it above and the stored rung wins — which is the bug this replaced.
- **Fires once per mount**, guarded by a ref rather than by effect deps: a re-render that
  changes the prop must not re-adopt mid-session.
- **Both storage accesses are `try`/`catch`ed.** An unreadable marker reads as "nothing
  adopted" (re-adopting is the recoverable outcome); a failed write still adopts for this
  visit, so private mode costs a repeat adoption, not a lost size.
- **Global, not per session.** Someone who needs larger text needs it in the next leg of
  an Experience too, and on the next questionnaire. They should set it once. The marker is
  global for the same reason — scoping it per version would re-impose the authored size on
  every leg of an Experience.
- **Versioned key.** `.v1` lets a future change to the ladder ignore stale indices rather
  than mapping a stale number onto the wrong size.
- **Hydrates after mount.** `useLocalStorage` is SSR-safe and starts from the initial
  value, so first paint is the questionnaire's authored rung and settles to the stored size
  (then, if it is being adopted, back to the authored one). That is a `font-size` change
  only — no layout shift beyond reflow — which is why the preference is applied as a custom
  property rather than by swapping classes or rendering a different tree.

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
