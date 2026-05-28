/**
 * ActiveQuarantinesPanel
 *
 * Dashboard panel listing capabilities currently in quarantine. Hidden
 * when there are none — empty is the all-clear signal. Operational, not
 * statistical: each row links to the capability detail page where the
 * admin can lift the quarantine or update the reason.
 *
 * Server component: no client state.
 */

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface ActiveQuarantineRow {
  id: string;
  slug: string;
  name: string;
  mode: 'quarantined-soft' | 'quarantined-hard';
  reason: string | null;
  /** ISO 8601 timestamp; null for indefinite. */
  expiresAt: string | null;
}

export interface ActiveQuarantinesPanelProps {
  rows: ActiveQuarantineRow[];
}

export function ActiveQuarantinesPanel({
  rows,
}: ActiveQuarantinesPanelProps): React.ReactElement | null {
  if (rows.length === 0) return null;

  return (
    <Card className="border-amber-300 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
          Active quarantines
          <Badge variant="secondary">{rows.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3">
              <Badge
                variant={row.mode === 'quarantined-hard' ? 'destructive' : 'secondary'}
                className="shrink-0"
              >
                {row.mode === 'quarantined-hard' ? 'Hard' : 'Soft'}
              </Badge>
              <div className="min-w-0 flex-1">
                <Link
                  href={`/admin/orchestration/capabilities/${row.id}`}
                  className="font-medium hover:underline"
                >
                  {row.name}
                </Link>{' '}
                <span className="text-muted-foreground font-mono text-xs">({row.slug})</span>
                {row.reason && <p className="text-muted-foreground text-xs">{row.reason}</p>}
                {row.expiresAt && (
                  <p className="text-muted-foreground text-xs">
                    Auto-lift at {new Date(row.expiresAt).toLocaleString()}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
