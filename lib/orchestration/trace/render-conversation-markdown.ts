/**
 * Deterministic Markdown rendering of a conversation + per-message
 * provenance bundle.
 *
 * No LLM. Mirrors {@link renderExecutionMarkdown} at the message level:
 * a human (or auditor) can read a conversation's provenance bundle
 * top-to-bottom and answer "how was each message grounded?" without
 * additional joins. Three provenance trails converge per assistant
 * message — KB citations, workflow step sources (if `run_workflow`
 * fired), and capability calls — and the renderer presents them as
 * structured tables, not free-form prose.
 *
 * Why deterministic, not LLM-generated: provenance is audit substrate.
 * An LLM narration of who-cited-what would reintroduce the
 * marking-your-own-homework problem the supervisor was added to fix.
 *
 * The output is **HTML-ready Markdown** — all blocks use stable
 * GitHub-flavoured Markdown constructs that a downstream Markdown→HTML
 * converter (for the future Gotenberg PDF route) renders without
 * surprises. No HTML inline tags; no rendering quirks.
 *
 * Used by:
 *  - `GET /api/v1/admin/orchestration/conversations/:id/provenance.md`
 *    (on-demand download from the trace viewer)
 *  - The JSON `/provenance` route's optional embedded Markdown view
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { Citation, MessageProvenance, ToolCallTrace } from '@/types/orchestration';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';

export interface RenderConversationInfo {
  id: string;
  title: string | null;
  userId: string;
  agentId: string | null;
  agentSlug: string | null;
  agentName: string | null;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
}

export interface RenderConversationMessage {
  id: string;
  role: string;
  content: string;
  capabilitySlug: string | null;
  createdAt: string;
  agentVersionId: string | null;
  workflowExecutionId: string | null;
  workflowVersionId: string | null;
  modelId: string | null;
  providerSlug: string | null;
  /** Already validated by the caller via `messageProvenanceSchema.safeParse`. */
  provenance: MessageProvenance | null;
}

export interface RenderConversationOptions {
  /**
   * Optional admin host (e.g. "https://admin.example.com") to absolutize
   * the link back to the conversation detail page in the footer. Omit
   * for relative links.
   */
  hostPrefix?: string;
  /**
   * Excerpt-length cap for citation excerpts. Provenance bundles can be
   * long; trimming excerpts keeps the bundle scannable in PDF form. The
   * full chunk is still recoverable via `chunkId` against the KB.
   * Defaults to 400 chars.
   */
  excerptCap?: number;
}

const DEFAULT_EXCERPT_CAP = 400;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString();
  } catch {
    return iso;
  }
}

function escapePipe(s: string): string {
  // Markdown table cells can't contain unescaped `|` or unescaped newlines.
  // Escape backslashes first so a trailing `\` can't escape the `|` delimiter.
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap - 1).trimEnd() + '…';
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return role;
  }
}

// ─── Per-message blocks ──────────────────────────────────────────────────────

function renderCitationsBlock(citations: Citation[], excerptCap: number): string[] {
  if (citations.length === 0) return [];
  const lines: string[] = [];
  lines.push(`**Citations (${citations.length})**`);
  lines.push('');
  lines.push(`| Marker | Document | Section | Content hash | Excerpt |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const c of citations) {
    const docLabel = c.documentName
      ? `${c.documentName} (\`${c.documentId}\`)`
      : `\`${c.documentId}\``;
    const section = c.section ?? '—';
    const hash = c.contentHash ? `\`${c.contentHash.slice(0, 16)}…\`` : '—';
    const excerpt = truncate(c.excerpt, excerptCap);
    lines.push(
      `| [${c.marker}] | ${escapePipe(docLabel)} | ${escapePipe(section)} | ${hash} | ${escapePipe(excerpt)} |`
    );
  }
  lines.push('');
  return lines;
}

function renderCapabilityCallsBlock(calls: ToolCallTrace[]): string[] {
  if (calls.length === 0) return [];
  const lines: string[] = [];
  lines.push(`**Capability calls (${calls.length})**`);
  lines.push('');
  lines.push(`| Slug | Status | Latency | Cost | Result preview |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const c of calls) {
    const status = c.success ? '`ok`' : `\`fail: ${c.errorCode ?? 'unknown'}\``;
    const latency = `${c.latencyMs}ms`;
    const cost = typeof c.costUsd === 'number' ? `$${c.costUsd.toFixed(4)}` : '—';
    const preview = c.resultPreview ? truncate(c.resultPreview, 200) : '—';
    lines.push(`| \`${c.slug}\` | ${status} | ${latency} | ${cost} | ${escapePipe(preview)} |`);
  }
  lines.push('');
  return lines;
}

function renderWorkflowSourcesBlock(sources: ProvenanceItem[]): string[] {
  if (sources.length === 0) return [];
  const lines: string[] = [];
  lines.push(`**Workflow sources (${sources.length})**`);
  lines.push('');
  lines.push(`| Step | Source | Confidence | Reference | Note |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const s of sources) {
    const step = s.stepId ? `\`${s.stepId}\`` : '—';
    const ref = s.reference ? truncate(s.reference, 80) : '—';
    const note = s.note ? truncate(s.note, 120) : '—';
    lines.push(
      `| ${step} | \`${s.source}\` | \`${s.confidence}\` | ${escapePipe(ref)} | ${escapePipe(note)} |`
    );
  }
  lines.push('');
  return lines;
}

function renderMessageBlock(
  msg: RenderConversationMessage,
  index: number,
  excerptCap: number
): string[] {
  const lines: string[] = [];
  const label = roleLabel(msg.role);
  lines.push(`### ${index + 1}. ${label} — ${formatTimestamp(msg.createdAt)}`);
  lines.push('');

  // Version pin row — only emitted when at least one pin is set.
  const pins: string[] = [];
  if (msg.modelId) pins.push(`Model \`${msg.modelId}\``);
  if (msg.providerSlug) pins.push(`Provider \`${msg.providerSlug}\``);
  if (msg.agentVersionId) pins.push(`Agent version \`${msg.agentVersionId}\``);
  if (msg.workflowExecutionId) {
    const exec = `Workflow execution \`${msg.workflowExecutionId}\``;
    const ver = msg.workflowVersionId ? ` @ \`${msg.workflowVersionId}\`` : '';
    pins.push(`${exec}${ver}`);
  }
  if (msg.capabilitySlug) pins.push(`Capability \`${msg.capabilitySlug}\``);
  if (pins.length > 0) {
    lines.push(pins.join(' · '));
    lines.push('');
  }

  // Body. Tool messages are usually JSON payloads — present as code
  // fence so the audit trail shows the exact serialised result. Other
  // roles render as plain text (Markdown can passthrough; the LLM's
  // citation markers like `[1]` already look right.)
  if (msg.role === 'tool') {
    lines.push('```');
    lines.push(truncate(msg.content, 4000));
    lines.push('```');
    lines.push('');
  } else if (msg.content.trim().length > 0) {
    lines.push(msg.content);
    lines.push('');
  } else {
    lines.push('_empty content_');
    lines.push('');
  }

  // Provenance trails — only when present, in a stable order.
  if (msg.provenance) {
    if (msg.provenance.citations && msg.provenance.citations.length > 0) {
      lines.push(...renderCitationsBlock(msg.provenance.citations, excerptCap));
    }
    if (msg.provenance.workflowSources && msg.provenance.workflowSources.length > 0) {
      lines.push(...renderWorkflowSourcesBlock(msg.provenance.workflowSources));
    }
    if (msg.provenance.capabilityCalls && msg.provenance.capabilityCalls.length > 0) {
      lines.push(...renderCapabilityCallsBlock(msg.provenance.capabilityCalls));
    }
  }

  return lines;
}

// ─── Renderer ────────────────────────────────────────────────────────────────

export function renderConversationMarkdown(
  conversation: RenderConversationInfo,
  messages: RenderConversationMessage[],
  options: RenderConversationOptions = {}
): string {
  const excerptCap = options.excerptCap ?? DEFAULT_EXCERPT_CAP;
  const lines: string[] = [];

  // ─── Header ───────────────────────────────────────────────────────────────
  const title = conversation.title ?? '(untitled conversation)';
  lines.push(`# Conversation provenance — \`${conversation.id}\``);
  lines.push('');
  lines.push(`**${title}**`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  const agentLabel = conversation.agentName
    ? `${conversation.agentName} (\`${conversation.agentSlug ?? conversation.agentId ?? '—'}\`)`
    : `\`${conversation.agentSlug ?? conversation.agentId ?? '—'}\``;
  lines.push(`| Agent | ${agentLabel} |`);
  lines.push(`| User | \`${conversation.userId}\` |`);
  lines.push(`| Status | ${conversation.isActive ? '`active`' : '`archived`'} |`);
  lines.push(`| Started | ${formatTimestamp(conversation.createdAt)} |`);
  lines.push(`| Last activity | ${formatTimestamp(conversation.updatedAt)} |`);
  lines.push(`| Messages | ${messages.length} |`);
  lines.push('');

  // ─── Body summary ─────────────────────────────────────────────────────────
  let citationCount = 0;
  let capabilityCallCount = 0;
  let workflowSourceCount = 0;
  for (const m of messages) {
    if (m.provenance?.citations) citationCount += m.provenance.citations.length;
    if (m.provenance?.capabilityCalls) capabilityCallCount += m.provenance.capabilityCalls.length;
    if (m.provenance?.workflowSources) workflowSourceCount += m.provenance.workflowSources.length;
  }
  if (citationCount + capabilityCallCount + workflowSourceCount > 0) {
    lines.push(`## Provenance summary`);
    lines.push('');
    lines.push(`- **Citations:** ${citationCount}`);
    lines.push(`- **Capability calls:** ${capabilityCallCount}`);
    lines.push(`- **Workflow sources:** ${workflowSourceCount}`);
    lines.push('');
  }

  // ─── Message timeline ─────────────────────────────────────────────────────
  lines.push(`## Message timeline`);
  lines.push('');
  if (messages.length === 0) {
    lines.push('_No messages in this conversation._');
    lines.push('');
  } else {
    messages.forEach((msg, idx) => {
      lines.push(...renderMessageBlock(msg, idx, excerptCap));
    });
  }

  // ─── Footer ───────────────────────────────────────────────────────────────
  const url = `${options.hostPrefix ?? ''}/admin/orchestration/conversations/${conversation.id}`;
  lines.push('---');
  lines.push(`Conversation \`${conversation.id}\` — [open in admin](${url})`);
  lines.push(`Generated ${new Date().toISOString()}.`);
  lines.push('');

  return lines.join('\n');
}
