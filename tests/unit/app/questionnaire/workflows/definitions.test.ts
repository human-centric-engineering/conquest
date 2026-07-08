/**
 * Unit tests: workflow diagram definitions are structurally valid.
 *
 * The Behind-the-Scenes diagrams are hand-authored data, so these tests are the
 * guard that every diagram is a coherent DAG the canvas can render: the entry
 * step exists, every edge points at a real step, ids are unique, each step
 * carries a hand-placed `_layout` (deterministic demo layout — never BFS), and
 * the pure platform mapper turns it into the expected node count without
 * throwing.
 */

import { describe, expect, it } from 'vitest';

import { workflowDefinitionToFlow } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';
import { WORKFLOW_DIAGRAMS } from '@/lib/app/questionnaire/workflows/registry';

describe('workflow diagram definitions', () => {
  it('registers at least the nine key pipelines', () => {
    expect(WORKFLOW_DIAGRAMS.length).toBeGreaterThanOrEqual(9);
  });

  it('has unique slugs', () => {
    const slugs = WORKFLOW_DIAGRAMS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  for (const diagram of WORKFLOW_DIAGRAMS) {
    describe(diagram.slug, () => {
      const { steps, entryStepId } = diagram.definition;
      const ids = new Set(steps.map((s) => s.id));

      it('has unique step ids', () => {
        expect(ids.size).toBe(steps.length);
      });

      it('entry step resolves to a real step', () => {
        expect(ids.has(entryStepId)).toBe(true);
      });

      it('every edge targets a real step', () => {
        for (const step of steps) {
          for (const edge of step.nextSteps) {
            expect(ids.has(edge.targetStepId)).toBe(true);
          }
        }
      });

      it('every step carries a hand-placed numeric _layout', () => {
        for (const step of steps) {
          const layout = step.config['_layout'] as { x?: unknown; y?: unknown } | undefined;
          expect(typeof layout?.x).toBe('number');
          expect(typeof layout?.y).toBe('number');
        }
      });

      it('maps to the same number of nodes without throwing', () => {
        const flow = workflowDefinitionToFlow(diagram.definition);
        expect(flow.nodes).toHaveLength(steps.length);
      });
    });
  }
});
