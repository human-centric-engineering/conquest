/**
 * QuarantinedCapabilitiesBanner
 *
 * Top-of-page banner on the agent detail view. Lists every capability
 * this agent binds that is currently quarantined, with mode chip and
 * reason. Hidden when there are none — the absence of a banner is the
 * "all clear" signal.
 *
 * Server component: no client state, just rendering.
 */

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

export interface QuarantinedCapabilityForAgent {
  capabilityId: string;
  capabilitySlug: string;
  capabilityName: string;
  mode: 'quarantined-soft' | 'quarantined-hard';
  reason: string | null;
  /** ISO 8601 timestamp; null = indefinite. */
  expiresAt: string | null;
}

export interface QuarantinedCapabilitiesBannerProps {
  items: QuarantinedCapabilityForAgent[];
}

export function QuarantinedCapabilitiesBanner({
  items,
}: QuarantinedCapabilitiesBannerProps): React.ReactElement | null {
  if (items.length === 0) return null;

  return (
    <div
      className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/30"
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            {items.length} tool{items.length === 1 ? '' : 's'} unavailable —{' '}
            {items.length === 1
              ? 'a capability this agent uses is'
              : 'capabilities this agent uses are'}{' '}
            quarantined
          </p>
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={item.capabilityId} className="flex items-start gap-2">
                <Badge
                  variant={item.mode === 'quarantined-hard' ? 'destructive' : 'secondary'}
                  className="shrink-0"
                >
                  {item.mode === 'quarantined-hard' ? 'Hard' : 'Soft'}
                </Badge>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/admin/orchestration/capabilities/${item.capabilityId}`}
                    className="font-medium hover:underline"
                  >
                    {item.capabilityName}
                  </Link>{' '}
                  <span className="text-muted-foreground font-mono text-xs">
                    ({item.capabilitySlug})
                  </span>
                  {item.reason && <p className="text-muted-foreground text-xs">{item.reason}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
