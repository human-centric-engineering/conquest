# Brand import

> **DEMO-ONLY.** Reads a prospect's branding off their website, off screenshots of it, or off both — and
> proposes demo-client theme values. Colours persist nothing; a re-hosted logo writes its column
> immediately, exactly as an upload does. See [demo-clients.md](./demo-clients.md) for the columns
> it proposes into and what they render.

Branding a demo client by hand is a dozen fields copied out of a brand guideline, and it is the step
most likely to be skipped. This reads them off the client's own site instead.

Two sources, and the second exists because we cannot render a website server-side — Playwright is a
dev dependency and Chromium on a serverless function is a size-and-cold-start fight we would lose.
The admin's browser already has.

| Source          | Contributes                                                                          |
| --------------- | ------------------------------------------------------------------------------------ |
| **Website URL** | The page, its stylesheets and its logo. The **only** source of a logo or a typeface. |
| **Screenshots** | Painted AREA on the rendered page — up to three frames, measured, nothing else.      |

They started as alternatives — an address, falling back to a picture when the site blocked us — and
they are better read as **complementary**, which is why they are now one form, one request and one
analysis rather than two tabs.

A stylesheet cannot say which of its ninety colours the page is actually drawn in: a count of
`#f8f2ec` in a CSS file is a count of tokens, not of pixels. A screenshot answers exactly that and
nothing else — it has no logo file in it and no font name. So the reliable import gives us both, and
either alone still works, which is what an admin with only an address, or only a picture, has.

Two consequences worth stating:

- A **blocked** harvest is no longer the end of the run. With pictures in hand we analyse those and
  say the site itself could not be read. `blocked` is now only returned when there was nothing else.
- A colour that the site **declares** AND a screenshot **measures** is the strongest result this
  feature produces: two independent sources agreeing, and it is reported as such.

### What each source is trusted for

The two palettes are merged, screenshots weighted `3` against the site's `2` — the screenshot leads
because it is the only one that measured the rendered page, and the site stays close behind because
a brand's accent may occupy a few dozen pixels of one frame and still be the colour the company is
known by. Several screenshots are merged **with each other first**, at equal weight, so that
uploading more pictures cannot quietly become "outvote the logo".

## The measurement principle

**The model never invents a hex.** Colours are measured deterministically first; the LLM only
decides which measured colour plays which role. Every screenshot goes into that ONE call: the roles
are one decision about one brand, and asking per image would produce N answers with nothing to
arbitrate between them.

That split is the whole design, and both halves are load-bearing:

- Ranking by area cannot answer the question. On a screenshot the largest cluster is the white
  background — right for `canvasColor`, useless for everything else — and nothing in the numbers
  separates a brand accent from a border grey.
- An unconstrained model returns confident, plausible, wrong hexes: brand colours that were never on
  the page. So the reply is filtered against the candidate list by **exact string match**, and a hex
  that is not in it is **dropped, not snapped to the nearest neighbour**. Snapping would hide the
  failure and still ship a colour the page never used.

`narrowAssignments` is that guarantee, and it is tested directly rather than only through a mocked
provider.

### A merged colour is named by its heaviest contributor

Two candidates within `MERGE_DISTANCE` become one, and the surviving hex is the one that the most
evidence actually is — not whichever source was folded in first. That reads as a detail and is not.
A logo's white margin and a page's warm paper stock are 39 apart on the redmean scale, so they
merge; with the logo merged first, a site whose ground is a cream could only ever be proposed
`#ffffff` — a colour appearing nowhere on it. It cost a real import: Eagle Eye's `#f8f2ec` ground is
in their stylesheet thirteen times and could not reach the admin. The page's ground is the single
value this feature most has to get right, and a few hundred pixels of logo margin were overwriting
it. `extractPalette` already orders its own buckets heaviest-first for this reason; `mergePalettes`
now applies the same rule across sources.

## What it proposes

Ten colours (`surfaceColor`, `ctaColor`, `ctaColorEnd`, `accentColor`, `accentColorEnd`,
`canvasColor`, `inkColor`, `canvasColorDark`, `inkColorDark`, `logoBackgroundColor`), three images,
the type pairing and — when the brand's face is not one we ship — the two custom families. Colours
come from either route; images and type only from the URL route, since a screenshot contains no logo
file and no font name.

One deliberate omission:

| Not proposed | Why                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bannerUrl`  | The only banner-shaped image a site reliably exposes is `og:image` at ~1.9:1, and `BRAND_BANNER_SPEC` needs 4:1 within 12%. Proposing it would guarantee a rejected upload. |

## Reading a website

### The trust ladder

A brand colour found three different ways deserves three different levels of confidence, and
flattening them would throw that away. The harvest weights its sources accordingly:

| Source                                        | Weight | Why                                                                                   |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| The logo's own pixels (and inline header SVG) | 5      | A logo **is** the brand. It is also the only signal that survives an empty SPA shell. |
| The square mark / touch icon                  | 2      | Real, but often a generic square rather than the lockup.                              |
| What the page declares                        | 3      | `theme-color` and `--brand-primary` are statements of intent, not accidents.          |
| Colour frequency across the stylesheets       | 1      | Real, and mostly greys. Earns its place only by sometimes being all there is.         |

A hex in the **declared** set is reported to the admin as high confidence with the reason attached
("the site declares this colour as part of its brand"); everything else is a guess by a model that
could not see the page, and is labelled one.

### Finding the logo

Ranked in descending order of how much the page is really telling us:

1. `schema.org` `Organization.logo` — the site asserting what its logo is. Searched recursively,
   because it is usually nested under an `@graph` or hung off a `WebSite.publisher`.
2. An `<img>` in a `<header>`/`<nav>` whose class, id, alt or src says logo/brand/wordmark.
3. Any image on the page whose filename says logo.
4. `apple-touch-icon` → `logoMarkUrl`. Typically 180×180, so it clears `BRAND_MARK_SPEC`'s 128px
   floor. **There is no favicon fallback**, and that is the point: a 16 or 32px `.ico` can never
   clear the floor, so proposing one produced a field guaranteed to fail. The re-host rejects it on
   dimensions, a failed re-host deliberately keeps the _remote_ address (right for a logo a CDN
   merely refused us), and `isBrandImageSrc` accepts any https URL — so the favicon was written into
   the square-mark column and drawn at mark size. A site with no touch icon simply has no mark to
   propose.

**Every one of those signals is circumstantial**, and a real import proved it: a company called
Eagle Eye Solutions was handed a circular **Forbes** logo. A marketing homepage is full of files
literally named `logo` that belong to press outlets, review sites, partners and customers, and any
of them beats the real lockup if it appears earlier in the DOM. So the ranking is a **list of
candidates**, not an answer, and two things narrow it.

#### Excluding somebody else's mark

`isThirdPartyLogo` reads the image's own attributes AND walks its ancestors, because the evidence
comes in two forms: `forbes-logo.svg` names the outlet, while an anonymous `eagle.svg` inside
`<section class="our-clients">` is given away only by where it sits. Named outlets, role words
(`as-seen`, `partner`, `award`, `badge`, `testimonial`) and container classes (`logo-wall`,
`trusted-by`) are all excluded before ranking.

This will never catch every case — the next site's badge is a company nobody has heard of.

#### Reading the logo

So the candidates are **looked at**. The model is asked what each wordmark SAYS — a transcription
task — and the match against the site's own name (`og:site_name` → `<title>` head → hostname) is
then done in code by `namesMatch`, on letters and digits alone so `eagleeye` matches
`Eagle Eye Solutions`.

The split is the same one the colour analyst uses, and for the same reason: **a model asked "is this
their logo?" agrees; a model asked "what does it say?" answers `Forbes`**, and no string comparison
turns that into `Eagle Eye Solutions`.

Three outcomes:

| Verdict                               | Result                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Read, and it names the site           | Proposed, **high** confidence, with what it read shown to the admin.                      |
| Read, and it names some other company | **Nothing is proposed**, and the reason says what it read.                                |
| No readable text                      | Proposed, **low** confidence, saying we could not read a name in it. Most abstract marks. |
| Could not be checked                  | The ranking's first candidate, **low** confidence, saying it was not verified.            |

A mismatch **rejects** rather than downgrading. A wrong logo at "low confidence" is still a wrong
logo, and the failure being fixed is an admin accepting one without looking. Proposing nothing is a
worse-looking result and a better one: the admin uploads the file they can find in ten seconds.

Confidence is therefore about what the logo IS, not about where it was found — the old scheme rated
a `schema.org` claim "high" and could not tell a Forbes badge from a client's own lockup.

#### The dark lockup goes through the same check

`logoDarkUrl` is discovered separately (an explicit `prefers-color-scheme: dark` `<source>`, or a
file named as both dark and logo) and originally had **no** third-party exclusion at all. That is
how a "Forbes Communications Council" badge — named like a logo _and_ drawn white for a dark ground
— became a client's dark lockup on the second attempt, after the light one had been fixed.

It did more damage there than it would have in the light slot: `resolveTheme` picks
`logoDarkUrl ?? logoUrl` for the header band whenever the band's ground is dark, and a brand with a
deep canvas has a dark ground in **both** modes. So the wrong image replaced the right one
everywhere the client actually looks.

Both slots are now filled from one verification call: the model is asked for the logo AND for which
of the other images, if any, is the _same lockup_ drawn light-on-dark. A dark variant is only
proposed alongside an accepted lockup — a "dark version" of somebody else's logo is not worth
proposing — and a repeated index is read as "there isn't one".

`logoDarkUrl` comes only from an explicit `<source media="(prefers-color-scheme: dark)">` or a file
named as both dark and logo. No looser guess: the dark lockup is a field admins rarely check, so the
wrong artwork there is worse than none.

Non-https references are dropped rather than proposed — `isBrandImageSrc` would reject them on save,
so offering one would hand the admin a value the form then refuses.

### Colour notation

`css-color.ts` reads hex (3/4/6/8), `rgb()`, `hsl()`, `oklch()` and `oklab()`. **OKLCH is not
optional**: Tailwind 4 emits it for its entire palette, so a hex-only parser finds nothing on a
current site. The OKLab→sRGB conversion is written out against the published matrix rather than
pulled from a colour library — thirty lines of arithmetic against a dependency every fork would
carry.

Alpha is parsed and discarded, never composited onto an assumed background: that would invent a
light grey that appears nowhere in the design.

### The budget

Harvesting is a fan-out, not one document, so the caps are on the whole run: **12 requests, 2MB per
resource, 8MB total, 20s wall clock**. Redirect hops count. Exceeding a cap is a **result, not an
error** — we stop, and the note ("we stopped after 12 requests") is what keeps a truncated harvest
from reading as a complete answer.

### SSRF

Every request goes through `checkSafeProviderUrl` **on the first URL and on every redirect hop**.
That is not defence in depth, it is the only thing standing in the way: the guard validates one URL,
so under `redirect: 'follow'` a public address that 302s to `169.254.169.254` reaches cloud metadata
through a guard that reported `ok` — and in this feature that response would then be _measured and
echoed back as a proposed brand colour_.

Its documented limits are inherited, not fixed here: no DNS resolution, so a hostname pointing at a
private address is not blocked, and rebinding is not defended against. See `lib/security/safe-url.ts`.

The user agent is honest (`ConQuest-BrandImport/1.0`). Sites that refuse non-browser agents will
refuse us, and that is a `blocked` outcome with the screenshot offered — a better answer than
impersonating Chrome to get around someone's stated preference.

## Re-hosting a discovered logo

`brandImageHandlers` POST accepts either a multipart upload or `{ sourceUrl }`. Only the byte source
differs; both rejoin the same pipeline (magic bytes → dimensions → `processImage` →
`storage.upload` → column → audit), so every existing guard applies to an imported logo.

Re-hosting rather than storing the remote URL matters because `logoUrl` renders in invitation emails
and export PDFs, where a hotlink to someone else's CDN breaks the moment they move the file. When
storage is unconfigured — or the client has not been saved yet, so there is no key to write under —
the dialog falls back to the remote address and says so.

**SVG never survives the boundary.** Vector lockups are the norm, so they must be handled; but SVG
has no magic bytes for `validateImageMagicBytes` to recognise (nor should the validator be widened
to sniff for `<svg`), and it can carry `<script>` and external entities that would execute from our
own origin inside our own documents. `rasterise-svg.ts` converts it to PNG at 1600px — above every
brand spec's box, so `processImage` only ever scales down — and only the raster is stored.

## Typefaces

`font-match.ts` reads the families a site uses — Google Fonts links outrank `font-family` stacks,
since a loaded face is a deliberate choice where a stack is mostly fallbacks — and the answer takes
one of three shapes:

| Match              | Proposal                        | Why                                                                                                                                |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Exact face**     | that pairing                    | The site uses one of the ten faces we already load; nothing needs fetching.                                                        |
| **Anything else**  | `custom` + the two family names | The brand has its own face. Rounding it to the nearest grotesque we happen to ship is exactly what `custom` exists to avoid.       |
| **Nothing places** | nothing                         | `neutral` is a real choice an admin may have made; proposing it as a fallback would overwrite that with a value we never measured. |

The families are names read off a page, not entries checked against a catalogue — so the proposal
carries a caveat saying we will _try_ to load them. There is no offline catalogue to check against
and shipping one would go stale from the day it was written; asking Google whether the family exists
is both the check and the fetch. When it fails, the dialog drops all three type fields, applies
everything else, and says which name was not found. `custom` with no stored files renders in the
system stack, so applying it anyway would look like the import silently ignored the typeface.

## Custom type

The escape hatch from the six pairings, and the reason it is built the way it is comes down to one
line in the platform: **`font-src` is `'self' data:`**, and `style-src` names no Google origin
(`lib/security/headers.ts`). The only app-owned CSP seam is `frame-src` (`lib/app/csp.ts`), so a
`<link>` to fonts.googleapis.com would need a platform edit — which this fork fixes upstream rather
than patching locally.

So the faces are **self-hosted**: fetched once from Google, stored, and served back from our own
origin, which needs no CSP change at all and removes a runtime dependency on Google from every
respondent session.

### What is stored

Three weights (400/600/700), latin only. Body copy, a medium for emphasis and a bold for the
masthead cover everything the respondent surface sets; the full ramp would triple the download for
faces nothing renders. A family that does not publish a weight simply yields fewer files and the
browser synthesises the rest — better than refusing the family.

Google emits one `@font-face` per unicode subset, all at the same weight, so `parseFaceUrls` keeps
only the first block per weight. Missing that multiplies the download by six for scripts a demo
questionnaire will not set, and nothing else notices.

The request sends a browser `User-Agent` — the one place this feature does not announce itself.
Google serves a different FORMAT per agent, and our honest agent gets TTF where a browser gets
woff2: several times the bytes for the same glyphs, on a file every respondent downloads. That is
format negotiation, not getting past a stated preference about automated readers.

### The three columns

| Column              | Holds                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `customFontDisplay` | Google family for headings                                            |
| `customFontBody`    | Google family for running text                                        |
| `customFontFiles`   | `{ display?: { "400": url, … }, body?: … }` — what we actually stored |

`customFontFiles` holds storage **URLs**, not derived keys: Vercel Blob appends a random suffix to
every pathname, so a key alone cannot be turned back into something fetchable.

### Rendering

`resolveTheme` builds the `@font-face` rules (`ResolvedTheme.fontFaceCss`) because it is the only
place holding both the client id and the file map, and every surface that renders a brand already
takes a `ResolvedTheme` and nothing else. That is also why `DemoClientTheme` now carries `id`: a
theme is otherwise pure presentation, but a self-hosted face is an **asset**, and an asset has to be
addressed.

The rules are emitted as an inline `<style>` inside `BrandThemeProvider` — inside the surface, so a
fork that strips demo tenancy drops the faces with the provider — and `null` unless the pairing is
`custom` AND a family is set AND files were stored. `font-display: swap`, because a questionnaire
that renders immediately in the fallback and reflows into the brand's face beats one that renders
nothing.

`GET /api/v1/app/demo-clients/:id/font/:face` serves them. It is **unauthenticated** — a respondent
is often not logged in, so the surface's assets cannot be — and exposes a typeface the client chose
that Google already serves to the whole internet. It proxies the stored object's public URL rather
than calling `storage.download()`, because **Vercel Blob declares `download: false`**
(`lib/storage/providers/vercel-blob.ts`) and a download-based route would work in development and
404 in production. The stored URL still goes through the SSRF guard: the column is Json, and a
direct write or a restored backup could put anything there.

### Loading is not saving

`POST /api/v1/app/demo-clients/:id/fonts` writes the families and the file map **immediately** —
the same contract `BrandImageField` has for uploads, and for the same reason: there is no draft
state for a binary, and the alternative strands orphaned objects for every abandoned edit.

It deliberately does **not** write `fontPairing`. That stays an ordinary form field, so loaded faces
sit inert until the pairing is `custom` — inert rather than lost, so switching the picker away and
back does not mean fetching Google again.

It **merges**, and it has to. A POST is routinely partial: the import dialog sends only the families
still ticked, and the field's own Load button sends only the ones typed. A full replace therefore
cleared a face the client already had in the slot this request said nothing about — silently, and
orphaning its stored objects, because nothing deletes the old prefix on POST. So a slot the body
does not name keeps its family and its files, and the response reports the **merged** state rather
than only what this call loaded, since the field renders it straight into its "Stored:" line.
Clearing is what `DELETE` is for.

### The family name is the security boundary

`isCustomFontFamily` is an allowlist of the charset a real family name uses, not a blocklist of
dangerous parts, because the value goes into a URL we build server-side. A family has no legitimate
reason to contain a slash, a colon, an ampersand or a percent, and each is a way to reach a
different path or smuggle a second query parameter into the request. `resolveCustomFontFamily`
re-checks on read, since the column is plain text and a seed or a rollback can put anything in it.

## Both grounds, always

A questionnaire is drawn on a ground in **two modes**, and the respondent picks which — so the
import answers for four fields, not one: canvas and ink in light, the same pair in dark.

Leaving the dark pair to the resolver looked right and was not. `resolveTheme` derives a dark ground
when none is set, but for a canvas that is **already dark** it carries the colour across unchanged,
reasoning that darkening a navy again gives a black rectangle and loses the brand. That is a fair
default for a colour an admin typed. For an import it produced a real failure: a brand whose canvas
is a deep purple got two **identical** panels, and the admin was shown a light/dark comparison in
which nothing differed and no way to tell that was a bug rather than the brand.

So `ground.ts` completes the set:

1. **The dark ground must differ from the light one.** The analyst's own choice is kept when it
   clears `MIN_GROUND_SEPARATION` (a contrast ratio of 1.5 between the two grounds — they never
   appear together, so they need to be _distinguishable_, not legible against each other).
   Otherwise it is derived: a light canvas takes the platform's existing tint-over-near-black; an
   already-dark canvas is **mixed toward near-black instead**, which keeps the hue while dropping
   the luminance, so a deep purple becomes a deeper purple rather than either an unchanged purple or
   a black rectangle.

   `MIN_GROUND_SEPARATION` gates the analyst's ground but is deliberately **not** re-applied to the
   derived one. For an already-dark brand nothing we could derive would pass it — deepening
   `#111827` gives `#0d1017`, a ratio of about 1.07 — and the only value that would clear 1.5 is a
   _lighter_ one, which is the opposite of a dark mode. Dropping the field instead would hand the
   question back to `resolveTheme`, which carries an already-dark canvas across unchanged, and two
   identical panels is the exact bug this was built to fix. So the deepening is kept and the **copy**
   carries the honesty: a pair that did clear the threshold reads "so dark mode is not the same
   colour", one that did not reads "a deeper cut of the canvas, which is as far as an already-dark
   brand goes". The one case with nothing to say is a canvas already at near-black, where the
   derivation returns the canvas itself — that field is withheld rather than shown repeating the
   value above it.

2. **An ink that cannot be read is replaced, not warned about.** The form warns and saves anyway for
   a colour the admin typed — a brand may genuinely be low-contrast, and refusing would overrule
   their designer. An imported ink is nobody's decision yet, so shipping an unreadable pair only
   sets up a mistake the admin has to catch.
3. **Both inks are filled in.** They resolve to what the theme would derive anyway, so nothing
   renders differently — it just puts all four fields in front of the admin, which is the only way
   the dark pair is reviewable at all.

**The resolver is deliberately untouched.** Changing how it treats an already-dark canvas would
silently repaint every demo client that has one.

Deriving here is not the model inventing a colour: it is arithmetic on a colour the page really
used, deterministic, and labelled as derived where the admin can see it. A site often has no
dark-mode ground anywhere in its stylesheet — it may have no dark mode at all — so refusing to
derive one would leave the field permanently empty for exactly the brands that need it.

## The failure contract

Reading a brand off the open web fails often, so the feature is designed around its failure modes
rather than its happy path. `BrandImportResult.outcome` is one of four values, and every
unsuccessful one names a next step:

| Outcome   | Means                                             | `nextStep`                    |
| --------- | ------------------------------------------------- | ----------------------------- |
| `ok`      | Three or more fields proposed                     | none                          |
| `partial` | One or two fields proposed                        | `manual`                      |
| `empty`   | We read the source and found nothing brand-like   | `screenshot` (url) / `manual` |
| `blocked` | We never got the bytes, **and had no screenshot** | `screenshot` — always         |

`source` says what actually produced the answer: `url`, `screenshot`, or `combined`. A URL that came
back blocked is reported as `screenshot`, never `combined` — attributing the answer to a page we
never read would be a lie about where it came from. A one-sided `partial` names the half it has not
used yet ("Adding a screenshot usually fills in the rest"); a combined one has nothing left to
offer, so it does not pretend otherwise.

Three rules hold across all of them:

1. **A field we could not read is ABSENT, never a default.** A grey filled into `canvasColor`
   because we found nothing better is indistinguishable, on the form, from a grey we measured — and
   the admin would ship it. Absence is legible; a plausible wrong value is not.
2. **An unreadable source is a 200, not a 500.** "We could not find a brand in that image" is an
   ordinary answer with guidance attached. The 4xx cases are only the ones where the _request_ is
   malformed — no file, wrong bytes, a decompression bomb, too small — which the admin fixes by
   sending a different file rather than by trying a different route.
3. **`blocked` always points at the screenshot, and only happens without one.** We cannot render a website server-side (Playwright
   is a dev dependency, and Chromium on a serverless function is a size-and-cold-start fight we
   would lose), but the admin's browser already has. That constraint is why the screenshot route
   exists at all, rather than being a fallback we added later.

## Degradation

Three things can be missing, and none is fatal:

| Missing                | What happens                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A vision-capable model | The image is dropped, roles are assigned from shares and neutral flags, proposals are marked `confidence: 'low'`. |
| Any LLM provider       | `degraded: true`, no proposals, **the measured palette is still returned**.                                       |
| A parseable reply      | Same as above — the structured runner already retried.                                                            |

The palette is the expensive half and it is always returned. Discarding it because the model was
unavailable would throw away the work and leave the admin with nothing.

## Modules

| File                                                    | Job                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `brand-import/index.ts`                                 | The barrel. What the route and the dialog import; nothing reaches past it.                        |
| `brand-import/result.ts`                                | The shared contract — outcomes, proposals, the `analysedResult` / `blockedResult` builders. Pure. |
| `brand-import/palette-record.ts`                        | The palette as STORED: the Zod write boundary, `narrowBrandPalette`, `describeSource`. Pure.      |
| `brand-import/color.ts`                                 | Hex ↔ channels, chroma, redmean distance. Pure.                                                   |
| `brand-import/css-color.ts`                             | Every CSS colour notation → hex. Pure; see [Colour notation](#colour-notation).                   |
| `brand-import/palette.ts`                               | Buffer → ranked candidates (sharp). Bucket, then merge.                                           |
| `brand-import/fetch.ts`                                 | The SSRF-guarded fetcher and `HarvestBudget` — every outbound hop goes through it.                |
| `brand-import/harvest.ts`                               | The URL entry point: page + stylesheets + logo candidates, weighted by the trust ladder.          |
| `brand-import/verify-logo.ts`                           | The second model call — is that lockup theirs? — plus `judge` and `namesMatch`.                   |
| `brand-import/ground.ts`                                | Both grounds: light/dark pairs, and whether two are far enough apart to read as different modes.  |
| `brand-import/font-match.ts`                            | A harvested family → one of the six shipped pairings, or none.                                    |
| `brand-import/google-fonts.ts`                          | Resolves a family on Google Fonts and pulls one woff2 per weight (`parseFaceUrls`).               |
| `brand-import/assign-roles.ts`                          | The one model call, plus `narrowAssignments`.                                                     |
| `brand-import/contrast.ts`                              | Annotates an unreadable canvas/ink pair. Reuses `contrastRatio` / `MIN_CONTRAST_RATIO`.           |
| `brand-import/analyse.ts`                               | `analyseBrand` — the one entry point: a URL, screenshots, or both, merged into one analysis.      |
| `app/api/v1/app/demo-clients/brand-import/route.ts`     | Gate stack + the multipart boundary.                                                              |
| `app/api/v1/app/demo-clients/_lib/rasterise-svg.ts`     | SVG → PNG, so a vector logo can be re-hosted without ever storing the markup.                     |
| `app/api/v1/app/demo-clients/[id]/fonts/route.ts`       | Loads (POST) / clears (DELETE) a client's custom faces into storage.                              |
| `app/api/v1/app/demo-clients/[id]/font/[face]/route.ts` | Serves one stored face same-origin, which is what `font-src 'self'` requires.                     |
| `components/admin/demo-clients/brand-import-dialog.tsx` | Upload, per-field accept, the palette strip.                                                      |
| `components/admin/demo-clients/brand-palette-strip.tsx` | The kept palette on the branding page — proportional band, click-to-copy chips, Clear.            |
| `components/admin/demo-clients/custom-font-field.tsx`   | The two family names, the load action, and what is currently stored.                              |

### Why buckets, then a merge

A coarse 5-bit-per-channel bucket collapses antialiasing and JPEG noise that would otherwise make
every logo edge its own colour; the merge pass then folds buckets still within redmean 48 of each
other into the heaviest one. k-means would do the second step better and needs a `k` we cannot
choose — a two-colour wordmark and a photographic hero want very different values, and guessing
wrong silently splits or merges a brand colour.

### Neutrals are kept, not filtered

A near-neutral colour is flagged, never discarded. The neutrals **are** the answer for `canvasColor`
and `inkColor` — a page's ground and its text are near-neutral on almost every real site. Filtering
low-chroma colours out as "not brand colours" is the obvious first implementation and it quietly
makes the two most structurally important fields unfillable.

Transparent pixels, by contrast, are skipped entirely: a logo PNG is mostly transparent, and
counting its empty margin would rank "nothing" as the brand's primary colour.

## Gates on the route

`withAdminAuth` → per-admin sub-cap (`brandImportLimiter`, 10/min) → then, by content type:

- **JSON** → shape check → harvest (which carries its own budget and SSRF guard).
- **multipart** → byte cap → magic bytes → pixel ceiling → minimum edge → analyse.

The two shapes are distinguished by content type rather than a mode flag: a JSON body and a
multipart body are already different requests, and a flag that could disagree with its payload is a
third thing to keep in step.

Two orderings matter on the screenshot branch:

- **`MAX_INPUT_PIXELS` is checked from the image header, before any decode.** A solid-colour
  16000×16000 PNG is ~200KB on disk and ~1GB decoded — it clears the byte cap and every other gate.
- **Magic bytes run before anything reads the file as an image.** Nothing downstream trusts the
  browser's claim about the type — and nothing reads the DETECTED one either, because `assignRoles`
  re-encodes every frame before a model sees it (below), so the type attached to the vision call is
  one we produced. This check earns its place as the gate that refuses a file that is not an image
  at all.

### Screenshots are resized before they reach the model

`assignRoles` caps each frame's long edge at **1568px** and re-encodes it to PNG, the same way
`verifyLogo` thumbnails its own candidates — preparing an image for a model belongs beside the call
that sends it, not in the orchestrator.

1568 is the providers' own downscale threshold, so a larger frame buys no detail: it is resized
before it is ever tokenised. What it did cost was real — the route accepts up to three screenshots
at the storage size cap each, and base64 adds a third again, so a set of large frames could exceed
a provider's per-image limit outright and fail the call, losing the assignment we could still have
made from the numbers.

**PNG rather than JPEG**, because this feature is about colour. The model can only ever _return_ a
hex from the measured candidate list — `narrowAssignments` guarantees that — so a lossy encode could
never fabricate a colour, but it could blur which region is which and move a real colour onto the
wrong role. A UI screenshot is flat colour, which PNG compresses well, so losslessness is cheap
here; the resize is what does the work.

The palette is measured from the **original** bytes, not the downsample — `extractPalette` runs
before any of this. A frame that cannot be decoded is dropped and the others still go; if none can,
the call runs on the numbers alone, exactly as it does for a model without vision.

The route is collection-scoped (`/brand-import`, not `/[id]/brand-import`) because the create form
has no client id yet and colours are worth importing before the client exists. `demoClientId` is
optional context for cost attribution only — it is never written to. The static segment resolves
ahead of `[id]`, so the path never reaches the single-client handler.

## Cost and provenance

Spend is logged via `logAppLlmCost` under `capability: 'app_brand_import'` with `versionId: null` —
an import belongs to a demo client, not to a questionnaire version — and the client id in `extra`.

**No `AppAiRun` row is written.** This proposes cosmetics the admin adjudicates in full before any
save, so it follows the Respondent Report config assistant's precedent (records nothing) rather than
the house-rules suggester's. Recording it would mean adding a `demo_client` subject kind for runs
nobody would read back. See [ai-run-provenance.md](./ai-run-provenance.md).

## The admin's contract

Accepted proposals are written into **form state** via ordinary `setValue` calls with
`shouldDirty` — indistinguishable from typing. The live theme preview updates, Save becomes enabled,
and Cancel discards the lot. Nothing reaches a column except through the same audited PATCH as every
other demo-client edit.

Proposals arrive pre-ticked: the admin's job is to veto what looks wrong, not to re-select what the
import already got right.

The dialog also renders **every measured colour** as a palette strip, ranked by share, so an admin
can copy a hex by hand when a suggestion is wrong. On a degraded run that strip is the entire
result — and it is still useful.

## The sibling feature

The import fills these boxes from a brand; the **contrast optimiser** checks that what is in them
can be read, and proposes the nearest shade of the client's own colours where it cannot. Same
propose-and-veto contract, same "the model cannot invent a colour" guarantee, and the two buttons
sit side by side on the branding form. See [brand-contrast.md](./brand-contrast.md).

## The palette is kept

The proposals used to be the durable half of an import and the palette the disposable one: accepted
colours landed in columns, and the measurement they came from disappeared when the dialog closed.
That is backwards. A proposal can be re-typed off a brand guideline; a colour measured from a site
that has since been redesigned **cannot be measured again**.

So the palette is persisted on `AppDemoClient.brandPalette` and the branding page renders it under
the import button, beside the fields it filled.

### The contract

```ts
interface BrandPalette {
  candidates: ColorCandidate[]; // every measured colour, ranked by share
  readFrom: string | null; // "acme.example + 2 screenshots"
  capturedAt: string; // ISO, stamped when the run RETURNED
}
```

`readFrom` and `capturedAt` are what make the strip honest rather than decorative. A row of hexes
with no provenance invites an admin to trust colours read off a brand that has since changed; with
them, the strip says what it is — a record of what was there on the day we looked.

### It rides with the proposals, not on its own beat

`onApply` hands the palette back **in the same call** as the accepted fields, and the form writes it
through the same `setValue`/`shouldDirty` path. Three consequences, all deliberate:

- An import that is applied but never saved leaves **no trace**, exactly like the colours it
  proposed.
- Vetoing every colour still keeps the palette: it is evidence about the **site**, not about the
  fields accepted from it, and an admin re-typing colours by hand is typing _from_ it.
- A run that measured nothing hands back `null`, which **clears** a stored palette. Leaving an older
  strip beside newly imported colours would attribute them to evidence we did not gather this time.

Because it is not a field anyone types into, the instinct is to keep it out of form state. It lives
there anyway: Save is gated on `isDirty`, and a palette held beside the form could be replaced by a
re-import — or cleared — with the button still greyed out.

### Strict write, forgiving read

`brandPaletteSchema` validates on the way in (six-digit lower-case hex, `share` in 0–1, at most
`MAX_STORED_CANDIDATES`, an ISO `capturedAt`). `narrowBrandPalette` narrows on the way out and
returns `null` for anything it does not recognise — the same split `customFontFiles` already uses on
this table, and for the same reason: the column is `Json?`, so a seed, a rollback or an older build
can leave anything there, and a branding page with no strip is a state the page already renders
correctly. One that throws is not.

The cap is applied in the dialog **as well as** at the write boundary. A merged run over a site plus
three screenshots can measure more colours than the column keeps, and silently posting a body the
API rejects would fail the whole save over the least important thing in it.

### Copy, not apply

A chip copies its hex. It deliberately does not write itself into a field: the strip has a dozen
colours and the form has ten colour boxes, so "apply" would need a target, and every way of choosing
one is more machinery than pasting. Assigning colours to roles is the **dialog's** job; the strip is
the reference sheet beside it. Clearing travels back through the form rather than being handled in
the strip, so the column and the Save button stay in step.

A one-line reminder sits beside the import button: check you are entitled to use the client's
branding. Pulling a prospect's logo is equivalent to an admin downloading it manually, but the
product should say so rather than imply we have checked.
