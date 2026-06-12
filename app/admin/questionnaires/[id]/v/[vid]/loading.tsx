/**
 * Workspace loading skeleton — shown while a tab's server component fetches.
 * Keeps the page from collapsing to blank during version switches and tab
 * navigation so the surface feels instant.
 */
export default function QuestionnaireWorkspaceLoading() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="bg-muted h-3 w-40 animate-pulse rounded" />
      <div className="space-y-3 border-b pb-3">
        <div className="flex items-center gap-3">
          <div className="bg-muted h-7 w-64 animate-pulse rounded" />
          <div className="bg-muted h-5 w-16 animate-pulse rounded-full" />
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-muted h-6 w-20 animate-pulse rounded" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-muted h-28 animate-pulse rounded-xl" />
        ))}
      </div>
    </div>
  );
}
