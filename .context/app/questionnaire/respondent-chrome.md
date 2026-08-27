# Respondent chrome

How much of **ConQuest** shows around a respondent surface, and the shell that stopped every page
guessing its own height.

> **Orthogonal to the layout.** `respondentLayout` arranges the questionnaire's own parts;
> `respondentChrome` decides what surrounds them. A white-labelled Broadsheet and a fully-branded
> Broadsheet are the same arrangement in different clothes. Every combination is valid.

## The problem this solves

`/q`, `/x` and `/m` lived in the `(public)` route group, so every questionnaire link — including
one a client sent to their own customers, under their own brand, with our name nowhere in the
covering email — arrived wrapped in the ConQuest marketing header and footer. A respondent
half-way through a consultation could click Pricing.

That is a commercial problem before it is a design one. It also had a mechanical twin: because the
chrome was fixed, every page hard-coded its own arithmetic against it.

| Page                          | Height it assumed | Width it used           |
| ----------------------------- | ----------------- | ----------------------- |
| `/q/[versionId]`              | `100dvh - 9rem`   | `RESPONDENT_SHELL`      |
| `/q/loading.tsx`              | `100dvh - 9rem`   | `max-w-3xl` ← disagreed |
| `/x/[publicRef]`              | `100vh - 8rem`    | `RESPONDENT_SHELL`      |
| `/m/[joinRef]`                | `100vh - 8rem`    | `max-w-4xl` ← disagreed |
| `/questionnaires/[sessionId]` | `100vh - 12rem`   | `RESPONDENT_SHELL`      |

Five numbers describing one thing, disagreeing by up to 4rem, none of them checkable — and all of
them wrong the moment the chrome above them becomes a setting. The `/q` skeleton's width was
visibly wrong today: the conversation jumped wider the instant the page loaded.

## The parts

| Part           | File                                                        | Role                                 |
| -------------- | ----------------------------------------------------------- | ------------------------------------ |
| The vocabulary | `lib/app/questionnaire/types.ts` (`RESPONDENT_CHROMES`)     | The three modes and the default      |
| Human copy     | `lib/app/questionnaire/layout/catalog.ts`                   | Labels + descriptions, one source    |
| The component  | `components/app/questionnaire/chrome/respondent-chrome.tsx` | Draws the chrome AND owns the height |
| Route group    | `app/(respondent)/`                                         | Inherits no chrome; URLs unchanged   |
| The setting    | `app_questionnaire_config.respondentChrome`                 | Per questionnaire version            |

## The three modes

- **`full`** — the ConQuest site header and footer, exactly as every respondent page has always had
  them. The default, so no existing questionnaire changes appearance.
- **`co_branded`** — a slim ConQuest wordmark above the questionnaire's own brand band, and nothing
  below. Deliberately **not a link**: a respondent mid-questionnaire offered a route to our pricing
  page is a respondent who might take it, and this mode was chosen precisely to keep them here.
- **`white_label`** — the questionnaire alone, no ConQuest branding at all. Including the browser
  tab: `/q`'s `generateMetadata` drops the layout's `" - ConQuest"` title template for an absolute
  title, because a tab is part of what a respondent sees.

## The shell measures itself

`RespondentChrome` is a flex column of exactly viewport height (`h-dvh`). The chrome sizes to its
content; the surface takes the rest (`flex-1 min-h-0`). No page knows or cares how tall a header is,
which is what makes the chrome a setting rather than a constant.

Two details are load-bearing and both have a failure mode worth naming:

- **Flex, not the grid this was planned as.** A three-row grid puts a lone child in row ONE — so a
  white-label page, with no header and no footer, would have had its conversation land in the
  header's row and size to its content. Flex has no such trap: absent chrome is simply absent.
- **`min-h-0` on the surface.** Without it a flex child refuses to shrink below its content, the
  surface grows past the viewport, the conversation's internal scroll never engages, and the
  composer ends up below the fold with the _page_ scrolling instead.

`RESPONDENT_SHELL` rides here too, so every respondent surface gets the shared reading width — and
the viewport text-scale ladder that keys off `cq-respondent-shell` — by construction. That is how
`/m` got it back: the meeting participant surface had its own `max-w-4xl` and had silently lost the
ladder. A page that genuinely sets its own width (the `/x` "we can't open this here" card) passes
`shell={false}`.

## The default is load-bearing

There is no backfill. Every questionnaire that predates the column keeps its header and footer
because four layers all resolve an absent or unrecognised value to `full`:

| Layer          | Where                                    | Behaviour                          |
| -------------- | ---------------------------------------- | ---------------------------------- |
| Column default | the migration                            | `DEFAULT 'full'`                   |
| Config default | `DEFAULT_QUESTIONNAIRE_CONFIG`           | `'full'`                           |
| DB → view      | `asRespondentChrome` in `_lib/detail.ts` | unknown → default                  |
| Version read   | `resolveRespondentChromeForVersion`      | absent config or unknown → default |

Same asymmetry as the layout, for the same reason: the **write** boundary (`updateConfigSchema`)
_rejects_ an unknown mode, because an admin PATCHing one is a caller bug; every **read** boundary
accepts it and falls back, because a stored unknown value is a rollback artefact a live respondent
has to survive. `tests/unit/lib/app/questionnaire/layout/respondent-chrome-default.test.ts` walks
all of it.

## What it deliberately does NOT cover

**The signed-in surface** (`/questionnaires/[sessionId]`) keeps the app's own navigation whatever
this is set to. A respondent with a ConQuest account is inside the product; hiding its navigation
would white-label a page they can see the rest of the product from anyway, and strand them with no
way out. It therefore also keeps its `100vh - 12rem`: killing that arithmetic means making the
`(protected)` layout self-measuring, which would make every authenticated page fixed-height. That
is a separate change with a much wider blast radius, and it is not smuggled in here.

**`/m` renders `full` unconditionally.** A meeting's breakout rooms can each run a different
questionnaire version, and the participant surface swaps sessions in place without a server render —
so reading chrome per session would change the frame around people mid-meeting, which is the one
thing a facilitated room cannot have. Making it configurable waits for a per-**meeting** setting to
read; the route move and the shared shell it did get, and those were the parts that were broken.

**The loading skeleton draws no chrome.** Which chrome a questionnaire wants is one of the things
still being resolved when the skeleton shows, and a guess would flash a header that then vanished on
a white-labelled page. A brief chrome-less moment is the honest version.

**`/x/new/[experienceId]` draws no chrome.** It is a transient boot that mints a run and redirects
to `/x/<publicRef>`, and it does not yet know which questionnaire — so which chrome — it is heading
for. Rendering `full` there would flash a ConQuest header on the way into a white-labelled run,
which is the promise this feature exists to keep. It centres its own spinner and error card, so
chrome-less it reads as a loading step rather than a broken page.

**`/m`'s tab title** still carries the template, which is consistent — that page is hard-coded to
`full` chrome anyway.

`/x` does not: its title is **absolute** (`{ absolute: 'Your conversation' }`), unconditionally
rather than per-chrome. Making it chrome-aware would mean resolving the RUN inside
`generateMetadata`, and `resolveRunSurface` is a cookie-credential check plus a query that is not
memoised — so it would run the whole credential path twice on every load of the respondent hot
path. "Your conversation" is truthful under all three modes, and the two branded modes still show
our name on the page itself, which is where branding belongs.

## One thing to confirm with whoever owns the privacy notice

`white_label` (and `co_branded`) drop `PublicFooter`, and with it the **Privacy and Terms links**
that a respondent on `/q` or `/x` would otherwise have had at the foot of the page.

The cookie-consent banner is unaffected — it is mounted in the ROOT layout (`app/layout.tsx`), not
the public one, so it renders under every chrome mode. Nothing about consent capture changes.

But if those footer links are part of how a deployment surfaces its privacy notice to respondents,
then a white-labelled questionnaire needs that notice reachable some other way — the client's own
page around the link, the intro splash, or a link the questionnaire itself carries. That is a
product and legal decision rather than a technical one, which is why it is written down here rather
than solved in code: the mode is doing exactly what it was asked to do.

## Related

- `.context/app/questionnaire/respondent-layouts.md` — the arrangement axis, and the slot contract
- `.context/app/questionnaire/respondent-layout.md` — the shared width/geometry constants
- `.context/app/questionnaire/configuration.md` — the setting alongside every other per-version one
