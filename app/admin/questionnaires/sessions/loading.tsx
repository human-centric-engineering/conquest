/**
 * Sessions console loading skeleton — shown while the server component fetches the filtered
 * session list and its summary charts. Mirrors the console's stats-then-table layout so the
 * page doesn't reflow when the real content lands.
 */
export default function SessionsConsoleLoading() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <div className="bg-muted h-7 w-48 animate-pulse rounded" />
        <div className="bg-muted h-4 w-96 animate-pulse rounded" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-muted h-24 animate-pulse rounded-xl" />
        ))}
      </div>
      <div className="bg-muted h-14 w-full animate-pulse rounded-lg" />
      <div className="space-y-2 rounded-lg border p-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="bg-muted h-11 animate-pulse rounded" />
        ))}
      </div>
    </div>
  );
}
