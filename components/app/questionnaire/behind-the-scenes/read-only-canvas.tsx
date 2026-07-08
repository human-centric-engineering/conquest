'use client';

/**
 * Read-only React Flow surface for the Behind-the-Scenes visualizer.
 *
 * A view-only mirror of the platform `workflow-canvas.tsx`: it reuses the pure
 * `workflowDefinitionToFlow` adapter and renders the ConQuest node, but drops
 * authoring wiring (drag/drop, connect, the interactive retry edge). Nodes are
 * non-draggable/non-connectable.
 *
 * It DOES keep `onNodesChange`/`onEdgesChange` (via `useNodesState`/
 * `useEdgesState`) — not for editing, but because React Flow applies measured
 * node dimensions through the change pipeline. Without it the MiniMap never
 * learns node sizes and renders blank. Node/edge state is re-seeded whenever the
 * selected workflow changes.
 */

import { useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { workflowDefinitionToFlow } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';
import {
  conquestNodeTypes,
  miniMapNodeColor,
} from '@/components/app/questionnaire/behind-the-scenes/conquest-workflow-node';
import type { WorkflowDefinition } from '@/types/orchestration';

interface ReadOnlyCanvasProps {
  definition: WorkflowDefinition;
  onSelectNode: (nodeId: string | null) => void;
}

/** We don't register the interactive `retry` edge type; render retries as plain
 *  labelled default edges (the "(retry ×N)" label is already on them). */
function normaliseEdges(edges: Edge[]): Edge[] {
  return edges.map((edge) => (edge.type === 'retry' ? { ...edge, type: 'default' } : edge));
}

function CanvasInner({ definition, onSelectNode }: ReadOnlyCanvasProps) {
  const initial = useMemo(() => workflowDefinitionToFlow(definition), [definition]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(normaliseEdges(initial.edges));

  // Re-seed the graph when the selected workflow changes.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(normaliseEdges(initial.edges));
  }, [initial, setNodes, setEdges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={conquestNodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      edgesFocusable={false}
      fitView
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
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
        className="!hidden sm:!block"
      />
    </ReactFlow>
  );
}

export function ReadOnlyCanvas(props: ReadOnlyCanvasProps) {
  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
