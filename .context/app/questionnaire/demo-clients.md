# Demo clients (F2.5.1 · branding F3.4)

> **DEMO-ONLY.** Demo-client tenancy is an attribution + branding partition for the
> sales demo — **not** a security boundary and **not** real multi-tenancy. A real
> client engagement strips it. See [forking.md] § "Replacing demo tenancy" (P9) and
> the [development plan][plan] P2.5 section.
>
> **Spinning one up?** The end-to-end operational walkthrough — seed fast path,
> branding, content, launch, invite, first session, reset — is in
> [runbook.md](./runbook.md).

## What it is (and isn't)

A **demo client** lets a questionnaire be attributed to a prospect, so the sales
surface is theirs ("this is the Acme Bank demo"). F2.5.1 ships the **foundation**:
the identity table, the `AppQuestionnaire` foreign key, the admin CRUD, and the
attribution control on a questionnaire. Attribution can be set **at upload time**
(the `demoClientId` field on the ingest form), **at definition-import time** (the
demo-client picker on the "Import definition" dialog — sent as a `?demoClientId=`
query param since the body is the definition file itself), changed later via the
settings-tab picker, or set in reverse from the demo client's **Overview** tab (the
`<AttributeQuestionnairePicker>` — pick a generic questionnaire and brand it as that
client); either way it surfaces as an owner column on the questionnaires list.

| It **is**                                           | It is **not**                                        |
| --------------------------------------------------- | ---------------------------------------------------- |
| An application-layer attribution/branding partition | A security or data-isolation boundary                |
| Adequate because demo clients aren't adversarial    | Row-level security / per-tenant DB / the `Org` model |
| The thing later phases hang branding + scoping off  | Real multi-tenancy (that's Sunrise's RLS seam)       |

A fork that becomes a multi-customer product activates Sunrise's RLS tenancy seam
(`TENANCY_MODE=multi`, `Org`/`orgId` retrofit at `lib/db/client.ts`) — it does
**not** harden this table into an isolation mechanism. That trap is exactly what
Sunrise's [multi-tenancy doc][mt] warns against.

## Data model

`AppDemoClient` (`app_demo_client`) — identity (F2.5.1) + theme (F3.4):

| Field                   | Type     | Notes                                                                                             |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `id`                    | cuid     |                                                                                                   |
| `slug`                  | String   | `@unique`, kebab-case ("acme-bank"); admin URLs                                                   |
| `name`                  | String   | display name ("Acme Bank Demo")                                                                   |
| `description`           | String?  | internal admin note                                                                               |
| `isActive`              | Boolean  | soft-disable; excluded from the attribution picker                                                |
| `ctaColor`              | String?  | **F3.4** hex CTA / button colour; null → ConQuest default                                         |
| `accentColor`           | String?  | **F3.4** hex accent; email fallback-link colour + F7.1 CSS var; null → default                    |
| `logoUrl`               | String?  | **F3.4** logo (https URL **or** `/uploads/...`) for the email + session band; null → none         |
| `bannerUrl`             | String?  | **F7.2** full-bleed session header banner (https or `/uploads/...`); null → none                  |
| `welcomeCopy`           | String?  | **F3.4** branded invitation intro line; null → default copy                                       |
| `surfaceColor`          | String?  | **F7.1+** hex brand "chrome" colour — session header band + default logo backdrop; null → no band |
| `ctaColorEnd`           | String?  | **F7.1+** hex CTA gradient end; set → CTA renders `ctaColor → ctaColorEnd`; null → solid CTA      |
| `logoBackgroundColor`   | String?  | **F7.1+** hex colour painted behind the logo (when enabled); null → falls back to `surfaceColor`  |
| `logoBackgroundEnabled` | Boolean  | **F7.1+** "apply this colour as the logo background" toggle; default `false`                      |
| `canvasColor`           | String?  | **kit** hex page ground in LIGHT mode — Broadsheet's paper stock, Horizon's field                 |
| `inkColor`              | String?  | **kit** hex text on that ground; null → derived for contrast from `canvasColor`                   |
| `canvasColorDark`       | String?  | **kit** the ground in DARK mode; null → derived from `canvasColor`                                |
| `inkColorDark`          | String?  | **kit** text on the dark ground; null → derived for contrast from it                              |
| `accentColorEnd`        | String?  | **kit** hex second accent (surfaces, not the CTA); null → the accent alone                        |
| `logoMarkUrl`           | String?  | **kit** square mark (https or `/uploads/...`); null → none                                        |
| `logoDarkUrl`           | String?  | **kit** light-on-dark lockup; null → the standard lockup everywhere                               |
| `fontPairing`           | String?  | **kit** one of the six pairings in `theming/fonts.ts`; null → `neutral` (the system stack)        |
| timestamps              | DateTime |                                                                                                   |

`AppQuestionnaire.demoClientId String?` — nullable FK, `onDelete: SetNull`, indexed.
`null` = a "Generic Sunrise demo" (defaults end-to-end). Pre-F2.5.1 questionnaires
keep working; **no backfill**.

**Theme columns are all nullable** (`logoBackgroundEnabled` defaults `false`) — null/off
on any field means "use the ConQuest default" (`resolveTheme()` fills it).

**Setting any ONE visual column flips the whole surface to white-label.** That is what
`ResolvedTheme.hasBrandIdentity` records (see below): a client that sets so much as a CTA
colour owns the respondent area outright, and a client that sets nothing gets ConQuest
branding rather than an anonymous grey page. `welcomeCopy` is excluded from the test — it
is copy, not identity. The **F7.1+ chrome set** (`surfaceColor`, `ctaColorEnd`,
`logoBackgroundColor`, `logoBackgroundEnabled`) makes a brand _suggestive_ — a deep header
band, a gradient CTA, a backdrop for logos drawn to sit on one — without trying to clone the
client's site. They are optional on the raw `DemoClientTheme` contract (absent === null), so
older DB selects / forks / tests that pass only the F3.4 four still resolve cleanly.
The **brand kit** (`canvasColor` / `inkColor` and their `…Dark` counterparts, `accentColorEnd`,
`logoMarkUrl`, `logoDarkUrl`, `fontPairing`) is the other half of the same idea, one axis further in. The
F7.1+ chrome set brands what SURROUNDS the conversation; the kit brands the conversation
itself — the ground it is drawn on and the type it is set in. That distinction is what the
respondent layouts need: a white-labelled Broadsheet with no paper stock, or a Horizon with
no field colour, is Classic in a different shape. Like every column above they are nullable
and optional on the raw contract, and every null resolves to today's look.

`fontPairing` is the one visual column that does **not** flip the white-label switch. It is
a design choice rather than an identity, like `welcomeCopy`: a client who picks the editorial
serif and nothing else has given us no brand to protect, so the questionnaire keeps ConQuest
colours and the wordmark — set in that serif.

`reset-sessions` (F6.4) is now built ([demo-session-reset.md](./demo-session-reset.md));
clone-for-client (P3+) is the remaining distributed P2.5 work. See the
[development plan][plan] P2.5 distributed-work table.

### Theming module (F3.4)

`lib/app/questionnaire/theming/` (Prisma-free, `DEMO-ONLY`) turns the nullable theme
columns into a usable brand:

- `resolveTheme(client | null)` → a `ResolvedTheme` with every gap filled by
  `CONQUEST_THEME_DEFAULTS` (`logoUrl` stays nullable — there is no default logo _image_;
  the renderer substitutes the ConQuest wordmark instead). `null` (generic demo) resolves
  to the all-defaults theme.
- `hasBrandIdentity` — true when the client set any of `ctaColor`, `accentColor`,
  `logoUrl`, `bannerUrl`, `surfaceColor`, `ctaColorEnd`, a resolved logo backdrop, or any of
  `canvasColor` / `inkColor` / `canvasColorDark` / `inkColorDark` / `accentColorEnd` /
  `logoMarkUrl` / `logoDarkUrl`. It reads the
  RAW columns, never the resolved ones, so the defaults it applies can't make an unbranded
  client look branded. `welcomeCopy` and `fontPairing` are both excluded — copy and type are
  not identity.
- `themeToCssVariables(theme)` → when `hasBrandIdentity`, `--app-cta-color` /
  `--app-accent-color` / `--app-cta-gradient` (a `linear-gradient(...)` when `ctaColorEnd`
  is set, else the solid CTA colour), plus `--app-surface-color`, `--app-logo-bg`,
  `--app-logo-url`, `--app-banner-url` when those are set.

  **When `hasBrandIdentity` is false it emits NO colour variables at all.** That is
  deliberate, not an omission: an inline style beats the stylesheet, so writing the flat
  ConQuest hexes here would pin light mode and break the dark-mode flip. Instead the
  mode-aware `[data-surface='respondent'][data-brand='conquest']` block in
  `app/brand-theme.css` supplies them (navy on cream → gold on navy), matching the
  consumer palette. The **F7.1** user UI spreads these onto a container; the invitation
  email reads the resolved values inline instead.

- `--app-on-cta` — the CTA's own foreground, emitted as `readableTextColor(ctaColor)` for a
  branded client and supplied by the mode-aware `[data-brand='conquest']` block otherwise.
  It exists because the respondent CTAs paint their background from `--app-cta-gradient`
  directly and never consult the platform's `primary` / `primary-foreground` pair — so
  re-tokenising `primary` looks like a fix but nothing reads it. Without this the ConQuest
  dark-mode CTA (gold) carried hardcoded white text at ~1.7:1.
- `cssUrl(url)` — the single sink wrapping a brand image as a quoted, escaped `url("…")`
  so a stored value cannot break out of the `url()` context. Used by
  `themeToCssVariables` and by the admin preview thumbnail.
- `resolveTheme` also resolves the **logo backdrop** once: `logoBackgroundColor` is null
  whenever `logoBackgroundEnabled` is off, otherwise the explicit colour falling back to
  `surfaceColor` — so renderers paint it directly without re-deriving the toggle.
- `themeFields` (Zod) validate hex colours + brand image sources (+ the boolean toggle);
  they spread into the demo-client create/update schemas. An empty colour form field
  coerces to null (= reset to the ConQuest default).
- `isBrandImageSrc(value)` — accepts an absolute `https://` URL **or** an app-relative
  `/uploads/...` path. The relative branch exists because the local storage provider
  serves uploads from `public/uploads/`; it rejects traversal, backslashes and `//` so it
  can only ever address our own upload tree.

**First renderer = the invitation email (F3.4).** The send seam resolves the theme
from the invitation's denormalised `demoClientId` snapshot — see [invitations.md].
The F7.1 chat surface is the second consumer (via `themeToCssVariables`).

### The brand kit — the ground, the type, and the marks

Six columns, and three derivations that make them usable without asking the admin for more
than they know.

**The ground.** `canvasColor` is the page the questionnaire is drawn on; `inkColor` is the
text on it. Ink is optional because an admin who picks a midnight canvas should not also have
to work out that they now need light text — `resolveTheme` derives it with the same
`readableTextColor` the band already uses, and exposes the result as `onCanvas`. `canvasIsDark`
is a second reading of that same number, never a separate threshold, so the ink and the
lockup choice cannot disagree about a borderline mid-tone.

**And the ground has two of everything, because the respondent has a switch.** Every layout now
offers light/dark (see [respondent-chrome.md](./respondent-chrome.md)), so a canvas that only
worked in one of them was never really a setting. `canvasColorDark` / `inkColorDark` exist for a
brand with its own dark palette, but both are usually null: `darkenForDarkMode` derives the dark
ground as the client's colour at 14% over near-black, and the ink is derived from that.

Three choices in that derivation are worth stating, because each has an obvious-looking
alternative that is wrong:

- **A tint, not an inversion.** A cream paper stock has no honest inverse. What it has is a hue,
  and keeping that hue over the near-black the surface already uses is what makes a dark-mode
  Broadsheet still look like this client's rather than like everyone else's.
- **An already-dark canvas is carried across unchanged.** Darkening a navy again gives a black
  rectangle and loses the brand entirely — the opposite of the point.
- **The mix happens in TypeScript, not as a CSS `color-mix()`.** The result is needed as a real
  colour, because `readableTextColor` has to read it to derive the dark ink, and it cannot see
  inside a `color-mix()` the browser has not computed yet.

The resolver cannot pick BETWEEN the two grounds, though — the respondent flips the mode
client-side, long after the server resolved the theme. So `themeToCssVariables` emits both
(`--app-canvas-light` / `--app-canvas-dark`, `--app-ink-light` / `--app-ink-dark`) and the
stylesheet publishes the winner as `--app-canvas-color` / `--app-on-canvas` from its light and
`.dark` blocks. The `data-canvas='custom'` derivation below then reads only that published pair,
so it is mode-agnostic by construction and needs no `.dark` variant of its own. The band's
lockup is split the same way: `--app-logo-src` and `--app-logo-src-dark` in, `--app-logo-url`
out.

A canvas has to reach further than a variable. `--app-canvas-color` and `--app-on-canvas`
drive `--color-background` / `--color-foreground` on the respondent surface, but the rest of
the neutral palette is literal (`--color-card: #ffffff`), so a midnight canvas would have got
light ink and white cards on top — worse than not offering the setting. `BrandThemeProvider`
therefore also sets **`data-canvas='custom'`** when the client has a ground of their own, and
`app/brand-theme.css` re-derives cards, popovers, borders, inputs, rings and muted text from
it with `color-mix`. Mixing rather than listing a second palette is what lets one rule serve
both a bone-white paper stock and a near-black field: every step moves toward the ink, and its
direction follows the canvas automatically — including when the ground is the DERIVED dark one,
since the rule reads the published pair rather than the client's columns. The attribute is
carried to portalled roots alongside the variables (see
`respondent-surface-context.tsx`), or the answer drawer would come out a white card over a
dark questionnaire.

**Which lockup the band draws.** `logoDarkUrl` is the same artwork in light ink.
`resolveTheme` picks between it and `logoUrl` per the ground the band ACTUALLY paints —
the logo backdrop if there is one, else the surface colour, else the canvas — and does it
**once per mode**, since the canvas differs between them: `bandLogoUrl` and `bandLogoDarkUrl`.
The renderer still reads one variable (`--app-logo-url`) and needs no branch; the stylesheet
chooses which source fills it. With no band colour at all the dark-mode ground is the neutral
near-black, so a client who supplied a dark lockup gets it there even with no surface set. `logoUrl` itself keeps its old meaning (the light-ground lockup) because the invitation
email and the export PDFs render onto paper-white and must not follow the band's choice.

**The type.** `fontPairing` is one choice covering two faces, not two font-family boxes: a
typed family name is a worse form and a worse failure (a typo silently falls back). The six
pairings live in `theming/fonts.ts` with their stacks and their admin copy — `neutral` (the
system stack), `humanist` (Outfit / Source Sans 3), `editorial` (Instrument Serif / Newsreader),
`classical` (Playfair Display / Lora), `contemporary` (Bricolage Grotesque / Space Grotesk) and
`monospace` (JetBrains Mono / IBM Plex Mono). `app/layout.tsx` loads the ten brand faces via
`next/font` with **`preload: false`**, so a marketing page does not fetch typefaces only a demo
client uses — that opt-out is what makes the list cheap to grow, and the parity test derives its
expected count from `FONT_PAIRINGS` so a seventh pairing that preloads fails rather than taxing
every page. `themeToCssVariables` emits
`--app-font-display` / `--app-font-body` only for a non-neutral pairing — `neutral` IS the
stylesheet default, and an inline style would beat it on portalled roots. The link between the
stack strings and the `next/font` variable names is nothing but a string, so
`tests/unit/lib/app/questionnaire/theming/fonts.test.ts` reads `app/layout.tsx` and checks
them against each other; a rename on either side fails there rather than rendering in Georgia.
The same file pins two invariants a seventh pairing could quietly break: **no two pairings share
a face** (a duplicate would cost a download to look identical on screen), and **`monospace` tails
`MONO_FONT_STACK`, not `NEUTRAL_FONT_STACK`**. That second one is the only place the generic
matters — a mono stack falling back to the neutral sans renders proportional and then reflows to
fixed-width the moment the webfont lands, mid-read.

**Reading is forgiving, writing is strict.** `resolveFontPairing` resolves null and anything
unrecognised to `neutral` (the column is plain TEXT, so a rollback or a seed can put anything
there), while the Zod field rejects an unknown pairing outright — an admin's typo should be
told, a value already in the column must still render.

**Every emitted variable has a default**, declared in `app/brand-theme.css` on the
`[data-surface='respondent']` blocks rather than the `[data-brand='conquest']` one: they are
the neutral ground any questionnaire falls back to, branded or not, and a client who sets only
a logo still needs a canvas to draw it on. The exceptions are the variables whose consumers
branch before painting (`--app-surface-color`, `--app-on-surface`, `--app-logo-bg` and the
image URLs) — a default there would paint a brand band onto every unbranded questionnaire.
A test enumerates what `themeToCssVariables` can emit and checks the stylesheet declares each
one, with that exemption list stated in the test.

### One select, not nine

`DEMO_CLIENT_THEME_SELECT` (`theming/select.ts`) is the single Prisma `select` fragment every
consumer of a client's brand uses. Before it there were nine hand-written column lists — the
email, the respondent surface, the report notification, four export PDFs, the admin list — and
nothing connected them. Missing a column produced no error at all, because `resolveTheme`
treats an absent key exactly like an explicit null: the surface simply rendered unbranded,
which is plausible enough that nobody notices.

That was not hypothetical. Four of those selects still listed only the original F3.4 four, so
`transcript-pdf-document.tsx` — which reads `surfaceColor` — had been rendering transcripts
without the client's band since F7.1 shipped. Fixed here.

The fragment is guarded at COMPILE time: `DEMO_CLIENT_THEME_SELECT satisfies Record<keyof
Required<DemoClientTheme>, true>` means a new field on the resolver's contract without a
matching key is a type error. Add a theme column in one place and the whole product picks it up.

### Custom type

The six pairings are a picker; `fontPairing = 'custom'` is the escape hatch for a brand with its own
face. `customFontDisplay` / `customFontBody` name two Google Fonts families and `customFontFiles`
records the woff2 files we fetched and stored for them.

They are **self-hosted, not linked**: the CSP's `font-src` is `'self' data:` and the only app-owned
seam is `frame-src`, so a `<link>` to fonts.googleapis.com would need a platform edit. `resolveTheme`
emits the `@font-face` rules (`ResolvedTheme.fontFaceCss`) pointing at
`/api/v1/app/demo-clients/:id/font/:face`, which is also why `DemoClientTheme` carries `id` — a
self-hosted face is an asset, and an asset has to be addressed.

Loading applies immediately (like an image upload); `fontPairing` itself stays an ordinary form
field, so loaded faces sit inert until the pairing is switched. Full design:
[brand-import.md](./brand-import.md#custom-type).

### Filling the theme from the client's website

Every field in this section can also be **proposed** rather than typed. `Import from their website`
in the Brand theming fieldset takes an address (or a screenshot), reads the page, its stylesheets
and its logo, and proposes colours, a lockup, a mark and a typeface. The admin ticks what they want
and the ordinary Save writes the colours; images and typefaces are stored immediately, exactly as an
upload is. The model can only return colours that were actually measured.

Full design, including the four-outcome failure contract and why a field we could not read is
absent rather than defaulted: [brand-import.md](./brand-import.md).

### Brand images: upload or link (F7.2)

Every brand image accepts **either** a pasted `https://` URL **or** an uploaded file. Both
paths write the same column, so `PATCH /api/v1/app/demo-clients/:id` is unchanged — upload
simply returns a URL the form writes into the same field.

| Route                                        | Spec                                    | Stored as | Where it renders                        |
| -------------------------------------------- | --------------------------------------- | --------- | --------------------------------------- |
| `POST/DELETE .../demo-clients/:id/logo`      | any shape, min 80x40, max box 1200x1200 | PNG       | email header, session band, export PDFs |
| `POST/DELETE .../demo-clients/:id/banner`    | ~4:1 (±12%), min 800x200, box 1600x400  | JPEG      | respondent session header only          |
| `POST/DELETE .../demo-clients/:id/logo-dark` | same spec as the logo                   | PNG       | any band whose ground resolves dark     |
| `POST/DELETE .../demo-clients/:id/mark`      | 1:1 (±6%), min 128x128, box 512x512     | PNG       | layouts wanting a mark, not a lockup    |

- All four are built from one `brandImageHandlers(kind)` factory. The **kind is passed
  explicitly**, not derived from the spec: `logo-dark` shares the logo's spec object, so the
  old `spec.label === 'Banner' ? … : logo` derivation in the admin field would have sent both
  new kinds to the logo route and overwritten a column the admin was not editing.
- **Squareness IS enforced for the mark**, unlike the logo. A wordmark uploaded there would
  be scaled to illegibility in the slots that use it, so the shape is checked on the way in
  rather than imposed by the renderer.

- **PNG for the logo** because it needs transparency and is rendered by the invitation
  email and the export PDFs, where WebP support is patchy. **JPEG for the banner** because
  banners are photographic and transparency is meaningless once it fills the band.
- **Dimensions are checked before processing** (`readImageDimensions` → `validateImageDimensions`),
  so a wrong-shaped export is rejected with its measured size in the message rather than
  silently reshaped. The browser pre-checks the same rules for instant feedback; the server
  re-checks because the client check is UX, not a boundary.
- `processImage` is called with `fit: 'inside'`. Its default is a centred **square crop**
  (the avatar shape) which would destroy a wordmark — this was the one platform change the
  feature needed, added as an option so the avatar path is untouched.
- Keys are fixed per client and kind (`demo-clients/<id>/<kind>/<kind>.<ext>`) so
  re-uploading overwrites; the stored URL carries `?v=<timestamp>` to defeat the cache.
- **An upload persists immediately; a typed URL does not.** `POST` writes the column
  server-side and `DELETE` clears it, both before the form is saved — so **Cancel cannot
  undo an upload or a removal**. There is no draft state for a binary, and the alternative
  (store on upload, persist on save) strands an orphaned object for every abandoned
  upload. The field says "uploads apply immediately" so the admin isn't surprised.
- **Remove always calls `DELETE`** when upload is available. It cannot gate on a
  `/uploads/` prefix to detect "one of ours": only the LOCAL provider returns relative
  paths, while S3 and Vercel Blob return absolute https URLs indistinguishable from a
  pasted link — so a prefix check skipped cleanup on every real deployment and left the
  object public in the bucket. The route is idempotent, so calling it for a typed URL is
  a harmless no-op.
- **Storage is optional.** When no provider is configured `isStorageEnabled()` is false,
  the routes 503 with actionable copy, and the admin field degrades to URL-only. Upload
  also needs a saved client (the key includes its id), so the create form shows "Save the
  client first to upload a file".

**A banner REPLACES the header band** rather than sitting inside it: the logo, title and
band colours no longer render in that strip, so the banner must carry the branding itself.
The title moves to its own strip below — the alternative, overlaying it, depends on the
legibility of an image we have never seen.

### FK delete policy (AD2)

`onDelete: SetNull` with a reverse `questionnaires` relation, **plus an app-layer
409 guard**:

- The reverse relation powers the list `questionnaireCount`, the delete guard, and the
  detail page's attributed-questionnaire list (each row links to the questionnaire editor,
  where the picker detaches/reassigns — so the guard's "detach or reassign first" has a destination).
- `DELETE /demo-clients/:id` **refuses with 409 `DEMO_CLIENT_IN_USE`** while any
  questionnaire is attributed — the admin must detach/reassign first. This is the
  happy-path UX; `SetNull` is the schema-honest backstop (a delete that bypassed
  the guard would clear attribution rather than orphan a row).

## API

All routes are `withAdminAuth` (401/403) and audited. Registry: `API.APP.DEMO_CLIENTS`.

| Method + path                                      | Purpose                                                                            | Notable codes                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /api/v1/app/demo-clients`                     | List (active + inactive)                                                           | —                                                           |
| `POST /api/v1/app/demo-clients`                    | Create                                                                             | `409 SLUG_CONFLICT`                                         |
| `GET /api/v1/app/demo-clients/:id`                 | Detail (+ attributed-questionnaire list)                                           | `404`                                                       |
| `PATCH /api/v1/app/demo-clients/:id`               | Edit any identity or theme field                                                   | `404`, `409 SLUG_CONFLICT`                                  |
| `DELETE /api/v1/app/demo-clients/:id`              | Delete (guarded)                                                                   | `404`, `409 DEMO_CLIENT_IN_USE`                             |
| `POST /api/v1/app/demo-clients/:id/reset-sessions` | Reset session graph (F6.4)                                                         | `400 CONFIRM_SLUG_MISMATCH`, `409 ANONYMOUS_MODE_PROTECTED` |
| `GET /api/v1/app/demo-clients/:id/knowledge`       | The client's private knowledge corpus (F10.1) — grounds its Respondent Reports     | `404`                                                       |
| `POST/DELETE .../demo-clients/:id/logo-dark`       | Light-on-dark lockup upload / remove                                               | `404`, `400`, `503`, `429`                                  |
| `POST/DELETE .../demo-clients/:id/mark`            | Square brand mark upload / remove                                                  | `404`, `400`, `503`, `429`                                  |
| `PATCH /api/v1/app/questionnaires/:id`             | Attribute / detach (`demoClientId`); also renames with `{ title }` (not demo-only) | `404`, `404 DEMO_CLIENT_NOT_FOUND`                          |
| `POST /api/v1/app/questionnaires/import`           | Import a definition file; optional `?demoClientId=` attributes the new draft       | `404 DEMO_CLIENT_NOT_FOUND`, `400 VALIDATION_ERROR`         |

**Slug is derive-with-override:** omit it on create and the server derives a
kebab-case slug from the name (`slugifyDemoClient`); supply it to override. A
collision surfaces as `409`, never a silent mutation.

Audit actions: `app_demo_client.create | update | delete | reset_sessions`,
`questionnaire.assign_demo_client`.

**Session reset (F6.4):** `POST /demo-clients/:id/reset-sessions` hard-deletes the
session graph for all the client's questionnaires — the between-demos clean slate, with
a typed-confirmation guard and an anonymous-mode refusal. See
[demo-session-reset.md](./demo-session-reset.md).

## Admin UI

- `/admin/demo-clients` — list + "New demo client".
- `/admin/demo-clients/new` — create form.
- `/admin/demo-clients/:id/…` — the detail surface, split into **route-based sub-tabs**
  (the sibling of the questionnaire workspace at `…/v/:vid/…`). A shared
  `[id]/layout.tsx` owns the chrome — breadcrumb, sticky header (name + Active/Inactive
  badge + slug · count), and the `<DemoClientSubNav>` tab bar — and resolves the client
  once via `getDemoClientDetailCached` (React `cache()`), so each tab page reuses the
  fetch for free. Tabs (registry in `lib/app/questionnaire/demo-clients/nav.ts`, all
  always-on — no per-tab flags):
  - **Overview** (`/:id`) — the **"Attributed questionnaires"** list (each row links to
    the questionnaire editor, with the make-generic / reassign menus that unblock the
    delete guard) + the saved **brand preview**. Above the list, the
    **`<AttributeQuestionnairePicker>`** (reverse attribution) lets the admin brand a
    _generic_ (unattributed) questionnaire as this client without opening its Settings
    tab — options come from `getAttributableQuestionnaires()` (the full list filtered to
    `demoClient === null`), and it PATCHes the same `…/questionnaires/:id { demoClientId }`
    endpoint. Reassigning one already branded as _another_ client stays in that client's
    row menu.
  - **Branding** (`/:id/branding`) — the `<DemoClientForm>` (identity fields + brand
    theming + live preview), intact.
  - **Knowledge** (`/:id/knowledge`) — the `<ClientKnowledgePanel>` (below).
  - **Management** (`/:id/management`) — the destructive demo-ops: **Reset sessions** and
    **Delete** (disabled with an explanation while questionnaires are still attributed —
    act on the delete guard from the Overview tab's row menus).
- Both forms carry a **"Brand theming"** fieldset (F3.4 / F7.1+ / F7.2): CTA colour, accent
  colour, **logo** and **header banner** (each a `<BrandImageField>` — paste a URL or
  upload a file), welcome copy, plus a **"Session chrome"** sub-block — surface colour,
  CTA gradient end, and an **"Apply a colour behind the logo"** toggle (the requested
  device, with an optional colour that defaults to the surface colour). Each field is
  optional with a `<FieldHelp>`; leaving **everything** blank runs the session in ConQuest
  colours with the ConQuest wordmark in the band, while setting any one field hands the
  surface to the client. Colours apply to **both** the invitation email and the respondent question
  session (visible via "Preview as respondent"). The edit form shows a **live `<DemoClientThemePreview>`** under the fieldset
  (valid inputs only — a half-typed hex shows the default, not a broken swatch).
- Beneath it, **"The page itself"** carries the brand kit: canvas colour, ink colour, their two
  dark-mode counterparts (both placeholdered _"Leave blank to derive it"_, which is the path
  almost every client takes), second accent, a **Typeface** select (the six pairings, with the
  chosen one's description under it — the picker is a plain `<select>` because the description
  line, not the option label, is what tells an admin what they are choosing), and the
  **light-on-dark logo** + **square mark** image fields. Ink is placeholdered
  _"Leave blank to derive it"_ because deriving is the path almost every client takes.
- **Colours are pickers now, not text boxes.** `<BrandColorField>` pairs a native
  `<input type="color">` (OS picker, eyedropper on macOS/Chrome) with the hex box, which stays
  the source of truth and freely editable mid-type — `#28` is a legal thing to have typed.
  **The unset state was the hard part**: a native colour input has no empty value and shows black,
  so an untouched field read as "this colour is black" beside a placeholder saying otherwise. The
  swatch is therefore a styled span with the input laid transparently over it — unset draws a
  muted diagonal slash, and clicking still opens the OS picker, seeded from the placeholder hex so
  the admin starts at the suggested colour. The control never writes on its own, so an untouched
  field stores nothing and blank still means "use the default".
- **A soft contrast warning per mode**, on the canvas/ink pairs — the only pairs on this form
  that can be independently valid and jointly unreadable. Both light and dark are checked, because
  a respondent can be reading either and the derived dark pair can fail too. Each measures the
  pair that will ACTUALLY RENDER, names which mode is the problem, and warns below
  `MIN_CONTRAST_RATIO` without blocking the save: a brand may genuinely be low-contrast, and
  refusing would be us overruling the client's designer. A mid-grey canvas trips it whatever ink
  is chosen, which is precisely when the admin should hear about it.

  "Actually render" is load-bearing and was got wrong first time. The check originally measured
  only when BOTH halves were authored, which meant the single most likely way to ship an
  unreadable questionnaire went unchecked: a guideline reads "ink: #FFFFFF on dark", the admin
  fills in **Ink colour**, leaves **Canvas colour** blank, and the stylesheet pairs that white ink
  with the DEFAULT white ground. Nothing said a word. Each side now falls back to
  `NEUTRAL_RESPONDENT_GROUND` — a TypeScript mirror of the `var()` fallbacks in
  `app/brand-theme.css`, kept in step by a test, because TS cannot read inside a chain the browser
  has not resolved. When the ground is the default one, the warning says so, since an admin who
  never set a canvas cannot otherwise tell what they are being warned about.

- **Brand preview (`<DemoClientThemePreview>`).** Surfaces the configured brand back
  to the admin — the gap that a client could set theme fields and see nothing. Reuses
  `resolveTheme()` and the same escaped `url()` sink (`cssUrl`) as `BrandThemeProvider`
  (never a raw `<img src>`), and renders a **miniature of the session chrome** (surface
  band + logo backdrop + gradient send button) so the admin recognises the brand before
  opening "Preview as respondent". The miniature paints the client's **canvas and ink** and
  sets its sample question in the chosen **display face** — the preview is not inside a
  respondent surface, so it applies the ground itself rather than inheriting it, and the type
  pairing is otherwise just a word in a dropdown. The band draws `bandLogoUrl`, so an admin who
  uploads a dark lockup sees the swap happen here; the full mode also shows that lockup on a
  dark chip (the only way to tell it is really the light-ink artwork) plus the square mark. Two modes: **compact** on the list's
  _Branding_ column (a swatch/thumbnail only for fields actually set; "Default" when
  none) and **full** on the detail page / live form preview (the resolved brand the
  respondent sees, defaults filled).
- **Knowledge base (F10.1).** The detail surface's **Knowledge** tab carries the
  `<ClientKnowledgePanel>` (from `components/admin/demo-clients/`) — upload / list / delete for the
  client's private corpus, used to ground its **Respondent Reports**. The corpus is client-owned and
  shared across all the client's questionnaires, so it lives here (not per questionnaire); a
  questionnaire's report opts into grounding via its own toggle and links here to manage the docs.
  Backed by `GET /demo-clients/:id/knowledge` → `getClientKnowledgeViewForClient`; documents carry the
  client's dedicated `KnowledgeTag` for strict per-client isolation. See
  [respondent-report.md](./respondent-report.md#per-client-knowledge-isolation-tag-based).
- The questionnaire detail page (`/admin/questionnaires/:id`) carries the
  attribution `<DemoClientAssign>` picker (active clients + the current one) and a
  **`<CloneForClientDialog>`** "Clone for client" action (below).

Nav entry registered via `initAppNav()` (seam 4 — no sidebar edit). The admin shell
itself is **not** themed (that's for the end-user surface in P7).

## Clone for client

`POST /api/v1/app/questionnaires/:id/clone-for-client` `{ targetDemoClientId, nameSuffix? }`
(DEMO-ONLY) duplicates a questionnaire's **current** version (launched if present, else
the highest-numbered) into a brand-new questionnaire as a fresh `draft` v1, attributed to
the chosen demo client (`null` = a generic, unattributed copy) — so the same questionnaire
is re-usable for the next prospect. The structural copy (config + sections/slots + tag
vocabulary + assignments) is single-sourced with the F2.1 version-fork via
`_lib/copy-version-graph.ts` (`copyVersionGraph`); goal/audience are copied onto the new
v1; the newest source-document row is copied as provenance. **Not** copied: sessions,
invitations, evaluation runs, extraction-change records (a clone starts fresh). The new
title is `"<source title> — <suffix>"`, the suffix defaulting to the client name (or
"Copy"). Admin-only, flag-gated, audited as `questionnaire.clone_for_client`. _(Built
2026-06-07, deferred-gaps audit Item 4 — the relocated P2.5 clone-for-client, unblocked
once F2.2 tags + F3.1 config existed.)_

## Fork guidance

Everything demo-only is grep-isolated under the `DEMO-ONLY` marker:

- `lib/app/questionnaire/demo-clients/**` + `lib/app/questionnaire/theming/**`
  (domain) · `app/api/v1/app/demo-clients/**` (routes) ·
  `components/admin/demo-clients/**` + `app/admin/demo-clients/**` (UI) ·
  the `AppDemoClient` model + theme columns + the invitation `demoClientId`
  snapshot + the `AppQuestionnaire.demoClientId` column · the `API.APP.DEMO_CLIENTS`
  block · the nav item · the attribution PATCH on the questionnaire route · the theme
  resolution in the invitation send seam.

`grep -rl "DEMO-ONLY" lib app components prisma` finds the full surface. See
[forking.md] for the three replacement paths (delete · rename to `AppTenant` + RLS
· keep as `AppBrand` without the marker).

[plan]: ../planning/development-plan.md#p25--demo-client-foundation
[forking.md]: ./forking.md
[mt]: ../../architecture/multi-tenancy.md
