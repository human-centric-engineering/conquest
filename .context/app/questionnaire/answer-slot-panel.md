# Answer-slot panel (F7.2)

The live panel beside the respondent chat that shows the questionnaire's answer slots
as the conversation fills them in — confidence, provenance, refinement history, and a
per-slot "Revisit". Pure consumer UI on top of **one new read endpoint**. Gated by
`APP_QUESTIONNAIRES_ENABLED` + `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED` (the same
flags as the chat surface).

`// DEMO-ONLY:` everything here is questionnaire-domain — a non-questionnaire fork
strips the `panel/` directory and the `answers` route and keeps the generic chat.

## The data seam

The F6.1 streaming route (`POST …/questionnaire-sessions/:id/messages`) emits only
`start | content | warning | done | error` — **no answer-slot events**; answers are
persisted server-side (`persistTurn`) just before `done`. So the panel reads its own
endpoint and refetches when each turn settles, rather than the chat stream carrying
slot updates. This keeps the streaming contract untouched.

### `GET /api/v1/app/questionnaire-sessions/:id/answers`

Returns `{ success: true, data: AnswerPanelView }`. Gate order mirrors the messages
route: **live-sessions flag (404 before auth) → load session → `resolveTurnAccess`
(401/403) → respond**. It reuses `resolveTurnAccess` (an authenticated owner OR a valid
anonymous `X-Session-Token`), so it serves both respondent kinds; `withAuth` can't. No
status gate — a paused or completed session still shows its answers. No extra rate
limiter (a read inherits the automatic 100/min on `/api/v1/**`).

`AnswerPanelView` (the client-safe projection):

```
{ status, scope, sections: [{ sectionId, title, slots: [PanelSlotView] }], answeredCount, totalCount }
```

`PanelSlotView` carries `slotKey` (the stable per-version slug, never the cuid),
`prompt`, `type`, `required`, `answered`, and — when answered — `value`, `provenance`,
`confidence` (0–1, null = unscored), `rationale`, `answeredAtTurnIndex`, and
`refinementHistory`. Authoring internals (`weight`, tags, config) are **not** projected.

## Scope (admin config)

The version's `answerSlotPanelScope` config field (configuration.md) decides what the
endpoint returns:

- `full_progress` (default) — every slot, grouped by section; the panel header reads
  "X of N answered".
- `answered_only` — only captured answers; the pure builder omits pending slots and
  drops sections left empty, so the **pending prompts are never sent to the client**.
  `totalCount` still reflects the whole version, so the header reads "N captured"
  honestly.

The filter lives in the pure builder, not the route — see below.

## Code map

| Concern                           | File                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| Pure view contracts               | `lib/app/questionnaire/panel/types.ts`                                                |
| Pure join + scope filter + counts | `lib/app/questionnaire/panel/answer-panel.ts` (`buildAnswerPanelView`)                |
| Confidence band mapping           | `lib/app/questionnaire/panel/confidence.ts`                                           |
| DB read seam (one query)          | `app/api/v1/app/questionnaire-sessions/_lib/answer-panel.ts` (`loadAnswerPanelState`) |
| Route                             | `app/api/v1/app/questionnaire-sessions/[id]/answers/route.ts`                         |
| Live fetch hook                   | `lib/hooks/use-answer-panel.ts`                                                       |
| Shared parent (chat + panel)      | `components/app/questionnaire/session-workspace.tsx`                                  |
| Panel components                  | `components/app/questionnaire/panel/*`                                                |

The pure core stays Prisma-free; the read seam loads plain rows (including a turn-id →
ordinal map so `lastUpdatedTurnId` becomes `answeredAtTurnIndex`) and hands them to
`buildAnswerPanelView`.

## Live update + Revisit wiring

`SessionWorkspace` owns the single `useQuestionnaireSessionStream` instance **and** the
`useAnswerPanel` fetch, then renders `QuestionnaireChat` and `AnswerSlotPanel` side by
side. Two consequences:

- **Live refresh:** the stream hook gained an additive `onTurnSettled` option, fired
  once a turn settles cleanly to `idle` (not on error/abort). `SessionWorkspace` routes
  it to **both** `panel.refetch` and the F7.3 lifecycle-status refetch, so the answer
  panel and the Submit affordance update off the same settle. (F7.3 also lifted a third
  hook, `useSessionLifecycle`, into `SessionWorkspace` — see
  [`session-lifecycle.md`](./session-lifecycle.md).)
- **Revisit:** because the chat and panel share one stream, the panel's confirm-gated
  "Revisit" button calls `stream.sendMessage("I'd like to revisit my answer to: …")`,
  re-asking the question through the same turn loop. Disabled while `!stream.canSend`.

`QuestionnaireChat` was refactored to **receive the stream as a `stream` prop** (the
hook call moved up to `SessionWorkspace`); its rendering is otherwise unchanged and it
stays a single readable column.

## Layout

Both respondent pages render `SessionWorkspace` inside the existing
`BrandThemeProvider`, so the panel inherits the brand CSS vars (`--app-accent-color`,
`--app-cta-color`) with no prop-drilling. The grid is
`lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_26rem]`; below `lg` the panel is
`hidden lg:flex`, so small screens get the full-width chat (the F7.1 experience). The
authenticated page SSR-seeds the panel via `loadAnswerPanelState` (the owner is already
verified); the anonymous page can't (the token is client-only), so its panel shows a
brief skeleton before the first fetch.

## Confidence language

`confidence.ts` maps a 0–1 confidence to a quiet, semantic band. Four scored bands (not the
earlier three) track the finer extraction rubric (0.3–1.0 by directness × elaboration ×
certainty): **high** ≥0.85 ("Confident"), **moderate** ≥0.65 ("Fairly sure"), **tentative**
≥0.45 ("Tentative"), **low** <0.45 ("Unsure"), plus **unscored** ("Captured"). This deliberately
**decouples** the respondent panel from the admin eval chips (`evaluation-metric-chips.tsx`, still
two-cut at 0.85/0.6) — the panel needs the extra resolution to make the new nuance legible.

The respondent sees a tinted dot (`ConfidenceIndicator`) **and** the label + raw percentage
(`ConfidenceScore`, e.g. "Fairly sure · 62%") on every captured slot — by product decision the
nuanced 30–100% range is shown, not collapsed to a band word. The panel header pairs completion
with the **average confidence** across all filled slots (an honest mean — a tangential, low-confidence
fill drags it down by design), computed server-side in `_lib/answer-panel.ts` and carried on
`AnswerPanelView.averageConfidence`.

## Not here

Read-only display, so no `<FieldHelp>` (that's for form inputs). Session-lifecycle UX
(pause/resume controls, completion prompt) is **F7.3**; PDF export is **F7.4**.
