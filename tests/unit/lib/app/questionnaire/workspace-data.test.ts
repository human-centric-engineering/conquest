/**
 * workspace-data Tests
 *
 * Unit tests for the central server-side data layer used by the questionnaire
 * admin workspace. Covers:
 * - getQuestionnaireDetailCached: success, !res.ok, body.success=false, fetch throws
 * - getVersionGraphCached: success, !res.ok, body.success=false, fetch throws
 * - getVersionDataSlotCountCached: success (counts slots), !res.ok, body.success=false, fetch throws
 * - resolveQuestionnaireWorkspaceFlags: all-on, master-off (sub-flags ANDed to false), mixed
 *
 * @see lib/app/questionnaire/workspace-data.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (hoisted so factories run before module imports) ───────────────────

const { mockServerFetch, mockParseApiResponse } = vi.hoisted(() => ({
  mockServerFetch: vi.fn(),
  mockParseApiResponse: vi.fn(),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: mockServerFetch,
  parseApiResponse: mockParseApiResponse,
}));

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn(),
}));

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: mockLogger,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import type {
  EvaluationFindingView,
  QuestionnaireDetail,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  DEFAULT_COHORT_REPORT_SETTINGS,
  DEFAULT_INTRO_SETTINGS,
  DEFAULT_TONE_SETTINGS,
} from '@/lib/app/questionnaire/types';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots';
import {
  getEvaluationAddQuestionSeed,
  getQuestionnaireDetailCached,
  getVersionGraphCached,
  getVersionDataSlotCountCached,
  getVersionEmbeddingCoverageCached,
  getVersionDataSlotEmbeddingCoverageCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';

// ─── Factories ────────────────────────────────────────────────────────────────

function makeDetail(over: Partial<QuestionnaireDetail> = {}): QuestionnaireDetail {
  return {
    id: 'qn-1',
    title: 'Prospect Discovery',
    status: 'draft',
    demoClient: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versions: [],
    ...over,
  };
}

function makeGraph(over: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand prospects',
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [],
    tags: [],
    config: {
      saved: true,
      selectionStrategy: 'sequential',
      minQuestionsAnswered: 0,
      coverageThreshold: 1,
      answerConfidenceFloor: 0.5,
      costBudgetUsd: null,
      maxQuestionsPerSession: null,
      voiceEnabled: false,
      attachmentsEnabled: false,
      contradictionMode: 'off',
      contradictionWindowN: 0,
      contradictionEveryNTurns: 1,
      answerFitMode: 'fallback',
      extractionPrefilter: false,
      anonymousMode: false,
      accessMode: 'invitation_only',
      inviteeFields: [],
      abuseThreshold: 4,
      maxDataSlotAttempts: 2,
      sensitivityAwareness: false,
      supportMessage: '',
      supportResourceUrl: '',
      profileFields: [],
      answerSlotPanelScope: 'full_progress',
      presentationMode: 'chat',
      inlineCorrectionEnabled: true,
      reasoningStreamEnabled: true,
      reasoningStreamPlacement: 'overlay',
      reasoningStreamDwellMs: 2000,
      reasoningStreamPerItemMs: 330,
      reasoningStreamPersist: true,
      previewInspectorEnabled: false,
      tone: DEFAULT_TONE_SETTINGS,
      respondentReport: DEFAULT_RESPONDENT_REPORT_SETTINGS,
      cohortReport: DEFAULT_COHORT_REPORT_SETTINGS,
      intro: DEFAULT_INTRO_SETTINGS,
    },
    ...over,
  };
}

function makeSlot(i: number): DataSlotView {
  return {
    id: `slot-${i}`,
    key: `slot_${i}`,
    name: `Slot ${i}`,
    description: 'A data slot.',
    theme: 'Goals',
    ordinal: i,
    weight: 1,
    questionKeys: [`q${i}`],
  };
}

/** Build a minimal Response-like object for the serverFetch mock */
function makeOkResponse() {
  return { ok: true };
}

function makeErrorResponse() {
  return { ok: false };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getQuestionnaireDetailCached ─────────────────────────────────────────────

describe('getQuestionnaireDetailCached', () => {
  describe('success path', () => {
    it('returns the parsed QuestionnaireDetail when the fetch succeeds and body.success=true', async () => {
      // Arrange
      const detail = makeDetail({ title: 'My Questionnaire', id: 'qn-abc' });
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: detail });

      // Act
      const result = await getQuestionnaireDetailCached('qn-abc');

      // Assert: result is the data the route layer parsed — not the raw mock shape.
      // The function unwraps body.data and returns it directly.
      expect(result).toMatchObject({ id: 'qn-abc', title: 'My Questionnaire' });
    });

    it('calls serverFetch with the questionnaire byId endpoint path', async () => {
      // Arrange
      const detail = makeDetail({ id: 'qn-xyz' });
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: detail });

      // Act
      await getQuestionnaireDetailCached('qn-xyz');

      // Assert: the correct endpoint was requested — verifies the function wires the id correctly
      expect(mockServerFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/app/questionnaires/qn-xyz')
      );
    });
  });

  describe('!res.ok path', () => {
    it('returns null when serverFetch responds with !ok', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      const result = await getQuestionnaireDetailCached('qn-1');

      // Assert: documented fallback on !ok is null
      expect(result).toBeNull();
    });

    it('does not call parseApiResponse when res.ok is false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      await getQuestionnaireDetailCached('qn-1');

      // Assert: the !res.ok guard short-circuits before parse
      expect(mockParseApiResponse).not.toHaveBeenCalled();
    });
  });

  describe('body.success=false path', () => {
    it('returns null when parseApiResponse returns success=false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: false, error: { code: 'NOT_FOUND' } });

      // Act
      const result = await getQuestionnaireDetailCached('qn-1');

      // Assert: body.success=false → null fallback
      expect(result).toBeNull();
    });
  });

  describe('fetch throws path', () => {
    it('returns null when serverFetch rejects', async () => {
      // Arrange
      mockServerFetch.mockRejectedValueOnce(new Error('Network failure'));

      // Act
      const result = await getQuestionnaireDetailCached('qn-1');

      // Assert: documented fallback on thrown error is null
      expect(result).toBeNull();
    });

    it('logs the error via logger.error when serverFetch throws', async () => {
      // Arrange
      const fetchError = new Error('Network failure');
      mockServerFetch.mockRejectedValueOnce(fetchError);

      // Act
      await getQuestionnaireDetailCached('qn-1');

      // Assert: error is surfaced through structured logging, not swallowed silently
      expect(mockLogger.error).toHaveBeenCalledWith(
        'workspace: questionnaire detail fetch failed',
        fetchError
      );
    });

    it('logs the error via logger.error when parseApiResponse throws', async () => {
      // Arrange
      const parseError = new Error('Malformed JSON');
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockRejectedValueOnce(parseError);

      // Act
      await getQuestionnaireDetailCached('qn-1');

      // Assert: errors from the parse step are also caught and logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'workspace: questionnaire detail fetch failed',
        parseError
      );
    });
  });
});

// ─── getVersionGraphCached ─────────────────────────────────────────────────────

describe('getVersionGraphCached', () => {
  describe('success path', () => {
    it('returns the parsed VersionGraphView when the fetch succeeds and body.success=true', async () => {
      // Arrange
      const graph = makeGraph({ id: 'ver-42', questionnaireId: 'qn-7', versionNumber: 3 });
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: graph });

      // Act
      const result = await getVersionGraphCached('qn-7', 'ver-42');

      // Assert: the graph fields are present — function unwraps body.data
      expect(result).toMatchObject({ id: 'ver-42', questionnaireId: 'qn-7', versionNumber: 3 });
    });

    it('calls serverFetch with the versionGraph endpoint containing both id and versionId', async () => {
      // Arrange
      const graph = makeGraph();
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: graph });

      // Act
      await getVersionGraphCached('qn-abc', 'ver-xyz');

      // Assert: both IDs are threaded into the endpoint path
      expect(mockServerFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/v1\/app\/questionnaires\/qn-abc\/versions\/ver-xyz/)
      );
    });
  });

  describe('!res.ok path', () => {
    it('returns null when serverFetch responds with !ok', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      const result = await getVersionGraphCached('qn-1', 'ver-1');

      // Assert: documented fallback on !ok is null
      expect(result).toBeNull();
    });

    it('does not call parseApiResponse when res.ok is false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      await getVersionGraphCached('qn-1', 'ver-1');

      // Assert: parse never runs on a failed response
      expect(mockParseApiResponse).not.toHaveBeenCalled();
    });
  });

  describe('body.success=false path', () => {
    it('returns null when parseApiResponse returns success=false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: false, error: { code: 'FORBIDDEN' } });

      // Act
      const result = await getVersionGraphCached('qn-1', 'ver-1');

      // Assert: body.success=false → null fallback
      expect(result).toBeNull();
    });
  });

  describe('fetch throws path', () => {
    it('returns null when serverFetch rejects', async () => {
      // Arrange
      mockServerFetch.mockRejectedValueOnce(new Error('Timeout'));

      // Act
      const result = await getVersionGraphCached('qn-1', 'ver-1');

      // Assert: documented fallback is null
      expect(result).toBeNull();
    });

    it('logs the error via logger.error when serverFetch throws', async () => {
      // Arrange
      const fetchError = new Error('Timeout');
      mockServerFetch.mockRejectedValueOnce(fetchError);

      // Act
      await getVersionGraphCached('qn-1', 'ver-1');

      // Assert: error is surfaced through structured logging
      expect(mockLogger.error).toHaveBeenCalledWith(
        'workspace: version graph fetch failed',
        fetchError
      );
    });
  });
});

// ─── getVersionDataSlotCountCached ────────────────────────────────────────────

describe('getVersionDataSlotCountCached', () => {
  describe('success path', () => {
    it('returns the number of slots when the fetch succeeds and body.success=true', async () => {
      // Arrange: three data slots in the response
      const slots = [makeSlot(0), makeSlot(1), makeSlot(2)];
      const okResponse = makeOkResponse();
      mockServerFetch.mockResolvedValueOnce(okResponse);
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: { slots } });

      // Act
      const count = await getVersionDataSlotCountCached('qn-1', 'ver-1');

      // Assert: the function counts slots.length — NOT the raw mock length;
      // this proves the function reads body.data.slots and computes length.
      expect(count).toBe(3);
      // Assert: parseApiResponse receives the actual Response object that serverFetch resolved —
      // confirms the function forwards the real Response, not a copy or wrapper.
      expect(mockParseApiResponse).toHaveBeenCalledWith(okResponse);
    });

    it('returns 0 when the slot list is empty', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: { slots: [] } });

      // Act
      const count = await getVersionDataSlotCountCached('qn-1', 'ver-1');

      // Assert
      expect(count).toBe(0);
    });

    it('calls serverFetch with the versionDataSlots endpoint containing both id and versionId', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: { slots: [] } });

      // Act
      await getVersionDataSlotCountCached('qn-abc', 'ver-xyz');

      // Assert: the correct slot endpoint was targeted with both path parameters
      expect(mockServerFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/api\/v1\/app\/questionnaires\/qn-abc\/versions\/ver-xyz\/data-slots/
        )
      );
    });
  });

  describe('!res.ok path', () => {
    it('returns 0 when serverFetch responds with !ok', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      const count = await getVersionDataSlotCountCached('qn-1', 'ver-1');

      // Assert: documented fallback on !ok is 0
      expect(count).toBe(0);
    });

    it('does not call parseApiResponse when res.ok is false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      await getVersionDataSlotCountCached('qn-1', 'ver-1');

      // Assert: parse never runs on a failed response
      expect(mockParseApiResponse).not.toHaveBeenCalled();
    });
  });

  describe('body.success=false path', () => {
    it('returns 0 when parseApiResponse returns success=false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      });

      // Act
      const count = await getVersionDataSlotCountCached('qn-1', 'ver-1');

      // Assert: body.success=false → 0 fallback
      expect(count).toBe(0);
    });
  });

  describe('fetch throws path', () => {
    it('returns 0 when serverFetch rejects', async () => {
      // Arrange
      mockServerFetch.mockRejectedValueOnce(new Error('Connection refused'));

      // Act
      const count = await getVersionDataSlotCountCached('qn-1', 'ver-1');

      // Assert: documented fallback is 0
      expect(count).toBe(0);
    });

    it('logs the error via logger.error when serverFetch throws', async () => {
      // Arrange
      const fetchError = new Error('Connection refused');
      mockServerFetch.mockRejectedValueOnce(fetchError);

      // Act
      await getVersionDataSlotCountCached('qn-1', 'ver-1');

      // Assert: error is surfaced through structured logging
      expect(mockLogger.error).toHaveBeenCalledWith(
        'workspace: data slot count fetch failed',
        fetchError
      );
    });
  });
});

// ─── getVersionEmbeddingCoverageCached ────────────────────────────────────────

describe('getVersionEmbeddingCoverageCached', () => {
  describe('success path', () => {
    it('returns the coverage object when the fetch succeeds and body.success=true', async () => {
      // Arrange
      const coverage = { total: 10, embedded: 8, missing: 2 };
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: coverage });

      // Act
      const result = await getVersionEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: the function unwraps body.data and returns it — not the mock shape directly.
      // Proves the code reads total/embedded/missing from the parsed body.
      expect(result).toEqual({ total: 10, embedded: 8, missing: 2 });
    });

    it('calls serverFetch with the embed-questions endpoint containing both id and versionId', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({
        success: true,
        data: { total: 0, embedded: 0, missing: 0 },
      });

      // Act
      await getVersionEmbeddingCoverageCached('qn-abc', 'ver-xyz');

      // Assert: the correct endpoint was targeted with both path parameters
      expect(mockServerFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/api\/v1\/app\/questionnaires\/qn-abc\/versions\/ver-xyz\/embed-questions/
        )
      );
    });
  });

  describe('!res.ok path', () => {
    it('returns the zero default object when serverFetch responds with !ok', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      const result = await getVersionEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: documented fallback on !ok is { total: 0, embedded: 0, missing: 0 }
      expect(result).toEqual({ total: 0, embedded: 0, missing: 0 });
    });

    it('does not call parseApiResponse when res.ok is false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      await getVersionEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: parse never runs on a failed response
      expect(mockParseApiResponse).not.toHaveBeenCalled();
    });
  });

  describe('body.success=false path', () => {
    it('returns the zero default object when parseApiResponse returns success=false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      });

      // Act
      const result = await getVersionEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: body.success=false → zero default so transient errors never wrongly block launch
      expect(result).toEqual({ total: 0, embedded: 0, missing: 0 });
    });
  });

  describe('fetch throws path', () => {
    it('returns the zero default object when serverFetch rejects', async () => {
      // Arrange
      mockServerFetch.mockRejectedValueOnce(new Error('Connection refused'));

      // Act
      const result = await getVersionEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: documented fallback is { total: 0, embedded: 0, missing: 0 }
      expect(result).toEqual({ total: 0, embedded: 0, missing: 0 });
    });

    it('logs the error via logger.error with the correct message when serverFetch throws', async () => {
      // Arrange
      const fetchError = new Error('Connection refused');
      mockServerFetch.mockRejectedValueOnce(fetchError);

      // Act
      await getVersionEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: error is surfaced through structured logging with the correct message
      expect(mockLogger.error).toHaveBeenCalledWith(
        'workspace: embedding coverage fetch failed',
        fetchError
      );
    });
  });
});

// ─── getVersionDataSlotEmbeddingCoverageCached ────────────────────────────────

describe('getVersionDataSlotEmbeddingCoverageCached', () => {
  describe('success path', () => {
    it('returns the coverage object when the fetch succeeds and body.success=true', async () => {
      // Arrange
      const coverage = { total: 5, embedded: 3, missing: 2 };
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({ success: true, data: coverage });

      // Act
      const result = await getVersionDataSlotEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: the function unwraps body.data and returns it — not the mock shape directly.
      // Proves the code reads total/embedded/missing from the parsed body.
      expect(result).toEqual({ total: 5, embedded: 3, missing: 2 });
    });

    it('calls serverFetch with the embed-data-slots endpoint containing both id and versionId', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({
        success: true,
        data: { total: 0, embedded: 0, missing: 0 },
      });

      // Act
      await getVersionDataSlotEmbeddingCoverageCached('qn-abc', 'ver-xyz');

      // Assert: the correct data-slot embeddings endpoint was targeted with both path parameters
      expect(mockServerFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/api\/v1\/app\/questionnaires\/qn-abc\/versions\/ver-xyz\/embed-data-slots/
        )
      );
    });
  });

  describe('!res.ok path', () => {
    it('returns the zero default object when serverFetch responds with !ok', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      const result = await getVersionDataSlotEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: documented fallback on !ok is { total: 0, embedded: 0, missing: 0 }
      expect(result).toEqual({ total: 0, embedded: 0, missing: 0 });
    });

    it('does not call parseApiResponse when res.ok is false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeErrorResponse());

      // Act
      await getVersionDataSlotEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: parse never runs on a failed response
      expect(mockParseApiResponse).not.toHaveBeenCalled();
    });
  });

  describe('body.success=false path', () => {
    it('returns the zero default object when parseApiResponse returns success=false', async () => {
      // Arrange
      mockServerFetch.mockResolvedValueOnce(makeOkResponse());
      mockParseApiResponse.mockResolvedValueOnce({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      });

      // Act
      const result = await getVersionDataSlotEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: body.success=false → zero default so transient errors never wrongly block launch
      expect(result).toEqual({ total: 0, embedded: 0, missing: 0 });
    });
  });

  describe('fetch throws path', () => {
    it('returns the zero default object when serverFetch rejects', async () => {
      // Arrange
      mockServerFetch.mockRejectedValueOnce(new Error('Connection refused'));

      // Act
      const result = await getVersionDataSlotEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: documented fallback is { total: 0, embedded: 0, missing: 0 }
      expect(result).toEqual({ total: 0, embedded: 0, missing: 0 });
    });

    it('logs the error via logger.error with the correct message when serverFetch throws', async () => {
      // Arrange
      const fetchError = new Error('Connection refused');
      mockServerFetch.mockRejectedValueOnce(fetchError);

      // Act
      await getVersionDataSlotEmbeddingCoverageCached('qn-1', 'ver-1');

      // Assert: error is surfaced through structured logging with the data-slot-specific message
      expect(mockLogger.error).toHaveBeenCalledWith(
        'workspace: data-slot embedding coverage fetch failed',
        fetchError
      );
    });
  });
});

// ─── getEvaluationAddQuestionSeed ─────────────────────────────────────────────

function makeFinding(over: Partial<EvaluationFindingView> = {}): EvaluationFindingView {
  return {
    id: 'find-1',
    dimension: 'coverage',
    ordinal: 0,
    targetKey: 'section:Background',
    severity: 'minor',
    proposedChange: 'Add a team-size question.',
    rationale: 'The goal segments by org size.',
    sourceQuote: null,
    status: 'pending',
    proposedEdit: {
      op: 'add_question',
      prompt: 'How big is your team?',
      type: 'free_text',
      sectionKey: 'Background',
    },
    editedOverride: null,
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    stale: false,
    applicable: 'deep-link',
    ...over,
  };
}

function runDetailWith(findings: EvaluationFindingView[]) {
  return { id: 'run-1', findings };
}

describe('getEvaluationAddQuestionSeed', () => {
  it('returns the seed for an actionable add_question finding', async () => {
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: runDetailWith([makeFinding()]),
    });

    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');

    expect(seed).toEqual({
      runId: 'run-1',
      findingId: 'find-1',
      prompt: 'How big is your team?',
      type: 'free_text',
      guidelines: null,
      sectionKey: 'Background',
    });
  });

  it('prefers the admin override op over the judge draft', async () => {
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: runDetailWith([
        makeFinding({
          editedOverride: {
            op: 'add_question',
            prompt: 'Edited prompt',
            type: 'single_choice',
            guidelines: 'Pick the closest band.',
          },
        }),
      ]),
    });

    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');

    expect(seed).toMatchObject({
      prompt: 'Edited prompt',
      type: 'single_choice',
      guidelines: 'Pick the closest band.',
      // No sectionKey on the override op → derived from the finding's `section:` targetKey.
      sectionKey: 'Background',
    });
  });

  it('returns null for a malformed ref (no separator)', async () => {
    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'not-a-ref');
    expect(seed).toBeNull();
    expect(mockServerFetch).not.toHaveBeenCalled();
  });

  it('returns null when the finding is already terminal (applied)', async () => {
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: runDetailWith([makeFinding({ status: 'applied' })]),
    });

    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');
    expect(seed).toBeNull();
  });

  it('returns null when the finding is not an add_question', async () => {
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: runDetailWith([
        makeFinding({ proposedEdit: { op: 'replace_prompt', prompt: 'x' }, applicable: 'apply' }),
      ]),
    });

    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');
    expect(seed).toBeNull();
  });

  it('returns null when the run fetch fails', async () => {
    mockServerFetch.mockResolvedValueOnce(makeErrorResponse());
    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');
    expect(seed).toBeNull();
  });

  it('returns null for a ref whose findingId half is empty (trailing separator)', async () => {
    // `run-1:` → runId 'run-1' but empty findingId; the `!findingId` guard short-circuits
    // before any fetch. Distinct from the no-separator case (sep <= 0).
    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:');
    expect(seed).toBeNull();
    expect(mockServerFetch).not.toHaveBeenCalled();
  });

  it('returns null when the run detail body reports success=false', async () => {
    // Distinct from the !res.ok path: the HTTP call succeeds but the envelope is an error.
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({ success: false, error: { code: 'NOT_FOUND' } });

    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');
    expect(seed).toBeNull();
  });

  it('returns null when the finding is already terminal (declined)', async () => {
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: runDetailWith([makeFinding({ status: 'declined' })]),
    });

    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');
    expect(seed).toBeNull();
  });

  it('returns null when no finding in the run matches the ref findingId', async () => {
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: runDetailWith([makeFinding({ id: 'a-different-finding' })]),
    });

    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');
    expect(seed).toBeNull();
  });

  it('sets sectionKey to null when targetKey does not start with "section:" and op has no sectionKey', async () => {
    // Arrange: targetKey is 'question:q1' — not a section key. The op also has no sectionKey.
    // The source falls through the `op.sectionKey ??` path, then checks targetKey.startsWith('section:'),
    // which is false, so the ternary returns null.
    mockServerFetch.mockResolvedValueOnce(makeOkResponse());
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: runDetailWith([
        makeFinding({
          targetKey: 'question:q1',
          proposedEdit: {
            op: 'add_question',
            prompt: 'What is your budget?',
            type: 'free_text',
            // no sectionKey on the op
          },
        }),
      ]),
    });

    // Act
    const seed = await getEvaluationAddQuestionSeed('qn-1', 'ver-1', 'run-1:find-1');

    // Assert: sectionKey must be null because the targetKey is not a 'section:' prefix key
    // and the op does not supply one. Verifies the ternary logic in the source.
    expect(seed).not.toBeNull();
    expect(seed!.sectionKey).toBeNull();
    expect(seed!.prompt).toBe('What is your budget?');
  });
});

// ─── resolveQuestionnaireWorkspaceFlags ───────────────────────────────────────

describe('resolveQuestionnaireWorkspaceFlags', () => {
  /**
   * Flag resolution order mirrors the Promise.all in the source:
   *   [master, dataSlots, designEval, liveSessions, adaptive, adaptiveDataSlots]
   *
   * Sub-flags are ANDed with master locally (after the parallel lookups),
   * so even when a sub-flag's own DB row is `true`, it resolves to `false`
   * when the master is `false`. `adaptiveDataSlots` is additionally ANDed with
   * dataSlots + liveSessions (it only runs in live data-slot mode).
   */

  describe('all flags on', () => {
    it('returns all flags true when master and all sub-flags are enabled', async () => {
      // Arrange: every flag enabled in the DB
      mockIsFeatureEnabled.mockResolvedValue(true);

      // Act
      const flags = await resolveQuestionnaireWorkspaceFlags();

      // Assert: the shape is complete and every field is true
      expect(flags).toMatchObject({
        master: true,
        dataSlots: true,
        designEval: true,
        liveSessions: true,
        adaptive: true,
        adaptiveDataSlots: true,
        respondentReport: true,
        introScreen: true,
      });
    });

    it('resolves each flag constant by its exact env-var name', async () => {
      // Arrange
      mockIsFeatureEnabled.mockResolvedValue(true);

      // Act
      await resolveQuestionnaireWorkspaceFlags();

      // Assert: each flag constant is looked up by its exact string name — verifies the
      // Promise.all wires the right constant for each field, not just "some 8 calls".
      // Uses toHaveBeenCalledWith rather than a bare count so a renamed constant fails loudly.
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_ENABLED');
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED');
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
        'APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED'
      );
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED');
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
        'APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED'
      );
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
        'APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_ENABLED'
      );
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
        'APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED'
      );
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_INTRO_SCREEN_ENABLED');
      // Cohort report (incl. the Scoring tab) requires cohorts + its own sub-flag.
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_COHORTS_ENABLED');
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED');
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_ADVISOR_ENABLED');
      // Also verify exactly 11 calls — prevents accidental re-resolution of the master flag
      expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(11);
    });
  });

  describe('master flag off — AND semantics enforced', () => {
    it('returns all sub-flags false when master is off, even when sub-flag DB rows are true', async () => {
      // Arrange: master=false, every sub-flag DB row=true (this is the critical AND test)
      mockIsFeatureEnabled.mockImplementation(async (flagName: string) => {
        if (
          flagName === 'APP_QUESTIONNAIRES_ENABLED' ||
          flagName === 'APP_QUESTIONNAIRES_MASTER' // defensive: catch any synonym
        ) {
          return false;
        }
        return true; // all sub-flags are "on" in the DB
      });

      // Act
      const flags = await resolveQuestionnaireWorkspaceFlags();

      // Assert: master is correctly false, AND sub-flags must be false even though
      // their own DB rows returned true — verifies the local AND operation
      expect(flags.master).toBe(false);
      expect(flags.dataSlots).toBe(false);
      expect(flags.designEval).toBe(false);
      expect(flags.liveSessions).toBe(false);
      expect(flags.adaptive).toBe(false);
    });
  });

  describe('master on, mixed sub-flags', () => {
    it('reflects individual sub-flag values when master is on', async () => {
      // Arrange: master=true, dataSlots=true, designEval=false, liveSessions=true, adaptive=false
      const flagValues: Record<string, boolean> = {
        APP_QUESTIONNAIRES_ENABLED: true,
        APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED: true,
        APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED: false,
        APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED: true,
        APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED: false,
      };
      mockIsFeatureEnabled.mockImplementation(async (flagName: string) => {
        return flagValues[flagName] ?? false;
      });

      // Act
      const flags = await resolveQuestionnaireWorkspaceFlags();

      // Assert: master=true so each sub-flag mirrors its own DB value
      expect(flags.master).toBe(true);
      expect(flags.dataSlots).toBe(true); // DB=true AND master=true → true
      expect(flags.designEval).toBe(false); // DB=false AND master=true → false
      expect(flags.liveSessions).toBe(true); // DB=true AND master=true → true
      expect(flags.adaptive).toBe(false); // DB=false AND master=true → false
    });

    it('returns a QuestionnaireWorkspaceFlags-shaped object with the expected keys', async () => {
      // Arrange
      mockIsFeatureEnabled.mockResolvedValue(false);

      // Act
      const flags = await resolveQuestionnaireWorkspaceFlags();

      // Assert: the returned object has the exact keys the interface defines
      expect(Object.keys(flags).sort()).toEqual(
        [
          'adaptive',
          'adaptiveDataSlots',
          'advisor',
          'cohortReport',
          'dataSlots',
          'designEval',
          'introScreen',
          'liveSessions',
          'master',
          'respondentReport',
        ].sort()
      );
    });
  });

  describe('master on, all sub-flags off', () => {
    it('returns master=true and all sub-flags false when sub-flag DB rows are false', async () => {
      // Arrange
      const flagValues: Record<string, boolean> = {
        APP_QUESTIONNAIRES_ENABLED: true,
        APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED: false,
        APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED: false,
        APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED: false,
        APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED: false,
      };
      mockIsFeatureEnabled.mockImplementation(async (flagName: string) => {
        return flagValues[flagName] ?? false;
      });

      // Act
      const flags = await resolveQuestionnaireWorkspaceFlags();

      // Assert
      expect(flags.master).toBe(true);
      expect(flags.dataSlots).toBe(false);
      expect(flags.designEval).toBe(false);
      expect(flags.liveSessions).toBe(false);
      expect(flags.adaptive).toBe(false);
    });
  });
});
