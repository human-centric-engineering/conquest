# Respondent designs — the third axis

How the respondent surface is **drawn**: corners, rules, shadows, and how much of the client's brand
is structural rather than decorative.

|                    |                                                                       |
| ------------------ | --------------------------------------------------------------------- |
| The setting        | `app_questionnaire_config.respondentDesign`                           |
| Scope              | Per questionnaire version                                             |
| Values             | `rounded` (default) · `press` · `marque`                              |
| Where it lands     | `data-design` on the `BrandThemeProvider` wrapper                     |
| The implementation | `app/respondent-design.css` — and nothing else                        |
| Admin copy         | `RESPONDENT_DESIGN_META` in `lib/app/questionnaire/layout/catalog.ts` |

## Three axes, and they are genuinely orthogonal

The respondent surface now has three independent settings, and the reason to hold them apart is that
each answers a question the others cannot:

- **Layout** (`respondentLayout`) — _where the parts sit_. Classic, Focus, Broadsheet, Horizon.
- **Chrome** (`respondentChrome`) — _what surrounds them_. Full ConQuest, co-branded, white label.
- **Design** (`respondentDesign`) — _what they look like_. Rounded, Press, Marque.

Four × three × three is thirty-six combinations, and every one of them is valid. That is not a claim
made carefully — it is a claim made **structurally**, and it is the reason the whole feature is a
stylesheet.

## Why a design is CSS and nothing else

A design sets no props, renders no DOM, and cannot reach into a layout. It sets one attribute; the
cascade does the rest.

That constraint is the feature's safety property. The layout axis needs an entire slot contract
(`lib/app/questionnaire/layout/slots.ts`) to guarantee that no arrangement can drop a respondent
feature, because a layout genuinely could — it places nodes, so it can fail to place one. A design
has no such power. There is no mechanism in a stylesheet for hiding a control, skipping a slot, or
leaving somebody unable to answer, so thirty-six combinations need no combinatorial testing: the
axes cannot interact, because two of them are React and the third is a selector.

The cost is that the design axis is invisible to the compiler, which is the trade the tests below
exist to cover.

## The scope, and where it stops

`data-design` goes on the `BrandThemeProvider` wrapper — the same element that already carries
`data-surface`, `data-brand` and `data-canvas`. So a design covers the questionnaire and stops at
the ConQuest chrome around it, which is correct: a design belongs to the questionnaire, not to us. A
`press` questionnaire does not square off the ConQuest header above it.

It is deliberately **not** on `<html>`, where `data-surface` is set per-request by `proxy.ts`. A
surface is a property of the request; a design is a property of a **questionnaire**. Two versions
with different designs can be open in two tabs, and an admin previewing one must not repaint the
admin surface behind it.

Portalled panels — the answers drawer, the interviewer switcher, the final-check modal — land on
`document.body`, outside that wrapper, and re-apply the attribute at their own root through
`RespondentSurfaceAttrs`. Unlike `data-brand` and `data-canvas`, which are conditional, `data-design`
is **always** present there: an absent attribute matches no block and falls back to the platform's
corners, which is a different look from `rounded` rather than the same one.

## The mechanism

Tailwind v4 compiles `rounded-sm|md|lg|xl|2xl` to `border-radius: var(--radius-*)`. Resetting those
custom properties on a subtree therefore flattens every one of them at once — no component knows,
and no class list changes. That single fact is what makes the axis cheap.

Two things it does not cover, both handled explicitly in the stylesheet:

- `rounded-full` compiles to a literal (`calc(infinity * 1px)`, which ships as `3.40282e38px`), with
  no variable to intercept. The pills are named in a selector of their own.
- Values set in **inline styles** — the user bubble's fill, the turn mark's colour — cannot be
  overridden by a rule at all. Rather than reach for `!important`, those two moved to custom
  properties (`--cq-user-bubble-bg`) with their previous literal as the fallback, so a transcript
  rendered outside a design scope (the read-only admin replay) is byte-for-byte what it always was.

The stylesheet is **unlayered**, like `app/brand-theme.css`, so it beats Tailwind's `@layer
utilities` on layer order regardless of specificity. Nothing in it needs `!important`, and a test
asserts that stays true — an `!important` creeping in would mean the mechanism had quietly stopped
working and the next person would copy the workaround instead.

## The designs

### `rounded` — ConQuest Rounded (default)

Soft corners, warm rules, the conversational look every questionnaire has always had.

Its block in the stylesheet is **empty**, and a test asserts it stays empty. That is the load-bearing
promise of the whole axis: a questionnaire that never touches this setting must render exactly what
it always did, and the cheapest way to guarantee it is for the default's implementation to contain
nothing that can go wrong.

### `press` — straight lines and hairline rules

The register of a printed report. All radii to zero, pills flattened, resting shadows removed,
hairlines given a little more contrast because with the shadows gone the borders are the only thing
separating a card from its ground.

Two details carry the design:

- **The answer box keeps a 2px corner** — the single exception, and the reason this is not just
  "square". The field is the one thing on the page a respondent touches, and a touchable object
  should read as an object.
- **The respondent's answers stop being bubbles.** No fill, and a 2px accent rule down the edge they
  are set against. Right-aligned text with a right-hand rule is how a printed page marks an aside,
  and it is the one move that makes a Press transcript read as a document rather than as a chat log
  with the corners filed off.

### `marque` — the brand as structure

Straight lines too, plus the client's brand built into the page rather than sat on top of it. Three
moves, each taking something the surface was already drawing and making it carry the brand:

1. **The logo signs every question.** The 8px accent dot beside each interviewer turn becomes the
   client's logo mark. A banner is seen once and then stops being seen; a mark set against every
   question is present for the whole twenty minutes without competing with a word of the text.
2. **A spine down the conversation.** The conversation card's left hairline becomes a 3px accent
   rule, so the column reads as bound rather than floated. It _replaces_ a border that was already
   there, so no space is taken and nothing shifts — which is what lets it hold across all four
   layouts.
3. **Their colour closes the header.** A 3px accent rule under the brand band, turning a strip that
   sits above the conversation into one that opens it. The coverage bar thickens to match and reads
   as the page's own edge.

The answer box gets a full 2px accent border — the one live object on an otherwise static page.

**Without a logo mark it still works.** `--app-logo-mark-url` is set only when the client has one;
when it is absent the `background-image` is invalid at computed-value time and resolves to `none`,
leaving the element's inline background colour — the accent — showing through as a small brand
block. The degradation is a deliberate second design, not a hole. But the admin copy says plainly
that Marque is at its best for a client with a strong mark, because with none it has less to say.

## What the tests cover, and why they are unusual

Every other setting on this surface is enforced by the compiler somewhere. A design is an attribute
value and a block of CSS joined by a string, and when they stop matching **nothing throws** — the
questionnaire renders the platform's own corners and looks almost right. So two suites do the
joining that TypeScript cannot:

- `tests/unit/app/respondent-design-css.test.ts` reads the real stylesheet and the real components:
  every design has a block, every block belongs to a design, the default's block is empty, every
  class hook (`cq-turn-mark`, `cq-user-bubble`, `cq-conversation-frame`, `cq-composer`) is still
  applied by the component that draws it, no colour is hard-coded, nothing is `!important` or
  layered, and the shadow reset still excludes `:focus-visible` — Tailwind draws focus rings as
  box-shadows, and a design that deleted them would ship an accessibility regression wearing an
  aesthetic.
- `tests/unit/lib/app/questionnaire/layout/respondent-design-default.test.ts` walks every layer that
  can produce a design and checks it narrows to `rounded`, including that a **layout** name is
  rejected in the design field: the two settings sit adjacent on the tab, both take lowercase single
  words, and crossing them is the plausible caller bug.

## Adding a design

1. Add the name to `RESPONDENT_DESIGNS` in `lib/app/questionnaire/types.ts`.
2. Add its copy to `RESPONDENT_DESIGN_META` in `lib/app/questionnaire/layout/catalog.ts`.
3. Add a `[data-design='<name>']` block to `app/respondent-design.css`.
4. Add a thumbnail to `components/admin/questionnaires/respondent-design-picker.tsx`, drawn with the
   same primitives the design itself uses — corner radius, rule weight, where the accent falls —
   rather than a screenshot, so it cannot go stale against the stylesheet it describes.

Steps 1–2 and 1–4 are compile errors if skipped; step 3 is the test above. No migration is needed —
the column is a free-text `String` narrowed in the app layer, so a new name needs no DDL.

## Related

- `.context/app/questionnaire/respondent-layouts.md` — the arrangement axis and the slot contract
- `.context/app/questionnaire/respondent-chrome.md` — the chrome axis
- `.context/ui/surface-theming.md` — the `data-surface` seam this borrows its mechanism from
