# Chat-transcript export (F7.6)

The respondent can download their **conversation** — the verbatim chat turns — as a branded
PDF or plain text. This is distinct from the F7.4 [respondent report / answers
export](./respondent-report.md): F7.4 renders the captured _answers_; F7.6 renders the
_conversation_ that produced them.

Gated by the live-sessions platform flag (`APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED`, a
[feature-flag row](./feature-flags.md)) — the same gate as the rest of the respondent surface.
No migration: it reads existing `AppQuestionnaireTurn` rows.

## What's in the document

Both formats open with an **intro / context block**, then the conversation:

- **Intro** — questionnaire title, support **reference** (`7F3K-9M2P`), version, goal, audience,
  the respondent line, start + completion timing, status, and a short explainer of the labels and
  the UTC timestamp convention.
- **Turns** — every persisted turn, oldest-first, labelled and timestamped. The opening kickoff
  turn (empty user message) contributes only the agent's question, matching the F7.1 replay.

### Speaker labels

- The agent is always **"Interviewer"**.
- The respondent is **their display name** when one is known AND the session is **not anonymous**;
  otherwise the generic **"Respondent"**. Anonymous mode never leaks identity into the label — the
  redaction is enforced in the pure builder (`build-transcript-export-model.ts`), not just the UI,
  the same contract as the F7.4 export.

### Timestamps

Formatted in **UTC** (e.g. `1 Jun 2026, 10:04`). The export is generated server-side with no
knowledge of the respondent's timezone, and a fixed zone keeps the pure builders deterministic for
tests. The intro notes the UTC convention. Each turn carries its underlying turn-row `createdAt`;
the user message and agent reply within one turn share that timestamp.

## Routes

| Route                                             | Returns                     | Auth                                      |
| ------------------------------------------------- | --------------------------- | ----------------------------------------- |
| `GET …/questionnaire-sessions/:id/transcript.pdf` | `application/pdf`           | `resolveTurnAccess` (owner OR anon token) |
| `GET …/questionnaire-sessions/:id/transcript.txt` | `text/plain; charset=utf-8` | `resolveTurnAccess`                       |

Both are `withLiveSessionsEnabled`-gated, dot-segment routes. Gate order mirrors the F7.4
`export.pdf`: **flag (404 before auth) → load → access (401/403) → build → render → respond.** The
PDF route is `runtime = 'nodejs'` (`@react-pdf/renderer` renders to a Node Buffer); the logo is
fetched best-effort **only after** access is granted. The text route skips the logo fetch
(`fetchLogo: false`). Download filename: `transcript-<slug>-v<N>.<ext>`, `Cache-Control: no-store`.

Registry: `API.APP.QUESTIONNAIRE_SESSIONS.transcriptPdf(id)` / `.transcriptText(id)`.

## Code map

| Concern                       | File                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| View contract (pure)          | `lib/app/questionnaire/export/transcript-types.ts`                     |
| Model builder (pure)          | `lib/app/questionnaire/export/build-transcript-export-model.ts`        |
| Text serialiser (pure)        | `lib/app/questionnaire/export/build-transcript-text.ts`                |
| Shared UTC date/status format | `lib/app/questionnaire/export/transcript-format.ts`                    |
| PDF document                  | `components/app/questionnaire/export/transcript-pdf-document.tsx`      |
| DB seam + assembly            | `app/api/v1/app/questionnaire-sessions/_lib/transcript-export.ts`      |
| Shared logo fetch             | `app/api/v1/app/questionnaire-sessions/_lib/fetch-logo-data-uri.ts`    |
| PDF render helper             | `app/api/v1/app/questionnaire-sessions/_lib/render-transcript-pdf.tsx` |
| Response helpers              | `app/api/v1/app/questionnaire-sessions/_lib/transcript-response.ts`    |
| PDF route                     | `app/api/v1/app/questionnaire-sessions/[id]/transcript.pdf/route.ts`   |
| Text route                    | `app/api/v1/app/questionnaire-sessions/[id]/transcript.txt/route.ts`   |
| Download control (UI)         | `components/app/questionnaire/lifecycle/transcript-download.tsx`       |

## UI surfaces

A quiet **"Transcript"** dropdown (Themed PDF / Plain text):

- **Lifecycle bar** — in the right cluster beside the [ref chip](./session-lifecycle.md),
  available throughout the conversation once a real exchange exists (`turnCount > 1`).
- **Completion screen** — beside the F7.4 responses download, always available once submitted
  (independent of the responses-report config).

Both use the `TranscriptDownload` component: each option `fetch`es (so it can send the anonymous
`X-Session-Token` header — a no-login respondent has no cookie), saves the blob honouring the
server's `Content-Disposition` filename, and surfaces a transient inline error on failure.

## Forking

`// DEMO-ONLY (F7.6):` — the export modules are questionnaire-domain shape and strip alongside the
F7.4 answers export. The shared `fetch-logo-data-uri.ts` and `resolveTheme` come from the
[theming module](./demo-clients.md), which a real engagement renames rather than strips.
