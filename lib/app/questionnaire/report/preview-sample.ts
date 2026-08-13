/**
 * Report preview — AI-synthesised sample answers (admin config preview).
 *
 * The admin "Preview report" flow needs answers to render a real report before any respondent has
 * completed the questionnaire. This module fabricates a plausible sample set from the version's
 * structure (questions + data slots), then runs it through the SAME transcript + data-slot builders
 * production uses ({@link buildAnswerTranscript}, {@link buildDataSlotContextBlock}), so the previewed
 * report is generated from inputs shaped exactly like a live one.
 *
 * Synthesis is a persona pass followed by a fan-out, not one call: one small call invents the
 * respondent, then batches of ~20 items are answered as that respondent with capped concurrency. A
 * single call has to emit one entry per question AND per data slot, which truncates (or times out) on
 * any real questionnaire — see the batch-sizing constants below for the measurements.
 *
 * Pure orchestration around mockable seams (prisma, the agent resolver, the provider). Server-side only.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isRecord } from '@/lib/utils';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { mapWithConcurrency } from '@/lib/app/questionnaire/llm/run-with-concurrency';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import { RESPONDENT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import {
  buildAnswerPanelView,
  type PanelAnswerInput,
  type PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import type { ExportDataSlotGroup } from '@/lib/app/questionnaire/export/types';
import {
  buildAnswerTranscript,
  buildDataSlotContextBlock,
  buildUnansweredQuestionsBlock,
} from '@/lib/app/questionnaire/report/content';

/** One question the sample answerer should respond to. */
export interface PreviewQuestion {
  key: string;
  prompt: string;
  required: boolean;
}

/** One section of questions in the version being previewed. */
export interface PreviewSection {
  sectionId: string;
  title: string;
  questions: PreviewQuestion[];
}

/** One data slot the sample answerer should fill (the conversational "understanding" targets). */
export interface PreviewDataSlot {
  key: string;
  name: string;
  description: string | null;
  theme: string;
}

/** The version structure a preview is generated against (loaded by the route). */
export interface PreviewStructure {
  questionnaireTitle: string;
  goal: string | null;
  audience: AudienceShape | null;
  sections: PreviewSection[];
  dataSlots: PreviewDataSlot[];
}

/** The synthesised inputs the report generator consumes, plus the LLM cost of synthesising them. */
export interface SampleReportInputs {
  transcript: string;
  dataSlotContext: string;
  /** Answer coverage for the writer's negative-space block (see `buildUnansweredQuestionsBlock`). */
  coverage: { answered: number; total: number; unansweredBlock: string };
  costUsd: number;
}

/**
 * Batch sizing for the sample answerer.
 *
 * The sample must emit one `{value, confidence, rationale}` object per question AND per data slot,
 * so its output grows linearly with the version — a real 71-question / 30-slot version measures at
 * ~7k output tokens and ~84s in a single call. Asking one call to do all of it therefore fails two
 * ways on any non-toy questionnaire: it truncates mid-JSON against the token cap (the parse then
 * fails, burns the retry, and throws), or it runs past the request timeout. Both were live preview
 * failures.
 *
 * So the work fans out the same way `data-slots/generate-stream.ts` handles the same problem: split
 * the items into groups small enough that no single response can truncate, and run the groups with
 * capped concurrency. Wall-clock stays roughly flat as the questionnaire grows, and one bad group
 * degrades the preview instead of failing it.
 */
const SAMPLE_BATCH_ITEMS = 20;
/** Cap concurrent batch calls so a large version can't trip the provider's rate limit. */
const SAMPLE_BATCH_CONCURRENCY = 6;
/**
 * Per-batch output allowance. Measured cost is ~70 output tokens per item (prose answer + rationale);
 * this is ~2x that, which also absorbs the reasoning tokens that count against the same cap on
 * reasoning models.
 */
const SAMPLE_BATCH_MAX_TOKENS = 20 * 140;
const SAMPLE_BATCH_TIMEOUT_MS = 90_000;

/**
 * The persona pass. Batches are independent calls, so without a persona fixed up front each one
 * would invent its own respondent and the preview would read as several different people — the one
 * thing a report preview must not do. One small call establishes the persona, every batch answers as
 * it. Short by construction (a compact profile, not prose), hence the small budget.
 */
const PERSONA_MAX_TOKENS = 700;
const PERSONA_TIMEOUT_MS = 60_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A single synthesised answer/fill after validation. */
interface SampleEntry {
  value: string;
  confidence: number;
  rationale: string;
}

/**
 * Normalise a key the model echoed back.
 *
 * The prompt lists each item as `- [some_key] prompt text`, and models routinely copy the brackets
 * into the response (`"key": "[some_key]"`). The bracketed form matches no question or data slot, so
 * every such entry was silently dropped at the mapping step below and its question rendered as
 * unanswered — a preview that quietly lost most of its answers. Stripping one layer of wrapping
 * brackets is unambiguous: no real key contains them.
 */
function normaliseKey(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped = /^\[.*\]$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
  return unwrapped;
}

/** Narrow one raw entry `{ key, value, confidence?, rationale? }` into a keyed sample entry. */
function narrowEntry(entry: unknown): { key: string; entry: SampleEntry } | null {
  if (!isRecord(entry)) return null;
  const key = typeof entry.key === 'string' ? normaliseKey(entry.key) : '';
  const value = typeof entry.value === 'string' ? entry.value.trim() : '';
  if (!key || !value) return null;
  const confidence =
    typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
      ? Math.min(1, Math.max(0, entry.confidence))
      : 0.8;
  const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
  return { key, entry: { value, confidence, rationale } };
}

/** The parsed sample: answers keyed by question key, fills keyed by data-slot key. */
interface ParsedSample {
  answers: Map<string, SampleEntry>;
  dataSlots: Map<string, SampleEntry>;
}

/** Narrow the model's JSON into keyed answer/data-slot maps, or `null` when unusable. */
function parseSample(parsed: unknown): ParsedSample | null {
  if (!isRecord(parsed)) return null;
  const answers = new Map<string, SampleEntry>();
  const dataSlots = new Map<string, SampleEntry>();
  for (const raw of Array.isArray(parsed.answers) ? parsed.answers : []) {
    const narrowed = narrowEntry(raw);
    if (narrowed) answers.set(narrowed.key, narrowed.entry);
  }
  for (const raw of Array.isArray(parsed.dataSlots) ? parsed.dataSlots : []) {
    const narrowed = narrowEntry(raw);
    if (narrowed) dataSlots.set(narrowed.key, narrowed.entry);
  }
  // Need at least one answer OR one data-slot fill to be worth previewing; an empty sample is unusable.
  return answers.size > 0 || dataSlots.size > 0 ? { answers, dataSlots } : null;
}

/** One thing the sample answerer must produce an entry for — a question or a data slot. */
interface SampleItem {
  kind: 'question' | 'dataSlot';
  key: string;
  /** Section title (questions) or theme (data slots) — grouping context in the batch prompt. */
  group: string;
  /** The question prompt, or the slot name plus its description. */
  text: string;
}

/** One batch of items handed to a single sample-answerer call. */
interface SampleBatch {
  index: number;
  items: SampleItem[];
}

/** Flatten the version structure into the flat item list the batcher splits. */
export function flattenSampleItems(structure: PreviewStructure): SampleItem[] {
  const items: SampleItem[] = [];
  for (const section of structure.sections) {
    for (const q of section.questions) {
      items.push({ kind: 'question', key: q.key, group: section.title, text: q.prompt });
    }
  }
  for (const ds of structure.dataSlots) {
    items.push({
      kind: 'dataSlot',
      key: ds.key,
      group: ds.theme,
      text: ds.description ? `${ds.name} — ${ds.description}` : ds.name,
    });
  }
  return items;
}

/**
 * Split items into evenly-sized batches, preserving order. Even sizing (rather than filling each
 * batch to the cap and leaving a runt) keeps every call's latency about the same, so the slowest
 * batch — which sets the wall clock — is as fast as it can be.
 */
export function buildSampleBatches(
  items: SampleItem[],
  maxPerBatch = SAMPLE_BATCH_ITEMS
): SampleBatch[] {
  if (items.length === 0) return [];
  const batchCount = Math.ceil(items.length / maxPerBatch);
  const perBatch = Math.ceil(items.length / batchCount);
  const batches: SampleBatch[] = [];
  for (let i = 0; i < items.length; i += perBatch) {
    batches.push({ index: batches.length, items: items.slice(i, i + perBatch) });
  }
  return batches;
}

/** Describe the questionnaire being sampled — shared header for the persona and batch prompts. */
function structureHeader(structure: PreviewStructure): string {
  const lines: string[] = [`Questionnaire: ${structure.questionnaireTitle}`];
  if (structure.goal) lines.push(`Goal: ${structure.goal}`);
  if (structure.audience?.description) lines.push(`Audience: ${structure.audience.description}`);
  if (structure.audience?.role) lines.push(`Audience role: ${structure.audience.role}`);
  return lines.join('\n');
}

/** Assemble the persona-pass messages — invent the one respondent every batch then answers as. */
function buildPersonaMessages(structure: PreviewStructure): LlmMessage[] {
  const topics = structure.sections
    .map((s) => `- ${s.title} (${s.questions.length} questions)`)
    .join('\n');

  const system =
    'You invent a single PLAUSIBLE SAMPLE respondent for a questionnaire, so an admin can preview ' +
    'the report this configuration would produce. Describe one coherent, realistic persona: who they ' +
    'are, their role and organisation, their situation, their constraints, and the attitudes and ' +
    'opinions they hold on this questionnaire’s subject matter. Be specific and concrete — names, ' +
    'numbers, and particulars — because separate passes will answer the questionnaire as this person ' +
    'and must not contradict each other. Keep it under 250 words. This is sample data for a preview, ' +
    'never presented as a real person.\n\n' +
    'Respond with ONLY the persona description as plain prose — no JSON, no headings, no preamble.';

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${structureHeader(structure)}\n\nThe questionnaire covers:\n${topics}\n\nInvent the respondent now.`,
    },
  ];
}

/** Assemble one batch's messages — answer this slice of the questionnaire as the fixed persona. */
function buildBatchMessages(
  structure: PreviewStructure,
  persona: string,
  batch: SampleBatch
): LlmMessage[] {
  const questions = batch.items.filter((i) => i.kind === 'question');
  const dataSlots = batch.items.filter((i) => i.kind === 'dataSlot');

  const lines: string[] = [structureHeader(structure)];
  if (questions.length > 0) {
    lines.push('', 'QUESTIONS:');
    let currentGroup = '';
    for (const item of questions) {
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        lines.push(`# ${currentGroup}`);
      }
      lines.push(`- [${item.key}] ${item.text}`);
    }
  }
  if (dataSlots.length > 0) {
    lines.push('', 'DATA SLOTS (higher-level understanding to capture about the respondent):');
    for (const item of dataSlots) lines.push(`- [${item.key}] ${item.text}`);
  }

  const system =
    'You are answering part of a questionnaire AS the sample respondent described below, so an admin ' +
    'can preview the report this configuration would produce. Stay strictly in character: every ' +
    'answer must be consistent with the persona’s stated situation, constraints, and opinions — other ' +
    'passes are answering the rest of the same questionnaire as this same person, so do not invent ' +
    'facts that contradict the persona. Answer in natural first-person prose, varied and specific, ' +
    'not placeholder text. Fill each data slot with the higher-level position this persona holds. ' +
    'Give each answer/fill a `confidence` in 0..1 (vary it realistically — some things a respondent ' +
    'is sure about, some not) and a one-sentence `rationale` explaining the captured position. This ' +
    'is sample data for a preview, never presented as a real person.\n\n' +
    `THE RESPONDENT YOU ARE:\n${persona}\n\n` +
    'Answer ONLY the items listed in the user message — the rest of the questionnaire is handled ' +
    'separately. Emit exactly one entry per listed item, reusing its bracketed key verbatim.\n\n' +
    'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
    '{"answers":[{"key":string,"value":string,"confidence":number,"rationale":string}],' +
    '"dataSlots":[{"key":string,"value":string,"confidence":number,"rationale":string}]}';

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${lines.join('\n')}\n\nAnswer these items now.` },
  ];
}

/**
 * Synthesise a sample respondent for `structure` and return the report-generation inputs (Q&A
 * transcript + themed data-slot context block), built through the same content builders production
 * uses. `includeConfidence` mirrors `generation.discountLowConfidence` so the preview annotates
 * confidence exactly as a live report would. Throws when the report agent is not seeded, no provider
 * resolves, or the model output can't be parsed after a retry.
 */
export async function synthesiseSampleReportInputs(
  structure: PreviewStructure,
  opts: { includeConfidence: boolean }
): Promise<SampleReportInputs> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: RESPONDENT_REPORT_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true, temperature: true },
  });
  if (!agent) throw new Error('Respondent report agent is not seeded');

  const { providerSlug, model, fallbacks } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const { provider } = await getProviderWithFallbacks(providerSlug, fallbacks);

  // A touch of temperature so the sample persona reads naturally, not templated.
  const temperature = agent.temperature ?? 0.7;
  const batches = buildSampleBatches(flattenSampleItems(structure));
  const tokenUsage = { input: 0, output: 0 };
  let costUsd = 0;

  // 1. Persona pass — one respondent, fixed before any batch runs, so the batches can't each invent
  // a different person. A failure here is not fatal: the batches fall back to the un-personalised
  // instruction, which is exactly the (coherent-on-one-call) behaviour this flow had before batching.
  let persona = '';
  try {
    const personaResult = await provider.chat(buildPersonaMessages(structure), {
      model,
      temperature,
      maxTokens: PERSONA_MAX_TOKENS,
      timeoutMs: PERSONA_TIMEOUT_MS,
      signal: AbortSignal.timeout(PERSONA_TIMEOUT_MS),
    });
    persona = personaResult.content.trim();
    tokenUsage.input += personaResult.usage.inputTokens;
    tokenUsage.output += personaResult.usage.outputTokens;
    costUsd += calculateCost(
      model,
      personaResult.usage.inputTokens,
      personaResult.usage.outputTokens
    ).totalCostUsd;
  } catch (err) {
    logger.warn('report preview: persona pass failed; batches will self-describe', {
      model,
      error: errorMessage(err),
    });
  }
  if (!persona) {
    persona =
      'Invent a coherent, realistic respondent for this questionnaire and answer consistently as them.';
  }

  // 2. Batch passes — each answers its slice as that persona, capped concurrency. A batch that fails
  // costs its items, not the preview: a sample missing some answers still renders a representative
  // report (the coverage block below reports the gap honestly), whereas throwing shows the admin
  // nothing at all.
  const batchResults = await mapWithConcurrency(
    batches,
    SAMPLE_BATCH_CONCURRENCY,
    async (batch): Promise<ParsedSample | null> => {
      try {
        const batchResult = await runStructuredCompletion<ParsedSample>({
          provider,
          model,
          messages: buildBatchMessages(structure, persona, batch),
          temperature,
          maxTokens: SAMPLE_BATCH_MAX_TOKENS,
          timeoutMs: SAMPLE_BATCH_TIMEOUT_MS,
          parse: (raw) => tryParseJson(raw, parseSample),
          retryUserMessage:
            'Respond with ONLY the JSON object {"answers":[{"key","value","confidence","rationale"}],' +
            '"dataSlots":[...]} — no prose, no code fence.',
          onFinalFailure: () =>
            new Error('Sample answer synthesis did not return valid JSON after retry'),
          phase: 'report-preview-sample',
        });
        tokenUsage.input += batchResult.tokenUsage.input;
        tokenUsage.output += batchResult.tokenUsage.output;
        costUsd += batchResult.costUsd;
        logger.debug('report preview: sample batch complete', {
          batchIndex: batch.index,
          requested: batch.items.length,
          answers: batchResult.value.answers.size,
          dataSlots: batchResult.value.dataSlots.size,
        });
        return batchResult.value;
      } catch (err) {
        logger.warn('report preview: sample batch failed; continuing without it', {
          batchIndex: batch.index,
          itemCount: batch.items.length,
          model,
          error: errorMessage(err),
        });
        return null;
      }
    }
  );

  // `versionId` is null — the preview runs against an in-memory structure (possibly an unsaved draft),
  // so there is no version row to attribute to. Logged once for the whole fan-out: the admin pressed
  // "Preview" once, and the capability's cost is the sum of the passes it took.
  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage,
    capability: 'app_report_preview_sample',
    versionId: null,
  });

  // Merge the batches back into one sample. Batches answer disjoint item sets, so first-write-wins
  // only matters if a batch echoed a key outside its slice — in which case the owning batch's entry
  // is the one to keep.
  const sample: ParsedSample = { answers: new Map(), dataSlots: new Map() };
  for (const batchResult of batchResults) {
    if (!batchResult) continue;
    for (const [key, entry] of batchResult.answers) {
      if (!sample.answers.has(key)) sample.answers.set(key, entry);
    }
    for (const [key, entry] of batchResult.dataSlots) {
      if (!sample.dataSlots.has(key)) sample.dataSlots.set(key, entry);
    }
  }
  if (sample.answers.size === 0 && sample.dataSlots.size === 0) {
    throw new Error('Sample answer synthesis produced no usable answers');
  }
  // An entry whose key matches no question / data slot is dropped by the mapping below, and a
  // dropped entry is invisible in the output — it just renders as an unanswered question. Surface it
  // instead: silent key drift is exactly how this flow previously lost most of its sample.
  const knownQuestionKeys = new Set(
    structure.sections.flatMap((s) => s.questions.map((q) => q.key))
  );
  const knownSlotKeys = new Set(structure.dataSlots.map((ds) => ds.key));
  const unmatched = [
    ...[...sample.answers.keys()].filter((k) => !knownQuestionKeys.has(k)),
    ...[...sample.dataSlots.keys()].filter((k) => !knownSlotKeys.has(k)),
  ];
  if (unmatched.length > 0) {
    logger.warn('report preview: sample entries did not match the structure; dropping them', {
      model,
      unmatchedCount: unmatched.length,
      totalEntries: sample.answers.size + sample.dataSlots.size,
      examples: unmatched.slice(0, 5),
    });
  }

  // Map the sample onto the panel view exactly as generation does (structure + answers → panel),
  // rendering each answer as free text (the transcript shows the prompt + the sample prose).
  const sections: PanelSectionInput[] = structure.sections.map((s) => ({
    sectionId: s.sectionId,
    title: s.title,
    slots: s.questions.map((q) => ({
      slotKey: q.key,
      prompt: q.prompt,
      type: 'free_text',
      typeConfig: null,
      required: q.required,
    })),
  }));
  const answers: PanelAnswerInput[] = [];
  for (const section of structure.sections) {
    for (const q of section.questions) {
      const a = sample.answers.get(q.key);
      if (!a) continue;
      answers.push({
        slotKey: q.key,
        value: a.value,
        provenance: 'direct',
        confidence: a.confidence,
        rationale: a.rationale,
        answeredAtTurnIndex: null,
        refinementHistory: [],
      });
    }
  }
  const panel = buildAnswerPanelView({
    status: 'completed',
    scope: 'full_progress',
    sections,
    answers,
  });
  const transcript = buildAnswerTranscript(
    {
      questionnaireTitle: structure.questionnaireTitle,
      goal: structure.goal,
      audience: structure.audience,
      sections: panel.sections,
    },
    { includeConfidence: opts.includeConfidence }
  );

  // Map data-slot fills into themed groups (in structure order), then the shared context builder.
  const groups: ExportDataSlotGroup[] = [];
  const byTheme = new Map<string, ExportDataSlotGroup>();
  for (const ds of structure.dataSlots) {
    const fill = sample.dataSlots.get(ds.key);
    if (!fill) continue;
    let group = byTheme.get(ds.theme);
    if (!group) {
      group = { theme: ds.theme, slots: [] };
      byTheme.set(ds.theme, group);
      groups.push(group);
    }
    group.slots.push({
      key: ds.key,
      name: ds.name,
      description: ds.description,
      value: fill.value,
      rationale: fill.rationale,
      confidence: fill.confidence,
    });
  }
  const dataSlotContext = buildDataSlotContextBlock(groups, {
    includeConfidence: opts.includeConfidence,
  });

  return {
    transcript,
    dataSlotContext,
    // Parity with the live path: a synthesised sample normally answers every question (so this is ''
    // and no coverage block is emitted), but if the sample generator skipped some, the preview shows
    // the writer the same negative space a real partial session would.
    coverage: {
      answered: panel.answeredCount,
      total: panel.totalCount,
      unansweredBlock: buildUnansweredQuestionsBlock(panel.sections),
    },
    costUsd,
  };
}
