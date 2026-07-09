'use client';

/**
 * ConQuest read-only workflow node.
 *
 * A view-only replacement for the platform `PatternNode` used only on the
 * Behind-the-Scenes canvas. It keeps the registry-driven icon + handle layout,
 * but makes the demo's core distinctions unmistakable:
 *
 * - **Retrieval** steps (they read a knowledge base or run an embedding/vector
 *   engine — `_meta.kb`/`_meta.vector`) render violet with a "KB"/"Vector" badge.
 *   This treatment wins over the agentic/deterministic split because "where does
 *   knowledge/vector plug in" is the question the highlight answers; an agentic
 *   retrieval step still keeps its "AI" badge.
 * - **Agentic** steps (an LLM agent runs them — `_meta.agentSlug`/
 *   `promptCatalogSlug`) render solid blue with an "AI" badge.
 * - **Hybrid** steps (`_meta.hybrid` — a deterministic path AND an LLM path in
 *   the same turn, e.g. the safety gates) render blue with a DASHED border (the
 *   "AI" blue + the deterministic dash) and a "Hybrid" badge.
 * - **Deterministic** steps (plumbing: parse, merge, persist, pure-code guards)
 *   render muted with a dashed border.
 *
 * The per-step icon still conveys the specific role. `miniMapNodeColor` is
 * exported so the canvas MiniMap can colour nodes the same way.
 */

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Blend, Boxes, Database, HelpCircle, Sparkles } from 'lucide-react';

import { getStepMetadata, getStepOutputs } from '@/lib/orchestration/engine/step-registry';
import {
  getNodeMeta,
  nodeExecutionKind,
  nodeRetrievalKind,
} from '@/lib/app/questionnaire/workflows/types';
import type { NodeExecutionKind, RetrievalKind } from '@/lib/app/questionnaire/workflows/types';
import { cn } from '@/lib/utils';
import type { PatternNode as PatternNodeType } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

/** Top-left badge content for a retrieval step. */
const RETRIEVAL_BADGE: Record<RetrievalKind, { label: string; Icon: typeof Database }> = {
  kb: { label: 'KB', Icon: Database },
  vector: { label: 'Vector', Icon: Boxes },
};

/** Top-right "an LLM runs here" badge, per execution kind (deterministic steps get none). */
const EXECUTION_BADGE: Record<
  Exclude<NodeExecutionKind, 'deterministic'>,
  { label: string; Icon: typeof Sparkles }
> = {
  agent: { label: 'AI', Icon: Sparkles },
  hybrid: { label: 'Hybrid', Icon: Blend },
};

/** Human sub-label under the node title, per execution kind. */
const EXECUTION_SUBLABEL: Record<NodeExecutionKind, string> = {
  agent: 'AI agent',
  hybrid: 'Hybrid',
  deterministic: 'Deterministic',
};

export function ConquestWorkflowNode({ data, selected }: NodeProps<PatternNodeType>) {
  const meta = getStepMetadata(data.type);
  const Icon = meta?.icon ?? HelpCircle;
  const inputs = meta?.inputs ?? 1;
  const { outputs, outputLabels } = getStepOutputs(data.type, data.config);
  const execution = nodeExecutionKind(data.config);
  const retrieval = nodeRetrievalKind(data.config);
  const badge = retrieval ? RETRIEVAL_BADGE[retrieval] : null;
  const execBadge = execution !== 'deterministic' ? EXECUTION_BADGE[execution] : null;

  return (
    <div
      data-testid={`cq-node-${data.type}`}
      data-execution={execution}
      data-retrieval={retrieval ?? undefined}
      className={cn(
        'relative flex max-w-[172px] min-w-[150px] flex-col items-center gap-2 rounded-lg px-3 py-3 transition-shadow',
        retrieval
          ? 'border-2 border-violet-400 bg-violet-50 text-violet-950 shadow-sm dark:border-violet-500 dark:bg-violet-950/50 dark:text-violet-100'
          : execution === 'agent'
            ? 'border-2 border-blue-400 bg-blue-50 text-blue-950 shadow-sm dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-100'
            : execution === 'hybrid'
              ? 'border-2 border-dashed border-blue-400 bg-blue-50/80 text-blue-950 shadow-sm dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-100'
              : 'border-2 border-dashed border-slate-300 bg-slate-50/70 text-slate-500 dark:border-slate-600 dark:bg-slate-900/40 dark:text-slate-400',
        selected && 'ring-primary shadow-md ring-2'
      )}
    >
      {badge ? (
        <span className="absolute -top-2 -left-2 z-10 inline-flex items-center gap-0.5 rounded-full bg-violet-600 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white shadow">
          <badge.Icon className="h-2.5 w-2.5" />
          {badge.label}
        </span>
      ) : null}

      {execBadge ? (
        <span
          className={cn(
            'absolute -top-2 -right-2 z-10 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white shadow',
            execution === 'hybrid' ? 'bg-sky-500' : 'bg-blue-600'
          )}
        >
          <execBadge.Icon className="h-2.5 w-2.5" />
          {execBadge.label}
        </span>
      ) : null}

      {/* Input handles — stacked on the left. */}
      {Array.from({ length: inputs }).map((_, i) => (
        <Handle
          key={`in-${i}`}
          id={`in-${i}`}
          type="target"
          position={Position.Left}
          style={{ top: inputs === 1 ? '50%' : `${((i + 1) * 100) / (inputs + 1)}%` }}
          className="!h-2 !w-2 !border-2 !border-current !bg-white dark:!bg-zinc-800"
        />
      ))}

      <div
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md',
          retrieval
            ? 'bg-violet-100 dark:bg-violet-900/60'
            : execution === 'deterministic'
              ? 'bg-slate-200 dark:bg-slate-800'
              : 'bg-blue-100 dark:bg-blue-900/60'
        )}
      >
        <Icon className="h-4 w-4" />
      </div>

      <div className="text-center">
        <div className="text-sm leading-tight font-semibold">{data.label}</div>
        <div className="text-[10px] font-medium tracking-wide uppercase opacity-70">
          {EXECUTION_SUBLABEL[execution]}
        </div>
      </div>

      {/* Output handles — stacked on the right; hover for the label. */}
      {Array.from({ length: outputs }).map((_, i) => {
        const label = outputLabels?.[i];
        const topPct = outputs === 1 ? '50%' : `${((i + 1) * 100) / (outputs + 1)}%`;
        return (
          <Handle
            key={`out-${i}`}
            id={`out-${i}`}
            type="source"
            position={Position.Right}
            style={{ top: topPct }}
            title={label}
            className="!h-2 !w-2 !border-2 !border-current !bg-white dark:!bg-zinc-800"
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel group box — a labelled container drawn *behind* a set of member nodes
// (e.g. the seven design-evaluation judges). Synthesised client-side from member
// positions by `buildGroupNodes`; not a DAG node. Non-interactive: it never
// intercepts clicks (the members render on top) and is never selectable.
// ---------------------------------------------------------------------------

interface PanelGroupData extends Record<string, unknown> {
  label: string;
  width: number;
  height: number;
}

export function PanelGroupNode({ data }: NodeProps) {
  const { label, width, height } = data as PanelGroupData;
  return (
    <div
      style={{ width, height }}
      className="pointer-events-none relative rounded-xl border-2 border-dashed border-slate-300/80 bg-slate-100/30 dark:border-slate-600/70 dark:bg-slate-800/20"
    >
      <span className="absolute -top-2.5 left-3 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-700 dark:text-slate-200">
        {label}
      </span>
    </div>
  );
}

// Approx node footprint + padding used to size a group box from member positions
// (member `position` is the hand-placed `_layout`, so this is deterministic — no
// dependence on React Flow's measured dimensions).
const GROUP_APPROX_W = 176;
const GROUP_APPROX_H = 104;
const GROUP_PAD_X = 28;
const GROUP_PAD_TOP = 44;
const GROUP_PAD_BOTTOM = 24;

/**
 * Synthesise a container node for every `_meta.group` on the mapped nodes. Returned nodes are
 * meant to be prepended to the node list (so they paint *behind* their members) by the canvas.
 */
export function buildGroupNodes(nodes: PatternNodeType[]): Node[] {
  const groups = new Map<string, { label: string; members: PatternNodeType[] }>();
  for (const n of nodes) {
    const meta = getNodeMeta((n.data as { config?: Record<string, unknown> }).config ?? {});
    if (!meta.group) continue;
    const entry = groups.get(meta.group.id) ?? { label: meta.group.label, members: [] };
    entry.members.push(n);
    groups.set(meta.group.id, entry);
  }

  const out: Node[] = [];
  for (const [id, { label, members }] of groups) {
    if (members.length === 0) continue;
    const xs = members.map((m) => m.position.x);
    const ys = members.map((m) => m.position.y);
    const x = Math.min(...xs) - GROUP_PAD_X;
    const y = Math.min(...ys) - GROUP_PAD_TOP;
    out.push({
      id: `group-${id}`,
      type: 'panelGroup',
      position: { x, y },
      data: {
        label,
        width: Math.max(...xs) + GROUP_APPROX_W + GROUP_PAD_X - x,
        height: Math.max(...ys) + GROUP_APPROX_H + GROUP_PAD_BOTTOM - y,
      },
      selectable: false,
      draggable: false,
      // Click-through: the box is pure decoration, so clicks in its padding reach the pane
      // (which deselects) rather than the container.
      style: { pointerEvents: 'none' },
      zIndex: 0,
    });
  }
  return out;
}

/** nodeTypes map for the read-only ConQuest canvas (keyed 'pattern' to match the mapper). */
export const conquestNodeTypes = {
  pattern: ConquestWorkflowNode,
  panelGroup: PanelGroupNode,
} as const;

/** MiniMap fill for a node, matching the retrieval/agent/hybrid/deterministic node treatment.
 *  Defensive: MiniMap must never throw here or it renders no nodes at all. */
export function miniMapNodeColor(node: Node): string {
  // Group container: a pale fill so it reads as background, not a step.
  if (node?.type === 'panelGroup') return '#e2e8f0';
  const data = node?.data as { config?: Record<string, unknown> } | undefined;
  // violet-600 for retrieval (KB/vector); blue-600 for AI; sky-500 for hybrid; slate-400 for
  // deterministic (all dark enough to read on the light map).
  if (nodeRetrievalKind(data?.config ?? {})) return '#7c3aed';
  switch (nodeExecutionKind(data?.config)) {
    case 'agent':
      return '#2563eb';
    case 'hybrid':
      return '#0ea5e9';
    case 'deterministic':
      return '#94a3b8';
  }
}
