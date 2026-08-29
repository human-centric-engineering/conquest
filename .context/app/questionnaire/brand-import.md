# Brand import

> **DEMO-ONLY.** Reads a prospect's branding off their website — or off a screenshot of it — and
> proposes demo-client theme values. Colours persist nothing; a re-hosted logo writes its column
> immediately, exactly as an upload does. See [demo-clients.md](./demo-clients.md) for the columns
> it proposes into and what they render.

Branding a demo client by hand is a dozen fields copied out of a brand guideline, and it is the step
most likely to be skipped. This reads them off the client's own site instead.

Two ways in, and the second exists because of how the first fails:

| Route           | What it does                                                              | When                                                  |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Website URL** | Fetches the page, its stylesheets and its logo; parses and measures them. | The default. Also the only route that finds a logo.   |
| **Screenshot**  | Measures the colours in an image the admin uploaded.                      | When the site blocks us, needs a login, or is all JS. |

We cannot render a website server-side — Playwright is a dev dependency and Chromium on a
serverless function is a size-and-cold-start fight we would lose. The admin's browser already has.
That single constraint is why the screenshot route exists at all, and why every `blocked` outcome
points at it.

## The measurement principle

**The model never invents a hex.** Colours are measured deterministically first; the LLM only
decides which measured colour plays which role.

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

## What it proposes

Eight colours (`surfaceColor`, `ctaColor`, `ctaColorEnd`, `accentColor`, `accentColorEnd`,
`canvasColor`, `inkColor`, `logoBackgroundColor`), three images and the type pairing. Colours come
from either route; images and type only from the URL route, since a screenshot contains no logo file
and no font name.

Two deliberate omissions:

| Not proposed                       | Why                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvasColorDark` / `inkColorDark` | `darkenForDarkMode` already derives a dark palette from the light one, and that derivation is usually better than anything a light-mode page can say about a brand's dark mode. |
| `bannerUrl`                        | The only banner-shaped image a site reliably exposes is `og:image` at ~1.9:1, and `BRAND_BANNER_SPEC` needs 4:1 within 12%. Proposing it would guarantee a rejected upload.     |

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

In descending order of how much the page is really telling us:

1. `schema.org` `Organization.logo` — the site asserting what its logo is. Searched recursively,
   because it is usually nested under an `@graph` or hung off a `WebSite.publisher`.
2. An `<img>` in a `<header>`/`<nav>` whose class, id, alt or src says logo/brand/wordmark.
3. Any image on the page whose filename says logo.
4. `apple-touch-icon` → `logoMarkUrl`. Typically 180×180, so it clears `BRAND_MARK_SPEC`'s 128px
   floor, which the 32px favicon never does.

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

`font-match.ts` maps discovered families onto one of the six pairings, in two tiers: an **exact**
match on one of the ten faces we actually load, or a **shape** match from the family's name (a
Didone, a grotesque, a monospace). Google Fonts links outrank `font-family` stacks, since a loaded
face is a deliberate choice where a stack is mostly fallbacks.

A family that places nowhere resolves to **nothing, not `neutral`**. `neutral` is a real choice an
admin may have made deliberately, and proposing it as a fallback would overwrite that with a value
we never measured — the same mistake as defaulting a colour field.

## The failure contract

Reading a brand off the open web fails often, so the feature is designed around its failure modes
rather than its happy path. `BrandImportResult.outcome` is one of four values, and every
unsuccessful one names a next step:

| Outcome   | Means                                             | `nextStep`                    |
| --------- | ------------------------------------------------- | ----------------------------- |
| `ok`      | Three or more fields proposed                     | none                          |
| `partial` | One or two fields proposed                        | `manual`                      |
| `empty`   | We read the source and found nothing brand-like   | `screenshot` (url) / `manual` |
| `blocked` | We never got the bytes (403, timeout, unsafe URL) | `screenshot` — always         |

Three rules hold across all of them:

1. **A field we could not read is ABSENT, never a default.** A grey filled into `canvasColor`
   because we found nothing better is indistinguishable, on the form, from a grey we measured — and
   the admin would ship it. Absence is legible; a plausible wrong value is not.
2. **An unreadable source is a 200, not a 500.** "We could not find a brand in that image" is an
   ordinary answer with guidance attached. The 4xx cases are only the ones where the _request_ is
   malformed — no file, wrong bytes, a decompression bomb, too small — which the admin fixes by
   sending a different file rather than by trying a different route.
3. **`blocked` always points at the screenshot.** We cannot render a website server-side (Playwright
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
| `brand-import/result.ts`                                | The shared contract — outcomes, proposals, the `analysedResult` / `blockedResult` builders. Pure. |
| `brand-import/color.ts`                                 | Hex ↔ channels, chroma, redmean distance. Pure.                                                   |
| `brand-import/palette.ts`                               | Buffer → ranked candidates (sharp). Bucket, then merge.                                           |
| `brand-import/assign-roles.ts`                          | The one model call, plus `narrowAssignments`.                                                     |
| `brand-import/contrast.ts`                              | Annotates an unreadable canvas/ink pair. Reuses `contrastRatio` / `MIN_CONTRAST_RATIO`.           |
| `brand-import/analyse.ts`                               | The screenshot entry point; phase 2's URL path reuses everything below the harvest.               |
| `app/api/v1/app/demo-clients/brand-import/route.ts`     | Gate stack + the multipart boundary.                                                              |
| `components/admin/demo-clients/brand-import-dialog.tsx` | Upload, per-field accept, the palette strip.                                                      |

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
- **Magic bytes run before the detected type reaches the model.** The type attached to the vision
  call is the DETECTED one, never the browser's claim, so a mislabelled upload cannot send the
  provider a lie about its payload.

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

A one-line reminder sits beside the import button: check you are entitled to use the client's
branding. Pulling a prospect's logo is equivalent to an admin downloading it manually, but the
product should say so rather than imply we have checked.
