/**
 * Prompt builder for the Agent Settings "AI Advisory" completion.
 *
 * Serialises one agent's current settings, the deterministic recommendation, and
 * the cost trade-off into an LlmMessage[] that asks for an INDEPENDENT, critical
 * second opinion grounded in what the agent's task requires: (a) a plain-language
 * assessment of whether the settings are genuinely the best fit for the work — its
 * depth, who is waiting on it, and what it costs — and (b) a concrete patch when a
 * better config exists, even if the current settings already match the baseline. The advisor is told to treat that
 * baseline as a fallible opinion, not ground truth. Pure — builds messages from
 * a snapshot; no Prisma / Next / LLM imports.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { AgentSettingEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import { EXPLAIN_REASONING_EFFORTS } from '@/lib/app/questionnaire/agent-advisory/explain-schema';

const SYSTEM = `You are the AI Advisor for the ConQuest questionnaire platform's agent settings. The \
operator runs on OpenAI. You are given ONE agent's role, its current model/temperature/maxTokens/\
reasoning-effort, a DETERMINISTIC baseline recommendation, a rough cost trade-off, and real recent spend.

Your job is an INDEPENDENT, critical second opinion — NOT to justify the defaults. Treat the deterministic \
recommendation as one fallible opinion, not ground truth: it is a hand-maintained table and has been wrong \
before. Question BOTH the current settings AND the recommendation, and reason from what this agent's task \
actually has to do.

Judge fitness on the task, not on parameter support:
- Ask what the work requires. Does quality depend on sustained analysis over a lot of material (reading a \
document into structure, judging a design against a rubric, synthesising a report across many respondents)? \
Then a reasoning model such as the gpt-5 family fits. Is it a short, well-specified job — phrasing a \
question, pulling a typed value from a reply, formatting prose, reading an image — where fluency and speed \
are the quality bar? Then a fast conversational model such as gpt-4o or gpt-4o-mini fits.
- Ask who is waiting. On the per-turn path a respondent sits watching for a reply, so latency is part of \
quality and a deliberative model makes the experience worse. Background and one-off work has no such \
constraint, so depth is close to free there.
- Size the parameters to the task: temperature by how much latitude the task should have, maxTokens by the \
largest realistic output, reasoning effort by how much deliberation the work rewards. Never recommend a \
model because of which parameters it does or does not read — that is a housekeeping detail, not a reason to \
choose or reject a model.
- Weigh cost AND quality AND latency, and lean on the real recent spend: optimise the expensive, \
high-volume paths hardest; do not overspend on rare ones.

If a genuinely better configuration exists — EVEN WHEN the current settings already match the baseline \
("optimal") — propose it and explain why it beats both the current settings and the recommendation. Only \
call the settings already-best if you can justify that independently, on the merits, not by deferring to the \
baseline. Be concrete and reference the actual numbers. Never invent models or fields that don't exist.`;

const OUTPUT_CONTRACT = `Respond with ONLY a JSON object, no prose outside it:
{
  "narrative": "2-4 sentences of independent assessment: is this genuinely the best choice for this agent's role, and why / why not? Reference the actual numbers.",
  "suggestion": {              // a concrete change when a better config exists; null only if the settings are genuinely already best
    "model": "<openai model id or null to keep the inherited/current model>",
    "temperature": <number 0-2 or null>,
    "maxTokens": <integer or null>,
    "reasoningEffort": <one of ${EXPLAIN_REASONING_EFFORTS.map((e) => `"${e}"`).join(', ')} or null>,
    "rationale": "one sentence justifying the suggested change and why it beats the current settings"
  }
}
Set a field to null when you would not change it. Set "suggestion" to null ONLY when you independently judge the settings already optimal — do not default to null out of deference to the baseline.`;

function describe(agent: AgentSettingEvaluation): string {
  const c = agent.current;
  const r = agent.recommended;
  const cost = agent.cost;
  const lines = [
    `Agent: ${agent.label} (${agent.slug})`,
    `Role: ${agent.role}`,
    `Task tier: ${agent.taskTier} (inherits the shared ${agent.taskTier} default model unless overridden)`,
    '',
    'CURRENT:',
    `  resolved model: ${c.resolvedModel ?? 'unresolved (tier default unset)'}${c.explicitModel ? ' (pinned override)' : ' (inherited)'}`,
    `  temperature: ${c.temperature}${agent.flags.temperatureIgnored ? ' (not read by the resolved model — housekeeping only, not a reason to change model)' : ''}`,
    `  maxTokens: ${c.maxTokens}`,
    `  reasoningEffort: ${c.reasoningEffort ?? 'none'}`,
    '',
    'DETERMINISTIC RECOMMENDATION:',
    `  model: ${r.model}${r.isOverride ? ' (per-agent override)' : ' (tier default)'}`,
    `  temperature: ${r.temperature}`,
    `  maxTokens: ${r.maxTokens}`,
    `  reasoningEffort: ${r.reasoningEffort ?? 'none'}`,
    `  rationale: ${agent.rationale}`,
    '',
    'COST:',
    `  current model: ${fmtUsd(cost.currentModelPerMillionUsd)}/M, est ${fmtUsd(cost.currentEstPerCallUsd)}/call`,
    `  recommended model: ${fmtUsd(cost.recommendedModelPerMillionUsd)}/M, est ${fmtUsd(cost.recommendedEstPerCallUsd)}/call`,
    `  delta: ${cost.deltaPct === null ? 'n/a' : `${cost.deltaPct > 0 ? '+' : ''}${cost.deltaPct.toFixed(0)}%`}`,
    `  actual ${agent.actuals.windowDays}d spend: ${fmtUsd(agent.actuals.spendUsd)}${agent.actuals.calls !== null ? ` over ${agent.actuals.calls} calls` : ''}`,
  ];
  return lines.join('\n');
}

function fmtUsd(v: number | null): string {
  if (v === null) return 'unknown';
  if (v === 0) return '$0';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function buildExplainPrompt(agent: AgentSettingEvaluation): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${describe(agent)}\n\n${OUTPUT_CONTRACT}` },
  ];
}

export function buildExplainRetryMessage(): string {
  return `Your previous response was not valid JSON matching the required shape. Respond with ONLY the JSON object described — keys: narrative (string), suggestion (object or null).`;
}
