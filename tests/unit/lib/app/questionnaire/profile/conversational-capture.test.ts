/**
 * Unit test: conversational profile capture (F-capture).
 *
 * Covers the interviewer directive builder and the best-effort transcript extraction: it persists
 * ONLY a complete, valid profile (a partial extraction leaves the interviewer gathering the rest), it
 * writes nothing when the respondent hasn't provided anything yet, and it is fully non-fatal (an LLM
 * failure just retries next turn). Prisma, the LLM runner, the validator, and the snapshot writer are
 * all mocked so no real I/O runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTurn: { findMany: vi.fn() },
  appRespondentProfileSnapshot: { count: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));
const validateMock = vi.hoisted(() => ({ validateProfileSubmission: vi.fn() }));
vi.mock('@/lib/app/questionnaire/profile/validate-profile-fields', () => validateMock);
const snapshotMock = vi.hoisted(() => ({ upsertProfileSnapshot: vi.fn() }));
vi.mock('@/lib/app/questionnaire/profile/profile-snapshot', () => snapshotMock);
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: loggerMock }));

import {
  buildProfileCaptureInstructions,
  extractAndPersistConversationalProfile,
  hasProfileSnapshot,
  parseExtraction,
} from '@/lib/app/questionnaire/profile/conversational-capture';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';

const FIELDS: ProfileFieldConfig[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, validation: 'deterministic' },
  { key: 'org', label: 'Organisation', type: 'text', required: false, validation: 'agentic' },
];

function extractionResult(found: Array<{ key: string; value: string }>) {
  return { value: { found }, tokenUsage: { input: 10, output: 5 }, costUsd: 0.001 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-test',
    fallbacks: [],
  });
  vi.mocked(getProvider).mockResolvedValue({} as never);
  prismaMock.appQuestionnaireTurn.findMany.mockResolvedValue([
    { userMessage: 'I am Ada from Acme', agentResponse: 'Lovely — and your name?' },
  ]);
});

describe('buildProfileCaptureInstructions', () => {
  it('lists the fields and marks required vs optional', () => {
    const out = buildProfileCaptureInstructions(FIELDS);
    expect(out).toContain('Name (needed)');
    expect(out).toContain('Organisation (if they offer it)');
  });

  it('returns an empty string when there are no fields', () => {
    expect(buildProfileCaptureInstructions([])).toBe('');
  });
});

describe('extractAndPersistConversationalProfile', () => {
  it('persists a COMPLETE, valid profile (all required present)', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      extractionResult([
        { key: 'name', value: 'Ada' },
        { key: 'org', value: 'Acme' },
      ])
    );
    validateMock.validateProfileSubmission.mockResolvedValue({
      ok: true,
      values: { name: 'Ada', org: 'Acme' },
    });

    await extractAndPersistConversationalProfile({
      sessionId: 's1',
      respondentUserId: 'u1',
      fields: FIELDS,
    });

    expect(snapshotMock.upsertProfileSnapshot).toHaveBeenCalledWith(expect.anything(), 's1', 'u1', {
      name: 'Ada',
      org: 'Acme',
    });
  });

  it('writes NOTHING when the required field is still missing (validation not ok)', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      extractionResult([{ key: 'org', value: 'Acme' }])
    );
    validateMock.validateProfileSubmission.mockResolvedValue({
      ok: false,
      fieldErrors: { name: 'Name is required' },
      message: 'x',
    });

    await extractAndPersistConversationalProfile({
      sessionId: 's1',
      respondentUserId: 'u1',
      fields: FIELDS,
    });
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
  });

  it('writes NOTHING (and never validates) when the respondent has provided nothing yet', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(extractionResult([]));

    await extractAndPersistConversationalProfile({
      sessionId: 's1',
      respondentUserId: 'u1',
      fields: FIELDS,
    });
    expect(validateMock.validateProfileSubmission).not.toHaveBeenCalled();
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
  });

  it('is NON-FATAL: an LLM failure logs and writes nothing (retries next turn)', async () => {
    vi.mocked(runStructuredCompletion).mockRejectedValue(new Error('provider down'));

    await extractAndPersistConversationalProfile({
      sessionId: 's1',
      respondentUserId: 'u1',
      fields: FIELDS,
    });
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('writes NOTHING (and never calls the LLM) when the session has no turns yet', async () => {
    prismaMock.appQuestionnaireTurn.findMany.mockResolvedValue([]);
    await extractAndPersistConversationalProfile({
      sessionId: 's1',
      respondentUserId: 'u1',
      fields: FIELDS,
    });
    expect(runStructuredCompletion).not.toHaveBeenCalled();
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
  });

  it('returns early (no DB read, no LLM) when there are no fields to gather', async () => {
    await extractAndPersistConversationalProfile({
      sessionId: 's1',
      respondentUserId: 'u1',
      fields: [],
    });
    expect(prismaMock.appQuestionnaireTurn.findMany).not.toHaveBeenCalled();
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });
});

describe('hasProfileSnapshot', () => {
  it('is true when a snapshot row exists for the session', async () => {
    prismaMock.appRespondentProfileSnapshot.count.mockResolvedValue(1);
    expect(await hasProfileSnapshot('s1')).toBe(true);
    expect(prismaMock.appRespondentProfileSnapshot.count).toHaveBeenCalledWith({
      where: { sessionId: 's1' },
    });
  });

  it('is false when no snapshot row exists', async () => {
    prismaMock.appRespondentProfileSnapshot.count.mockResolvedValue(0);
    expect(await hasProfileSnapshot('s1')).toBe(false);
  });
});

describe('parseExtraction (LLM response parser)', () => {
  it('parses a clean JSON response', () => {
    expect(parseExtraction('{"found":[{"key":"name","value":"Ada"}]}')).toEqual({
      found: [{ key: 'name', value: 'Ada' }],
    });
  });

  it('strips a ```json code fence before parsing', () => {
    expect(parseExtraction('```json\n{"found":[]}\n```')).toEqual({ found: [] });
  });

  it('returns null on non-JSON and on a shape that fails the schema', () => {
    expect(parseExtraction('nonsense')).toBeNull();
    expect(parseExtraction('{"found":[{"key":"n"}]}')).toBeNull(); // missing value
  });
});
