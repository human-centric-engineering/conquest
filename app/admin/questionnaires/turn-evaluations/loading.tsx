/**
 * Turn-evaluations loading skeleton — shown while the server component seeds page 1 of the
 * stored verdicts. Mirrors the filter-bar-then-table layout so the page doesn't reflow.
 */
export default function TurnEvaluationsLoading() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <div className="bg-muted h-7 w-52 animate-pulse rounded" />
        <div className="bg-muted h-4 w-96 animate-pulse rounded" />
      </div>
      <div className="bg-muted h-20 w-full animate-pulse rounded-lg" />
      <div className="space-y-2 rounded-lg border p-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="bg-muted h-11 animate-pulse rounded" />
        ))}
      </div>
    </div>
  );
}
