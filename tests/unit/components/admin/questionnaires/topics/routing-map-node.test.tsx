// @vitest-environment happy-dom

/**
 * Unit tests: `ScopeMapNode` — the routing map's node renderer, and `miniMapNodeColor`.
 *
 * The graph these nodes are built from is asserted in
 * `tests/unit/lib/app/questionnaire/scope/graph.test.ts`; what is tested here is the half the builder
 * cannot reach — that every `ScopeNodeKind` the builder can emit actually renders, and that the two
 * pieces of copy an author reads off a node behave the way the module's header promises.
 *
 * Two of those promises are load-bearing enough to have their own tests:
 *
 * - **The title is never truncated.** A clamped rule title turns `Commercial outcome named was never
 *   answered` into `Commercial outcome named was never…`, which reads as a *different rule* — and the
 *   layout in `graph.ts` measures the wrapped height on the assumption that it wraps.
 * - **`miniMapNodeColor` never throws.** React Flow calls it per node while painting the MiniMap; if it
 *   throws on an unexpected shape the MiniMap renders nothing at all rather than one wrong colour.
 *
 * `@xyflow/react` is stubbed for the reason `routing-map-dialog.test.tsx` stubs it: happy-dom has no
 * ResizeObserver, and `Handle` measures on mount.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';

vi.mock('@xyflow/react', () => ({
  Handle: ({ type, position }: { type: string; position: string }) => (
    <div data-testid={`handle-${type}`} data-position={position} />
  ),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

// Imported after the mock, which vitest hoists above it.
import {
  ScopeMapNode,
  miniMapNodeColor,
  scopeNodeTypes,
  type ScopeFlowNode,
  type ScopeNodeData,
} from '@/components/admin/questionnaires/topics/routing-map-node';
import {
  ROUTING_MAP_NODE_WIDTH,
  SCOPE_BADGES,
  type ScopeGraphNode,
  type ScopeNodeBadge,
  type ScopeNodeKind,
} from '@/lib/app/questionnaire/scope/graph';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Every kind the builder can emit. Kept as a literal so a new kind fails to compile here first. */
const ALL_KINDS: ScopeNodeKind[] = [
  'start',
  'opening',
  'planner',
  'guardrails',
  'conditional',
  'always',
  'alwaysBand',
];

function graphNode(overrides: Partial<ScopeGraphNode> = {}): ScopeGraphNode {
  return {
    id: 'n1',
    kind: 'conditional',
    x: 0,
    y: 0,
    label: 'Pricing and packaging',
    detail: { title: 'Pricing and packaging', summary: 'A conditional topic.', rows: [] },
    ...overrides,
  };
}

/**
 * React Flow hands the renderer a wide prop bag it never reads. Only `data` and `selected` matter, so
 * the rest is filled in once here rather than at every call site.
 */
function nodeProps(node: ScopeGraphNode, selected = false): NodeProps<ScopeFlowNode> {
  return {
    id: node.id,
    type: 'scope',
    data: { node },
    selected,
    isConnectable: false,
    zIndex: 0,
    positionAbsoluteX: node.x,
    positionAbsoluteY: node.y,
    dragging: false,
    deletable: false,
    selectable: true,
    draggable: false,
  } as unknown as NodeProps<ScopeFlowNode>;
}

/** A React Flow node as the MiniMap sees one — `data` is the loose bag the callback has to survive. */
function flowNode(data: unknown): Node {
  return { id: 'n1', position: { x: 0, y: 0 }, data } as unknown as Node;
}

/* -------------------------------------------------------------------------- */
/* The node                                                                   */
/* -------------------------------------------------------------------------- */

describe('ScopeMapNode', () => {
  it('renders the label, sublabel and badges a builder node carries', () => {
    render(
      <ScopeMapNode
        {...nodeProps(
          graphNode({
            label: 'Pricing and packaging',
            sublabel: 'Conditional · 1m 17s',
            badges: [
              { label: 'Fallback', tone: 'neutral' },
              { label: 'No criteria', tone: 'warning' },
            ],
          })
        )}
      />
    );

    expect(screen.getByText('Pricing and packaging')).toBeInTheDocument();
    expect(screen.getByText('Conditional · 1m 17s')).toBeInTheDocument();
    expect(screen.getByText('Fallback')).toBeInTheDocument();
    expect(screen.getByText('No criteria')).toBeInTheDocument();
  });

  it('omits the sublabel and the badge row entirely when the node carries neither', () => {
    const { container } = render(<ScopeMapNode {...nodeProps(graphNode({ label: 'Start' }))} />);

    // Only the title line — nothing rendering an empty second row or an empty chip strip.
    expect(container.querySelectorAll('.line-clamp-3')).toHaveLength(0);
    expect(screen.getByText('Start')).toBeInTheDocument();
  });

  it('renders an empty badge array as no badge row', () => {
    const { container } = render(
      <ScopeMapNode {...nodeProps(graphNode({ badges: [] as ScopeNodeBadge[] }))} />
    );

    expect(container.querySelectorAll('.rounded-full')).toHaveLength(0);
  });

  it('never truncates the title, because a clamped rule reads as a different rule', () => {
    const long = 'Commercial outcome named was never answered';
    render(<ScopeMapNode {...nodeProps(graphNode({ label: long }))} />);

    const title = screen.getByText(long);
    // `break-words` wraps; a `line-clamp-*` or `truncate` here would silently change what the rule says.
    expect(title.className).toContain('break-words');
    expect(title.className).not.toMatch(/truncate|line-clamp/);
  });

  it('clamps the sublabel to three lines — its full text is one click away in the detail panel', () => {
    render(<ScopeMapNode {...nodeProps(graphNode({ sublabel: 'A very long summary' }))} />);

    expect(screen.getByText('A very long summary').className).toContain('line-clamp-3');
  });

  it('takes its width from the layout module rather than a class, so the gutter stays open', () => {
    render(<ScopeMapNode {...nodeProps(graphNode({ id: 'sized' }))} />);

    expect(screen.getByTestId('scope-node-sized')).toHaveStyle({
      width: `${ROUTING_MAP_NODE_WIDTH}px`,
    });
  });

  it('marks the selected node with a ring and leaves an unselected one plain', () => {
    const { rerender } = render(<ScopeMapNode {...nodeProps(graphNode({ id: 'sel' }), false)} />);
    expect(screen.getByTestId('scope-node-sel').className).not.toContain('ring-2');

    rerender(<ScopeMapNode {...nodeProps(graphNode({ id: 'sel' }), true)} />);
    expect(screen.getByTestId('scope-node-sel').className).toContain('ring-2');
  });

  it('draws both handles on every node, so the shape does not change between columns', () => {
    render(<ScopeMapNode {...nodeProps(graphNode())} />);

    expect(screen.getByTestId('handle-target')).toBeInTheDocument();
    expect(screen.getByTestId('handle-source')).toBeInTheDocument();
  });

  /**
   * The band's head is the one node the flow arrives at from above.
   *
   * `graph.ts` puts it directly beneath `start`, in the same column, which is what lets the band's
   * topics sit clear of the rule column. With a left-side target handle that edge would leave `start`'s
   * right side and double back over both boxes — the backwards loop this exception exists to remove.
   */
  it('takes the band head’s inbound edge on the top, not the left', () => {
    render(<ScopeMapNode {...nodeProps(graphNode({ kind: 'alwaysBand' }))} />);

    expect(screen.getByTestId('handle-target')).toHaveAttribute('data-position', 'top');
    expect(screen.getByTestId('handle-source')).toHaveAttribute('data-position', 'right');
  });

  it.each(ALL_KINDS.filter((k) => k !== 'alwaysBand'))(
    'keeps the %s kind left-in / right-out',
    (kind) => {
      render(<ScopeMapNode {...nodeProps(graphNode({ kind }))} />);

      expect(screen.getByTestId('handle-target')).toHaveAttribute('data-position', 'left');
      expect(screen.getByTestId('handle-source')).toHaveAttribute('data-position', 'right');
    }
  );

  it.each(ALL_KINDS)('renders the %s kind with its own box tone and an icon', (kind) => {
    const { container } = render(
      <ScopeMapNode {...nodeProps(graphNode({ id: kind, kind, label: kind }))} />
    );

    const box = screen.getByTestId(`scope-node-${kind}`);
    expect(box).toHaveAttribute('data-kind', kind);
    // A kind missing from TONES would throw on `tone.box`; this asserts the lookup produced classes.
    expect(box.className.length).toBeGreaterThan(0);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('gives each of the four badge tones a distinct colour', () => {
    const tones: ScopeNodeBadge['tone'][] = ['neutral', 'positive', 'negative', 'warning'];
    const classes = tones.map((tone) => {
      const { container, unmount } = render(
        <ScopeMapNode {...nodeProps(graphNode({ badges: [{ label: tone, tone }] }))} />
      );
      const chip = container.querySelector('.rounded-full');
      const className = chip?.className ?? '';
      unmount();
      return className;
    });

    expect(new Set(classes).size).toBe(4);
    expect(classes.every((c) => c.length > 0)).toBe(true);
  });

  it('renders every badge the builder has a table entry for', () => {
    const badges = Object.values(SCOPE_BADGES).map(({ label, tone }) => ({ label, tone }));
    render(<ScopeMapNode {...nodeProps(graphNode({ badges }))} />);

    for (const { label } of badges) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* nodeTypes                                                                  */
/* -------------------------------------------------------------------------- */

describe('scopeNodeTypes', () => {
  it('maps the single "scope" type to the renderer', () => {
    expect(scopeNodeTypes.scope).toBe(ScopeMapNode);
    expect(Object.keys(scopeNodeTypes)).toEqual(['scope']);
  });
});

/* -------------------------------------------------------------------------- */
/* MiniMap colours                                                            */
/* -------------------------------------------------------------------------- */

describe('miniMapNodeColor', () => {
  it.each(ALL_KINDS)('returns a hex colour for the %s kind', (kind) => {
    const data: ScopeNodeData = { node: graphNode({ kind }) };
    expect(miniMapNodeColor(flowNode(data))).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each([
    ['no data at all', undefined],
    ['an empty data bag', {}],
    ['a data bag with no node', { node: undefined }],
    ['a node with an unknown kind', { node: { kind: 'not-a-kind' } }],
  ])('falls back to the neutral fill rather than throwing for %s', (_label, data) => {
    expect(miniMapNodeColor(flowNode(data))).toBe('#94a3b8');
  });
});
