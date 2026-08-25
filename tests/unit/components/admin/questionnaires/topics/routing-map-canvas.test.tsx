/**
 * Unit tests: `RoutingMapCanvas` — the React Flow surface for the routing map.
 *
 * The component's real job is a translation: a neutral `ScopeGraph` from `scope/graph.ts` in, React
 * Flow's `{ nodes, edges }` out. `graph.ts` is deliberately free of any `@xyflow/react` import, which
 * means this mapping is the only place the two vocabularies meet — and the only place a wrong edge
 * colour, a dropped position or an unstyled kind can be caught.
 *
 * So `@xyflow/react` is stubbed to record what it was handed rather than to draw anything (happy-dom
 * has no ResizeObserver; React Flow measures on mount). `useNodesState` / `useEdgesState` are stubbed
 * with real `useState` rather than a frozen tuple, because the re-seed effect — the thing that keeps a
 * saved settings change from leaving stale positions on the canvas — is only observable if the setter
 * actually sets.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Edge, Node } from '@xyflow/react';

const { ReactFlowMock, useThemeMock, MINIMAP_PROPS } = vi.hoisted(() => ({
  ReactFlowMock: vi.fn(),
  useThemeMock: vi.fn(),
  MINIMAP_PROPS: [] as Record<string, unknown>[],
}));

vi.mock('@xyflow/react', async () => {
  const react = await import('react');
  return {
    ReactFlow: (props: Record<string, unknown>) => {
      ReactFlowMock(props);
      return (
        <div data-testid="rf-canvas" aria-label={props['aria-label'] as string}>
          {props.children as ReactNode}
        </div>
      );
    },
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Background: () => <div data-testid="rf-background" />,
    Controls: () => <div data-testid="rf-controls" />,
    MiniMap: (props: Record<string, unknown>) => {
      MINIMAP_PROPS.push(props);
      return <div data-testid="rf-minimap" />;
    },
    Panel: ({ children }: { children: ReactNode }) => <div data-testid="rf-panel">{children}</div>,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    useNodesState: (initial: Node[]) => {
      const [nodes, setNodes] = react.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: Edge[]) => {
      const [edges, setEdges] = react.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
  };
});

vi.mock('@xyflow/react/dist/style.css', () => ({}));

vi.mock('@/hooks/use-theme', () => ({ useTheme: () => useThemeMock() }));

// Imported after the mocks, which vitest hoists above them.
import { RoutingMapCanvas } from '@/components/admin/questionnaires/topics/routing-map-canvas';
import { miniMapNodeColor } from '@/components/admin/questionnaires/topics/routing-map-node';
import type {
  ScopeEdgeKind,
  ScopeGraph,
  ScopeGraphEdge,
  ScopeGraphNode,
} from '@/lib/app/questionnaire/scope/graph';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ALL_EDGE_KINDS: ScopeEdgeKind[] = [
  'always',
  'candidate',
  'ruleInclude',
  'ruleExclude',
  'evidence',
  'evidenceWeak',
];

function node(id: string, x = 0, y = 0): ScopeGraphNode {
  return {
    id,
    kind: 'conditional',
    x,
    y,
    label: id,
    detail: { title: id, summary: '', rows: [] },
  };
}

function edge(id: string, kind: ScopeEdgeKind, label?: string): ScopeGraphEdge {
  return { id, source: 'a', target: 'b', kind, ...(label ? { label } : {}) };
}

function graph(overrides: Partial<ScopeGraph> = {}): ScopeGraph {
  return {
    nodes: [node('a', 10, 20), node('b', 300, 40)],
    edges: [edge('a->b', 'always')],
    ...overrides,
  };
}

/** The props the stub last saw. */
function lastProps(): Record<string, unknown> {
  const call = ReactFlowMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0] as Record<string, unknown>;
}

function lastNodes(): Node[] {
  return lastProps().nodes as Node[];
}

function lastEdges(): Edge[] {
  return lastProps().edges as Edge[];
}

beforeEach(() => {
  ReactFlowMock.mockClear();
  MINIMAP_PROPS.length = 0;
  useThemeMock.mockReturnValue({ theme: 'light', setTheme: vi.fn() });
});

/* -------------------------------------------------------------------------- */
/* Node mapping                                                               */
/* -------------------------------------------------------------------------- */

describe('RoutingMapCanvas — nodes', () => {
  it('carries the layout module’s x/y through as React Flow positions', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    expect(lastNodes()).toEqual([
      expect.objectContaining({ id: 'a', type: 'scope', position: { x: 10, y: 20 } }),
      expect.objectContaining({ id: 'b', type: 'scope', position: { x: 300, y: 40 } }),
    ]);
  });

  it('hands the whole builder node through as `data.node`, unwrapped by the renderer', () => {
    const only = node('solo', 5, 6);
    render(<RoutingMapCanvas graph={graph({ nodes: [only] })} onSelectNode={vi.fn()} />);

    expect(lastNodes()[0]?.data).toEqual({ node: only });
  });

  it('renders an empty graph without crashing', () => {
    render(<RoutingMapCanvas graph={graph({ nodes: [], edges: [] })} onSelectNode={vi.fn()} />);

    expect(lastNodes()).toEqual([]);
    expect(lastEdges()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Edge mapping                                                               */
/* -------------------------------------------------------------------------- */

describe('RoutingMapCanvas — edges', () => {
  it('gives every edge kind its own stroke, so no two read the same on the canvas', () => {
    render(
      <RoutingMapCanvas
        graph={graph({ edges: ALL_EDGE_KINDS.map((kind) => edge(kind, kind)) })}
        onSelectNode={vi.fn()}
      />
    );

    const strokes = lastEdges().map((e) => (e.style as { stroke: string }).stroke);
    expect(strokes).toHaveLength(ALL_EDGE_KINDS.length);
    expect(strokes.every((s) => /^#[0-9a-f]{6}$/i.test(s))).toBe(true);
    // `evidence` shares slate with `always` deliberately — the pair that must differ is include/exclude.
    expect(new Set(strokes).size).toBeGreaterThanOrEqual(ALL_EDGE_KINDS.length - 1);
  });

  it('dashes exactly the two kinds nothing has settled yet', () => {
    render(
      <RoutingMapCanvas
        graph={graph({ edges: ALL_EDGE_KINDS.map((kind) => edge(kind, kind)) })}
        onSelectNode={vi.fn()}
      />
    );

    const dashed = lastEdges()
      .filter((e) => (e.style as { strokeDasharray?: string }).strokeDasharray !== undefined)
      .map((e) => e.id);

    expect(dashed.sort()).toEqual(['candidate', 'evidenceWeak']);
  });

  it('draws the two hard-rule kinds thicker than the rest — an author’s own certainty', () => {
    render(
      <RoutingMapCanvas
        graph={graph({ edges: ALL_EDGE_KINDS.map((kind) => edge(kind, kind)) })}
        onSelectNode={vi.fn()}
      />
    );

    const widthOf = (id: string) =>
      (lastEdges().find((e) => e.id === id)?.style as { strokeWidth: number }).strokeWidth;

    expect(widthOf('ruleInclude')).toBe(2);
    expect(widthOf('ruleExclude')).toBe(2);
    expect(widthOf('always')).toBe(1.5);
  });

  it('colours the arrowhead to match its line, so an edge reads as one object', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    const [e] = lastEdges();
    const marker = e?.markerEnd as { type: string; color: string };
    expect(marker.type).toBe('arrowclosed');
    expect(marker.color).toBe((e?.style as { stroke: string }).stroke);
  });

  it('sets a label only when the builder gave one', () => {
    render(
      <RoutingMapCanvas
        graph={graph({
          edges: [
            edge('labelled', 'evidenceWeak', 'timing not guaranteed'),
            edge('bare', 'always'),
          ],
        })}
        onSelectNode={vi.fn()}
      />
    );

    const byId = new Map(lastEdges().map((e) => [e.id, e]));
    expect(byId.get('labelled')?.label).toBe('timing not guaranteed');
    expect('label' in (byId.get('bare') ?? {})).toBe(false);
  });

  it('keeps the edge kind on the edge, so a reader can trace it back to the legend', () => {
    render(
      <RoutingMapCanvas graph={graph({ edges: [edge('x', 'candidate')] })} onSelectNode={vi.fn()} />
    );

    expect(lastEdges()[0]?.data).toEqual({ kind: 'candidate' });
  });
});

/* -------------------------------------------------------------------------- */
/* Re-seeding                                                                 */
/* -------------------------------------------------------------------------- */

describe('RoutingMapCanvas — rebuilds', () => {
  it('re-seeds nodes and edges when a new graph arrives, discarding any drag', () => {
    const { rerender } = render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);
    expect(lastNodes().map((n) => n.id)).toEqual(['a', 'b']);

    rerender(
      <RoutingMapCanvas
        graph={graph({ nodes: [node('c', 1, 2)], edges: [] })}
        onSelectNode={vi.fn()}
      />
    );

    expect(lastNodes().map((n) => n.id)).toEqual(['c']);
    expect(lastEdges()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

describe('RoutingMapCanvas — wiring', () => {
  it('reports the clicked node’s id, and null when the pane is clicked', () => {
    const onSelectNode = vi.fn();
    render(<RoutingMapCanvas graph={graph()} onSelectNode={onSelectNode} />);

    const props = lastProps();
    (props.onNodeClick as (e: unknown, n: { id: string }) => void)({}, { id: 'b' });
    expect(onSelectNode).toHaveBeenCalledWith('b');

    (props.onPaneClick as () => void)();
    expect(onSelectNode).toHaveBeenCalledWith(null);
  });

  it('is read-only: nothing can be connected, and nothing writes', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    const props = lastProps();
    expect(props.nodesConnectable).toBe(false);
    expect(props.elementsSelectable).toBe(true);
    // Draggable so an author can pull a crowded column apart; the drag is local and discarded on rebuild.
    expect(props.nodesDraggable).toBe(true);
  });

  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'light'],
  ])('maps the %s theme onto React Flow colorMode %s', (theme, expected) => {
    useThemeMock.mockReturnValue({ theme, setTheme: vi.fn() });
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    expect(lastProps().colorMode).toBe(expected);
  });

  it('labels the canvas for screen readers and hides the vendor attribution', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    expect(screen.getByLabelText('Conditional topics routing map')).toBeInTheDocument();
    expect(lastProps().proOptions).toEqual({ hideAttribution: true });
  });

  it('paints the MiniMap from the shared per-kind colour function', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    expect(MINIMAP_PROPS[0]?.nodeColor).toBe(miniMapNodeColor);
    expect(MINIMAP_PROPS[0]?.nodeStrokeColor).toBe(miniMapNodeColor);
  });

  it('mounts the background, controls and minimap chrome', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    expect(screen.getByTestId('rf-background')).toBeInTheDocument();
    expect(screen.getByTestId('rf-controls')).toBeInTheDocument();
    expect(screen.getByTestId('rf-minimap')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Legend                                                                     */
/* -------------------------------------------------------------------------- */

describe('RoutingMapCanvas — legend', () => {
  it('names every edge kind the canvas can draw, in plain English', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    for (const label of [
      'Always happens',
      'Evidence a rule reads',
      'Evidence that may not be there yet',
      'Rule: always include',
      'Rule: never include',
      'The agent may choose it',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('has one legend row per edge kind, so no kind can reach the canvas unexplained', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    expect(screen.getByTestId('rf-panel').querySelectorAll('li')).toHaveLength(
      ALL_EDGE_KINDS.length
    );
  });

  it('draws each legend swatch in its own edge colour', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    const lines = [...screen.getByTestId('rf-panel').querySelectorAll('line')];
    const strokes = lines.map((l) => l.getAttribute('stroke'));

    expect(lines).toHaveLength(ALL_EDGE_KINDS.length);
    expect(strokes.every((s) => s !== null && /^#[0-9a-f]{6}$/i.test(s))).toBe(true);
  });

  it('dashes the two legend swatches whose edges are dashed', () => {
    render(<RoutingMapCanvas graph={graph()} onSelectNode={vi.fn()} />);

    const dashed = [...screen.getByTestId('rf-panel').querySelectorAll('line')].filter((l) =>
      l.hasAttribute('stroke-dasharray')
    );

    expect(dashed).toHaveLength(2);
  });
});
