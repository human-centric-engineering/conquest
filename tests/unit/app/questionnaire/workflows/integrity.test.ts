/**
 * Unit tests: diagram `_meta` references resolve against live sources.
 *
 * The visualizer's per-node overlay names agents, prompt-catalog specimens, and
 * capabilities by string slug. These are the drift guard: if an agent is
 * renamed, a prompt specimen id changes, or a capability is removed, a diagram
 * would silently point at nothing — so every referenced slug is pinned here to
 * the live constants / catalog / capability registry, and CI fails on a dangling
 * reference.
 *
 * Prisma is mocked because the prompt catalog transitively imports server
 * modules; only the pure catalog + in-memory capability registration are used.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { buildPromptCatalog } from '@/app/api/v1/app/questionnaires/_lib/prompt-catalog';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities/registry';
import * as constants from '@/lib/app/questionnaire/constants';
import { WORKFLOW_DIAGRAMS } from '@/lib/app/questionnaire/workflows/registry';
import { getNodeMeta } from '@/lib/app/questionnaire/workflows/types';

// Every `*_AGENT_SLUG` export is a legitimate agent slug a node may reference.
const KNOWN_AGENT_SLUGS = new Set(
  Object.entries(constants)
    .filter(([name, value]) => name.endsWith('_AGENT_SLUG') && typeof value === 'string')
    .map(([, value]) => value as string)
);

const catalog = buildPromptCatalog();
const catalogBySlug = new Map(catalog.map((entry) => [entry.slug, entry]));

registerBuiltInCapabilities();

interface MetaRef {
  slug: string;
  stepId: string;
  meta: ReturnType<typeof getNodeMeta>;
}

const allMetas: MetaRef[] = WORKFLOW_DIAGRAMS.flatMap((d) =>
  d.definition.steps.map((s) => ({ slug: d.slug, stepId: s.id, meta: getNodeMeta(s.config) }))
);

describe('workflow diagram integrity', () => {
  it('every agentSlug is a known agent slug constant', () => {
    for (const { slug, stepId, meta } of allMetas) {
      if (!meta.agentSlug) continue;
      expect(KNOWN_AGENT_SLUGS.has(meta.agentSlug), `${slug}/${stepId} → ${meta.agentSlug}`).toBe(
        true
      );
    }
  });

  it('every promptCatalogSlug + promptSpecimenId resolves in the catalog', () => {
    for (const { slug, stepId, meta } of allMetas) {
      if (!meta.promptCatalogSlug) continue;
      const entry = catalogBySlug.get(meta.promptCatalogSlug);
      expect(entry, `${slug}/${stepId} → ${meta.promptCatalogSlug}`).toBeTruthy();
      if (entry && meta.promptSpecimenId) {
        const specimen = entry.specimens.find((s) => s.id === meta.promptSpecimenId);
        expect(specimen, `${slug}/${stepId} → specimen ${meta.promptSpecimenId}`).toBeTruthy();
      }
    }
  });

  it('every capability slug is registered in the dispatcher', () => {
    for (const { slug, stepId, meta } of allMetas) {
      for (const cap of meta.capabilitySlugs ?? []) {
        expect(capabilityDispatcher.has(cap), `${slug}/${stepId} → ${cap}`).toBe(true);
      }
    }
  });
});
