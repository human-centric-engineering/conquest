/**
 * Unit test: conversational profile capture (F-capture).
 *
 * Covers the interviewer directive builder and the best-effort transcript extraction: it persists the
 * captured subset PARTIALLY (a field the respondent has answered lands even while others are still
 * outstanding — hybrid-friendly, "persist partial, don't block"), it writes nothing when the respondent
 * hasn't provided anything yet, and it is fully non-fatal (an LLM failure just retries next turn). It
 * also covers `readProfileSnapshotValues`, the read the interviewer uses to decide whether the
 * conversational subset still needs gathering. Prisma, the LLM runner, the validator, and the snapshot
 * writer are all mocked so no real I/O runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTurn: { findMany: vi.fn() },
  appRespondentProfileSnapshot: { findUnique: vi.fn() },
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
  readProfileSnapshotValues,
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
  it('persists all captured, valid values', async () => {
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

  it('persists PARTIALLY — validates only the captured subset, so a required field still missing does not block the ones in hand', async () => {
    // The respondent has given only the (optional) org so far; the required name is still outstanding.
    // Partial persist writes org now (merged by the snapshot writer) rather than withholding everything
    // until the whole profile is complete.
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      extractionResult([{ key: 'org', value: 'Acme' }])
    );
    validateMock.validateProfileSubmission.mockResolvedValue({ ok: true, values: { org: 'Acme' } });

    await extractAndPersistConversationalProfile({
      sessionId: 's1',
      respondentUserId: 'u1',
      fields: FIELDS,
    });

    // Only the captured field is handed to the validator — the missing required one must NOT force a
    // rejection of the value we do have.
    expect(validateMock.validateProfileSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ fields: [FIELDS[1]], raw: { org: 'Acme' } })
    );
    expect(snapshotMock.upsertProfileSnapshot).toHaveBeenCalledWith(expect.anything(), 's1', 'u1', {
      org: 'Acme',
    });
  });

  it('writes NOTHING when validation rejects the captured value (retries next turn)', async () => {
    vi.mocked(runStructuredCompletion).mockResolvedValue(
      extractionResult([{ key: 'org', value: 'asdf' }])
    );
    validateMock.validateProfileSubmission.mockResolvedValue({
      ok: false,
      fieldErrors: { org: 'That does not look like a real organisation' },
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

describe('readProfileSnapshotValues', () => {
  it('returns the stored values when a snapshot exists', async () => {
    prismaMock.appRespondentProfileSnapshot.findUnique.mockResolvedValue({
      values: { name: 'Ada', org: 'Acme' },
    });
    expect(await readProfileSnapshotValues('s1')).toEqual({ name: 'Ada', org: 'Acme' });
    expect(prismaMock.appRespondentProfileSnapshot.findUnique).toHaveBeenCalledWith({
      where: { sessionId: 's1' },
      select: { values: true },
    });
  });

  it('returns an empty object when no snapshot row exists', async () => {
    prismaMock.appRespondentProfileSnapshot.findUnique.mockResolvedValue(null);
    expect(await readProfileSnapshotValues('s1')).toEqual({});
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
