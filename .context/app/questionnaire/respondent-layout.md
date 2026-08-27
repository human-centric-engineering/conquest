# Respondent surface layout on large displays

How the conversation surface uses the width it is given, and why it stops where it does.

Before this, the respondent shell was a flat `max-w-6xl` on all three host pages. On a
laptop that is the full width of the window and reads well. On a 27" display it is a
1152px ribbon with ~700px of dead space either side — the same layout as the laptop, just
lonelier. The fix is not one change but three coordinated ones, because widening any of
them alone makes the surface worse rather than better.

## Where it's wired

| Concern               | Location                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell + split         | `lib/app/questionnaire/layout/index.ts` (`RESPONDENT_SHELL`, `RESPONDENT_SPLIT`)                                                                 |
| Host pages            | `app/(respondent)/q/[versionId]`, `app/(respondent)/x/[publicRef]`, `app/(respondent)/m/[joinRef]`, `app/(protected)/questionnaires/[sessionId]` |
| Who applies the shell | `components/app/questionnaire/chrome/respondent-chrome.tsx` (the three standalone pages), the page itself (signed-in)                            |
| Split application     | `components/app/questionnaire/session-workspace.tsx` (`chatSurface`)                                                                             |
| Reading measure       | `app/globals.css` → `.cq-chat-measure`, applied in `chat/questionnaire-chat.tsx`                                                                 |
| Viewport text factor  | `app/globals.css` → `.cq-respondent-shell` media queries                                                                                         |
| The reference width   | `components/layouts/app-header.tsx`, `public-footer.tsx` (`container mx-auto px-4`)                                                              |

## The three moves

**1. The shell is the header's container.** `RESPONDENT_SHELL` is `container mx-auto` —
the exact geometry the site header and footer use — and each host page adds the matching
`px-4` (the signed-in surface inherits it from the protected layout's own `container`).
Since the chrome became a setting, `RespondentChrome` applies the shell for the three
standalone pages rather than each of them remembering to — which is how `/m` got it back
after quietly running on its own `max-w-4xl` and losing the text-scale ladder. See
[respondent-chrome.md](./respondent-chrome.md).
So the conversation's left and right edges line up with the logo and the account button
above it, and with the footer links below it, at every breakpoint.

This replaced a short-lived bespoke ladder (`76rem` xl → `90rem` 2xl → `104rem` 1920px →
`112rem` 2400px). It solved the dead space but created a worse problem: on a ~1800px
display the conversation sat about 32px inside the header content on both edges. A
misalignment like that has no explanation a respondent can construct, and this is the one
surface they stare at for twenty minutes. Matching the chrome is worth more than the last
few rem of width. **Do not reintroduce a shell-specific width** — if the surface should be
wider on big displays, widen the container (a platform seam) so header, footer and
conversation move together.

One exported class string, not three copies: a respondent moving between legs of an
Experience crosses between the signed-in surface and the no-login one, and the
conversation must not change width mid-journey.

**2. The extra width goes mostly to the answer panel.** `RESPONDENT_SPLIT` ladders the
panel track `22rem` (lg) → `26rem` (xl) → `30rem` (2xl). This is where the width is
genuinely wanted — a captured paraphrase at `22rem` wraps after a handful of words. The
conversation column takes the remainder through `minmax(0,1fr)`; the `0` (not `auto`) is
what stops a long unbroken token in a reply from forcing the track past its share. The
ladder stops at `2xl` because the container does; past there a wider panel would only be
taking width off the conversation rather than spending width the shell just gained.

**3. The conversation grows by getting BIGGER, not longer-lined.** This is the one that
is easy to get wrong. `max-w-2xl` at the base text size is already ~95 characters per
line — the top of the comfortable range — so pouring extra pixels into the transcript
would push it straight past readable. Instead `.cq-chat-measure` expresses the measure as
`42rem × --cq-chat-scale × --cq-chat-viewport-scale`, the same two factors that drive the
font size. Characters-per-line therefore stays constant while the whole conversation
scales to suit the viewing distance a large monitor implies. At both factors `= 1` this
resolves to exactly the `42rem` it replaced.

The composer carries the same `.cq-chat-measure`, so the input stays aligned with the
transcript at every text size and every viewport step rather than drifting apart.

## Why it is capped rather than fluid

The container tops out at `96rem`, so past ~1536px the surplus becomes margin and the
conversation grows typographically instead (move 3). That is deliberate on both counts:
a two-column conversation stretched to a 2560px edge puts the answer panel at the outer
edge of peripheral vision, and the respondent has to physically turn their head between
the question they are answering and the answers being captured. Treat "there is still
margin at 2560px" as intended, not as an unfinished step — and note the header has the
same margin, so the page still reads as one composition.

## Invariants worth keeping

- **The shell tracks the chrome, never its own ladder.** The alignment is the point. Any
  change to how wide the conversation is belongs in the container, where the header and
  footer pick it up too.
- **The measure is a `max-width` over `width: 100%`, never a fixed width.** It has to cap
  without forcing, because the same transcript renders inside narrower hosts — the mobile
  card and the admin session drawer — where the viewport breakpoint says "wide" but the
  container is not.
- **`.cq-respondent-shell` rides on `RESPONDENT_SHELL`, not separately.** It is the hook
  the viewport-scale media queries key off, so every host gets the text scale by
  construction rather than by remembering to add a class.
- **The intro splash caps its own blocks at `2xl`, it does not cap its sections.** The
  right-hand "what to expect" panel is tinted and its divider spans the track, so the cap
  is applied to the children (`2xl:*:max-w-[34rem]`) and the surplus becomes margin.

## Related

- [`chat-text-size.md`](./chat-text-size.md) — the respondent-owned half of the scale.
- [`answer-slot-panel.md`](./answer-slot-panel.md) — what the widened panel track holds.
