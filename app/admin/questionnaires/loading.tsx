/**
 * Questionnaires list loading skeleton — shown while the server component fetches the
 * enriched list. Keeps the page from collapsing to blank on navigation into the surface.
 */
export default function QuestionnairesListLoading() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="bg-muted h-7 w-56 animate-pulse rounded" />
          <div className="bg-muted h-4 w-80 animate-pulse rounded" />
        </div>
        <div className="bg-muted h-9 w-40 animate-pulse rounded-md" />
      </div>
      <div className="bg-muted h-9 w-full max-w-sm animate-pulse rounded-md" />
      <div className="space-y-2 rounded-lg border p-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-muted h-11 animate-pulse rounded" />
        ))}
      </div>
    </div>
  );
}
