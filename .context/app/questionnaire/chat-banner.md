# Respondent chat banner (brand band)

The coloured header above the respondent conversation. Historically it carried only the client
logo (left-aligned on the brand surface), leaving the rest of the bar empty. It now renders a
three-zone header — **Brand · Title · Schedule** — so the questionnaire title and the round's
open/close window fill that space.

> **DEMO-ONLY surface theming.** The brand colours come from demo-client tenancy
> ([demo-clients.md](./demo-clients.md)); a fork that strips demo tenancy keeps the band but
> sources the title/round from its own models. See [forking.md](./forking.md).

## The three zones

Rendered by `BrandThemeProvider` (`components/app/questionnaire/chat/brand-theme-provider.tsx`):

| Zone         | Content                                                                                           | Degrades to           |
| ------------ | ------------------------------------------------------------------------------------------------- | --------------------- |
| **Brand**    | Logo (escaped `--app-logo-url` background, never `<img src>`), optional `--app-logo-bg` chip      | nothing (no logo)     |
| **Title**    | Questionnaire title (lead); round name as a small uppercase eyebrow above it. `flex-1`, truncates | title-only (no round) |
| **Schedule** | Status dot + label (Open / Closing soon / Opens / Closed) over the date window                    | omitted (open-ended)  |

The middle zone takes the slack and truncates, so a long title never pushes the schedule off the
bar. The schedule cluster is **hidden below `sm`** — on a phone the title keeps priority.

**Below 420px the band stacks** (mark on its own row, title block on the next) instead of
squeezing both onto one line — a fixed-width logo/wordmark next to a `flex-1` title otherwise
crushes the title to a sliver (e.g. "Workplac…") on narrow phones. `min-[420px]:flex-row` restores
the one-line two-anchor layout as soon as there's width to spare. **While stacked, everything is
centred** (`items-center` + `text-center`) rather than left-led — a lone row of centred text reads
as deliberate on a narrow phone, where a left-led block sitting under a centred mark would not; the
title block carries an explicit `w-full` so it still fills the row (and its `truncate` still has a
real width to truncate against) instead of shrinking to its own content width under the now-centred
cross-axis, handing back to `flex-1` via `min-[420px]:w-auto` once the header is a row again. The
same treatment applies to the anonymity badge in the banner-mode title strip, which centres under
the title below 420px rather than squeezing it.

The band renders whenever there's a surface to paint, a logo, a title, **or** an anonymity notice
— so a themed or unthemed questionnaire both get a title bar. With no surface, no logo, no header
and a non-anonymous version it renders nothing (unchanged).

## The anonymity notice

`anonymous?: boolean` (the version's `anonymousMode`, threaded in from each respondent page
alongside `header`) puts a shield-marked **"Responses are anonymous"** line under the title,
aligned with it — right-aligned in the two-anchor band, left-led when there's no mark, and on the
opposite end of the title row in the banner variant (which is left-led and has no slack beneath).
Below the 420px stacking breakpoint it's always centred with the title, since it no longer shares a
row with the mark to anchor against.
It used to sit on the `SessionLifecycleBar` below the band; moving it here reclaims that strip's
whole row and keeps the reassurance next to the questionnaire it applies to. The strip no longer
renders it at all, and the admin session viewer — which has no band — shows an `Anonymous` badge
in its own header row instead. See [session-lifecycle.md](./session-lifecycle.md).

## Data flow

`header?: BandHeader` is threaded into the band from each respondent page; the band is otherwise
pure presentational. `BandHeader = { title, round: BandRound | null }`.

- **`lib/app/questionnaire/header/resolve.ts`** — the DB seam (server-only):
  - `resolveSessionHeader(sessionId)` — authenticated `/questionnaires/[sessionId]`. The session
    has a `roundId`, but it's a **plain String, not a Prisma `@relation`** (UG-1 identity-firewall
    posture), so the round is fetched in a **second query**. `roundId = null` → `round: null`
    (open-ended).
  - `resolveVersionHeader(versionId)` — no-login `/q/[versionId]`. The session is booted
    client-side and doesn't exist at SSR, so only the version's title resolves; `round` is always
    null there (title shows, schedule omitted). The title is projected off the shared respondent
    surface row, not queried — see [`surface-config.md`](./surface-config.md).
- **`lib/app/questionnaire/header/schedule.ts`** — pure derivation. `buildScheduleView(round, now)`
  returns `{ status, statusLabel, dateRange } | null`. `now` is injected (the band passes the
  render-time clock; tests inject a fixed instant). Status precedence:
  1. **Closed** — `status === 'closed'`, `closedAt` set, or `now` past `closesAt`.
  2. **Upcoming** — before `opensAt` → "Opens 1 Jul".
  3. **Open** — inside the window. With a close date: "Closing soon · N days" within 3 days,
     "Open · closes in N days" within 30, else "Open".
     Returns null when the round has no dates at all (the round name still shows as the eyebrow).

## Contrast on the brand surface

The band background is the client's arbitrary `surfaceColor`, so the neutral `text-foreground`
token (near-black) would vanish on a dark brand colour. `themeToCssVariables` emits
**`--app-on-surface`** — `readableTextColor(surfaceColor)` picks white or near-black by WCAG
contrast (relative luminance). The band sets `color: var(--app-on-surface)` and uses
`currentColor` + opacity for muted/secondary text, dividers and the closed dot, so one resolved
colour drives the whole band. With no surface the band sits on the neutral respondent canvas
(`text-foreground`) with a hairline underline to separate it.

Status dots use fixed semantic hues (emerald / amber / sky) that read on both light and dark
surfaces; the closed dot is muted `currentColor`.

## Three band modes

The band has three mutually exclusive forms, decided in `BrandThemeProvider`:

| Condition                | What renders                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| `bannerUrl` set          | **Full-bleed banner** — replaces the band; title moves to a strip below |
| `hasBrandIdentity` true  | The client band above (logo / surface colour / three zones)             |
| `hasBrandIdentity` false | **ConQuest band** — the wordmark plus the ConQuest palette              |

### ConQuest default (unbranded)

An unbranded questionnaire used to render **no band at all** (`showBand` required a surface,
logo or title) on a grey canvas. It now always gets a band carrying the `<ConquestWordmark>`,
and `data-brand="conquest"` on the wrapper switches the whole surface to the ConQuest palette.

Two details that look odd until you know why:

- The wordmark is the **component**, not an image. It is CSS type (Fraunces, two-tone), so it
  stays crisp at any size and already follows `.dark` — a flat PNG would do neither.
- `themeToCssVariables` emits **no colour vars** in this mode, and `--cq-band-bg` / `-fg` /
  `-border` come from `app/brand-theme.css`. The ConQuest CTA flips navy→gold with the theme
  and an inline style cannot express that; inline would also _win_ over the stylesheet, pinning
  light mode. See [demo-clients.md](./demo-clients.md#theming-module-f34).

### Custom banner (F7.2)

`bannerUrl` replaces the band outright — no logo, no wordmark, no band colours in that strip —
because the image is the client's own composition and drawing our chrome over it would fight it.
The box is `aspect-[4/1]`, matching `BRAND_BANNER_SPEC`, so an accepted upload fills it exactly
at every width; `bg-cover` absorbs the ±12% ratio tolerance.

The title renders **below** the banner rather than overlaid. Overlaying would need a scrim and
would still depend on the legibility of an image we have never seen.

## Keeping the admin preview faithful

`components/admin/demo-clients/demo-client-theme-preview.tsx` (`ChromePreview`) renders a
miniature of this band with an illustrative title + date pill, reading the same `--app-on-surface`
var. Update it alongside any band layout change so the admin "branding" preview stays honest.

## Tests

- `tests/unit/lib/app/questionnaire/header/schedule.test.ts` — every status/date branch.
- `tests/unit/lib/app/questionnaire/header/resolve.test.ts` — Prisma-mocked; asserts the round
  second-query only fires when `roundId` is set.
- `tests/unit/lib/app/questionnaire/theming/theme.test.ts` — `readableTextColor`,
  `--app-on-surface`, `hasBrandIdentity`, and the no-colour-vars-when-unbranded rule.
- `tests/unit/lib/app/questionnaire/theming/brand-image.test.ts` — the logo/banner dimension
  specs and the `/uploads/` src predicate.
- `tests/unit/components/app/questionnaire/chat/brand-theme-provider.test.tsx` — all three band
  modes (including that a banner suppresses both the logo and the wordmark), plus title/
  eyebrow/schedule/no-band/surface-contrast rendering.
