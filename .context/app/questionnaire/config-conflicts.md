# Version-config conflict detection

A questionnaire's Settings span several independent axes (presentation, identity, capture, tone,
safeguarding…). Some combinations are **contradictory or silently no-op at runtime** — e.g. profile
fields on an anonymous version are never collected, or a "conversation" that's actually form-only can't
run the interviewer. Left unsurfaced, an admin sets something and it just doesn't happen.

The config editor now detects these live and flags them where the admin is working.

## How it surfaces

- **Summary banner** at the top of the Settings column — a count + one line per conflict, each a
  jump-link (`#<sectionId>` anchor) to the offending section. Renders nothing when the config is
  coherent.
- **Inline alert** at the top of each affected `SettingsGroup`, so the warning sits exactly where the
  setting is edited.

Both update **live** as the admin edits (the detector runs over the current in-editor state via
`useMemo`). Alerts are **non-blocking** — they warn, they never prevent saving (some combinations are
deliberate mid-edit states). Styling is by severity: `error` (won't work as set) · `warning` (partly
ignored) · `info` (redundant/no-op).

## The detector (pure)

`lib/app/questionnaire/authoring/config-conflicts.ts` — `detectConfigConflicts(input)` returns
`ConfigConflict[]` (`{ id, severity, sectionId, title, message }`). Pure: no Prisma / React / IO — the
same slice of config the editor holds is enough, so it's fully unit-tested
(`tests/unit/lib/app/questionnaire/authoring/config-conflicts.test.ts`).

UI: `components/admin/questionnaires/config-conflicts.tsx` (`ConfigConflictBanner`, `SectionConflicts`).
Wiring: `config-editor.tsx` computes `conflicts` and passes `conflictsFor(sectionId)` to each
`SettingsGroup` (which renders `SectionConflicts` atop its body) plus the top-level banner.

## Rules (grounded in the runtime gating)

| id                                 | Severity | When                                                                              | Why it's a conflict                                                                                                      |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `anonymous-hides-capture`          | error    | `anonymousMode` **and** profile capture on (fields present)                       | `resolve-capture.ts` returns `null` for anonymous → fields never collected                                               |
| `form-only-conversational-capture` | error    | `presentationMode='form'` **and** a field's effective placement is conversational | form-only never runs the interviewer, so in-chat capture can't happen                                                    |
| `form-only-persona`                | warning  | `form` **and** persona selection enabled                                          | the picker requires the chat carousel (`showPersona` needs `showChat`)                                                   |
| `form-only-reasoning`              | warning  | `form` **and** reasoning stream enabled                                           | the reasoning trace renders only in the chat surface                                                                     |
| `form-only-composer`               | warning  | `form` **and** voice or attachment input enabled                                  | those live in the chat composer, absent in form-only                                                                     |
| `min-questions-unreachable`        | warning  | `minQuestionsAnswered > questionCount`                                            | completion can never satisfy the floor                                                                                   |
| `sensitivity-no-support`           | info     | `sensitivityAwareness` **and** empty `supportMessage`                             | an empty message disables the signpost, so nothing shows                                                                 |
| `adaptive-scope-targeted-opening`  | warning  | Adaptive Scope on **and** `approach='targeted'`                                   | the planner routes off the opening; targeted asks one narrow question from turn one, so there may be nothing to route on |
| `adaptive-scope-no-probes`         | warning  | Adaptive Scope on **and** `limitOpeningProbes` **and** `maxOpeningProbes=0`       | an opening answer too vague to route on can never be clarified, so the planner falls back                                |
| `adaptive-scope-guided-openings`   | info     | Adaptive Scope on **and** `openingMode='examples'` with something written         | the examples steer the very answer the planner reads, not just the tone                                                  |

### The three that cross a tab boundary

The house-rules and opening checks describe settings that live on this tab. The `adaptive-scope-*`
three do not: Adaptive Scope is authored on the **Topics** tab and has its own server-side coherence
checker (`validateAdaptiveScope`), which answers "is this routing setup well-formed". These answer a
different question that neither surface could see — **the two features meet at the opening, and only
there**.

The Scope Planner runs once, the moment the opening topics are covered, and decides the rest of the
interview from what the respondent said. The questioning approach decides how that opening is asked.
When they disagree nothing errors and nothing is empty — `planScope` never throws, it falls back — so
the instrument quietly asks less than its author believes it asks.

All three anchor to `interviewer-strategy`, not to Adaptive Scope: that is the setting the admin
would change, and it is the one on this tab. They read `config.adaptiveScope`, which `ConfigEditor`
has had in its props all along (`CONFIG_SELECT` selects it) and simply never read — so they cost no
new query.

### Two builders, deliberately

`ConfigConflictInput` is assembled twice:

- **The Settings editor** builds it in a `useMemo` over unsaved local `useState` values, so the
  banner reacts as the admin types.
- **`configConflictInputFromConfig(config, questionCount)`** builds it from a saved `ConfigView`,
  for surfaces describing a version as it stands — the launch-readiness section on the version
  overview.

That is the right number, not a smell: "what would this be if I saved now" and "what is this today"
are different questions. They cannot drift silently either, because `ConfigConflictInput` has no
optional fields — a new one breaks both call sites at compile time.

### At launch time

`detectConfigConflicts` is deliberately **not** a launch-readiness check. Readiness rows are pass/fail
gates and this detector never emits `error` by design, so wiring it in would misrepresent both.

Instead the overview page renders `ConfigConflictBanner` above the checklist, with `basePath` set to
the settings path so each row links to the control that fixes it. The finding that motivated it is
`house-rules-overpromise-anonymity`: warning severity, so it never blocked anything, yet it is a
claim the client has to stand behind afterwards — and it was visible only to an admin who happened
to open the Settings tab.

### Adding a rule

Append a block to `detectConfigConflicts` (errors first, then warnings, then info), add the field to
`ConfigConflictInput` if it's new, thread it in from the editor's `useMemo`, and add a case to the unit
test. If the rule points at a section that isn't yet wired, add `conflicts={conflictsFor('<id>')}` to
that `SettingsGroup` and a label to `SECTION_LABELS` in `config-conflicts.tsx`.

## Related fixes shipped alongside

- **"Responses are anonymous" badge** now reflects the version's `anonymousMode` config, not merely a
  no-login/preview session (`session-status.ts` — was `respondentUserId === null`). A no-login walk-up
  on a non-anonymous questionnaire still collects a name/email, so the badge must not claim anonymity.
- **Anonymous-mode toggle relocated** from "Respondent experience" to **"Access & invitations"** (with a
  note that it's the independent _identity_ axis), so it's findable next to Access. See
  [[questionnaire-access-mode-gates-walkup]] for the access-vs-identity distinction.
