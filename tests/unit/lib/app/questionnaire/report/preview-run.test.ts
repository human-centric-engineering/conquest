/**
 * Report preview run + stream driver — unit tests.
 *
 * The two routes (synchronous and streamed) share every decision in this module, so what is pinned
 * here is the shared contract rather than either transport: the refusals an admin can hit before any
 * paid work starts, that previews force web search + KB grounding off, that a failure is classified
 * into retry-worthy vs not, and — the point of the whole change — that the stream reports each phase
 * as it happens and always terminates with exactly one `done` or `error`.
 *
 * @see lib/app/questionnaire/report/preview-run.ts
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

import {
  checkPreviewStructure,
  classifyPreviewFailure,
  isTimeoutError,
  preparePreviewSettings,
  previewStructureCounts,
  runReportPreview,
  streamReportPreview,
} from '@/lib/app/questionnaire/report/preview-run';
import type { PreviewStructure } from '@/lib/app/questionnaire/report/preview-sample';
import { synthesiseSampleReportInputs } from '@/lib/app/questionnaire/report/preview-sample';
import { generateReportFromInputs } from '@/lib/app/questionnaire/report/generate';
import type { RespondentReportSettings } from '@/lib/app/questionnaire/types';

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireVersion: { findFirst: vi.fn() } },
}));
vi.mock('@/lib/app/questionnaire/report/preview-sample', () => ({
  synthesiseSampleReportInputs: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/generate', () => ({
  generateReportFromInputs: vi.fn(),
}));

const synthesise = synthesiseSampleReportInputs as unknown as Mock;
const generate = generateReportFromInputs as unknown as Mock;

const structure: PreviewStructure = {
  questionnaireTitle: 'Pulse',
  goal: 'Understand engagement',
  audience: null,
  sections: [
    {
      sectionId: 's1',
      title: 'Wellbeing',
      questions: [
        { key: 'q1', prompt: 'Mood?', required: true },
        { key: 'q2', prompt: 'Workload?', required: false },
      ],
    },
  ],
  dataSlots: [{ key: 'ds1', name: 'Driver', description: null, theme: 'Motivation' }],
};

const SAMPLE = {
  transcript: 'Q: Mood?\nA: Good',
  dataSlotContext: 'Motivation: growth',
  coverage: { answered: 2, total: 2, unansweredBlock: '' },
  costUsd: 0.01,
};

const REPORT = {
  content: { summary: 'All good', sections: [], actions: [] },
  costUsd: 0.02,
  formatted: true,
  completionPct: 100,
  methodRecord: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  synthesise.mockResolvedValue(SAMPLE);
  generate.mockResolvedValue(REPORT);
});

describe('preparePreviewSettings', () => {
  it('refuses a raw config — its output is the answers, previewed elsewhere', () => {
    const prepared = preparePreviewSettings({ mode: 'raw' });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error('expected a refusal');
    expect(prepared.refusal.code).toBe('REPORT_PREVIEW_MODE_UNSUPPORTED');
    expect(prepared.refusal.status).toBe(400);
  });

  it('forces web search and knowledge-base grounding off for an AI mode', () => {
    const prepared = preparePreviewSettings({
      mode: 'narrative',
      generation: { useClientKnowledge: true, discountLowConfidence: true },
      research: { enabled: true, timing: 'before' },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('expected settings');
    expect(prepared.settings.generation.useClientKnowledge).toBe(false);
    expect(prepared.settings.research.enabled).toBe(false);
    // Everything else the admin configured survives — the preview must read like the real thing.
    expect(prepared.settings.generation.discountLowConfidence).toBe(true);
    expect(prepared.settings.mode).toBe('narrative');
  });
});

describe('checkPreviewStructure', () => {
  it('refuses a version with nothing to sample from', () => {
    const refusal = checkPreviewStructure({ ...structure, sections: [], dataSlots: [] });
    expect(refusal?.code).toBe('REPORT_PREVIEW_EMPTY_VERSION');
    expect(refusal?.status).toBe(400);
  });

  it('accepts a version with only data slots', () => {
    expect(checkPreviewStructure({ ...structure, sections: [] })).toBeNull();
  });

  it('accepts a version with questions', () => {
    expect(checkPreviewStructure(structure)).toBeNull();
  });
});

describe('previewStructureCounts', () => {
  it('counts questions across sections and data slots separately', () => {
    expect(previewStructureCounts(structure)).toEqual({ questionCount: 2, dataSlotCount: 1 });
  });
});

describe('classifyPreviewFailure', () => {
  it.each([
    ['a fetch AbortSignal.timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' })],
    [
      'an OpenAI SDK timeout',
      Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }),
    ],
    ["the platform's ProviderError", Object.assign(new Error('slow'), { code: 'timeout' })],
  ])('treats %s as retry-worthy', (_label, err) => {
    expect(isTimeoutError(err)).toBe(true);
    const refusal = classifyPreviewFailure(err);
    expect(refusal.code).toBe('REPORT_PREVIEW_TIMEOUT');
    expect(refusal.status).toBe(504);
    expect(refusal.message).toMatch(/try again/i);
  });

  it('does not tell an admin to retry a genuine failure', () => {
    const refusal = classifyPreviewFailure(new Error('Respondent report agent is not seeded'));
    expect(refusal.code).toBe('REPORT_PREVIEW_FAILED');
    expect(refusal.status).toBe(502);
  });

  it('never leaks the raw error message to the admin', () => {
    const refusal = classifyPreviewFailure(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(refusal.message).not.toContain('ECONNREFUSED');
  });
});

const settings = {
  mode: 'narrative',
  generation: { discountLowConfidence: false },
} as unknown as RespondentReportSettings;

describe('runReportPreview', () => {
  it('generates against the synthesised sample, with the preview marker and no client KB', async () => {
    const payload = await runReportPreview({ structure, settings, versionId: 'v1' });

    expect(payload).toEqual({
      questionnaireTitle: 'Pulse',
      mode: 'narrative',
      content: REPORT.content,
      formatted: true,
      completionPct: 100,
    });
    const inputs = generate.mock.calls[0][0];
    expect(inputs.transcript).toBe(SAMPLE.transcript);
    expect(inputs.dataSlotContext).toBe(SAMPLE.dataSlotContext);
    // `preview: true` is what stops the method record describing a sample as a real respondent.
    expect(inputs.preview).toBe(true);
    expect(inputs.demoClientId).toBeNull();
    expect(inputs.sessionId).toBe('preview:v1');
    // A synthesised sample answers everything — no partial-completion caveat.
    expect(inputs.completionPct).toBe(100);
  });

  it('reports which pass threw, so a production failure is diagnosable from the logs', async () => {
    generate.mockRejectedValueOnce(new Error('writer exploded'));
    const stages: string[] = [];
    await expect(
      runReportPreview({ structure, settings, versionId: 'v1', onStage: (s) => stages.push(s) })
    ).rejects.toThrow('writer exploded');
    expect(stages).toEqual(['sample', 'generate']);
  });

  it('passes no emitter through when the caller supplies none', async () => {
    await runReportPreview({ structure, settings, versionId: 'v1' });
    expect(synthesise.mock.calls[0][1]).not.toHaveProperty('onProgress');
    expect(generate.mock.calls[0][0]).not.toHaveProperty('onProgress');
  });
});

/** Drain the SSE driver into an array — it must always terminate on its own. */
async function collectStream(): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of streamReportPreview({
    structure,
    settings,
    versionId: 'v1',
    questionnaireId: 'q1',
    adminId: 'admin1',
  })) {
    events.push(event as unknown as Record<string, unknown>);
  }
  return events;
}

describe('streamReportPreview', () => {
  it('opens with the work ahead and closes with the rendered report', async () => {
    const events = await collectStream();

    expect(events[0]).toEqual({ type: 'started', questionCount: 2, dataSlotCount: 1 });
    expect(events[events.length - 1]).toEqual({
      type: 'done',
      questionnaireTitle: 'Pulse',
      mode: 'narrative',
      content: REPORT.content,
      formatted: true,
      completionPct: 100,
    });
  });

  it('forwards the phases the core emits, in the order the core crosses them', async () => {
    // Stand in for the real passes: emit what each stage of the pipeline announces.
    synthesise.mockImplementation(
      async (_structure: unknown, opts: { onProgress?: (e: unknown) => void }) => {
        opts.onProgress?.({ type: 'persona' });
        opts.onProgress?.({ type: 'sampling', batchesDone: 0, batchesTotal: 2 });
        await new Promise((r) => setTimeout(r, 0));
        opts.onProgress?.({ type: 'sampling', batchesDone: 2, batchesTotal: 2 });
        return SAMPLE;
      }
    );
    generate.mockImplementation(async (inputs: { onProgress?: (e: unknown) => void }) => {
      inputs.onProgress?.({ type: 'writing' });
      await new Promise((r) => setTimeout(r, 0));
      inputs.onProgress?.({ type: 'formatting' });
      return REPORT;
    });

    const events = await collectStream();

    expect(events.map((e) => e.type)).toEqual([
      'started',
      'persona',
      'sampling',
      'sampling',
      'writing',
      'formatting',
      'done',
    ]);
    // The counter must carry through unchanged — it is the only phase with a real denominator.
    expect(events[3]).toEqual({ type: 'sampling', batchesDone: 2, batchesTotal: 2 });
  });

  it('ends with an error event rather than throwing, since the status code is already sent', async () => {
    generate.mockRejectedValueOnce(new Error('writer exploded'));

    const events = await collectStream();

    const terminal = events[events.length - 1];
    expect(terminal.type).toBe('error');
    expect(terminal.code).toBe('REPORT_PREVIEW_FAILED');
    expect(terminal.message).not.toContain('writer exploded');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
  });

  it('marks a timeout as retry-worthy on the error event', async () => {
    synthesise.mockRejectedValueOnce(
      Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })
    );

    const events = await collectStream();

    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'REPORT_PREVIEW_TIMEOUT',
    });
  });
});
