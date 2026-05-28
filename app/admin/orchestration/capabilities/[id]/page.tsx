import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  CapabilityForm,
  type UsedByAgentSummary,
} from '@/components/admin/orchestration/capability-form';
import { CapabilityQuarantineCard } from '@/components/admin/orchestration/capability-quarantine-card';
import { CapabilityStatsPanel } from '@/components/admin/orchestration/capability-stats-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { AiCapability } from '@/types/prisma';

interface QuarantineAttribution {
  /** ISO 8601 timestamp of the most recent quarantine write. */
  at: string;
  /** Actor name; falls back to email; null when the user row is gone. */
  actorName: string | null;
}

/**
 * Fetch the most recent `capability.quarantine` audit row for this
 * capability so the QuarantineCard can render "Quarantined N ago by X".
 *
 * Returns null when the capability has never been quarantined, when the
 * stored state is 'active' (no point pulling the row), or when the
 * query fails — the card simply omits attribution rather than blocking.
 */
async function getQuarantineAttribution(
  capabilityId: string,
  storedState: string | null | undefined
): Promise<QuarantineAttribution | null> {
  if (storedState === 'active' || !storedState) return null;
  try {
    const row = await prisma.aiAdminAuditLog.findFirst({
      where: {
        entityType: 'capability',
        entityId: capabilityId,
        action: 'capability.quarantine',
      },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!row) return null;
    return {
      at: row.createdAt.toISOString(),
      actorName: row.user?.name ?? row.user?.email ?? null,
    };
  } catch (err) {
    logger.error('edit capability page: quarantine attribution fetch failed', err, {
      capabilityId,
    });
    return null;
  }
}

export const metadata: Metadata = {
  title: 'Edit capability · AI Orchestration',
  description: 'Edit an existing capability.',
};

/**
 * Admin — Edit capability page (Phase 4 Session 4.3).
 *
 * Fetches the capability, its agent-usage list, and the sibling
 * category list in parallel. Missing capability → `notFound()`. The
 * other two fetches tolerate failure — the form degrades to an empty
 * `usedBy` chip card / empty category dropdown rather than throwing.
 */
async function getCapability(id: string): Promise<AiCapability | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.capabilityById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<AiCapability>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('edit capability page: capability fetch failed', err, { id });
    return null;
  }
}

async function getUsedBy(id: string): Promise<UsedByAgentSummary[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.capabilityAgents(id));
    if (!res.ok) return [];
    const body = await parseApiResponse<UsedByAgentSummary[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('edit capability page: used-by fetch failed', err, { id });
    return [];
  }
}

async function getAvailableCategories(): Promise<string[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AiCapability[]>(res);
    if (!body.success) return [];
    return Array.from(new Set(body.data.map((c) => c.category).filter(Boolean))).sort();
  } catch (err) {
    logger.error('edit capability page: categories fetch failed', err);
    return [];
  }
}

export default async function EditCapabilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [capability, usedBy, availableCategories] = await Promise.all([
    getCapability(id),
    getUsedBy(id),
    getAvailableCategories(),
  ]);

  if (!capability) notFound();

  // Audit attribution depends on capability.quarantineState — fetched
  // after we know the row exists. Skipped entirely when not quarantined.
  const quarantineAttribution = await getQuarantineAttribution(id, capability.quarantineState);

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/capabilities" className="hover:underline">
          Capabilities
        </Link>
        {' / '}
        <span>{capability.name}</span>
      </nav>

      <CapabilityStatsPanel capabilityId={id} />

      <CapabilityQuarantineCard
        capabilityId={id}
        capabilityName={capability.name}
        state={{
          quarantineState: (capability.quarantineState ?? 'active') as
            | 'active'
            | 'quarantined-soft'
            | 'quarantined-hard',
          quarantineReason: capability.quarantineReason ?? null,
          quarantineUntil: capability.quarantineUntil
            ? new Date(capability.quarantineUntil).toISOString()
            : null,
        }}
        attribution={quarantineAttribution}
        affectedAgents={usedBy.map((a) => ({ id: a.id, name: a.name, slug: a.slug }))}
      />

      <CapabilityForm
        mode="edit"
        capability={capability}
        usedBy={usedBy}
        availableCategories={availableCategories}
      />
    </div>
  );
}
