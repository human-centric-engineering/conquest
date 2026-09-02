'use client';

/**
 * The React Flow surface for the Conditional topics routing map.
 *
 * A sibling of `behind-the-scenes/read-only-canvas.tsx` rather than a reuse of it: that one is typed to a
 * `WorkflowDefinition` and drives its nodes off the orchestration step registry, which has nothing to say
 * about topics, rules or guardrails. What IS reused is its wiring, verbatim, including the trap it
 * documents — `useNodesState` / `useEdgesState` are needed even for a static view, because they drive
 * React Flow's measured-dimension pipeline and without them the MiniMap never learns node sizes and
 * renders blank.
 *
 * Nodes stay draggable so an author can pull a crowded column apart; drags are local and reset whenever
 * the graph is rebuilt. Nothing here writes.
 */

import { useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useTheme } from '@/hooks/use-theme';
import type { ScopeEdgeKind, ScopeGraph } from '@/lib/app/questionnaire/scope/graph';
import {
  miniMapNodeColor,
  scopeNodeTypes,
  type ScopeFlowNode,
} from '@/components/admin/questionnaires/topics/routing-map-node';

/* -------------------------------------------------------------------------- */
/* Edge styling                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How each edge kind paints. Hex rather than Tailwind classes because React Flow strokes an SVG path
 * with an inline style; a `dark:` variant would never apply. These read acceptably on both the light
 * and dark canvas backgrounds, which is why the palette is mid-tone throughout.
 */
const EDGE_STYLES: Record<ScopeEdgeKind, { stroke: string; dashed: boolean; width: number }> = {
  always: { stroke: '#64748b', dashed: false, width: 1.5 },
  candidate: { stroke: '#7c3aed', dashed: true, width: 1.5 },
};

/** The legend, in the order the pipeline uses each kind. */
const LEGEND: { kind: ScopeEdgeKind; label: string }[] = [
  { kind: 'always', label: 'Always happens' },
  { kind: 'candidate', label: 'The agent may choose it' },
];

function toFlow(graph: ScopeGraph): { nodes: ScopeFlowNode[]; edges: Edge[] } {
  const nodes: ScopeFlowNode[] = graph.nodes.map((node) => ({
    id: node.id,
    type: 'scope',
    position: { x: node.x, y: node.y },
    data: { node },
  }));

  const edges: Edge[] = graph.edges.map((edge) => {
    const style = EDGE_STYLES[edge.kind];
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      ...(edge.label ? { label: edge.label } : {}),
      labelStyle: { fontSize: 10, fill: style.stroke },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      style: {
        stroke: style.stroke,
        strokeWidth: style.width,
        ...(style.dashed ? { strokeDasharray: '6 4' } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 16, height: 16 },
      data: { kind: edge.kind },
    };
  });

  return { nodes, edges };
}

/* -------------------------------------------------------------------------- */
/* The canvas                                                                 */
/* -------------------------------------------------------------------------- */

export interface RoutingMapCanvasProps {
  graph: ScopeGraph;
  /** Called with the node id, or null when the pane is clicked. */
  onSelectNode: (nodeId: string | null) => void;
}

function CanvasInner({ graph, onSelectNode }: RoutingMapCanvasProps) {
  const { theme } = useTheme();
  const initial = useMemo(() => toFlow(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  // Re-seed when the graph is rebuilt — a settings save, or the always-band toggle. Any drag the author
  // did is discarded with it, which is correct: the positions describe the old graph.
  //
  // The selection is deliberately NOT cleared here. The caller resolves it by id against the graph it
  // just built, so a node that survives the rebuild stays selected and one that does not resolves to
  // null on its own — which is the behaviour an author wants when they expand the always-asked band
  // while reading a topic's detail.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={scopeNodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      edgesFocusable={false}
      fitView
      // Tighter than the 0.15 a canvas usually wants. The map is six columns wide, so `fitView` is
      // width-bound on every real version: padding it generously costs zoom on the whole graph, and
      // zoom is what makes a node's second line readable. The legend still sits over empty canvas.
      fitViewOptions={{ padding: 0.06 }}
      minZoom={0.15}
      colorMode={theme === 'dark' ? 'dark' : 'light'}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
      aria-label="Conditional topics routing map"
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={miniMapNodeColor}
        nodeStrokeColor={miniMapNodeColor}
        nodeStrokeWidth={3}
        maskColor="rgba(0, 0, 0, 0.06)"
        className="!hidden lg:!block"
      />
      <Panel position="top-left">
        <ul className="bg-background/90 rounded-md border p-2 text-[11px] shadow-sm backdrop-blur">
          {LEGEND.map(({ kind, label }) => {
            const style = EDGE_STYLES[kind];
            return (
              <li key={kind} className="flex items-center gap-2 py-0.5">
                <svg width="26" height="6" aria-hidden="true" className="shrink-0">
                  <line
                    x1="0"
                    y1="3"
                    x2="26"
                    y2="3"
                    stroke={style.stroke}
                    strokeWidth={style.width + 0.5}
                    {...(style.dashed ? { strokeDasharray: '5 3' } : {})}
                  />
                </svg>
                <span className="text-muted-foreground">{label}</span>
              </li>
            );
          })}
        </ul>
      </Panel>
    </ReactFlow>
  );
}

export function RoutingMapCanvas(props: RoutingMapCanvasProps) {
  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
