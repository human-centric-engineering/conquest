/**
 * Unit tests: the AI leg's runner — one steer call, and what it refuses.
 *
 * `steer-schema.test.ts` pins the contract (what the model may return, and how a revision folds
 * back into the judge's op). This file pins the orchestration around it, where three things carry
 * real weight:
 *
 * 1. **An op-kind switch is refused outright.** It is the model overruling the reviewer's own
 *    decision, and it is the one case where a syntactically valid response is thrown away.
 * 2. **Every failure path is a `failed` provenance row, not silence.** A reviewer who sees "not
 *    applied" asks why later, and "the model returned a different kind of change and we refused it"
 *    is only answerable if it was written down. `provider`/`model` read `n/a` where the call never
 *    reached a provider — the agreed spelling for "this never ran".
 * 3. **Nothing throws.** Every expected failure is a discriminated result, because the batch has a
 *    per-finding report line waiting for it and one dead call must not take the other ten changes
 *    down with it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/db/client', () => prismaMock);

const llmMock = vi.hoisted(() => ({
  resolveAgentProviderAndModel: vi.fn(),
  getProvider: vi.fn(),
  runStructuredCompletion: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: llmMock.resolveAgentProviderAndModel,
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: llmMock.getProvider }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: llmMock.runStructuredCompletion,
}));

const costMock = vi.hoisted(() => ({ logCost: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: costMock.logCost }));

const runMock = vi.hoisted(() => ({ recordAiRun: vi.fn(() => Promise.resolve('run-row-1')) }));
vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: runMock.recordAiRun }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { steerProposedEdit } from '@/lib/app/questionnaire/evaluation/steer-edit';
import { STEER_PROMPT_VERSION } from '@/lib/app/questionnaire/evaluation/steer-prompt';
import type { SteerPromptInput } from '@/lib/app/questionnaire/evaluation/steer-prompt';

const CTX = { versionId: 'v1', runId: 'run-1', findingId: 'find-1', userId: 'admin-1' };

function input(over: Partial<SteerPromptInput> = {}): SteerPromptInput {
  return {
    instruction: 'Keep it under 15 words.',
    op: { op: 'replace_prompt', prompt: 'Judge wording' },
    proposedChange: 'Reword it.',
    rationale: 'It is ambiguous.',
    dimensionLabel: 'Clarity Judge',
    question: { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
    goal: 'Goal',
    audience: null,
    ...over,
  };
}

/** A completion whose `revised` is whatever the test wants to model the model saying. */
function completion(revised: unknown, over: Record<string, unknown> = {}) {
  return {
    value: { revised, note: 'Shortened it.', unhonoured: null, ...over },
    tokenUsage: { input: 100, output: 20 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.prisma.aiAgent.findUnique.mockResolvedValue({
    id: 'agent-1',
    provider: '',
    model: '',
    fallbackProviders: [],
  });
  llmMock.resolveAgentProviderAndModel.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-5.4',
  });
  llmMock.getProvider.mockResolvedValue({ name: 'openai' });
  llmMock.runStructuredCompletion.mockResolvedValue(
    completion({ op: 'replace_prompt', prompt: 'Reviewer wording' })
  );
});

describe('steerProposedEdit — the happy path', () => {
  it('returns the merged op, the note, and anything unhonoured', async () => {
    llmMock.runStructuredCompletion.mockResolvedValue(
      completion(
        { op: 'replace_prompt', prompt: 'Reviewer wording' },
        { unhonoured: 'A 1–5 scale is not a wording change.' }
      )
    );

    const result = await steerProposedEdit(input(), CTX);

    expect(result).toEqual({
      ok: true,
      edit: { op: 'replace_prompt', prompt: 'Reviewer wording' },
      note: 'Shortened it.',
      unhonoured: 'A 1–5 scale is not a wording change.',
    });
  });

  it('normalises a missing unhonoured to null rather than undefined', async () => {
    llmMock.runStructuredCompletion.mockResolvedValue({
      value: { revised: { op: 'replace_prompt', prompt: 'x' }, note: 'Done.' },
      tokenUsage: { input: 1, output: 1 },
    });

    const result = await steerProposedEdit(input(), CTX);
    expect(result).toMatchObject({ ok: true, unhonoured: null });
  });

  it('asks for the reasoning tier — the tier the judges it reconciles with run on', async () => {
    await steerProposedEdit(input(), CTX);
    expect(llmMock.resolveAgentProviderAndModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: '', model: '' }),
      'reasoning'
    );
  });

  it('attributes cost to the real agent row, with the finding it was spent on', async () => {
    await steerProposedEdit(input(), CTX);
    expect(costMock.logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        model: 'gpt-5.4',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 20,
        metadata: expect.objectContaining({ findingId: 'find-1', runId: 'run-1' }),
      })
    );
  });

  it('records the run against the version, with the resolved binding and the prompt version', async () => {
    // Resolved, never configured: the agent ships with an empty binding, so recording the row's
    // own values would file a real call under a blank.
    await steerProposedEdit(input(), CTX);
    expect(runMock.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKind: 'version',
        subjectId: 'v1',
        versionId: 'v1',
        kind: 'evaluation_steer',
        status: 'succeeded',
        provider: 'openai',
        model: 'gpt-5.4',
        promptVersion: STEER_PROMPT_VERSION,
        triggeredByUserId: 'admin-1',
        detail: expect.objectContaining({
          findingId: 'find-1',
          instruction: 'Keep it under 15 words.',
        }),
      })
    );
  });
});

describe('steerProposedEdit — the refusal', () => {
  it('refuses a revision that changes the operation, and says which one it returned', async () => {
    // The reviewer accepted a reword. A delete applied in its place is a change nobody agreed to.
    llmMock.runStructuredCompletion.mockResolvedValue(
      completion({ op: 'edit_goal', goal: 'Something else' })
    );

    const result = await steerProposedEdit(input(), CTX);

    expect(result).toMatchObject({ ok: false, code: 'steer_changed_op' });
    expect(runMock.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'steered edit changed the operation',
        detail: expect.objectContaining({ op: 'replace_prompt', returnedOp: 'edit_goal' }),
      })
    );
  });

  it('still bills a refused call — the tokens were spent either way', async () => {
    llmMock.runStructuredCompletion.mockResolvedValue(
      completion({ op: 'edit_goal', goal: 'Something else' })
    );
    await steerProposedEdit(input(), CTX);
    expect(costMock.logCost).toHaveBeenCalled();
  });
});

describe('steerProposedEdit — every failure is a result, never a throw', () => {
  it('reports an unseeded agent without reaching a provider', async () => {
    prismaMock.prisma.aiAgent.findUnique.mockResolvedValue(null);

    const result = await steerProposedEdit(input(), CTX);

    expect(result).toMatchObject({ ok: false, code: 'steer_agent_not_configured' });
    expect(llmMock.resolveAgentProviderAndModel).not.toHaveBeenCalled();
    // `n/a` is the agreed spelling for "this never reached a provider" — a legitimate value on a
    // failure path, not a gap to be filled in.
    expect(runMock.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', provider: 'n/a', model: 'n/a' })
    );
  });

  it('reports an unresolvable binding', async () => {
    llmMock.resolveAgentProviderAndModel.mockRejectedValue(new Error('no tier'));

    const result = await steerProposedEdit(input(), CTX);

    expect(result).toMatchObject({ ok: false, code: 'no_provider_configured' });
    expect(runMock.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'no tier' })
    );
  });

  it('reports an unavailable provider, keeping the binding it had resolved', async () => {
    llmMock.getProvider.mockRejectedValue(new Error('provider down'));

    const result = await steerProposedEdit(input(), CTX);

    expect(result).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(runMock.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', provider: 'openai', model: 'gpt-5.4' })
    );
  });

  it('reports a failed completion, and records the prompt that produced it', async () => {
    llmMock.runStructuredCompletion.mockRejectedValue(new Error('schema mismatch after retry'));

    const result = await steerProposedEdit(input(), CTX);

    expect(result).toMatchObject({ ok: false, code: 'steer_failed' });
    const calls = runMock.recordAiRun.mock.calls as unknown as [
      { status: string; error: string; promptSnapshot: unknown },
    ][];
    const call = calls.at(-1)?.[0];
    expect(call).toMatchObject({ status: 'failed', error: 'schema mismatch after retry' });
    // The prompt is kept on the failure: "what did the model actually see" is the debugging
    // question, and it is unanswerable after the fact if only the error survived.
    expect(call?.promptSnapshot).toBeTruthy();
  });

  it('names the schema mismatch when the model never produced a valid result', async () => {
    // `onFinalFailure` is what turns "two attempts, neither validated" into a sentence someone can
    // act on. Exercised through the real call options rather than asserted on the source.
    let onFinalFailure: (() => Error) | undefined;
    llmMock.runStructuredCompletion.mockImplementation((opts: { onFinalFailure: () => Error }) => {
      onFinalFailure = opts.onFinalFailure;
      return Promise.reject(opts.onFinalFailure());
    });

    const result = await steerProposedEdit(input(), CTX);

    expect(onFinalFailure?.().message).toMatch(/not valid against the schema after one retry/);
    expect(result).toMatchObject({ ok: false, code: 'steer_failed' });
  });

  it('parses a raw completion through the steer schema', async () => {
    // The parse hook is the boundary: a shape the schema rejects must come back null so the
    // completion helper retries, rather than being handed on as a revision.
    let parse: ((raw: string) => unknown) | undefined;
    llmMock.runStructuredCompletion.mockImplementation(
      (opts: { parse: (raw: string) => unknown }) => {
        parse = opts.parse;
        return Promise.resolve(completion({ op: 'replace_prompt', prompt: 'Reviewer wording' }));
      }
    );

    await steerProposedEdit(input(), CTX);

    expect(parse?.('{"revised":{"op":"replace_prompt","prompt":"x"},"note":"n"}')).toMatchObject({
      note: 'n',
    });
    expect(parse?.('{"revised":{"op":"delete_question"},"note":"n"}')).toBeNull();
    expect(parse?.('not json at all')).toBeNull();
  });

  it('logs a rejected cost write instead of failing the steer over it', async () => {
    // An accounting write must never take down the admin's actual action.
    costMock.logCost.mockRejectedValueOnce(new Error('cost table down'));

    const result = await steerProposedEdit(input(), CTX);

    expect(result).toMatchObject({ ok: true });
  });

  it('does not bill a call that never reached the provider', async () => {
    llmMock.getProvider.mockRejectedValue(new Error('provider down'));
    await steerProposedEdit(input(), CTX);
    expect(costMock.logCost).not.toHaveBeenCalled();
  });
});
