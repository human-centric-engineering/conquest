/**
 * Unit tests: the Design Evaluation judge panel is split into individual judge agents.
 *
 * The panel must render as SEVEN distinct judge nodes (one per seeded dimension agent), each
 * carrying its own agent + prompt, all wrapped in one on-canvas "Judge panel" group box — not a
 * single representative node. These tests pin that shape so the panel can't silently collapse
 * back to one node or lose a dimension.
 */

import { describe, expect, it } from 'vitest';

import { getWorkflowDiagram } from '@/lib/app/questionnaire/workflows/registry';
import { getNodeMeta } from '@/lib/app/questionnaire/workflows/types';
import { EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/evaluation/dimensions';

const diagram = getWorkflowDiagram('design-evaluation');

describe('design-evaluation judge panel', () => {
  it('is registered', () => {
    expect(diagram).toBeTruthy();
  });

  const judgeSteps = (diagram?.definition.steps ?? []).filter((s) => s.id.startsWith('judge-'));

  it('has one node per seeded judge agent (all 7 dimensions)', () => {
    expect(judgeSteps).toHaveLength(EVALUATION_JUDGE_SLUGS.length);
    const slugs = judgeSteps.map((s) => getNodeMeta(s.config).agentSlug).sort();
    expect(slugs).toEqual([...EVALUATION_JUDGE_SLUGS].sort());
  });

  it('shows each judge as an individual agent with its own prompt', () => {
    for (const step of judgeSteps) {
      const meta = getNodeMeta(step.config);
      expect(meta.agentSlug, step.id).toBeTruthy();
      expect(meta.promptCatalogSlug, step.id).toBe(meta.agentSlug);
      expect(meta.promptSpecimenId, step.id).toBe(`${meta.agentSlug}.judge`);
    }
  });

  it('wraps every judge in one shared "Judge panel" group box', () => {
    const groupIds = new Set(judgeSteps.map((s) => getNodeMeta(s.config).group?.id));
    expect(groupIds).toEqual(new Set(['judge-panel']));
  });

  it('fans out from the structure snapshot and back into aggregate', () => {
    const structure = diagram?.definition.steps.find((s) => s.id === 'structure');
    const fanOut = new Set((structure?.nextSteps ?? []).map((e) => e.targetStepId));
    for (const j of judgeSteps) {
      expect(fanOut.has(j.id), `structure → ${j.id}`).toBe(true);
      expect(
        j.nextSteps.map((e) => e.targetStepId),
        `${j.id} → aggregate`
      ).toEqual(['aggregate']);
    }
  });
});
