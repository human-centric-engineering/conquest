'use client';

/**
 * Node renderers for the Adaptive scope routing map.
 *
 * One component for every {@link ScopeNodeKind}, sharing a single shell so a node's *kind* is the only
 * thing that varies — mirroring `conquest-workflow-node.tsx`, which does the same for workflow steps.
 *
 * The colour scheme carries one distinction and only one: **who decides**.
 *
 * - Blue = the agent (the planner). The one node on the map whose output is a judgement.
 * - Slate, solid border = deterministic code an author configured (guardrails).
 * - Emerald / rose = a hard rule's include and exclude — an author's own certainty, and the two
 *   directions must never be confused at a glance.
 * - Amber = the "not gathered in the opening" marker, the only node that is a problem rather than a part.
 * - Muted, dashed = the always-asked band, drawn to recede: nothing on the map decides anything about it.
 *
 * Handles are fixed left-in / right-out. The map is a strictly left-to-right pipeline, so there is
 * nothing for a multi-handle layout to express.
 */

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Bot,
  CircleAlert,
  CirclePlay,
  Layers,
  ListChecks,
  MinusCircle,
  PlusCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import type {
  ScopeGraphNode,
  ScopeNodeBadge,
  ScopeNodeKind,
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
  ungathered: {
    box: 'border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-500 dark:bg-amber-950/50 dark:text-amber-100',
    plate: 'bg-amber-100 dark:bg-amber-900/60',
    Icon: CircleAlert,
  },
  ruleInclude: {
    box: 'border-emerald-400 bg-emerald-50 text-emerald-950 dark:border-emerald-500 dark:bg-emerald-950/50 dark:text-emerald-100',
    plate: 'bg-emerald-100 dark:bg-emerald-900/60',
    Icon: PlusCircle,
  },
  ruleExclude: {
    box: 'border-rose-400 bg-rose-50 text-rose-950 dark:border-rose-500 dark:bg-rose-950/50 dark:text-rose-100',
    plate: 'bg-rose-100 dark:bg-rose-900/60',
    Icon: MinusCircle,
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

const BADGE_TONES: Record<ScopeNodeBadge['tone'], string> = {
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
      className={cn(
        'relative flex w-[236px] items-start gap-2.5 rounded-lg border-2 px-3 py-2.5 shadow-sm transition-shadow',
        tone.box,
        selected && 'ring-primary shadow-md ring-2'
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
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
        {/* Two lines maximum, then ellipsis: a forty-word criteria string in a node would push every
            other node off screen, and the full text is one click away in the detail panel. */}
        <div className="line-clamp-2 text-sm leading-tight font-semibold break-words">
          {node.label}
        </div>
        {node.sublabel ? (
          <div className="mt-0.5 line-clamp-2 text-[11px] leading-tight opacity-70">
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
  ungathered: '#f59e0b',
  ruleInclude: '#059669',
  ruleExclude: '#e11d48',
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
