/**
 * Respondent Report generation — unit tests.
 *
 * Mocks the DB, the session-export loader, the agent/provider resolution, KB search, and the client
 * doc-id resolution; exercises the real transcript build + structured-completion runner against a
 * fake provider. Asserts the prompt assembly (answers + KB grounding), the success shape, the
 * KB-skip paths, and the error throws.
 *
 * @see lib/app/questionnaire/report/generate.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/format', () => ({ formatReportContent: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProviderWithFallbacks: vi.fn() }));
vi.mock('@/lib/orchestration/knowledge/search', () => ({ searchKnowledge: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/client-knowledge', () => ({
  resolveClientKnowledgeDocumentIds: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-export', () => ({
  loadSessionExport: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/research', () => ({ runReportResearch: vi.fn() }));

import { prisma } from '@/lib/db/client';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { formatReportContent } from '@/lib/app/questionnaire/report/format';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { resolveClientKnowledgeDocumentIds } from '@/lib/app/questionnaire/report/client-knowledge';
import { loadSessionExport } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-export';
import { runReportResearch } from '@/lib/app/questionnaire/report/research';
import { APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_FLAG } from '@/lib/app/questionnaire/constants';
import { generateRespondentReport } from '@/lib/app/questionnaire/report/generate';

type Mock = ReturnType<typeof vi.fn>;

/** A fake provider that records the messages it was asked to complete. */
function fakeProvider(responseJson: object) {
  const chat = vi.fn().mockResolvedValue({
    content: JSON.stringify(responseJson),
    usage: { inputTokens: 100, outputTokens: 50 },
    // Match the real LlmResponse contract (provider.chat returns these too).
    model: 'test-model',
    finishReason: 'stop',
  });
  return { provider: { chat }, chat };
}

function sessionMeta(over: { respondentReport?: unknown; demoClientId?: string | null } = {}) {
  return {
    version: {
      config: {
        respondentReport: over.respondentReport ?? { enabled: true, mode: 'raw_plus_insights' },
      },
      questionnaire: { demoClientId: over.demoClientId ?? null },
    },
  };
}

function loadedExport() {
  return {
    status: 'completed',
    questionnaireTitle: 'Pulse',
    goal: 'Understand engagement',
    audience: { description: 'Employees' },
    sections: [
      {
        sectionId: 's1',
        title: 'Wellbeing',
        slots: [{ slotKey: 'q1', prompt: 'Mood?', type: 'free_text', required: false }],
      },
    ],
    answers: [
      {
        slotKey: 'q1',
        value: 'Positive',
        provenance: 'direct',
        confidence: null,
        rationale: null,
        answeredAtTurnIndex: 1,
        refinementHistory: [],
      },
    ],
  };
}

const VALID_RESPONSE = {
  summary: 'You are engaged.',
  sections: [{ heading: 'Strengths', body: 'Consistent positivity.' }],
  actions: ['Keep it up'],
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionMeta());
  (loadSessionExport as Mock).mockResolvedValue(loadedExport());
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    provider: 'openai',
    model: 'test-model',
    fallbackProviders: [],
    systemInstructions: 'You are the report writer.',
    temperature: 0.4,
    maxTokens: 4096,
  });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'openai',
    model: 'test-model',
    fallbacks: [],
  });
  (searchKnowledge as Mock).mockResolvedValue([]);
  (resolveClientKnowledgeDocumentIds as Mock).mockResolvedValue([]);
  // Formatter off by default — the existing suite asserts the un-thinned prompt + unformatted output.
  (isFeatureEnabled as Mock).mockResolvedValue(false);
  (formatReportContent as Mock).mockImplementation((content: unknown) => ({
    content,
    costUsd: 0,
    formatted: false,
  }));
  // Research disabled by default (no research config); each research test opts in explicitly.
  (runReportResearch as Mock).mockResolvedValue({ findings: [], costUsd: 0 });
});

describe('generateRespondentReport', () => {
  it('builds the transcript into the prompt and returns the parsed content + cost', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(result.content).toEqual(VALID_RESPONSE);
    // Deterministic: formatter + research are off and the fake model hits the zero-cost fallback.
    expect(result.costUsd).toBe(0);

    // The user message carries the answer transcript.
    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('Q: Mood?');
    expect(user?.content).toContain('A: Positive');
    // The system message carries the agent persona + actionable directive.
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('You are the report writer.');
    expect(system?.content.toLowerCase()).toContain('actionable');
  });

  it('strips a research block the writer hallucinated (research disabled → no fabricated sources)', async () => {
    // Web search is off in this suite, so no real research round runs and nothing is attached below.
    // A model that invents its own `research` key with plausible-but-fake links must not leak through.
    const { provider } = fakeProvider({
      ...VALID_RESPONSE,
      research: {
        findings: [{ title: 'Invented source', url: 'https://not-a-real-search.example' }],
        display: 'list',
      },
    });
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(result.content).not.toHaveProperty('research');
    expect(result.content).toEqual(VALID_RESPONSE);
  });

  it('resolves the report writer’s provider with the agent’s fallback providers', async () => {
    (resolveAgentProviderAndModel as Mock).mockResolvedValue({
      providerSlug: 'openai',
      model: 'test-model',
      fallbacks: ['anthropic', 'azure'],
    });
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');

    expect(getProviderWithFallbacks).toHaveBeenCalledWith('openai', ['anthropic', 'azure']);
  });

  it('grounds insights in client KB snippets when enabled and documents exist', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionMeta({
        respondentReport: {
          enabled: true,
          mode: 'raw_plus_insights',
          generation: {
            instructions: '',
            structure: '',
            backgroundContext: '',
            useClientKnowledge: true,
          },
        },
        demoClientId: 'clt-1',
      })
    );
    (resolveClientKnowledgeDocumentIds as Mock).mockResolvedValue(['doc-a']);
    (searchKnowledge as Mock).mockResolvedValue([
      { chunk: { content: 'Engagement rises with autonomy.' }, similarity: 0.9 },
    ]);
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');

    expect(resolveClientKnowledgeDocumentIds).toHaveBeenCalledWith('clt-1');
    // Search is scoped to the client's documents.
    expect((searchKnowledge as Mock).mock.calls[0][1]).toMatchObject({ documentIds: ['doc-a'] });
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('Engagement rises with autonomy.');
  });

  it('skips KB search when useClientKnowledge is off', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('skips KB search when there is no attributed client', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionMeta({
        respondentReport: {
          enabled: true,
          mode: 'raw_plus_insights',
          generation: {
            instructions: '',
            structure: '',
            backgroundContext: '',
            useClientKnowledge: true,
          },
        },
        demoClientId: null,
      })
    );
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    expect(resolveClientKnowledgeDocumentIds).not.toHaveBeenCalled();
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('throws when the session meta is missing', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    await expect(generateRespondentReport('sess-x')).rejects.toThrow(/not found/i);
  });

  it('throws when the session export cannot be loaded', async () => {
    (loadSessionExport as Mock).mockResolvedValue(null);
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });
    await expect(generateRespondentReport('sess-1')).rejects.toThrow(/export not found/i);
  });

  it('throws when the report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });
    await expect(generateRespondentReport('sess-1')).rejects.toThrow(/not seeded/i);
  });

  it('continues ungrounded when KB search throws (best-effort grounding)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionMeta({
        respondentReport: {
          enabled: true,
          mode: 'raw_plus_insights',
          generation: {
            instructions: '',
            structure: '',
            backgroundContext: '',
            useClientKnowledge: true,
          },
        },
        demoClientId: 'clt-1',
      })
    );
    (resolveClientKnowledgeDocumentIds as Mock).mockResolvedValue(['doc-a']);
    (searchKnowledge as Mock).mockRejectedValue(new Error('vector store down'));
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    // Does not throw — the report is still produced without grounding.
    const result = await generateRespondentReport('sess-1');
    expect(result.content).toEqual(VALID_RESPONSE);
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).not.toContain('Reference material');
  });

  it('skips KB search when the client has no documents', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionMeta({
        respondentReport: {
          enabled: true,
          mode: 'raw_plus_insights',
          generation: {
            instructions: '',
            structure: '',
            backgroundContext: '',
            useClientKnowledge: true,
          },
        },
        demoClientId: 'clt-1',
      })
    );
    (resolveClientKnowledgeDocumentIds as Mock).mockResolvedValue([]); // no docs tagged
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('threads populated instructions/structure/background into the system prompt', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionMeta({
        respondentReport: {
          enabled: true,
          mode: 'raw_plus_insights',
          generation: {
            instructions: 'Be warm and concise.',
            structure: 'Summary, then themes.',
            backgroundContext: 'Quarterly pulse for managers.',
            useClientKnowledge: false,
          },
        },
      })
    );
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('Be warm and concise.');
    expect(system?.content).toContain('Summary, then themes.');
    expect(system?.content).toContain('Quarterly pulse for managers.');
  });

  it('uses the woven-narrative framing for mode `narrative`', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionMeta({ respondentReport: { enabled: true, mode: 'narrative' } })
    );
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    // Narrative-specific weaving directive present, mode-2 framing absent; output shape unchanged.
    expect(system?.content).toContain('single woven report');
    expect(system?.content).toContain('woven chapter');
    expect(system?.content).not.toContain('AI-generated insights');
    expect(system?.content.toLowerCase()).toContain('actionable');
  });

  it('keeps the insights framing (not the narrative framing) for mode `raw_plus_insights`', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('personalised report');
    expect(system?.content).not.toContain('single woven report');
  });

  it('instructs the model to stay grounded and avoid unsupported generalisations', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('Ground every observation in a specific answer');
    expect(system?.content).toMatch(/do not make broad or sweeping generalisations/i);
    expect(system?.content).toMatch(/never invent facts/i);
  });

  it('instructs the model to write in short, blank-line-separated paragraphs', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toMatch(/readable paragraphs/i);
    expect(system?.content).toMatch(/never emit one large block of text/i);
    // The JSON-shape directive also spells out the blank-line paragraph separator.
    expect(system?.content).toContain('separate paragraphs with a blank line');
  });

  // One case per style (not a single loop) so a failure in one style doesn't mask the others, and
  // each relies on the shared beforeEach setup rather than re-typing the mocks inline.
  it.each([
    ['flowing', 'Style: flowing'],
    ['concise', 'Style: concise'],
    ['structured', 'Style: structured'],
  ] as const)(
    'applies the %s narrative-style preset to the system prompt',
    async (style, marker) => {
      (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionMeta({
          respondentReport: {
            enabled: true,
            mode: 'narrative',
            generation: { narrativeStyle: style },
          },
        })
      );
      const { provider, chat } = fakeProvider(VALID_RESPONSE);
      (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

      await generateRespondentReport('sess-1');
      const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
        (m) => m.role === 'system'
      );
      expect(system?.content).toContain(marker);
    }
  );

  it('falls back to the audience role when there is no description', async () => {
    (loadSessionExport as Mock).mockResolvedValue({
      ...loadedExport(),
      audience: { role: 'Line managers' },
    });
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    await generateRespondentReport('sess-1');
    const user = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user'
    );
    expect(user?.content).toContain('Audience: Line managers');
  });

  it('does not run the formatter and returns formatted:false when the flag is off', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(formatReportContent).not.toHaveBeenCalled();
    expect(result.formatted).toBe(false);
  });

  it('reports 100% completion when every slot was answered', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');
    // The default export has one slot, answered → 1/1 = 100%.
    expect(result.completionPct).toBe(100);
  });

  it('computes a partial completion % from answered/total slots (early submission)', async () => {
    // Two slots, one answered → 50% — a session submitted before finishing.
    (loadSessionExport as Mock).mockResolvedValue({
      ...loadedExport(),
      sections: [
        {
          sectionId: 's1',
          title: 'Wellbeing',
          slots: [
            { slotKey: 'q1', prompt: 'Mood?', type: 'free_text', required: false },
            { slotKey: 'q2', prompt: 'Sleep?', type: 'free_text', required: false },
          ],
        },
      ],
    });
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');
    expect(result.completionPct).toBe(50);
  });
});

describe('generateRespondentReport with the Report Formatter enabled', () => {
  const FORMATTED = {
    summary: 'You are engaged.\n\nYou answered positively.',
    sections: [{ heading: 'Strengths', body: 'Consistent positivity.' }],
    actions: ['Keep it up'],
  };

  beforeEach(() => {
    (isFeatureEnabled as Mock).mockResolvedValue(true);
  });

  it('runs the formatter on the writer output and sums both costs', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });
    (formatReportContent as Mock).mockResolvedValue({
      content: FORMATTED,
      costUsd: 0.02,
      formatted: true,
    });

    const result = await generateRespondentReport('sess-1');

    // The formatter received the validated writer output, plaintext mode.
    expect(formatReportContent).toHaveBeenCalledWith(VALID_RESPONSE, { format: 'plaintext' });
    expect(result.content).toEqual(FORMATTED);
    expect(result.formatted).toBe(true);
    // The formatter cost is summed into the total. The fake writer model has no pricing so it
    // computes to exactly 0, pinning the sum to the formatter's 0.02 — a double-count or dropped
    // term would fail this exact check (a loose >= bound would not).
    expect(result.costUsd).toBeCloseTo(0.02, 5);
  });

  it('propagates a formatter fallback (formatted:false) without failing the report', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });
    // Formatter fell back to the unformatted content (e.g. structural drift).
    (formatReportContent as Mock).mockResolvedValue({
      content: VALID_RESPONSE,
      costUsd: 0.01,
      formatted: false,
    });

    const result = await generateRespondentReport('sess-1');

    expect(result.content).toEqual(VALID_RESPONSE);
    expect(result.formatted).toBe(false);
  });

  it('thins agent 1s paragraph discipline (formatter owns final layout)', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });
    (formatReportContent as Mock).mockResolvedValue({
      content: FORMATTED,
      costUsd: 0,
      formatted: true,
    });

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    // The lighter guidance is present; the strict mechanical rule is gone.
    expect(system?.content).toMatch(/a separate formatting pass refines the final layout/i);
    expect(system?.content).not.toMatch(/never emit one large block of text/i);
  });

  it('drops the manual bullet mechanic from the structured style (formatter bulletises)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionMeta({
        respondentReport: {
          enabled: true,
          mode: 'narrative',
          generation: { narrativeStyle: 'structured' },
        },
      })
    );
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });
    (formatReportContent as Mock).mockResolvedValue({
      content: FORMATTED,
      costUsd: 0,
      formatted: true,
    });

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    // Still scannable/structured, but no "one point per line starting with -" instruction.
    expect(system?.content).toContain('Style: structured and scannable');
    expect(system?.content).not.toMatch(/each line starting with "- "/i);
  });
});

describe('generateRespondentReport — web-search research', () => {
  const FINDING = { title: 'Benchmark', url: 'https://bench.test', snippet: 'A stat' };

  /** A respondentReport config with research enabled at a given timing/flags. */
  function researchConfig(over: Record<string, unknown> = {}) {
    return sessionMeta({
      respondentReport: {
        enabled: true,
        mode: 'raw_plus_insights',
        research: {
          enabled: true,
          timing: 'before',
          rounds: 2,
          maxResults: 5,
          before: { instructions: 'Find benchmarks.' },
          after: { instructions: 'Find sources.' },
          display: 'list',
          informNarrative: true,
          ...over,
        },
      },
    });
  }

  beforeEach(() => {
    // Web-search platform flag on; formatter flag stays off.
    (isFeatureEnabled as Mock).mockImplementation(
      (flag: string) => flag === APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_FLAG
    );
  });

  it('does not run research when the platform flag is off (even if config enables it)', async () => {
    (isFeatureEnabled as Mock).mockResolvedValue(false);
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(researchConfig());
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');
    expect(runReportResearch).not.toHaveBeenCalled();
    expect(result.content).not.toHaveProperty('research');
  });

  it('runs a before round, folds it into the prompt, and attaches the research section', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(researchConfig());
    (runReportResearch as Mock).mockResolvedValue({
      findings: [FINDING],
      note: 'Context note.',
      costUsd: 0.02,
    });
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(runReportResearch).toHaveBeenCalledTimes(1);
    expect((runReportResearch as Mock).mock.calls[0][0]).toMatchObject({ phase: 'before' });
    // The before findings inform the grounded prose (framed as general external context).
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('External web research');
    expect(system?.content).toContain('https://bench.test');
    // The section is attached with the configured display and the research cost is summed.
    expect(result.content.research).toEqual({
      findings: [FINDING],
      note: 'Context note.',
      display: 'list',
    });
    // Base structured-completion cost is 0 (fake model); only the mocked research cost is summed in.
    expect(result.costUsd).toBeCloseTo(0.02, 5);
  });

  it('does not fold findings into the prompt when informNarrative is off, but still attaches the section', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      researchConfig({ informNarrative: false })
    );
    (runReportResearch as Mock).mockResolvedValue({ findings: [FINDING], costUsd: 0 });
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).not.toContain('External web research');
    expect(result.content.research?.findings).toEqual([FINDING]);
  });

  it('omits the research section when display is hidden', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      researchConfig({ display: 'hidden' })
    );
    (runReportResearch as Mock).mockResolvedValue({ findings: [FINDING], costUsd: 0 });
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');
    expect(result.content).not.toHaveProperty('research');
  });

  it('runs an after round on the drafted report and merges/dedupes findings by URL', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      researchConfig({ timing: 'both' })
    );
    (runReportResearch as Mock)
      .mockResolvedValueOnce({ findings: [FINDING], note: 'before', costUsd: 0 })
      .mockResolvedValueOnce({
        findings: [FINDING, { title: 'New', url: 'https://new.test', snippet: 's' }],
        note: 'after',
        costUsd: 0,
      });
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(runReportResearch).toHaveBeenCalledTimes(2);
    expect((runReportResearch as Mock).mock.calls[1][0]).toMatchObject({ phase: 'after' });
    // Deduped by URL (the shared finding appears once); the after note wins.
    expect(result.content.research?.findings).toEqual([
      FINDING,
      { title: 'New', url: 'https://new.test', snippet: 's' },
    ]);
    expect(result.content.research?.note).toBe('after');
  });

  it('skips the after round entirely when the findings are hidden (output cannot surface)', async () => {
    // after-research surfaces only via the displayed section; hidden ⇒ running it is pure waste.
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      researchConfig({ timing: 'after', display: 'hidden' })
    );
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(runReportResearch).not.toHaveBeenCalled();
    expect(result.content).not.toHaveProperty('research');
  });

  it('skips the before round when findings are hidden and not folded into the narrative', async () => {
    // before-research surfaces via the prose (informNarrative) or the displayed section; neither ⇒ skip.
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      researchConfig({ timing: 'before', display: 'hidden', informNarrative: false })
    );
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(runReportResearch).not.toHaveBeenCalled();
    expect(result.content).not.toHaveProperty('research');
  });

  it('still runs the before round when hidden but folded into the narrative', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      researchConfig({ timing: 'before', display: 'hidden', informNarrative: true })
    );
    (runReportResearch as Mock).mockResolvedValue({ findings: [FINDING], costUsd: 0 });
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    // Ran (to inform the prose) but the section stays hidden.
    expect(runReportResearch).toHaveBeenCalledTimes(1);
    expect(result.content).not.toHaveProperty('research');
  });

  it('attaches no research section when the round returns no findings and no note', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(researchConfig());
    (runReportResearch as Mock).mockResolvedValue({ findings: [], costUsd: 0 });
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(runReportResearch).toHaveBeenCalledTimes(1);
    expect(result.content).not.toHaveProperty('research');
  });

  it('attaches a note-only research block when the round yields a note but no findings', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(researchConfig());
    (runReportResearch as Mock).mockResolvedValue({
      findings: [],
      note: 'Nothing conclusive surfaced.',
      costUsd: 0,
    });
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProviderWithFallbacks as Mock).mockResolvedValue({ provider, usedSlug: 'openai' });

    const result = await generateRespondentReport('sess-1');

    expect(result.content.research).toEqual({
      findings: [],
      note: 'Nothing conclusive surfaced.',
      display: 'list',
    });
  });
});
