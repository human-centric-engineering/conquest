/**
 * Report preview — AI-synthesised sample answers (admin config preview).
 *
 * The admin "Preview report" flow needs answers to render a real report before any respondent has
 * completed the questionnaire. This module fabricates a plausible sample set from the version's
 * structure (questions + data slots) via one LLM call, then runs it through the SAME transcript +
 * data-slot builders production uses ({@link buildAnswerTranscript}, {@link buildDataSlotContextBlock}),
 * so the previewed report is generated from inputs shaped exactly like a live one.
 *
 * Pure orchestration around mockable seams (prisma, the agent resolver, the provider). Server-side only.
 */

import { prisma } from '@/lib/db/client';
import { isRecord } from '@/lib/utils';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import { RESPONDENT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
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

/** Generous cap for the sample answerer — many short answers; small model call. */
const SAMPLE_MAX_TOKENS = 3000;
const SAMPLE_TIMEOUT_MS = 45_000;

/** A single synthesised answer/fill after validation. */
interface SampleEntry {
  value: string;
  confidence: number;
  rationale: string;
}

/** Narrow one raw entry `{ key, value, confidence?, rationale? }` into a keyed sample entry. */
function narrowEntry(entry: unknown): { key: string; entry: SampleEntry } | null {
  if (!isRecord(entry)) return null;
  const key = typeof entry.key === 'string' ? entry.key.trim() : '';
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

/** Assemble the sample-answerer system + user messages from the version structure. */
function buildSampleMessages(structure: PreviewStructure): LlmMessage[] {
  const lines: string[] = [`Questionnaire: ${structure.questionnaireTitle}`];
  if (structure.goal) lines.push(`Goal: ${structure.goal}`);
  if (structure.audience?.description) lines.push(`Audience: ${structure.audience.description}`);
  if (structure.audience?.role) lines.push(`Audience role: ${structure.audience.role}`);
  lines.push('', 'QUESTIONS:');
  for (const section of structure.sections) {
    lines.push(`# ${section.title}`);
    for (const q of section.questions) lines.push(`- [${q.key}] ${q.prompt}`);
  }
  if (structure.dataSlots.length > 0) {
    lines.push('', 'DATA SLOTS (higher-level understanding to capture about the respondent):');
    for (const ds of structure.dataSlots) {
      lines.push(`- [${ds.key}] ${ds.name}${ds.description ? ` — ${ds.description}` : ''}`);
    }
  }

  const system =
    'You generate a single PLAUSIBLE SAMPLE respondent for a questionnaire, so an admin can preview ' +
    'the report this configuration would produce. Invent one coherent, realistic persona and answer ' +
    'every question as that persona would — natural first-person prose, varied and specific, not ' +
    'placeholder text. Also fill each data slot with the higher-level position that persona holds. ' +
    'Give each answer/fill a `confidence` in 0..1 (vary it realistically — some things a respondent ' +
    'is sure about, some not) and a one-sentence `rationale` explaining the captured position. This ' +
    'is sample data for a preview, never presented as a real person.\n\n' +
    'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
    '{"answers":[{"key":string,"value":string,"confidence":number,"rationale":string}],' +
    '"dataSlots":[{"key":string,"value":string,"confidence":number,"rationale":string}]}';

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${lines.join('\n')}\n\nGenerate the sample respondent now.` },
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
    select: { provider: true, model: true, fallbackProviders: true, temperature: true },
  });
  if (!agent) throw new Error('Respondent report agent is not seeded');

  const { providerSlug, model, fallbacks } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const { provider } = await getProviderWithFallbacks(providerSlug, fallbacks);

  const result = await runStructuredCompletion<ParsedSample>({
    provider,
    model,
    messages: buildSampleMessages(structure),
    // A touch of temperature so the sample persona reads naturally, not templated.
    temperature: agent.temperature ?? 0.7,
    maxTokens: SAMPLE_MAX_TOKENS,
    timeoutMs: SAMPLE_TIMEOUT_MS,
    parse: (raw) => tryParseJson(raw, parseSample),
    retryUserMessage:
      'Respond with ONLY the JSON object {"answers":[{"key","value","confidence","rationale"}],' +
      '"dataSlots":[...]} — no prose, no code fence.',
    onFinalFailure: () =>
      new Error('Sample answer synthesis did not return valid JSON after retry'),
    phase: 'report-preview-sample',
  });
  const sample = result.value;

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
    costUsd: result.costUsd,
  };
}
