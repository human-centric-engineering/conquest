// @vitest-environment jsdom
/**
 * Unit test: `buildGroupNodes` synthesises a correctly-sized container behind grouped members.
 *
 * Pins the geometry (bounding box + padding) and the "only grouped nodes get a box" rule so the
 * design-evaluation Judge panel box can't drift or wrap the wrong nodes.
 */

import { describe, expect, it } from 'vitest';

import { buildGroupNodes } from '@/components/app/questionnaire/behind-the-scenes/conquest-workflow-node';
import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

/** Minimal mapped node with a position and a `_meta` overlay under `data.config`. */
function fakeNode(
  id: string,
  x: number,
  y: number,
  group?: { id: string; label: string }
): PatternNode {
  return {
    id,
    type: 'pattern',
    position: { x, y },
    data: {
      label: id,
      type: 'agent_call',
      config: group ? { _meta: { group } } : {},
    },
  } as unknown as PatternNode;
}

describe('buildGroupNodes', () => {
  it('returns no boxes when nothing is grouped', () => {
    expect(buildGroupNodes([fakeNode('a', 0, 0), fakeNode('b', 200, 0)])).toEqual([]);
  });

  it('wraps grouped members in one padded container behind them', () => {
    const g = { id: 'judge-panel', label: 'Judge panel' };
    const boxes = buildGroupNodes([
      fakeNode('lonely', 0, 0),
      fakeNode('j1', 100, 0, g),
      fakeNode('j2', 100, 200, g),
    ]);

    expect(boxes).toHaveLength(1);
    const box = boxes[0];
    expect(box.id).toBe('group-judge-panel');
    expect(box.type).toBe('panelGroup');
    expect(box.selectable).toBe(false);
    expect(box.draggable).toBe(false);
    // Bounding box of members {(100,0),(100,200)} with W≈176/H≈104 and pad {x:28,top:44,bottom:24}.
    expect(box.position).toEqual({ x: 72, y: -44 });
    expect(box.data.width).toBe(232); // 100 + 176 + 28 - 72
    expect(box.data.height).toBe(372); // 200 + 104 + 24 - (-44)
    expect(box.data.label).toBe('Judge panel');
  });

  it('produces one box per distinct group id', () => {
    const boxes = buildGroupNodes([
      fakeNode('a', 0, 0, { id: 'g1', label: 'One' }),
      fakeNode('b', 0, 120, { id: 'g1', label: 'One' }),
      fakeNode('c', 400, 0, { id: 'g2', label: 'Two' }),
    ]);
    expect(boxes.map((b) => b.id).sort()).toEqual(['group-g1', 'group-g2']);
  });
});
