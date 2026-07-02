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
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/knowledge/search', () => ({ searchKnowledge: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/client-knowledge', () => ({
  resolveClientKnowledgeDocumentIds: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-export', () => ({
  loadSessionExport: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { resolveClientKnowledgeDocumentIds } from '@/lib/app/questionnaire/report/client-knowledge';
import { loadSessionExport } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-export';
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
});

describe('generateRespondentReport', () => {
  it('builds the transcript into the prompt and returns the parsed content + cost', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await generateRespondentReport('sess-1');

    expect(result.content).toEqual(VALID_RESPONSE);
    expect(typeof result.costUsd).toBe('number');

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
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);
    await expect(generateRespondentReport('sess-1')).rejects.toThrow(/export not found/i);
  });

  it('throws when the report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);
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
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('personalised report');
    expect(system?.content).not.toContain('single woven report');
  });

  it('instructs the model to stay grounded and avoid unsupported generalisations', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

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
    (getProvider as Mock).mockResolvedValue(provider);

    await generateRespondentReport('sess-1');
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toMatch(/readable paragraphs/i);
    expect(system?.content).toMatch(/never emit one large block of text/i);
    // The JSON-shape directive also spells out the blank-line paragraph separator.
    expect(system?.content).toContain('separate paragraphs with a blank line');
  });

  it('applies the configured narrative-style preset to the system prompt', async () => {
    for (const [style, marker] of [
      ['flowing', 'Style: flowing'],
      ['concise', 'Style: concise'],
      ['structured', 'Style: structured'],
    ] as const) {
      vi.clearAllMocks();
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
      (getProvider as Mock).mockResolvedValue(provider);

      await generateRespondentReport('sess-1');
      const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
        (m) => m.role === 'system'
      );
      expect(system?.content).toContain(marker);
    }
  });

  it('falls back to the audience role when there is no description', async () => {
    (loadSessionExport as Mock).mockResolvedValue({
      ...loadedExport(),
      audience: { role: 'Line managers' },
    });
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    await generateRespondentReport('sess-1');
    const user = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user'
    );
    expect(user?.content).toContain('Audience: Line managers');
  });
});
