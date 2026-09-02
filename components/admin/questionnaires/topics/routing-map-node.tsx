'use client';

/**
 * Node renderers for the Conditional topics routing map.
 *
 * One component for every {@link ScopeNodeKind}, sharing a single shell so a node's *kind* is the only
 * thing that varies — mirroring `conquest-workflow-node.tsx`, which does the same for workflow steps.
 *
 * The colour scheme carries one distinction and only one: **who decides**.
 *
 * - Blue = the agent (the planner). The one node on the map whose output is a judgement.
 * - Slate, solid border = deterministic code an author configured (guardrails).
 * - Muted, dashed = the always-asked band, drawn to recede: nothing on the map decides anything about it.
 *
 * Handles are left-in / right-out, with exactly one exception: the always-asked band's **head** takes
 * its inbound edge on the **top**.
 *
 * That is geometry, and it is the reason the band can sit where it does. The band is not a stage of the
 * left-to-right pipeline — it hangs off `start` and bypasses everything — so `graph.ts` draws it in the
 * columns beneath the pipeline's first two. With a left-in handle, `start` and the head sharing a column
 * meant an edge from a right handle to a left handle at the same `x`, which React Flow's `smoothstep`
 * renders as a backwards loop around both nodes. Taking it on top makes it the vertical drop it always
 * was in the description.
 *
 * The head has only ONE target handle either way, so no edge has to name a handle id.
 */

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Bot, CirclePlay, Layers, ListChecks, ShieldCheck, Sparkles } from 'lucide-react';

import {
  ROUTING_MAP_NODE_WIDTH,
  type ScopeGraphNode,
  type ScopeNodeBadge,
  type ScopeNodeKind,
} from '@/lib/app/questionnaire/scope/graph';
import { cn } from '@/lib/utils';

/** What React Flow carries on a routing-map node. The whole builder node, unwrapped by the renderer. */
export interface ScopeNodeData extends Record<string, unknown> {
  node: ScopeGraphNode;
}

export type ScopeFlowNode = Node<ScopeNodeData, 'scope'>;

/* -------------------------------------------------------------------------- */
/* Per-kind presentation                                                      */
/* -------------------------------------------------------------------------- */

type Tone = {
  /** The node's own box. */
  box: string;
  /** The icon plate. */
  plate: string;
  Icon: typeof Bot;
};

const TONES: Record<ScopeNodeKind, Tone> = {
  start: {
    box: 'border-slate-400 bg-white text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100',
    plate: 'bg-slate-100 dark:bg-slate-800',
    Icon: CirclePlay,
  },
  opening: {
    box: 'border-slate-300 bg-white text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100',
    plate: 'bg-slate-100 dark:bg-slate-800',
    Icon: ListChecks,
  },
  planner: {
    box: 'border-blue-400 bg-blue-50 text-blue-950 dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-100',
    plate: 'bg-blue-100 dark:bg-blue-900/60',
    Icon: Bot,
  },
  guardrails: {
    box: 'border-slate-400 bg-slate-50 text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100',
    plate: 'bg-slate-200 dark:bg-slate-800',
    Icon: ShieldCheck,
  },
  conditional: {
    box: 'border-violet-400 bg-violet-50 text-violet-950 dark:border-violet-500 dark:bg-violet-950/50 dark:text-violet-100',
    plate: 'bg-violet-100 dark:bg-violet-900/60',
    Icon: Sparkles,
  },
  always: {
    box: 'border-dashed border-slate-300 bg-slate-50/70 text-slate-600 dark:border-slate-600 dark:bg-slate-900/40 dark:text-slate-300',
    plate: 'bg-slate-200/70 dark:bg-slate-800/70',
    Icon: Layers,
  },
  alwaysBand: {
    box: 'border-dashed border-slate-400 bg-slate-100/80 text-slate-700 dark:border-slate-500 dark:bg-slate-800/60 dark:text-slate-200',
    plate: 'bg-slate-200 dark:bg-slate-700',
    Icon: Layers,
  },
};

/**
 * How a badge's tone paints.
 *
 * Exported because the detail panel re-draws the same pill beside its meaning: a reader arrives there
 * holding the chip they just saw on the canvas, and two tables would let the colours drift apart while
 * the text stayed identical — the one kind of mismatch that makes a reader doubt they clicked the
 * right node.
 */
export const BADGE_TONES: Record<ScopeNodeBadge['tone'], string> = {
  neutral: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100',
  positive: 'bg-emerald-600 text-white',
  negative: 'bg-rose-600 text-white',
  warning: 'bg-amber-500 text-white',
};

/* -------------------------------------------------------------------------- */
/* The node                                                                   */
/* -------------------------------------------------------------------------- */

export function ScopeMapNode({ data, selected }: NodeProps<ScopeFlowNode>) {
  const node = data.node;
  const tone = TONES[node.kind];
  const Icon = tone.Icon;
  // `start` has no inbound edge and the terminal columns have no outbound one. Rendering the handles
  // anyway is harmless and keeps every node the same shape, which matters more than the two dots saved.
  return (
    <div
      data-testid={`scope-node-${node.id}`}
      data-kind={node.kind}
      // Width comes from the layout module rather than a Tailwind class: the column pitch is derived
      // from it, and a node that renders wider than the layout believes closes the gutter it left.
      style={{ width: ROUTING_MAP_NODE_WIDTH }}
      className={cn(
        'relative flex items-start gap-2.5 rounded-lg border-2 px-3 py-2.5 shadow-sm transition-shadow',
        tone.box,
        selected && 'ring-primary shadow-md ring-2'
      )}
    >
      <Handle
        type="target"
        // See the header: the band's head is the one node the flow arrives at from above.
        position={node.kind === 'alwaysBand' ? Position.Top : Position.Left}
        className="!h-2 !w-2 !border-2 !border-current !bg-white dark:!bg-zinc-800"
      />

      <div
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          tone.plate
        )}
      >
        <Icon className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        {/* Never truncated. A clamped title turned a rule node into `Commercial outcome named was
            never…`, and a truncated rule sentence reads as a different rule — `was never…` could be
            `was never answered`, which is the operator deciding whether it fires for everybody. The
            layout in `graph.ts` counts the lines this wraps to, so a tall title costs nothing but
            height. */}
        <div className="text-sm leading-tight font-semibold break-words">{node.label}</div>
        {node.sublabel ? (
          // Three lines, then ellipsis: a summary whose full text is one click away, and the one field
          // an author can make arbitrarily long by naming a topic in a sentence.
          <div className="mt-0.5 line-clamp-3 text-[11px] leading-tight opacity-70">
            {node.sublabel}
          </div>
        ) : null}
        {node.badges && node.badges.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {node.badges.map((badge) => (
              <span
                key={badge.label}
                className={cn(
                  'inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide',
                  BADGE_TONES[badge.tone]
                )}
              >
                {badge.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-2 !border-current !bg-white dark:!bg-zinc-800"
      />
    </div>
  );
}

/** nodeTypes map for the routing map. Frozen at module scope — React Flow re-mounts on identity change. */
export const scopeNodeTypes = { scope: ScopeMapNode } as const;

/**
 * MiniMap fill per kind.
 *
 * Defensive about a missing kind for the same reason `conquestNodeTypes`' version is: if this throws,
 * the MiniMap renders no nodes at all rather than one wrong colour.
 */
const MINIMAP_COLORS: Record<ScopeNodeKind, string> = {
  start: '#64748b',
  opening: '#64748b',
  planner: '#2563eb',
  guardrails: '#334155',
  conditional: '#7c3aed',
  always: '#cbd5e1',
  alwaysBand: '#94a3b8',
};

export function miniMapNodeColor(node: Node): string {
  const kind = (node?.data as ScopeNodeData | undefined)?.node?.kind;
  return (kind && MINIMAP_COLORS[kind]) || '#94a3b8';
}
