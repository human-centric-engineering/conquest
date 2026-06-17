'use client';

/**
 * Prompt Library — read-only viewer for the prompts each questionnaire agent sends.
 *
 * The load-bearing prompts are assembled in code (not the agent's editable
 * `systemInstructions`), so this surface renders each builder's real output from a
 * representative sample context. Aesthetic: an editorial "dossier" — amber accents
 * from `.cq-surface`, a system/user transcript in monospace, stage-grouped master /
 * detail. Purely presentational; all data arrives from the server page.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  ChevronRight,
  Coins,
  Copy,
  Cpu,
  Eye,
  FileCode2,
  Gavel,
  Info,
  Radio,
  Thermometer,
  TriangleAlert,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  CatalogMessage,
  PromptAgentApiView,
  PromptSpecimen,
  PromptStage,
} from '@/app/api/v1/app/questionnaires/_lib/prompt-catalog';

interface PromptLibraryProps {
  agents: PromptAgentApiView[];
}

const STAGE_META: Record<PromptStage, { label: string; blurb: string; Icon: typeof FileCode2 }> = {
  authoring: {
    label: 'Authoring',
    blurb: 'Build & shape a questionnaire',
    Icon: FileCode2,
  },
  live: {
    label: 'Live conversation',
    blurb: 'Run a respondent session',
    Icon: Radio,
  },
  evaluation: {
    label: 'Evaluation',
    blurb: 'Score a draft before launch',
    Icon: Gavel,
  },
};

const STAGE_ORDER: PromptStage[] = ['authoring', 'live', 'evaluation'];

export function PromptLibrary({ agents }: PromptLibraryProps) {
  const [activeSlug, setActiveSlug] = useState<string>(agents[0]?.slug ?? '');
  const [specimenBySlug, setSpecimenBySlug] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  // Selecting an agent swaps the detail pane; if the page was scrolled down (a long
  // prompt), start the new agent from the top rather than mid-scroll.
  const selectAgent = useCallback((slug: string) => {
    setActiveSlug(slug);
    scrollNearestScrollableToTop(rootRef.current);
  }, []);

  const grouped = useMemo(() => {
    return STAGE_ORDER.map((stage) => ({
      stage,
      agents: agents.filter((a) => a.stage === stage),
    })).filter((g) => g.agents.length > 0);
  }, [agents]);

  const active = useMemo(
    () => agents.find((a) => a.slug === activeSlug) ?? agents[0],
    [agents, activeSlug]
  );

  const totalPrompts = useMemo(
    () => agents.reduce((sum, a) => sum + a.specimens.length, 0),
    [agents]
  );

  if (agents.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader agentCount={0} promptCount={0} />
        <div className="border-border/70 text-muted-foreground rounded-lg border border-dashed p-12 text-center text-sm">
          No agent prompts to show. Check that the questionnaire agents are seeded (
          <code className="font-mono text-xs">npm run db:seed</code>).
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="space-y-6 pb-16">
      <PageHeader agentCount={agents.length} promptCount={totalPrompts} />
      <HonestyBanner />

      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* Rail */}
        <nav aria-label="Agents" className="lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-6">
            {grouped.map((group, gi) => {
              const meta = STAGE_META[group.stage];
              return (
                <div key={group.stage}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <meta.Icon className="h-3.5 w-3.5 text-[var(--cq-accent)]" aria-hidden />
                    <span className="text-muted-foreground text-[0.7rem] font-semibold tracking-[0.14em] uppercase">
                      {meta.label}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {group.agents.map((agent, ai) => (
                      <li
                        key={agent.slug}
                        className="animate-in fade-in-0 slide-in-from-left-2"
                        style={{
                          animationDelay: `${(gi * 4 + ai) * 35}ms`,
                          animationFillMode: 'backwards',
                        }}
                      >
                        <RailItem
                          agent={agent}
                          active={agent.slug === active?.slug}
                          onSelect={() => selectAgent(agent.slug)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </nav>

        {/* Detail */}
        {active ? (
          <AgentDetail
            key={active.slug}
            agent={active}
            activeSpecimenId={specimenBySlug[active.slug] ?? active.specimens[0]?.id ?? ''}
            onSelectSpecimen={(id) => setSpecimenBySlug((prev) => ({ ...prev, [active.slug]: id }))}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header + banner
// ---------------------------------------------------------------------------

function PageHeader({ agentCount, promptCount }: { agentCount: number; promptCount: number }) {
  return (
    <header className="border-border/60 border-b pb-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Prompt library</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            The exact prompts each questionnaire agent sends to the model — rendered with{' '}
            <code className="bg-muted rounded px-1 py-0.5 text-[0.85em]">{'{{ … }}'}</code>{' '}
            placeholder inputs that, at run time, carry your questionnaire’s data. This library is{' '}
            <span className="text-foreground font-medium">read-only</span>; edit prompt behaviour in
            the source module noted on each agent.
          </p>
        </div>
        <div className="text-muted-foreground flex shrink-0 items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="text-foreground font-mono text-sm font-semibold">{agentCount}</span>
            agents
          </span>
          <span className="bg-border h-4 w-px" aria-hidden />
          <span className="flex items-center gap-1.5">
            <span className="text-foreground font-mono text-sm font-semibold">{promptCount}</span>
            prompts
          </span>
        </div>
      </div>
    </header>
  );
}

function HonestyBanner() {
  return (
    <div className="relative overflow-hidden rounded-lg border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] p-4">
      <div className="flex gap-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cq-accent)]" aria-hidden />
        <div className="space-y-1 text-sm">
          <p className="text-foreground font-medium">
            These are the real prompts — with sample data.
          </p>
          <p className="text-muted-foreground">
            Most questionnaire agents are dispatched programmatically — the prompt is assembled in
            code and shown here verbatim, so the editable{' '}
            <span className="text-foreground font-medium">Instructions</span> field is{' '}
            <span className="text-foreground font-medium">descriptive only</span> and isn’t sent to
            the model; edit prompt behaviour in the source module noted on each agent. The one
            exception is the <span className="text-foreground font-medium">Question Selector</span>,
            whose Instructions <span className="text-foreground font-medium">are</span> its system
            prompt. Values shown as{' '}
            <code className="bg-muted rounded px-1 py-0.5 text-[0.8em]">{'{{ … }}'}</code> are
            placeholders — at run time they’re filled with your questionnaire’s goal, questions, and
            the live transcript.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail item
// ---------------------------------------------------------------------------

function RailItem({
  agent,
  active,
  onSelect,
}: {
  agent: PromptAgentApiView;
  active: boolean;
  onSelect: () => void;
}) {
  const binding = bindingSummary(agent);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors',
        'hover:bg-muted/60',
        active
          ? 'border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)]'
          : 'border-l-2 border-l-transparent'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'truncate text-sm font-medium',
            active ? 'text-[var(--cq-accent)]' : 'text-foreground'
          )}
        >
          {agent.name}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[0.65rem]',
            active
              ? 'bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]'
              : 'bg-muted text-muted-foreground'
          )}
        >
          {agent.specimens.length}
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 truncate text-xs">{binding}</div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

function AgentDetail({
  agent,
  activeSpecimenId,
  onSelectSpecimen,
}: {
  agent: PromptAgentApiView;
  activeSpecimenId: string;
  onSelectSpecimen: (id: string) => void;
}) {
  const specimen = agent.specimens.find((s) => s.id === activeSpecimenId) ?? agent.specimens[0];
  const meta = STAGE_META[agent.stage];

  return (
    <div className="animate-in fade-in-0 min-w-0 space-y-5">
      <div className="border-border/70 bg-card relative overflow-hidden rounded-xl border">
        {/* Accent hairline */}
        <div className="absolute inset-x-0 top-0 h-0.5 bg-[var(--cq-accent)]" aria-hidden />

        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-[0.14em] uppercase">
                <meta.Icon className="h-3.5 w-3.5 text-[var(--cq-accent)]" aria-hidden />
                {meta.label}
              </div>
              <h2 className="text-xl font-semibold tracking-tight">{agent.name}</h2>
            </div>
            {agent.seeded ? (
              <Badge variant="secondary" className="shrink-0 gap-1 font-mono text-[0.65rem]">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
                  aria-hidden
                />
                seeded
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 font-mono text-[0.65rem] text-amber-600"
              >
                <TriangleAlert className="h-3 w-3" aria-hidden /> not seeded
              </Badge>
            )}
          </div>

          <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">{agent.summary}</p>

          <BindingStrip agent={agent} />

          <p className="text-muted-foreground text-xs">
            <span className="text-foreground font-medium">When:</span> {agent.dispatch}
          </p>

          <SourceLine path={agent.builderModule} />

          <InstructionsNote agent={agent} />
        </div>
      </div>

      {/* Specimen selector */}
      {agent.specimens.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Prompt variants">
          {agent.specimens.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === specimen?.id}
              onClick={() => onSelectSpecimen(s.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                s.id === specimen?.id
                  ? 'border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] text-[var(--cq-accent)]'
                  : 'border-border/70 text-muted-foreground hover:bg-muted/60'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      {specimen ? <SpecimenView key={specimen.id} specimen={specimen} /> : null}
    </div>
  );
}

function BindingStrip({ agent }: { agent: PromptAgentApiView }) {
  const b = agent.binding;
  if (!b) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Chip Icon={Cpu}>
        {b.resolvesAtRuntime ? 'Model: resolved at runtime' : `${b.provider} · ${b.model}`}
      </Chip>
      {b.temperature !== null ? <Chip Icon={Thermometer}>temp {b.temperature}</Chip> : null}
      {b.maxTokens !== null ? (
        <Chip Icon={Activity}>{b.maxTokens.toLocaleString()} max tokens</Chip>
      ) : null}
      {b.monthlyBudgetUsd !== null ? <Chip Icon={Coins}>${b.monthlyBudgetUsd}/mo cap</Chip> : null}
      {b.visibility ? <Chip Icon={Eye}>{b.visibility}</Chip> : null}
    </div>
  );
}

function Chip({ Icon, children }: { Icon: typeof Cpu; children: React.ReactNode }) {
  return (
    <span className="border-border/70 bg-muted/40 text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[0.7rem]">
      <Icon className="h-3 w-3" aria-hidden />
      {children}
    </span>
  );
}

function SourceLine({ path }: { path: string }) {
  return (
    <div className="border-border/60 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
      <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
        <span className="text-foreground/70 mr-1.5 font-sans font-medium">Prompt source</span>
        {path}
      </span>
      <CopyButton text={path} label="path" />
    </div>
  );
}

function InstructionsNote({ agent }: { agent: PromptAgentApiView }) {
  const [open, setOpen] = useState(false);
  const stored = agent.storedInstructions?.trim();
  return (
    <div className="border-border/60 bg-muted/30 rounded-md border px-3 py-2">
      <div className="flex items-start gap-2">
        <Info className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 text-xs">
          {agent.instructionsAreLoadBearing ? (
            <p className="text-muted-foreground">
              This agent runs through the chat handler, so its editable{' '}
              <span className="text-foreground font-medium">Instructions</span> field{' '}
              <span className="text-foreground font-medium">is</span> its system prompt — sent to
              the model above the message below. Editing it changes the agent’s behaviour.
            </p>
          ) : (
            <p className="text-muted-foreground">
              The agent’s editable <span className="text-foreground font-medium">Instructions</span>{' '}
              field is descriptive only — <span className="text-foreground font-medium">not</span>{' '}
              part of the prompt below.
            </p>
          )}
          {stored ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 font-medium text-[var(--cq-accent)] hover:underline"
            >
              <ChevronRight
                className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
                aria-hidden
              />
              {open ? 'Hide' : 'View'} stored instructions
            </button>
          ) : null}
          {open && stored ? (
            <pre className="text-muted-foreground border-border/60 bg-background/60 mt-2 max-h-40 overflow-auto rounded border p-2 font-mono text-[0.7rem] whitespace-pre-wrap">
              {stored}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Specimen (transcript)
// ---------------------------------------------------------------------------

function SpecimenView({ specimen }: { specimen: PromptSpecimen }) {
  const fullText = useMemo(
    () => specimen.messages.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`).join('\n\n'),
    [specimen]
  );

  return (
    <div className="animate-in fade-in-0 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{specimen.description}</p>
          {specimen.conditions.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {specimen.conditions.map((c) => (
                <span
                  key={c}
                  className="border-border/70 text-muted-foreground rounded-full border px-2 py-0.5 text-[0.65rem]"
                >
                  {c}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <CopyButton text={fullText} label="all" />
      </div>

      <p className="text-muted-foreground border-border/60 border-l-2 pl-3 text-xs leading-relaxed">
        A prompt is a sequence of <span className="text-foreground/80 font-medium">messages</span>,
        each tagged with a role. The model reads them top to bottom: the{' '}
        <span className="text-foreground/80 font-medium">System</span> message sets the rules, then
        the <span className="text-foreground/80 font-medium">User</span> message supplies this
        turn’s data to act on.
      </p>

      <div className="space-y-2.5">
        {specimen.messages.map((message, i) => (
          <MessageBlock key={i} index={i} message={message} error={specimen.error} />
        ))}
      </div>
    </div>
  );
}

function MessageBlock({
  index,
  message,
  error,
}: {
  index: number;
  message: CatalogMessage;
  error?: boolean;
}) {
  const role = message.role.toLowerCase();
  const tone = roleTone(role);
  const meta = roleMeta(role);
  return (
    <div className="border-border/70 bg-card overflow-hidden rounded-lg border">
      <div className="border-border/60 bg-muted/30 flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/70 font-mono text-[0.7rem]">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold tracking-wide uppercase',
              tone
            )}
          >
            {role}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/60 font-mono text-[0.65rem]">
            {message.content.length.toLocaleString()} chars
          </span>
          <CopyButton text={message.content} label="msg" />
        </div>
      </div>
      {meta.blurb ? (
        <p className="border-border/40 text-muted-foreground border-b px-3 py-1.5 text-[0.72rem] leading-snug">
          <span className="text-foreground/80 font-medium">{meta.term}</span> — {meta.blurb}
        </p>
      ) : null}
      <pre
        className={cn(
          'max-h-[28rem] overflow-auto px-4 py-3 font-mono text-[0.8rem] leading-relaxed whitespace-pre-wrap',
          error ? 'text-amber-600' : 'text-foreground/90'
        )}
      >
        {message.content}
      </pre>
    </div>
  );
}

function roleTone(role: string): string {
  switch (role) {
    case 'system':
      return 'bg-[var(--cq-accent-muted)] text-[var(--cq-accent)]';
    case 'user':
      return 'bg-slate-500/15 text-slate-600 dark:text-slate-300';
    case 'assistant':
      return 'bg-blue-500/15 text-blue-600 dark:text-blue-300';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * Plain-English description of how each chat role is *used* in the LLM call, shown
 * inline beneath the badge. A prompt is a list of messages, each tagged with a role;
 * both are sent to the model together on every call (it keeps no state between calls).
 */
function roleMeta(role: string): { term: string; blurb: string } {
  switch (role) {
    case 'system':
      return {
        term: 'System message',
        blurb:
          'Sent to the model first on every call — the instructions it must follow (the agent’s role, rules, and how to shape its answer). The model keeps no memory between calls, so this is re-sent each turn.',
      };
    case 'user':
      return {
        term: 'User message',
        blurb:
          'Sent alongside the system instructions — the data for this call that the model acts on (the goal, questions, a window of recent transcript, captured answers). Rebuilt each turn from your questionnaire.',
      };
    case 'assistant':
      return { term: 'Assistant message', blurb: 'The model’s reply, sent back in the response.' };
    default:
      return { term: role, blurb: '' };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-[0.65rem]"
      title={copied ? 'Copied!' : 'Copy'}
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            // Clipboard unavailable — no-op.
          }
        })();
      }}
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? 'Copied' : (label ?? 'Copy')}
    </Button>
  );
}

/**
 * Reset scroll to the top of whichever element actually scrolls. Walks up from the
 * component root to the nearest scrollable ancestor (the admin layout's `<main>`),
 * falling back to the window — so it works without coupling to the layout's markup.
 */
function scrollNearestScrollableToTop(start: HTMLElement | null): void {
  let node: HTMLElement | null = start?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      node.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    node = node.parentElement;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** One-line binding summary for the rail. */
function bindingSummary(agent: PromptAgentApiView): string {
  if (!agent.binding) return 'not seeded';
  if (agent.binding.resolvesAtRuntime) return 'runtime model · descriptive instructions';
  return `${agent.binding.provider} · ${agent.binding.model}`;
}
