/**
 * Loading skeleton for the authenticated questionnaire routes (F7.1).
 *
 * Covers `/questionnaires/start` (a brief redirect hop) and
 * `/questionnaires/[sessionId]` (the chat surface) while their server work —
 * session create/resume, ownership check, theme resolution — runs, so the
 * respondent sees the chat shell instead of a blank frame.
 */
export default function QuestionnairesLoading() {
  return (
    <div className="mx-auto h-[calc(100vh-12rem)] max-w-3xl">
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
