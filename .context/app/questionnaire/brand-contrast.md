# Contrast optimiser

An admin sets a dozen colours on a demo client's branding form, and until this feature nothing told
them whether a respondent could **read** the result.

The form warned about exactly one pairing — ink on canvas — which is worse than warning about none.
An admin who sees no warning reasonably concludes the theme is fine. It is not: the button label,
the header-band title and the accent used for links are all **derived**, which reads as "handled
automatically" and is not the same as "readable". A mid-tone brand colour has no label that clears
AA, and a single accent column is rendered on both the light and the dark ground.

So: one button, "Optimise for contrast". It measures every pairing the respondent surface actually
draws and proposes, per failure, the **nearest shade of a colour already in the brand** that clears
the threshold.

Sibling of [brand-import.md](./brand-import.md), and built to the same contract: it proposes, the
admin adjudicates field by field, it persists nothing, and the ordinary Save writes what was
accepted.

## The one idea

> An admin handed a brand does not want it **replaced** when it fails contrast. They want the
> nearest version of it that passes.

Every repair therefore holds the colour's hue and moves it only along the tint/shade axis — toward
black, or toward white. Nothing ever proposes a colour that is not a shade of one already there.

## Why the arithmetic is not the model's job

A language model is bad at "what is the nearest lightness of `#2f6bff` that clears 4.5:1 against
`#fffcf5`" and confident about its answers, which is the worst combination.

It is good at "the paper stock is what this client's site is recognised by — move the ink, not the
ground", which is a judgement about a brand and not a calculation.

So the work splits:

| Layer                | Decides          | Can it invent a colour?                                    |
| -------------------- | ---------------- | ---------------------------------------------------------- |
| `audit.ts` (pure)    | what is POSSIBLE | It computes them, and proves each one clears the target.   |
| `advise.ts` (1 call) | WHICH, and why   | No — it returns an **index** into a list it did not write. |

That is the same guarantee `narrowAssignments` gives the import: a pick naming a repair that does
not exist is dropped, and the deterministic recommendation stands. The rationale is the one thing
the model genuinely authors, and it is prose shown beside a swatch the admin can see — so a wrong
sentence is visibly wrong rather than silently wrong.

**No model is not no answer.** Without a provider the repairs stand, ranked by how little they move
the brand, and the result is marked `degraded` with a sentence saying the picks are ours. Losing the
adviser costs the feature its judgement, not its correctness.

## Why a tint/shade ramp and not HSL lightness

The obvious implementation converts to HSL and scans the L axis at fixed hue and saturation. It is
wrong, and wrong on exactly the colours this feature exists for.

HSL saturation is normalised by lightness, so a pale tinted neutral — a cream page ground like
`#fffcf5`, which is what half of real brands use — reports **S = 1.0**. Darkening it "at constant
saturation" walks it down a fully saturated ramp and lands on `#422f00`, a saturated brown. That is
not a shade of the cream; it is a different colour, proposed under the claim that we had kept theirs.

This is measured, not theorised — it is what the first draft of the module actually returned.

Mixing toward black or white in sRGB is the painter's definition of a shade and a tint, and it
behaves: scaling every channel by the same factor preserves their ratios, so the hue survives and
the saturation decays the way it has to. You cannot have a vivid near-black.

### Why a scan and not a binary search

1. **Contrast against a fixed counterpart is not monotonic along the ramp.** Darkening a mid-tone
   raises contrast against white and lowers it against black. A search that assumes a direction
   walks the wrong way half the time.
2. **A colour can have to satisfy more than one constraint.** The accent is emitted once and
   rendered on both grounds, so its repair must clear both at once. There is no single direction to
   walk.

A linear scan has neither problem, provably returns the _nearest_ satisfying shade, and costs ~200
WCAG ratio computations — free at the scale this runs at. It walks **outward, alternating** darker
and lighter, so a pale brand is not always darkened toward black when a small lift would do.

## What it measures

Everything `themeToCssVariables` emits that ends up as one colour drawn on another:

| Pair                         | What the respondent sees                      | Target | What can move          |
| ---------------------------- | --------------------------------------------- | ------ | ---------------------- |
| `canvas-light` `canvas-dark` | body text on the page, in both modes          | 4.5:1  | the ink or the canvas  |
| `cta`                        | the label on the send button                  | 4.5:1  | the button colour only |
| `cta-end`                    | the same label at the far end of the gradient | 4.5:1  | the gradient end only  |
| `surface`                    | the questionnaire title on the band           | 4.5:1  | the band colour only   |
| `accent-light` `accent-dark` | links and highlights, on **both** grounds     | 3:1    | the accent only        |

The button and the band have no separate text colour to move: their label is
`readableTextColor(ground)`, chosen for them. So the only repair is the ground itself — and because
moving it can flip the label from dark to light, the repaired pair is **re-derived** rather than
assumed.

`logoBackgroundColor` is deliberately absent. What sits on it is an image, and no ratio says whether
a lockup reads on a backdrop.

### It measures the RESOLVED theme, not the authored one

An admin who fills in "ink: `#FFFFFF`" off a brand guideline and leaves the canvas blank gets their
ink on our **default white page**. Measuring only authored pairs leaves the one combination
guaranteed to be unreadable as the one combination nothing checks. This is the same reasoning behind
`NEUTRAL_RESPONDENT_GROUND` in the theming module, and it reuses those same neutrals.

### Two thresholds, and why

Text is WCAG 1.4.3's 4.5:1. The accent is 1.4.11's **3:1** for user-interface components — it drives
`--color-primary`, which paints focus rings, borders and button grounds, not running copy.

Holding the accent to 4.5:1 was the first draft, and it made the feature useless rather than strict.
`--app-accent-color` is emitted once and rendered on both grounds, and the band of lightnesses
clearing 4.5:1 against a near-white _and_ a near-black is about **0.008 wide** — essentially no
saturated colour is in it. Every brand got an "unfixable" it could do nothing about.

ConQuest's own palette settles the question: `#2f6bff` on near-black is almost exactly 3:1. At 4.5
we would have been failing our own colours.

## The failure contract

| Outcome     | Means                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `clean`     | Every pairing clears its threshold. **Said out loud**, never an empty panel. |
| `proposed`  | One or more failures, each with a fix.                                       |
| `unfixable` | Failures that no shade can fix — see below.                                  |

`clean` is a real answer and the common one for a brand that was set up carefully. An admin who
presses the button and gets a blank panel reads a broken feature, not a passing check.

**`unfixable` is currently unreachable**, and the code says so rather than implying otherwise. A
tint/shade ramp runs continuously from black to white, and at the 3:1 UI threshold the satisfying
band is always wide enough for the scan to cross it. The branch stays because it is the honest
answer the day a stricter pair is added: a finding that reached neither bucket would let an admin
apply everything and believe the theme was readable. A totality test asserts every raised finding
lands in one bucket or the other.

## The theme is sent, not loaded

`POST /api/v1/app/demo-clients/optimise-contrast` takes the theme in its **body**, and that is the
whole reason the endpoint has one.

An admin presses this in the middle of adjusting colours. Reading the saved row would audit the
colours they have already moved on from — and would report a problem they have just fixed. So the
dialog is handed `livePreviewTheme`, the same object the live preview draws with, and the route
never touches the database.

Collection-scoped rather than `[id]`-scoped, like the import: the create form has no client id yet,
and a theme is worth checking before the client exists. `demoClientId` is cost context only.

The body validates with `themeFieldsSchema` — the schema the PATCH uses — so a body that passes here
is one the save would accept. A body that validated on the check and failed on the save would let an
admin accept a proposal they can never store.

## What the admin sees

Proposals arrive **pre-ticked**: the job is to veto what they disagree with, not to re-select fixes
they have just been told are necessary.

Each row shows **before → after** as swatches with their ratios, because a contrast proposal is only
judgeable next to what it replaces. The real question is not "does this pass" but "is this still
their brand".

Two details that look like polish and are not:

- **The repair carries the pair it produces** (`resultingGround` / `resultingInk`) rather than
  letting the dialog work out which half moved. Deriving it by comparing the repaired colour to the
  finding's ink breaks when the ground and the ink are the _same_ colour — which is exactly the
  state the worst finding has (white ink on the default white page).
- **The Apply button counts fields, not proposals.** The accent fails as two findings and is
  repaired by shading one colour, so "Apply 2 changes" for one moved field overstates what the
  button does.

Accepted repairs are written into **form state** through the same `setColor` the pickers use, so an
accepted repair is indistinguishable from the admin dragging the swatch there themselves. A
compile-time assertion in the form pins that every optimisable field is a colour field it can write
— otherwise an admin would accept a fix, watch nothing change, and save the unreadable colour.

## Modules

| File                                                         | Job                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `brand-contrast/index.ts`                                    | The barrel. `result`, `shade` and `audit` are pure; `advise` and `optimise` are server-only. |
| `brand-contrast/result.ts`                                   | The contract — findings, repairs, proposals, outcomes. Pure.                                 |
| `brand-contrast/shade.ts`                                    | The tint/shade ramp and `nearestReadableShade`. Pure.                                        |
| `brand-contrast/audit.ts`                                    | The pairs that render, their targets, and every legal repair. Pure.                          |
| `brand-contrast/advise.ts`                                   | The one model call, plus `applyPicks` and `recommendDefault`.                                |
| `brand-contrast/optimise.ts`                                 | The entry point: audit → advise → outcome.                                                   |
| `app/api/v1/app/demo-clients/optimise-contrast/route.ts`     | Gate stack; the theme arrives in the body.                                                   |
| `components/admin/demo-clients/contrast-optimise-dialog.tsx` | Run, review before/after, accept per proposal.                                               |
| `prisma/seeds/app-questionnaire/100-brand-contrast-agent.ts` | The adviser persona.                                                                         |

## Cost and provenance

Spend is logged via `logAppLlmCost` under `capability: 'app_brand_contrast'` with `versionId: null`
— a theme belongs to a demo client, not to a questionnaire version — and the client id in `extra`.

**No `AppAiRun` row is written**, for the same reason the brand import writes none: this proposes
cosmetics the admin adjudicates in full before any save. See
[ai-run-provenance.md](./ai-run-provenance.md).

Rate limited per admin at 30/min (`brandContrastLimiter`) — a band above the import's 10/min,
because the honest loop here is optimise → tweak → re-check and this is a button an admin is _meant_
to press repeatedly.
