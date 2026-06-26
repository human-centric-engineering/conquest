# Admin session viewer

The admin surface for looking up a respondent's session by its **support reference** and reading
the conversation — the long-promised "P8 admin session view" the F7.4 admin export route was built
for. Real respondent conversations are **read-only**; an admin's own **preview** conversation can be
**continued**.

## The read-only vs. continue gate

The split is keyed on `AppQuestionnaireSession.isPreview`, and is enforced at two independent layers:

- **UI** — the viewer only renders the interactive (continuable) workspace for a preview session
  that is still `active`; everything else renders read-only.
- **Server** — an admin can only obtain a continue credential for a preview session, and the live
  turn route refuses an admin posting into a real respondent session anyway:
  - `POST …/questionnaires/:id/sessions/:sessionId/preview-token` mints a session token **only** when
    the session is a preview and active (`409 SESSION_NOT_PREVIEW` / `SESSION_NOT_ACTIVE` otherwise).
    A real respondent session is never a preview, so it is structurally un-continuable.
  - `resolveTurnAccess` (the `/messages` gate) returns `403` to any caller who is not the session's
    `respondentUserId` owner — so even with a forged token an admin cannot post into a respondent's
    authenticated session.

This is not a new permission model — it surfaces the authorization that already existed.

## Routes (admin, `withAdminAuth`)

All nested under the questionnaire so the route shape enforces ownership: the session's version must
belong to `:id`, else `404` (never confirm a cross-questionnaire session). Same pattern as the F7.4
`export.pdf` route.

| Route                                                         | Gate                        | Purpose                                                                                                                   |
| ------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET …/questionnaires/:id/sessions/:sessionId/transcript`     | `withQuestionnairesEnabled` | Read the conversation + viewer metadata (`isPreview`, `status`, `publicRef`, redacted identity). Reuses `loadTranscript`. |
| `POST …/questionnaires/:id/sessions/:sessionId/preview-token` | `withLiveSessionsEnabled`   | Mint a continue token for a preview session (the only continue path).                                                     |
| `GET …/questionnaires/:id/sessions/:sessionId/export.pdf`     | `withQuestionnairesEnabled` | Download the session's answers/results PDF (embeds the AI report when ready). The F7.4 admin export.                      |
| `GET …/questionnaires/:id/sessions/:sessionId/transcript.pdf` | `withQuestionnairesEnabled` | Download the verbatim conversation as a branded PDF. Admin twin of the F7.6 respondent transcript export.                 |
| `GET …/questionnaires/:id/sessions/:sessionId/transcript.txt` | `withQuestionnairesEnabled` | Download the verbatim conversation as plain text. Admin twin of the F7.6 respondent transcript export.                    |
| `GET …/questionnaires/sessions/by-ref/:ref`                   | `withQuestionnairesEnabled` | Resolve a support reference → its session's viewer location (static sibling of the `[id]` segment).                       |

The read seams live in `app/api/v1/app/questionnaire-sessions/_lib/admin-session-view.ts`
(`loadAdminSessionView`, `resolveSessionRefLocation`). Identity redaction **mirrors the PDF export**:
in `anonymousMode` the respondent name is never queried, so an anonymous session's viewer carries no
identity.

## UI

- **Entry points (both):** a compact "View a session" ref input in the workspace header
  (`SessionRefLookup compact`, reachable from every tab) **and** a **Sessions** tab
  (`…/v/[vid]/sessions`, gated on the `liveSessions` flag) holding the full lookup panel. The tab is
  built to later grow a per-version session list above the lookup.
- **Viewer route:** `…/v/[vid]/sessions/[sessionId]` (server component). Loads the metadata +
  transcript, branches on `isPreview`:
  - real respondent → `SessionWorkspace readOnly` (transcript replay, no composer/panel/lifecycle).
  - active preview → mints a token server-side (`mintSessionToken`) and renders the full interactive
    `SessionWorkspace` so the admin can continue.

`SessionWorkspace` / `QuestionnaireChat` gained an additive `readOnly` prop; in read-only mode the
panel/lifecycle/form hooks are made inert (`enabled: false`) since the viewing admin holds no
respondent credential, so the viewer fires **zero** respondent-scoped fetches.

## Per-session downloads

The viewer header carries a `SessionDownloads`
(`components/admin/questionnaires/sessions/session-downloads.tsx`) toolbar that gives an admin the
**same two takeaways a respondent gets** on the completion screen, for any session (active / paused /
completed):

- **Download report (PDF)** → the F7.4 admin `export.pdf` route.
- **Transcript** (Themed PDF / Plain text) → the admin `transcript.pdf` / `transcript.txt` routes
  above.

Downloads go through the questionnaire-scoped admin routes, so the admin **session cookie** authorises
them (`credentials: 'same-origin'`) — no `X-Session-Token` (that's the respondent surface). The blob is
saved under the server's `Content-Disposition` filename, the same pattern as the analytics
`ExportButtons`. The transcript routes reuse the F7.6 builders/renderer verbatim
(`loadTranscriptExport` → `assembleTranscriptExportModel` → `renderTranscriptPdf` /
`buildTranscriptText`), with `withAdminAuth` + the questionnaire-ownership 404 replacing the
respondent route's `resolveTurnAccess`. Anonymous-mode redaction is unchanged (it lives in the model
builder), so an anonymous session's admin downloads carry no respondent identity.

No migration — `isPreview`, `publicRef`, `anonymousMode`, and the turn rows all predate this.
