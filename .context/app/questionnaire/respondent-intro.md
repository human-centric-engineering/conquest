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

| Field               | Where                                         | Notes                                                      |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `intro.enabled`     | `AppQuestionnaireConfig.intro` (JSON)         | The per-version toggle.                                    |
| `intro.background`  | `AppQuestionnaireConfig.intro` (JSON)         | Admin markdown — "about this questionnaire". May be blank. |
| `intro.buttonLabel` | `AppQuestionnaireConfig.intro` (JSON)         | Proceed-button text; `''` = a per-mode default.            |
| `introBackground`   | `AppCohort.introBackground` (nullable column) | Cohort override of the background (see below).             |

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
  flag): enable toggle, background markdown textarea, button-label input. Saved whole in the config
  PATCH (like the tone block).
- **Cohort form** (`cohort-form.tsx`): "Intro background override" textarea.

## Where the code lives

| Concern                 | Location                                                                      |
| ----------------------- | ----------------------------------------------------------------------------- |
| Settings type/default   | `lib/app/questionnaire/types.ts` (`IntroSettings`)                            |
| Narrow / copy / resolve | `lib/app/questionnaire/intro/{settings,copy,resolve}.ts`                      |
| Read endpoint           | `app/api/v1/app/questionnaire-sessions/[id]/intro/route.ts`                   |
| Gate + splash UI        | `components/app/questionnaire/intro/{session-entry,questionnaire-splash}.tsx` |
| Admin config card       | `components/admin/questionnaires/config-editor.tsx`                           |
| Cohort override field   | `components/admin/cohorts/cohort-form.tsx`                                    |
| Flag                    | `APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG`; seed `048-intro-screen-flag.ts`       |
