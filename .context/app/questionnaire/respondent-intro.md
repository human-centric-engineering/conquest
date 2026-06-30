# Respondent intro / splash screen (F12.1)

An admin opt-in cover screen shown to a respondent **before** the questionnaire starts. It explains
how the questionnaire works (adapting to the presentation mode), what they'll receive at the end
(adapting to the respondent-report settings), and shows an admin-authored "about this questionnaire"
background section — optionally overridden per cohort. The respondent presses a button to begin; no
LLM turn is spent until they do.

Off by default, so existing launched questionnaires are unchanged.

## Two gates, plus a fresh-session rule

The splash appears only when **all** of these hold:

1. **Platform flag** `APP_QUESTIONNAIRES_INTRO_SCREEN_ENABLED` is on (`isIntroScreenEnabled()` =
   master AND the sub-flag — see [`feature-flags.md`](./feature-flags.md)).
2. **Per-version toggle** `config.intro.enabled` is on (the admin opted this version in).
3. **Fresh session** — `autoStart` is true. A resume drops straight back into the conversation
   (mirrors the `animateOpening` rule); the splash is a once-at-the-start screen, not a gate on every
   reload.

When any gate is off, the respondent goes straight into the questionnaire exactly as before.

## What's stored vs derived

Only three fields are authored; the rest of the copy is **derived at runtime** so it always matches
the live settings (never drifts).

| Field               | Where                                         | Notes                                                                                                  |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `intro.enabled`     | `AppQuestionnaireConfig.intro` (JSON)         | The per-version toggle.                                                                                |
| `intro.background`  | `AppQuestionnaireConfig.intro` (JSON)         | Admin markdown — "about this questionnaire". May be blank.                                             |
| `intro.buttonLabel` | `AppQuestionnaireConfig.intro` (JSON)         | Proceed-button text; `''` = a per-mode default.                                                        |
| `intro.videoUrl`    | `AppQuestionnaireConfig.intro` (JSON)         | Optional YouTube/Vimeo link; `''` = no video. Not cohort-overridable. See [Intro video](#intro-video). |
| `introBackground`   | `AppCohort.introBackground` (nullable column) | Cohort override of the background (see below).                                                         |

`IntroSettings` + `DEFAULT_INTRO_SETTINGS` live in `lib/app/questionnaire/types.ts`; the stored JSON
is defensively narrowed by `narrowIntroSettings` (`lib/app/questionnaire/intro/settings.ts`), the
sibling of `narrowRespondentReportSettings`.

### Derived copy — `buildIntroCopy`

Pure function in `lib/app/questionnaire/intro/copy.ts`. From `{ presentationMode, report,
anonymousMode, voiceEnabled, buttonLabelOverride }` it returns:

- **How it works** — one of three bodies keyed on `presentationMode` (chat / form / both).
- **What you'll get at the end** — `null` when the report is off; otherwise keyed on
  `respondentReport.mode` (raw / raw_plus_insights / narrative), with a delivery clause built from
  `delivery.onScreen` + `delivery.download`. Only the AI modes mention the post-submit wait.
- **Good to know** — honesty always; anonymity when `anonymousMode`; voice when `voiceEnabled`.
- **buttonLabel** — the admin override, else a per-mode default ("Start the conversation" / "Start the
  questionnaire" / "Get started").

## Cohort override (replace semantics)

A cohort's `introBackground`, when non-empty, **replaces** the version-level `intro.background` for
that cohort's respondents; blank/null inherits the version text. Resolved by `resolveSessionIntro`
(`lib/app/questionnaire/intro/resolve.ts`) walking `session → cohortMember → cohort` — the same
fallback shape as theme resolution (`chat/theme.ts`). Only the background is overridable; the
how-it-works / what-you'll-get copy is intrinsic to the version's settings. See
[`cohorts.md`](./cohorts.md).

## Intro video

`intro.videoUrl` is an optional YouTube/Vimeo link the admin pastes on the Settings tab; the splash
embeds it in the LEFT "about" column (above the background card), grouped with the about text. One
video per version — unlike `background`, it is **not** cohort-overridable.

The security property lives in `resolveIntroVideo` (`lib/app/questionnaire/intro/video.ts`, pure):
the admin's raw link is parsed to a video id and the iframe `src` is **built** as a trusted
`https://www.youtube-nocookie.com/embed/<id>` or `https://player.vimeo.com/video/<id>` — never the
raw input. So the only sources the iframe can ever load are those two hosts; an unrecognised link,
a non-`http(s)` scheme (`javascript:`/`data:`), or a malformed id all resolve to `null` and no
iframe renders. This runs at **two seams** that must agree:

- **Write** — `introSettingsSchema`'s `superRefine` (`authoring/config-schema.ts`) rejects a
  non-empty link that doesn't resolve, with the error on `intro.videoUrl`, so every stored value is
  embeddable.
- **Render** — `IntroVideo` (`components/app/questionnaire/intro/intro-video.tsx`) resolves the
  stored link again and returns `null` (renders nothing) when it doesn't — defence in depth against a
  value that bypassed the write path (seed / direct DB write).

The iframe also needs the embed hosts in the page CSP: `frame-src` allow-lists exactly
`https://www.youtube-nocookie.com` and `https://player.vimeo.com` (the only two hosts the resolver
can produce) via `VIDEO_EMBED_FRAME_SRC` in `lib/security/headers.ts`. Without that the browser
blocks the frame ("This content is blocked. Contact the site owner to fix the issue.").

Supported forms: YouTube `watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`, `m.youtube.com`;
Vimeo `vimeo.com/<id>`, unlisted `vimeo.com/<id>/<hash>` (carried through as `?h=`),
`vimeo.com/channels/.../<id>`, `player.vimeo.com/video/<id>`.

> **Testing note:** a component that renders this live `<iframe>` runs under **jsdom**
> (`// @vitest-environment jsdom` docblock), not the project-default happy-dom — jsdom ignores the
> iframe `src`, while happy-dom tries to navigate it (real network + noisy aborts).

## Runtime wiring

`SessionEntry` (`components/app/questionnaire/intro/session-entry.tsx`) gates `SessionWorkspace`
behind `QuestionnaireSplash`. This matters: the workspace fires the LLM kickoff turn on mount, so the
splash must sit **before** it — the workspace only mounts after the respondent presses the button.
Both respondent surfaces render `SessionEntry` instead of the workspace directly:

- **Authenticated** (`app/(protected)/questionnaires/[sessionId]/page.tsx`) — resolves the intro
  server-side via `resolveSessionIntro` (only when the platform flag is on) and passes it down.
- **Anonymous** (`anonymous-session-boot.tsx`) — the session is created client-side, so it fetches
  the resolved intro from `GET /api/v1/app/questionnaire-sessions/:id/intro` (token-authed, validated
  with Zod, fresh-session only). The public page passes `introScreenEnabled` so the fetch is skipped
  when the platform flag is off.

`QuestionnaireSplash` is white-labelled: it inherits the client's brand via the page's
`BrandThemeProvider` CSS vars (`--app-accent-color`, `--app-cta-color`, `--app-cta-gradient`) and
renders the background markdown with the same `react-markdown` + `prose` treatment the chat uses.

## Admin surface

- **Settings tab → Intro screen card** (`config-editor.tsx`, gated on the `introScreen` workspace
  flag): enable toggle, the background editor (see below), the intro-video link input, and the
  button-label input. Saved whole in the config PATCH (like the tone block).
- **Cohort form** (`cohort-form.tsx`): the same background editor as the "Intro background override"
  (wired into react-hook-form via `watch`/`setValue`).

## Background authoring — upload / generate / refine (F12.2)

The background field is a shared control, `IntroBackgroundField`
(`components/admin/questionnaires/intro-background-field.tsx`), a controlled markdown textarea plus a
toolbar with three helpers. Each just **populates the field** — nothing persists here; the admin
reviews and saves via the existing config / cohort PATCH.

- **Upload document** → `POST …/intro-background/parse` (multipart): runs `parseDocument`
  (`lib/orchestration/knowledge/parsers`) and returns the extracted text, trimmed + capped. No LLM.
- **Generate with AI** → `POST …/intro-background/author` `{ mode: 'generate', brief }`.
- **Refine with AI** → `POST …/intro-background/author` `{ mode: 'refine', currentText, instruction }`
  (disabled until there's text to refine).

Both author modes dispatch the **`app_author_intro_background`** capability
(`AppAuthorIntroBackgroundCapability`), which runs one structured LLM call returning
`{ background }` (trimmed + capped) and reuses the seeded **composer agent** (the same authoring
binding as compose / refine-structure — no new agent). The prompts
(`lib/app/questionnaire/intro/authoring-prompt.ts`) fix a warm, plain, British-English respondent
voice and the JSON contract. Routes are gated by `withIntroScreenEnabled`, admin-auth, and a
per-admin LLM/upload sub-cap (the compose / ingest limiters).

## Where the code lives

| Concern                 | Location                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Settings type/default   | `lib/app/questionnaire/types.ts` (`IntroSettings`)                                                                    |
| Narrow / copy / resolve | `lib/app/questionnaire/intro/{settings,copy,resolve}.ts`                                                              |
| Intro video resolver    | `lib/app/questionnaire/intro/video.ts` (`resolveIntroVideo`)                                                          |
| Intro video embed UI    | `components/app/questionnaire/intro/intro-video.tsx`                                                                  |
| Authoring prompts       | `lib/app/questionnaire/intro/authoring-prompt.ts`                                                                     |
| Authoring capability    | `lib/app/questionnaire/capabilities/author-intro-background.ts`                                                       |
| Read endpoint           | `app/api/v1/app/questionnaire-sessions/[id]/intro/route.ts`                                                           |
| Authoring endpoints     | `app/api/v1/app/questionnaires/intro-background/{author,parse}/route.ts`                                              |
| Gate + splash UI        | `components/app/questionnaire/intro/{session-entry,questionnaire-splash}.tsx`                                         |
| Admin config card       | `components/admin/questionnaires/config-editor.tsx`                                                                   |
| Background editor       | `components/admin/questionnaires/intro-background-field.tsx`                                                          |
| Cohort override field   | `components/admin/cohorts/cohort-form.tsx`                                                                            |
| Flag                    | `APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG`; seeds `048-intro-screen-flag.ts`, `049-author-intro-background-capability.ts` |
