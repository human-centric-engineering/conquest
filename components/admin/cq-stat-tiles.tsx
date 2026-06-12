/**
 * Summary stat tiles for the ConQuest app admin surfaces.
 *
 * A responsive auto-fitting row of figures with the editorial display serif and a
 * staggered entrance (`cq-rise` + per-tile `animation-delay`). Server-renderable
 * (no hooks). Used on the questionnaires and demo-clients list pages and the
 * questionnaire Overview tab. Only meaningful inside a `.cq-surface` wrapper,
 * which supplies `--font-display` and `--cq-accent`.
 */
import { cn } from '@/lib/utils';

export interface CqStat {
  label: string;
  value: React.ReactNode;
  hint?: string;
  /** Render the figure in the surface accent colour (use sparingly — one tile). */
  accent?: boolean;
}

export function CqStatTiles({ stats, className }: { stats: CqStat[]; className?: string }) {
  return (
    <div
      className={cn(
        'grid [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))] gap-3',
        className
      )}
    >
      {stats.map((stat, i) => (
        <div
          key={stat.label}
          className="cq-rise bg-card rounded-xl border p-4"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {stat.label}
          </div>
          <div
            className={cn(
              'cq-display mt-1 text-3xl font-semibold tabular-nums',
              stat.accent && 'text-[color:var(--cq-accent)]'
            )}
          >
            {stat.value}
          </div>
          {stat.hint && <div className="text-muted-foreground mt-1 text-xs">{stat.hint}</div>}
        </div>
      ))}
    </div>
  );
}
