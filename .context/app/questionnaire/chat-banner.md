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

The band renders whenever there's a surface to paint, a logo, **or** a title — so a themed or
unthemed questionnaire both get a title bar. With no surface, no logo and no header it renders
nothing (unchanged).

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
    null there (title shows, schedule omitted).
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

## Keeping the admin preview faithful

`components/admin/demo-clients/demo-client-theme-preview.tsx` (`ChromePreview`) renders a
miniature of this band with an illustrative title + date pill, reading the same `--app-on-surface`
var. Update it alongside any band layout change so the admin "branding" preview stays honest.

## Tests

- `tests/unit/lib/app/questionnaire/header/schedule.test.ts` — every status/date branch.
- `tests/unit/lib/app/questionnaire/header/resolve.test.ts` — Prisma-mocked; asserts the round
  second-query only fires when `roundId` is set.
- `tests/unit/lib/app/questionnaire/theming/theme.test.ts` — `readableTextColor` + `--app-on-surface`.
- `tests/unit/components/app/questionnaire/chat/brand-theme-provider.test.tsx` — title/eyebrow/
  schedule/no-band/surface-contrast rendering.
