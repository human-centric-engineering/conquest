import { RESPONDENT_SHELL } from '@/lib/app/questionnaire/layout';

/**
 * Loading skeleton for the no-login public questionnaire route (F7.1).
 *
 * Shown while `/q/[versionId]` resolves its brand theme and settings server-side, before the client
 * mints the anonymous session. Mirrors the chat shell so the surface doesn't flash blank on first
 * paint.
 *
 * Two things it deliberately does NOT do. It does not draw chrome: which chrome this questionnaire
 * wants is one of the things still being resolved, and a skeleton that guessed would flash a header
 * that then vanished on a white-labelled page. And it no longer carries its own width or height —
 * it used `max-w-3xl` while the page it stands in for used the full container, so the conversation
 * visibly jumped wider the moment it loaded. `RESPONDENT_SHELL` is the same width the page settles
 * at, and `h-dvh` is the same height the chrome will hand it.
 */
export default function PublicQuestionnaireLoading() {
  return (
    <div className={`${RESPONDENT_SHELL} h-dvh px-4 py-6`}>
      <div className="bg-card flex h-full flex-col rounded-xl border">
        <div className="min-h-0 flex-1 space-y-6 px-4 py-6 sm:px-6">
          <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
          <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
          <div className="bg-muted ml-auto h-10 w-2/3 animate-pulse rounded-2xl" />
          <div className="bg-muted h-4 w-5/6 animate-pulse rounded" />
        </div>
        <div className="border-t px-4 py-3 sm:px-6">
          <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        </div>
      </div>
    </div>
  );
}
