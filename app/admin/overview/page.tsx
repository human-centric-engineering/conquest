import type { Metadata } from 'next';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { StatsCards } from '@/components/admin/stats-cards';
import { StatusPage } from '@/components/status/status-page';
import { ConfigHealthBanner } from '@/components/admin/config-health-banner';
import type { SystemStats } from '@/types/admin';
import type { ConfigHealthReport } from '@/lib/config-health/types';

export const metadata: Metadata = {
  title: 'Overview',
  description: 'Admin dashboard overview',
};

/**
 * Fetch admin stats from API
 */
async function getStats(): Promise<SystemStats | null> {
  try {
    const res = await serverFetch(API.ADMIN.STATS);

    if (!res.ok) {
      return null;
    }

    const data = await parseApiResponse<SystemStats>(res);
    return data.success ? data.data : null;
  } catch {
    return null;
  }
}

/** Fetch the config-health report (missing critical config). Null-safe: never throws the page. */
async function getConfigHealth(): Promise<ConfigHealthReport | null> {
  try {
    const res = await serverFetch(API.ADMIN.CONFIG_HEALTH);
    if (!res.ok) return null;
    const data = await parseApiResponse<ConfigHealthReport>(res);
    return data.success ? data.data : null;
  } catch {
    return null;
  }
}

/**
 * Admin Overview Page (Phase 4.4)
 *
 * Main dashboard with system statistics and status.
 */
export default async function AdminOverviewPage() {
  const [stats, configHealth] = await Promise.all([getStats(), getConfigHealth()]);

  return (
    <div className="space-y-8">
      {/* Config health — renders only when a critical/warning setting is missing. */}
      <ConfigHealthBanner report={configHealth} variant="card" />

      {/* Stats Cards */}
      <section>
        <h2 className="mb-4 text-lg font-semibold">User Statistics</h2>
        <StatsCards stats={stats} />
      </section>

      {/* System Status */}
      <section>
        <StatusPage
          title="System Status"
          description="Real-time status of all services"
          pollingInterval={30000}
          showMemory={true}
        />
      </section>
    </div>
  );
}
