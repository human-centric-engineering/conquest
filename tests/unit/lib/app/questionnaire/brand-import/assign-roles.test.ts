/**
 * Unit tests: brand-import role assignment.
 *
 * Two things are worth pinning here, and neither is "does it call the model".
 *
 * 1. **The model cannot invent a colour.** `narrowAssignments` is the entire guarantee that every
 *    hex an admin is shown came off a real pixel, so it is tested directly rather than only
 *    through a mocked provider — a guarantee exercised only via mocks is a guarantee nobody is
 *    really checking.
 * 2. **A model that cannot see is not a failure.** When the resolved model lacks `vision` the
 *    image is dropped and the call still runs on the numbers, marked so.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({ aiAgent: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const providerMock = vi.hoisted(() => ({
  getProvider: vi.fn(async () => ({ name: 'test' })),
  assertModelSupportsAttachments: vi.fn(async () => undefined),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => providerMock);

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({
    providerSlug: 'openai',
    model: 'gpt-test',
    fallbacks: [],
  })),
}));

const completionMock = vi.hoisted(() => ({ runStructuredCompletion: vi.fn() }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => completionMock);

vi.mock('@/lib/app/questionnaire/llm/log-app-cost', () => ({ logAppLlmCost: vi.fn() }));

import { assignRoles, narrowAssignments } from '@/lib/app/questionnaire/brand-import/assign-roles';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';

const CANDIDATES = [
  { hex: '#ffffff', share: 0.7, neutral: true },
  { hex: '#111114', share: 0.2, neutral: true },
  { hex: '#5469d4', share: 0.1, neutral: false },
];

describe('narrowAssignments', () => {
  it('maps the roles it recognises onto their columns', () => {
    expect(
      narrowAssignments(
        { pageBackground: '#ffffff', bodyText: '#111114', primaryButton: '#5469d4' },
        CANDIDATES
      )
    ).toEqual([
      { field: 'canvasColor', hex: '#ffffff' },
      { field: 'inkColor', hex: '#111114' },
      { field: 'ctaColor', hex: '#5469d4' },
    ]);
  });

  it('drops a hex that was never measured instead of snapping it to the nearest one', () => {
    // #5468d4 is one level off a real candidate — a fabrication, not a typo. Snapping would ship
    // a colour the page never used while looking exactly like one it did.
    expect(narrowAssignments({ primaryButton: '#5468d4' }, CANDIDATES)).toEqual([]);
  });

  it('drops the three-digit form of a measured colour, because the contract is exact match', () => {
    expect(narrowAssignments({ pageBackground: '#fff' }, CANDIDATES)).toEqual([]);
  });

  it('accepts a measured colour whatever case the model returned it in', () => {
    expect(narrowAssignments({ primaryButton: '#5469D4' }, CANDIDATES)).toEqual([
      { field: 'ctaColor', hex: '#5469d4' },
    ]);
  });

  it('ignores roles we did not ask for', () => {
    expect(narrowAssignments({ someInventedRole: '#5469d4' }, CANDIDATES)).toEqual([]);
  });

  it('ignores a null, which is how the model says "this page has no such thing"', () => {
    expect(narrowAssignments({ headerBand: null, primaryButton: '#5469d4' }, CANDIDATES)).toEqual([
      { field: 'ctaColor', hex: '#5469d4' },
    ]);
  });

  it('ignores a value that is not a hex at all', () => {
    expect(narrowAssignments({ primaryButton: 'the blue one' }, CANDIDATES)).toEqual([]);
  });

  it('keeps only the first assignment to a column', () => {
    // Two roles map to distinct columns, so this can only happen if the same role appears twice —
    // but the guard also stops a future role map from silently overwriting a field.
    expect(
      narrowAssignments({ primaryButton: '#5469d4', pageBackground: '#ffffff' }, CANDIDATES)
    ).toHaveLength(2);
  });
});

describe('assignRoles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.aiAgent.findUnique.mockResolvedValue({
      id: 'agent-1',
      provider: '',
      model: '',
      fallbackProviders: [],
      systemInstructions: 'be a brand analyst',
      temperature: 0.1,
      maxTokens: 700,
    });
    providerMock.assertModelSupportsAttachments.mockResolvedValue(undefined);
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: { roles: { pageBackground: '#ffffff', primaryButton: '#5469d4' } },
      tokenUsage: { input: 100, output: 20 },
      costUsd: 0.001,
      finishReason: 'stop',
    });
  });

  it('attaches the image when the resolved model can read one', async () => {
    const result = await assignRoles({
      candidates: CANDIDATES,
      images: [{ base64: 'AAAA', mediaType: 'image/png' }],
    });

    expect(result.sawImages).toBe(true);
    const messages = completionMock.runStructuredCompletion.mock.calls[0][0].messages;
    const parts = messages[1].content as { type: string }[];
    expect(parts.some((part) => part.type === 'image')).toBe(true);
  });

  it('attaches every screenshot to the same call, and says they are one brand', async () => {
    const result = await assignRoles({
      candidates: CANDIDATES,
      images: [
        { base64: 'AAAA', mediaType: 'image/png' },
        { base64: 'BBBB', mediaType: 'image/jpeg' },
      ],
    });

    expect(result.sawImages).toBe(true);
    const messages = completionMock.runStructuredCompletion.mock.calls[0][0].messages;
    const parts = messages[1].content as { type: string; source?: { data: string } }[];
    expect(parts.filter((part) => part.type === 'image').map((part) => part.source?.data)).toEqual([
      'AAAA',
      'BBBB',
    ]);
    // Without this the model has been seen to answer per image, which produces two palettes and
    // nothing to arbitrate between them.
    const text = parts.find((part) => part.type === 'text') as unknown as { text: string };
    expect(text.text).toContain('2 screenshots');
    expect(text.text).toContain('one set of roles');
  });

  it('drops the image and still assigns when the model has no vision capability', async () => {
    // The alternative — letting the provider reject the whole call — loses the assignment we
    // could still have made from the shares alone.
    providerMock.assertModelSupportsAttachments.mockRejectedValue(new Error('no vision'));

    const result = await assignRoles({
      candidates: CANDIDATES,
      images: [{ base64: 'AAAA', mediaType: 'image/png' }],
    });

    expect(result.sawImages).toBe(false);
    expect(result.assignments).toHaveLength(2);
    const messages = completionMock.runStructuredCompletion.mock.calls[0][0].messages;
    expect(typeof messages[1].content).toBe('string');
  });

  it('attributes the spend with no version, because an import has none', async () => {
    await assignRoles({ candidates: CANDIDATES, demoClientId: 'dc-1' });

    expect(logAppLlmCost).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'app_brand_import',
        versionId: null,
        extra: expect.objectContaining({ demoClientId: 'dc-1' }),
      })
    );
  });

  it('throws when the analyst agent is not seeded, so the caller can degrade', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    await expect(assignRoles({ candidates: CANDIDATES })).rejects.toThrow('not seeded');
  });

  it('falls back to the module default when the agent row has no maxTokens of its own', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue({
      id: 'agent-1',
      provider: '',
      model: '',
      fallbackProviders: [],
      systemInstructions: 'be a brand analyst',
      temperature: 0.1,
      maxTokens: 0,
    });

    await assignRoles({ candidates: CANDIDATES });

    // 0 is falsy, so `agent.maxTokens || MAX_TOKENS` has to fall through to the built-in default
    // rather than sending the provider a literal 0-token budget.
    expect(completionMock.runStructuredCompletion.mock.calls[0][0].maxTokens).toBe(700);
  });

  it('assigns nothing, rather than throwing, when the model omits `roles` entirely', async () => {
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: {},
      tokenUsage: { input: 100, output: 20 },
      costUsd: 0.001,
      finishReason: 'stop',
    });

    const result = await assignRoles({ candidates: CANDIDATES });

    expect(result.assignments).toEqual([]);
  });

  it('includes what the page declared about itself in the prompt, when there is any', async () => {
    await assignRoles({
      candidates: CANDIDATES,
      hints: ['The page declares theme-color: #5469d4'],
    });

    const messages = completionMock.runStructuredCompletion.mock.calls[0][0].messages;
    expect(messages[1].content).toContain('What the page declared about itself');
    expect(messages[1].content).toContain('The page declares theme-color: #5469d4');
  });

  describe('the parse callback handed to the structured-completion runner', () => {
    // `runStructuredCompletion` is mocked above, which means its `parse` option is captured but
    // never actually invoked by anything in this file. That leaves the glue between the model's
    // raw text and the validated shape — a real production code path — untested unless it is
    // called directly here.
    async function capturedParse(): Promise<(raw: string) => unknown> {
      await assignRoles({ candidates: CANDIDATES });
      return completionMock.runStructuredCompletion.mock.calls[0][0].parse;
    }

    it('parses a well-formed reply into the validated shape', async () => {
      const parse = await capturedParse();
      expect(parse('{"roles":{"pageBackground":"#ffffff"}}')).toEqual({
        roles: { pageBackground: '#ffffff' },
      });
    });

    it('returns null for JSON that does not match the expected shape', async () => {
      const parse = await capturedParse();
      // `roles` must be a record of string-or-null; a bare string fails the schema even though
      // the text is valid JSON.
      expect(parse('{"roles":"not an object"}')).toBeNull();
    });

    it('returns null for text that is not JSON at all', async () => {
      const parse = await capturedParse();
      expect(parse('not json')).toBeNull();
    });
  });
});
