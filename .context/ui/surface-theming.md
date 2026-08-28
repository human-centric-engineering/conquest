# Per-Surface Theming (`data-surface`)

## Overview

A fork that wants its **own brand palette and typography** on its consumer-facing
pages — while keeping `/admin` (or any other area) on the Sunrise defaults —
should never edit `app/globals.css` or the per-route-group layouts in place. That
is the fork-and-edit trap: every page touched becomes a merge conflict on every
upstream sync.

The **per-surface theming seam** solves this with a single `data-surface`
attribute on `<html>`, classified per-request, that scopes which set of
CSS-variable overrides applies. A fork ships its theme in one fork-owned file
(`app/brand-theme.css`) and never edits a platform layout or page.

This composes with the other brand seams — `BRAND.name` (the app name), and the
`<BrandMark>` / public-nav / email seams (mark, nav, email content). Those handle
_content_; this handles the _visual theme_. Together they let a fork rebrand
end-to-end without touching a platform file.

> Vanilla Sunrise ships `app/brand-theme.css` **empty**, so every surface inherits
> the `app/globals.css` defaults and the app is visually unchanged. The seam is
> inert until a fork fills that file.

## The mechanism

Four moving parts, all shipped by Sunrise:

| Part                                    | File                          | Role                                                                          |
| --------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `classifySurface(pathname)` policy seam | `lib/app/surface.ts`          | Pure string predicate → `'admin' \| 'consumer'`. **Fork-owned** policy.       |
| Server classification                   | `proxy.ts`                    | Sets the `x-surface` request header from `classifySurface(pathname)`.         |
| First-paint attribute                   | `app/layout.tsx`              | Reads `x-surface`, renders `<html data-surface={surface}>`.                   |
| Client re-sync                          | `components/surface-sync.tsx` | `<SurfaceSync>` keeps the attribute correct across App Router navigation.     |
| Fork theme                              | `app/brand-theme.css`         | **Fork-owned.** Per-surface CSS-variable overrides. Empty in vanilla Sunrise. |

Flow: the proxy classifies each request and forwards `x-surface`; the root layout
puts it on `<html data-surface>` for a correct first paint (and for portals — see
constraint 1); `<SurfaceSync>` re-derives it from `usePathname()` on client-side
navigation. A fork's `brand-theme.css` scopes token overrides per surface, e.g.:

```css
[data-surface='consumer'] {
  --color-primary: #0a1a3a;
  --color-background: #fbf6ec;
  --color-foreground: #16213d;
}
```

A shadcn `<Button>` under a consumer route then resolves `bg-primary` to the
fork's colour; the same component under `/admin` resolves it to the Sunrise
default. No component changes — pure CSS-variable inheritance.

## What Sunrise ships vs. what the fork owns

- **Sunrise ships** the mechanism (proxy plumbing, the `<html data-surface>`
  wiring, `<SurfaceSync>`) and **empty scaffolds**: the `classifySurface` policy
  with a sensible default (admin vs. consumer) and an empty `brand-theme.css`.
- **The fork owns** `app/brand-theme.css` (the palette/typography per surface),
  the `classifySurface` policy (its admin-vs-consumer split, or more surfaces),
  and any subtree pins.

## The six design constraints

These are not preferences — each one was hit and resolved building this against a
real, portal-heavy app with admin + consumer + a nested white-label surface.

### 1. The marker MUST live on `<html>`, not on route-group wrappers

Radix portals (dialogs, dropdowns, popovers, toasts) and the cookie-consent modal
mount at `document.body`, **outside** any route-group subtree. A marker on a
`(group)/layout.tsx` wrapper leaves every overlay on the default theme (a branded
page with a default-blue dialog). On `<html>` they inherit it for free. This is
why the marker is derived in the proxy (which already runs per-request) and set on
the root element, not rendered in a group layout.

### 2. The server header alone is not enough — you need a client re-sync

The root `<html>` is the one layout that does **not** re-render on App Router
client-side navigation. So the proxy-set attribute is correct on hard load but
goes **stale on client nav**: navigating from a consumer page to `/admin` would
keep the consumer theme until a refresh. `<SurfaceSync>` (a tiny `'use client'`
component) re-derives the surface from `usePathname()` and rewrites the attribute
on every navigation. **Both are required**: server header = correct first paint +
portals; client sync = correct across navigation.

> **Flash note.** `<SurfaceSync>` writes the attribute in `useEffect` (after
> paint), so a client-side nav between two **differently-themed** surfaces can
> show one frame of the old theme. In vanilla Sunrise there is no theme delta, so
> no visible flash. A fork that fills `brand-theme.css` and wants the flash gone
> can swap to a guarded layout-effect:
>
> ```tsx
> const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
> useIsomorphicLayoutEffect(() => {
>   document.documentElement.dataset.surface = classifySurface(pathname);
> }, [pathname]);
> ```
>
> The guard avoids React's "useLayoutEffect does nothing on the server" SSR
> warning.

### 3. A subtree needs a "pin" escape hatch, independent of the URL

A purely URL-derived surface is too coarse. Two real cases: (a) the _same_
component renders under more than one URL and must look identical in each; (b) a
nested region wants a _different_ surface — e.g. a neutral white-label canvas
where a tenant's own brand is the only identity, surrounded by the fork's chrome.
The fix: let a wrapper set its own `data-surface` on a descendant element,
overriding the inherited one for its subtree:

```tsx
<div data-surface="canvas">{children}</div>
```

Treat "URL classification" and "explicit subtree pin" as first-class — don't
assume the URL is always the source of truth.

### 3b. A per-tenant VALUE needs a data attribute beside it, not just a variable

The pin above gives a subtree its own palette. What it does not give you is a way for the
stylesheet to react to a value that arrives at RUNTIME, per tenant, as an inline custom
property — and CSS cannot branch on whether a variable was set.

ConQuest hit this the moment a demo client could choose its own page ground. The respondent
surface reads `--color-background: var(--app-canvas-color)`, so a client canvas lands
correctly; but the rest of the neutral palette is literal (`--color-card: #ffffff`), so a
midnight canvas produced light ink with white cards on top of it. There is no `@if var()` to
re-derive the rest with.

The fix is a second marker carrying the SHAPE of the value rather than the value itself —
`data-canvas='custom'`, set by the same component that spreads the variables — and a rule
keyed on it that re-derives the remaining tokens with `color-mix`:

```css
[data-surface='respondent'][data-canvas='custom'] {
  --color-card: color-mix(in srgb, var(--app-on-canvas) 4%, var(--app-canvas-color));
  --color-border: color-mix(in srgb, var(--app-on-canvas) 14%, transparent);
  /* …popover, secondary, accent, muted, input, ring */
}
```

Mixing rather than listing a second palette is what lets one rule serve both a bone-white
paper stock and a near-black field: each step moves toward the ink, so its direction follows
the ground automatically. `data-brand='conquest'` (the "no tenant identity at all" marker) is
the same pattern one step earlier, and both attributes must be carried to portalled roots
alongside the style, or an overlay lands wearing the wrong palette (see constraint 5's
sibling problem in `respondent-surface-context.tsx`).

### 4. Dark-mode selectors are DOM-position-dependent

`.dark` is toggled on `<html>` (the same element that carries `data-surface`). So:

- **`<html>`-level surface** → dark scope is the **compound** selector
  `[data-surface='consumer'].dark` (both classes on the same element).
- **Pinned (descendant) surface** → dark scope is the **descendant** selector
  `.dark [data-surface='canvas']` (the pin sits below `<html>.dark`).

Use the wrong form and that surface renders light-on-light in dark mode. A pinned
surface must also **re-declare every token** the parent surface set on `<html>`,
because those inherit down into the subtree and must be reset to the pin's values.

### 5. A nested surface can't re-theme its ancestors — `:has()` covers the backdrop

Re-declaring tokens on a pinned subtree only affects that subtree. An ancestor
element (e.g. the `<main>` that frames the content) still inherits the _parent_
surface's `--color-background`, so the backdrop shows the wrong colour around the
re-themed content. Paint the ancestor based on what it contains:

```css
main:has([data-surface='canvas']) {
  background-color: #ffffff;
}
```

**`:has()` selects an ancestor; it cannot READ one's descendants.** A custom property set on the
pinned subtree is invisible to the rule that matched on it, so a backdrop cannot follow a colour
that arrives inline on the pin. If the ancestor has to track a per-instance value, that value must
be put on an element at or above the ancestor and the rule must read it from there.

ConQuest does exactly this for a demo client's canvas: `RespondentChrome` puts
`--app-canvas-light` / `--app-canvas-dark` on the shell (`canvasBackdropVars` — only the ground,
never the rest of the brand, or the ConQuest header and footer would be repainted too), and the
backdrop rule reads `var(--app-canvas-light, var(--cq-respondent-canvas))`. Without it a branded
questionnaire above ~1536px — where the shell's `container` stops widening — rendered as a
coloured column flanked by neutral gutters. Invisible for as long as both were the same neutral.

### 6. Token overrides must be UNLAYERED

Tailwind 4 emits its `@theme` tokens at `:root` **inside a layer**. The fork
file's selectors must be **unlayered** (no `@layer`) so they win by layer order
(unlayered beats layered), and a descendant pin wins by specificity over the
`<html>`-level scope. `app/brand-theme.css` is imported in `app/layout.tsx`
**after** `globals.css` to reinforce this. Forks redeclare only the tokens they
change; everything else inherits — which keeps the fork diff small and lets
upstream palette changes flow through the untouched tokens.

## Adding or changing surfaces (fork checklist)

1. Edit `lib/app/surface.ts` — widen the `Surface` type and the `classifySurface`
   predicate (or return a single surface to collapse them).
2. Add the matching scope(s) to `app/brand-theme.css`, using the correct
   dark-mode selector form (constraint 4).
3. For a nested region, pin it with `data-surface` on the wrapper (constraint 3)
   and, if its backdrop needs it, add a `:has()` rule (constraint 5).
4. `classifySurface` is the single predicate shared by the proxy and
   `<SurfaceSync>`, so both stay in agreement automatically — no second place to
   update.
