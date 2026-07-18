'use client';

/**
 * SessionStats — the KPI + charts strip above the alpha Sessions table.
 *
 * Presentational: it renders the {@link AdminSessionStats} the browser fetches, recomputed server-side
 * over the SAME filter set as the list, so every figure and bar tracks the active filters. Collapsible
 * so it never crowds the table. Charts use recharts (as the cost / cohort dashboards do); the palette is
 * anchored on the ConQuest burnt-amber accent so the strip reads as one system.
 */

import { useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, ChevronDown } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { cn } from '@/lib/utils';
import type { SessionStatus } from '@/lib/app/questionnaire/types';
import type { AdminSessionStats } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-stats';

/** Amber-anchored categorical palette — warm primary, cool supports; harmonises with `--cq-accent`. */
const PALETTE = [
  '#c2410c',
  '#0d9488',
  '#7c3aed',
  '#e11d48',
  '#2563eb',
  '#ca8a04',
  '#475569',
  '#db2777',
];

/** Status → hue: amber (in-flight), emerald (done), slate/zinc (dormant), rose (aborted). */
const STATUS_COLOUR: Record<SessionStatus, string> = {
  active: '#c2410c',
  paused: '#64748b',
  completed: '#0d9488',
  abandoned: '#a1a1aa',
  aborted: '#e11d48',
};

export interface SessionStatsProps {
  stats: AdminSessionStats;
  /** Dim the strip while a filter change is refetching. */
  loading?: boolean;
}

export function SessionStats({ stats, loading }: SessionStatsProps) {
  // Charts are collapsed by default so the table is front-and-centre; the KPI tiles stay visible.
  const [open, setOpen] = useState(false);

  const kpis: CqStat[] = [
    { label: 'Sessions', value: stats.total.toLocaleString(), accent: true },
    { label: 'Completed', value: stats.completed.toLocaleString() },
    { label: 'Active', value: stats.active.toLocaleString() },
    { label: 'Avg completion', value: `${stats.avgCompletion}%` },
  ];

  return (
    <section className={cn('space-y-4 transition-opacity', loading && 'opacity-60')}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground group flex items-center gap-2 text-xs font-semibold tracking-wide uppercase transition-colors"
          aria-expanded={open}
        >
          <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
          {open ? 'Hide charts' : 'Show charts'}
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')}
            aria-hidden="true"
          />
        </button>
      </div>

      <CqStatTiles stats={kpis} />

      {open &&
        (stats.total === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed py-10 text-center text-sm">
            No sessions match these filters — nothing to chart.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Sessions over time" className="lg:col-span-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={stats.overTime}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="sessionsArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#c2410c" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#c2410c" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    tickFormatter={formatDay}
                    minTickGap={24}
                  />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(l) => formatDay(String(l))}
                    formatter={(v) => [String(v), 'Sessions']}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#c2410c"
                    strokeWidth={2}
                    fill="url(#sessionsArea)"
                    name="Sessions"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="By status">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.byStatus}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis dataKey="status" tick={{ fontSize: 10 }} interval={0} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    cursor={{ fill: 'var(--cq-accent-muted)' }}
                  />
                  <Bar dataKey="count" name="Sessions" radius={[4, 4, 0, 0]}>
                    {stats.byStatus.map((s) => (
                      <Cell key={s.status} fill={STATUS_COLOUR[s.status]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Completion distribution">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.completionBuckets}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    cursor={{ fill: 'var(--cq-accent-muted)' }}
                  />
                  <Bar dataKey="count" name="Sessions" fill="#0d9488" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {stats.byClient.length > 0 && (
              <ChartCard title="By client">
                <CategoryBars data={stats.byClient} />
              </ChartCard>
            )}

            {stats.byQuestionnaire.length > 0 && (
              <ChartCard title="By questionnaire">
                <CategoryBars data={stats.byQuestionnaire} />
              </ChartCard>
            )}
          </div>
        ))}
    </section>
  );
}

/** A horizontal category bar chart (client / questionnaire), coloured across the palette. */
function CategoryBars({ data }: { data: { name: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fontSize: 10 }}
          width={110}
          tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--cq-accent-muted)' }} />
        <Bar dataKey="count" name="Sessions" radius={[0, 4, 4, 0]}>
          {data.map((d, i) => (
            <Cell key={d.name} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** A titled chart card with a fixed plot height, matching the cost/cohort dashboard cards. */
function ChartCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-56 w-full" role="img" aria-label={title}>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

/** `YYYY-MM-DD` → `12 Jul` for compact axis + tooltip labels. */
function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const TOOLTIP_STYLE = { fontSize: 12, borderRadius: 8 } as const;
