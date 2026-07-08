'use client';

/**
 * Behind-the-Scenes explorer — the client shell.
 *
 * Owns the selected workflow, the optional questionnaire lens, and the selected
 * node. Re-fetches the tinted summaries when the lens changes, fetches the
 * chosen workflow's diagram + enrichment on demand, and lays out the picker,
 * the read-only canvas, and the node info panel.
 */

import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import type { WorkflowSummary } from '@/lib/app/questionnaire/workflows/types';

import { NodeInfoPanel } from '@/components/app/questionnaire/behind-the-scenes/node-info-panel';
import { QuestionnaireLens } from '@/components/app/questionnaire/behind-the-scenes/questionnaire-lens';
import { ReadOnlyCanvas } from '@/components/app/questionnaire/behind-the-scenes/read-only-canvas';
import { WorkflowPicker } from '@/components/app/questionnaire/behind-the-scenes/workflow-picker';
import {
  fetchWorkflowSummaries,
  useWorkflowDetail,
  type QuestionnaireOption,
} from '@/components/app/questionnaire/behind-the-scenes/use-workflows';

interface BehindTheScenesExplorerProps {
  initialWorkflows: WorkflowSummary[];
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-2 w-2 rounded-full', className)} aria-hidden />
      {label}
    </span>
  );
}

const STATUS_BANNER: Record<string, string> = {
  inactive:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
  unavailable:
    'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-200',
};

export function BehindTheScenesExplorer({ initialWorkflows }: BehindTheScenesExplorerProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>(initialWorkflows);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    initialWorkflows[0]?.slug ?? null
  );
  const [lens, setLens] = useState<QuestionnaireOption | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { detail, loading, error } = useWorkflowDetail(selectedSlug, lens?.versionId);

  // Re-tint the picker when the lens changes.
  useEffect(() => {
    let cancelled = false;
    fetchWorkflowSummaries(lens?.versionId)
      .then((next) => {
        if (!cancelled) setWorkflows(next);
      })
      .catch(() => {
        /* keep the previous summaries on a transient failure */
      });
    return () => {
      cancelled = true;
    };
  }, [lens?.versionId]);

  // Reset the node selection when the workflow changes.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [selectedSlug]);

  const selectedSummary = workflows.find((w) => w.slug === selectedSlug) ?? null;
  const selectedStep = useMemo(
    () => detail?.definition.steps.find((s) => s.id === selectedNodeId) ?? null,
    [detail, selectedNodeId]
  );
  const enrichment = selectedNodeId ? (detail?.enrichment[selectedNodeId] ?? null) : null;
  const applicability = detail?.applicability;
  const showBanner = Boolean(lens) && applicability && applicability.status !== 'applies';

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Behind the scenes</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            The agentic pipelines that power ConQuest. Pick a workflow, then click any step to see
            the agent, its prompt, the tools it calls, and where knowledge plugs in.
          </p>
        </div>
        <QuestionnaireLens value={lens} onChange={setLens} />
      </header>

      <WorkflowPicker
        workflows={workflows}
        selectedSlug={selectedSlug}
        onSelect={setSelectedSlug}
        lensActive={Boolean(lens)}
      />

      {lens ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <LegendDot className="bg-emerald-500" label="Applies to this questionnaire" />
          <LegendDot className="bg-amber-500" label="Available, but off in its settings" />
          <LegendDot className="bg-slate-400" label="Not enabled in this workspace" />
        </div>
      ) : null}

      {selectedSummary ? (
        <div>
          <p className="text-muted-foreground text-sm">{selectedSummary.description}</p>
          {lens ? (
            <p className="text-muted-foreground mt-1 text-xs">
              Lens: <span className="font-medium">{lens.title}</span> (v{lens.versionNumber})
            </p>
          ) : null}
        </div>
      ) : null}

      {showBanner && applicability ? (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            STATUS_BANNER[applicability.status] ?? STATUS_BANNER.inactive
          )}
        >
          {applicability.reason}
        </div>
      ) : null}

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-4 rounded-sm border-2 border-blue-400 bg-blue-50 dark:bg-blue-950/50" />
          AI agent (an LLM runs the step)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-4 rounded-sm border-2 border-dashed border-slate-300 bg-slate-50 dark:bg-slate-900/40" />
          Deterministic (code — no LLM)
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="bg-muted/20 relative h-[560px] rounded-lg border">
          {detail ? (
            <ReadOnlyCanvas definition={detail.definition} onSelectNode={setSelectedNodeId} />
          ) : (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              {error ? error : loading ? 'Loading workflow…' : 'Select a workflow.'}
            </div>
          )}
        </div>

        <div className="h-[560px] overflow-hidden rounded-lg border">
          <NodeInfoPanel
            nodeLabel={selectedStep?.name ?? 'No step selected'}
            nodeType={selectedStep?.type ?? '—'}
            enrichment={enrichment}
          />
        </div>
      </div>
    </div>
  );
}
