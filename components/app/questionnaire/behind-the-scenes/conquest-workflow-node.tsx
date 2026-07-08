'use client';

/**
 * ConQuest read-only workflow node.
 *
 * A view-only replacement for the platform `PatternNode` used only on the
 * Behind-the-Scenes canvas. It keeps the registry-driven icon + handle layout,
 * but makes the demo's core distinction unmistakable: **agentic** steps (an LLM
 * agent runs them — `_meta.agentSlug`/`promptCatalogSlug`) render solid and
 * vivid with an "AI" badge, while **deterministic** steps (plumbing: parse,
 * merge, persist, guards) render muted with a dashed border. The per-step icon
 * still conveys the specific role.
 *
 * `isAgenticNode` is exported so the canvas MiniMap can colour nodes the same
 * way.
 */

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { HelpCircle, Sparkles } from 'lucide-react';

import { getStepMetadata, getStepOutputs } from '@/lib/orchestration/engine/step-registry';
import { getNodeMeta } from '@/lib/app/questionnaire/workflows/types';
import { cn } from '@/lib/utils';
import type { PatternNode as PatternNodeType } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

/** True when an LLM agent runs this step (vs. deterministic code). */
export function isAgenticNode(config: Record<string, unknown> | undefined): boolean {
  const meta = getNodeMeta(config ?? {});
  return Boolean(meta.agentSlug || meta.promptCatalogSlug);
}

export function ConquestWorkflowNode({ data, selected }: NodeProps<PatternNodeType>) {
  const meta = getStepMetadata(data.type);
  const Icon = meta?.icon ?? HelpCircle;
  const inputs = meta?.inputs ?? 1;
  const { outputs, outputLabels } = getStepOutputs(data.type, data.config);
  const agentic = isAgenticNode(data.config);

  return (
    <div
      data-testid={`cq-node-${data.type}`}
      data-agentic={agentic}
      className={cn(
        'relative flex max-w-[172px] min-w-[150px] flex-col items-center gap-2 rounded-lg px-3 py-3 transition-shadow',
        agentic
          ? 'border-2 border-blue-400 bg-blue-50 text-blue-950 shadow-sm dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-100'
          : 'border-2 border-dashed border-slate-300 bg-slate-50/70 text-slate-500 dark:border-slate-600 dark:bg-slate-900/40 dark:text-slate-400',
        selected && 'ring-primary shadow-md ring-2'
      )}
    >
      {agentic ? (
        <span className="absolute -top-2 -right-2 z-10 inline-flex items-center gap-0.5 rounded-full bg-blue-600 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white shadow">
          <Sparkles className="h-2.5 w-2.5" />
          AI
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
          agentic ? 'bg-blue-100 dark:bg-blue-900/60' : 'bg-slate-200 dark:bg-slate-800'
        )}
      >
        <Icon className="h-4 w-4" />
      </div>

      <div className="text-center">
        <div className="text-sm leading-tight font-semibold">{data.label}</div>
        <div className="text-[10px] font-medium tracking-wide uppercase opacity-70">
          {agentic ? 'AI agent' : 'Deterministic'}
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

/** nodeTypes map for the read-only ConQuest canvas (keyed 'pattern' to match the mapper). */
export const conquestNodeTypes = { pattern: ConquestWorkflowNode } as const;

/** MiniMap fill for a node, matching the agentic/deterministic node treatment.
 *  Defensive: MiniMap must never throw here or it renders no nodes at all. */
export function miniMapNodeColor(node: Node): string {
  const data = node?.data as { config?: Record<string, unknown> } | undefined;
  // blue-600 for AI steps; slate-400 for deterministic (dark enough to read on the light map).
  return isAgenticNode(data?.config) ? '#2563eb' : '#94a3b8';
}
