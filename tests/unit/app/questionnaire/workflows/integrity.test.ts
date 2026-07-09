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
import { EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { WORKFLOW_DIAGRAMS } from '@/lib/app/questionnaire/workflows/registry';
import { WORKFLOW_CATEGORIES, categoryForSlug } from '@/lib/app/questionnaire/workflows/categories';
import { getNodeMeta } from '@/lib/app/questionnaire/workflows/types';

// Every `*_AGENT_SLUG` export is a legitimate agent slug a node may reference, plus the seven
// design-evaluation judge agents (whose slugs live in the dimension registry, not constants.ts).
const KNOWN_AGENT_SLUGS = new Set<string>([
  ...Object.entries(constants)
    .filter(([name, value]) => name.endsWith('_AGENT_SLUG') && typeof value === 'string')
    .map(([, value]) => value as string),
  ...EVALUATION_JUDGE_SLUGS,
]);

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
        // The specimen must actually render from its sample context — a builder throw is
        // captured as `error: true` (a visible ⚠️ in the UI), which is a silent gap in the
        // Prompt tab. Fail CI on it so a changed prompt-builder signature is caught here.
        expect(
          specimen?.error,
          `${slug}/${stepId} → specimen ${meta.promptSpecimenId} failed to render`
        ).not.toBe(true);
      }
    }
  });

  // Agents deliberately outside the Prompt Library's scope (see the `buildPromptCatalog`
  // docstring): post-completion / support agents that build prompts in code and are not
  // catalogued. Their diagram nodes legitimately show no Prompt tab — but the exception is
  // pinned here so a NEW agent-backed step can't silently ship without a prompt.
  const UNCATALOGUED_AGENT_SLUGS = new Set<string>([
    constants.RESPONDENT_REPORT_AGENT_SLUG,
    constants.REPORT_FORMATTER_AGENT_SLUG,
    constants.COHORT_REPORT_AGENT_SLUG,
    constants.QUESTIONNAIRE_EDIT_AGENT_SLUG,
    constants.QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
  ]);

  it('every agent-backed step exposes a catalogued prompt (or is a known exception)', () => {
    for (const { slug, stepId, meta } of allMetas) {
      if (!meta.agentSlug) continue;
      if (UNCATALOGUED_AGENT_SLUGS.has(meta.agentSlug)) continue;
      expect(
        meta.promptCatalogSlug,
        `${slug}/${stepId} (agent ${meta.agentSlug}) has no promptCatalogSlug — add one or allowlist the agent`
      ).toBeTruthy();
    }
  });

  it('every capability slug is registered in the dispatcher', () => {
    for (const { slug, stepId, meta } of allMetas) {
      for (const cap of meta.capabilitySlugs ?? []) {
        expect(capabilityDispatcher.has(cap), `${slug}/${stepId} → ${cap}`).toBe(true);
      }
    }
  });

  it('every step-setting key resolves to a real config field', () => {
    const resolve = (path: string): unknown =>
      path.split('.').reduce<unknown>((acc, key) => {
        if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
          return (acc as Record<string, unknown>)[key];
        }
        return undefined;
      }, DEFAULT_QUESTIONNAIRE_CONFIG);

    for (const { slug, stepId, meta } of allMetas) {
      for (const setting of meta.settings ?? []) {
        expect(resolve(setting.key), `${slug}/${stepId} → ${setting.key}`).not.toBeUndefined();
      }
    }
  });
});

describe('workflow category grouping', () => {
  it('every diagram is filed under exactly one category', () => {
    for (const d of WORKFLOW_DIAGRAMS) {
      expect(
        categoryForSlug(d.slug),
        `${d.slug} has no category — add it to WORKFLOW_CATEGORIES`
      ).not.toBeUndefined();
    }
  });

  it('every category slug names a real diagram (no dangling membership)', () => {
    const known = new Set(WORKFLOW_DIAGRAMS.map((d) => d.slug));
    for (const category of WORKFLOW_CATEGORIES) {
      for (const slug of category.slugs) {
        expect(known.has(slug), `category ${category.id} → unknown slug ${slug}`).toBe(true);
      }
    }
  });

  it('no diagram appears in two categories', () => {
    const seen = new Set<string>();
    for (const category of WORKFLOW_CATEGORIES) {
      for (const slug of category.slugs) {
        expect(seen.has(slug), `${slug} appears in more than one category`).toBe(false);
        seen.add(slug);
      }
    }
  });
});
