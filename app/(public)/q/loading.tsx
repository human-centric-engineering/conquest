/**
 * Loading skeleton for the no-login public questionnaire route (F7.1).
 *
 * Shown while `/q/[versionId]` resolves its feature flag and brand theme
 * server-side, before the client mints the anonymous session. Mirrors the chat
 * shell so the surface doesn't flash blank on first paint.
 */
export default function PublicQuestionnaireLoading() {
  return (
    <div className="container mx-auto h-[calc(100dvh-9rem)] max-w-3xl px-4 py-6">
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
