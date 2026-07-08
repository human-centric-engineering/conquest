'use client';

/**
 * Node info panel for the Behind-the-Scenes visualizer.
 *
 * Reveals the live detail behind a clicked step: the agent + its resolved
 * model/binding, the exact prompt messages (with a deep-link to the Prompt
 * Library), where a knowledge base plugs in, and the capabilities (tools) it
 * dispatches. Reads the server-computed `NodeEnrichment` — no fetching here.
 */

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { NodeEnrichment } from '@/lib/app/questionnaire/workflows/views';

interface NodeInfoPanelProps {
  nodeLabel: string;
  nodeType: string;
  enrichment: NodeEnrichment | null;
}

export function NodeInfoPanel({ nodeLabel, nodeType, enrichment }: NodeInfoPanelProps) {
  if (!enrichment) {
    return (
      <PanelShell nodeLabel={nodeLabel} nodeType={nodeType}>
        <p className="text-muted-foreground text-sm">Select a step to inspect it.</p>
      </PanelShell>
    );
  }

  const { meta, agent, prompt, kb, capabilities } = enrichment;

  return (
    <PanelShell nodeLabel={nodeLabel} nodeType={nodeType} note={meta.note}>
      <Tabs defaultValue="agent" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>

        <TabsContent value="agent" className="mt-4">
          <AgentTab agent={agent} />
        </TabsContent>
        <TabsContent value="prompt" className="mt-4">
          <PromptTab prompt={prompt} />
        </TabsContent>
        <TabsContent value="knowledge" className="mt-4">
          <KnowledgeTab kb={kb} agentAccessMode={agent?.knowledgeAccessMode ?? null} />
        </TabsContent>
        <TabsContent value="tools" className="mt-4">
          <ToolsTab capabilities={capabilities} />
        </TabsContent>
      </Tabs>
    </PanelShell>
  );
}

function PanelShell({
  nodeLabel,
  nodeType,
  note,
  children,
}: {
  nodeLabel: string;
  nodeType: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">{nodeLabel}</h3>
          <code className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[10px] uppercase">
            {nodeType}
          </code>
        </div>
        {note ? <p className="text-muted-foreground mt-1 text-xs">{note}</p> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-right text-sm font-medium">{value}</span>
    </div>
  );
}

function AgentTab({ agent }: { agent: NodeEnrichment['agent'] }) {
  if (!agent) {
    return <Empty>This step runs deterministic code — no AI agent.</Empty>;
  }
  const modelLabel = agent.resolved
    ? `${agent.resolved.providerSlug} · ${agent.resolved.model}`
    : agent.resolvesAtRuntime
      ? 'Resolved at runtime'
      : `${agent.provider} · ${agent.model}`;

  return (
    <div className="space-y-1">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold">{agent.name}</span>
        {!agent.isActive ? <Badge variant="outline">inactive</Badge> : null}
        {agent.resolvesAtRuntime && agent.resolved ? (
          <Badge variant="secondary">runtime-resolved</Badge>
        ) : null}
      </div>
      <Field label="Model" value={modelLabel} />
      {agent.resolved && agent.resolved.fallbacks.length > 0 ? (
        <Field label="Fallbacks" value={agent.resolved.fallbacks.join(', ')} />
      ) : null}
      <Field label="Temperature" value={agent.temperature ?? '—'} />
      <Field label="Max tokens" value={agent.maxTokens ?? '—'} />
      {agent.reasoningEffort ? <Field label="Reasoning" value={agent.reasoningEffort} /> : null}
      <Field
        label="Monthly budget"
        value={agent.monthlyBudgetUsd != null ? `$${agent.monthlyBudgetUsd}` : '—'}
      />
      <Separator className="my-2" />
      <Field label="Slug" value={<code className="text-xs">{agent.slug}</code>} />
    </div>
  );
}

function PromptTab({ prompt }: { prompt: NodeEnrichment['prompt'] }) {
  if (!prompt) {
    return <Empty>No catalogued prompt for this step.</Empty>;
  }
  return (
    <div className="space-y-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span>{prompt.label}</span>
        {prompt.instructionsAreLoadBearing ? (
          <Badge variant="secondary">editable system prompt</Badge>
        ) : (
          <Badge variant="outline">assembled in code</Badge>
        )}
      </div>
      <div className="space-y-2">
        {prompt.messages.map((m, i) => (
          <div key={i} className="rounded-md border">
            <div className="text-muted-foreground bg-muted/50 border-b px-2 py-1 text-[10px] font-semibold uppercase">
              {m.role}
            </div>
            <pre className="max-h-48 overflow-auto p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {m.content}
            </pre>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-[11px]">
        Placeholder tokens like <code>{'{{ … }}'}</code> are filled at run time with the real
        questionnaire and transcript.
      </p>
      <Link
        href={prompt.libraryHref}
        className="inline-flex items-center gap-1 text-sm font-medium text-[var(--cq-accent)] hover:underline"
      >
        Open in Prompt Library <ExternalLink className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

function KnowledgeTab({
  kb,
  agentAccessMode,
}: {
  kb: NodeEnrichment['kb'];
  agentAccessMode: string | null;
}) {
  if (!kb) {
    return <Empty>No knowledge base is wired into this step.</Empty>;
  }
  return (
    <div className="space-y-3">
      <Badge
        className={cn(
          kb.status === 'active'
            ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100'
            : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'
        )}
      >
        {kb.status === 'active' ? 'Knowledge base active' : 'Knowledge base pluggable'}
      </Badge>
      <p className="text-sm">{kb.description}</p>
      <Separator />
      <Field
        label="Mechanism"
        value={kb.mechanism === 'agent-grant' ? 'Agent knowledge grant' : 'Per-client KB tag'}
      />
      {agentAccessMode ? <Field label="Agent access mode" value={agentAccessMode} /> : null}
    </div>
  );
}

function ToolsTab({ capabilities }: { capabilities: NodeEnrichment['capabilities'] }) {
  if (capabilities.length === 0) {
    return <Empty>This step calls no capabilities (tools).</Empty>;
  }
  return (
    <ul className="space-y-3">
      {capabilities.map((c) => (
        <li key={c.slug} className="rounded-md border p-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{c.name}</span>
          </div>
          <code className="text-muted-foreground text-[10px]">{c.slug}</code>
          {c.description ? <p className="mt-1 text-xs">{c.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}
