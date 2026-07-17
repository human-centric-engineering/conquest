/**
 * The streaming-ingest orchestrator's fail-soft verify/repair branches.
 *
 * `mergeRepairs` (the pure merge guard) is covered in `merge-repairs.test.ts` — this file
 * covers `orchestrateExtraction` itself: the async generator that drives extract → verify →
 * repair → coherence. Every added stage is documented as FAIL-SOFT (a missing/failing
 * verifier or repair agent, or a malformed dispatch payload, must never abort the whole
 * ingest) — these tests are the regression net for that contract.
 *
 * @see app/api/v1/app/questionnaires/_lib/orchestrate-extraction.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

// Only extractFromDocument is mocked here; assertPersistable/IncoherentExtractionError
// (imported by orchestrate-extraction.ts from `_lib/persist`, NOT from this module) stay
// real, so the post-repair coherence branch is genuinely exercised, not stubbed away.
vi.mock('@/app/api/v1/app/questionnaires/_lib/extract-pipeline', () => ({
  extractFromDocument: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { orchestrateExtraction } from '@/app/api/v1/app/questionnaires/_lib/orchestrate-extraction';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { extractFromDocument } from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import type {
  GuardedUpload,
  ExtractedDocument,
  PipelineResult,
} from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import {
  QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
  QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
  VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG,
  REPAIR_QUESTIONS_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { ExtractedQuestion } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import type { VerifyResult } from '@/lib/app/questionnaire/ingestion/verify-schema';
import type { RepairResult } from '@/lib/app/questionnaire/ingestion/repair-schema';
import type { ExtractionPhaseEvent } from '@/lib/app/questionnaire/ingestion/extraction-stream-events';

type Mock = ReturnType<typeof vi.fn>;

/** Narrowly-typed mock casts so `.mockImplementation` sees a real Promise-returning
 *  signature (not the bare `Mock`'s `(...args: any[]) => any`), which keeps
 *  `no-misused-promises` happy about the async implementations below. */
type FindUniqueMock = Mock & {
  mockImplementation: (
    fn: (args: {
      where: { slug: string };
    }) => Promise<typeof VERIFIER_AGENT | typeof REPAIR_AGENT | null>
  ) => FindUniqueMock;
};
type DispatchMock = Mock & {
  mockImplementation: (fn: (slug: string) => Promise<unknown>) => DispatchMock;
};
type ExtractMock = Mock & {
  mockImplementation: (
    fn: (
      upload: GuardedUpload,
      ctx: {
        adminId: string;
        log: never;
        onExtractionProgress?: (questionsSoFar: number) => void;
      }
    ) => Promise<PipelineResult<ExtractedDocument>>
  ) => ExtractMock;
};

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const goodLikert = { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' };

function q(key: string, type: string, config: unknown, ordinal = 0): ExtractedQuestion {
  return {
    sectionOrdinal: ordinal,
    key,
    prompt: `Prompt for ${key}`,
    suggestedType: type as ExtractedQuestion['suggestedType'],
    suggestedTypeConfig: config as Record<string, unknown>,
    extractionConfidence: 0.6,
  };
}

/** A coherent extraction: one question, one declared section it maps to. */
const COHERENT_EXTRACTION: ExtractQuestionnaireStructureData = {
  sections: [{ ordinal: 0, title: 'About You' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'name',
      prompt: 'What is your name?',
      suggestedType: 'free_text',
      extractionConfidence: 0.9,
    },
  ],
  changes: [],
};

const PARSED_DOC = {
  title: 'Onboarding',
  fullText: '# Form\n1. Name',
} as unknown as ExtractedDocument['parsed'];

const UPLOAD = { file: { name: 'form.md' } } as unknown as GuardedUpload;

const VERIFIER_AGENT = { id: 'verifier-1', provider: '', model: '', fallbackProviders: [] };
const REPAIR_AGENT = { id: 'repair-1', provider: '', model: '', fallbackProviders: [] };

/** Build a fresh ctx (adminId + a log whose spies stay reachable for assertions). */
function makeCtx(adminId = 'admin-1') {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { ctx: { adminId, log: log as never }, log };
}

/** Seed (or not) the verifier / repair `AiAgent` rows the orchestrator loads by slug. */
function seedAgents(opts: { verifier?: boolean; repair?: boolean } = {}) {
  const { verifier = true, repair = true } = opts;
  (prisma.aiAgent.findUnique as FindUniqueMock).mockImplementation(async ({ where }) => {
    if (where.slug === QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG) {
      return verifier ? VERIFIER_AGENT : null;
    }
    if (where.slug === QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG) {
      return repair ? REPAIR_AGENT : null;
    }
    return null;
  });
}

/** Route `capabilityDispatcher.dispatch` responses by capability slug. */
function mockDispatch(byCapability: Record<string, unknown>) {
  (capabilityDispatcher.dispatch as DispatchMock).mockImplementation(async (slug) => {
    if (slug in byCapability) return byCapability[slug];
    throw new Error(`unmocked dispatch for capability "${slug}"`);
  });
}

/** Drive the generator to completion, collecting phase events + the final PipelineResult. */
async function drain(
  upload: GuardedUpload,
  ctx: { adminId: string; log: never }
): Promise<{ phases: ExtractionPhaseEvent[]; result: PipelineResult<ExtractedDocument> }> {
  const gen = orchestrateExtraction(upload, ctx);
  const phases: ExtractionPhaseEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    phases.push(step.value);
    step = await gen.next();
  }
  return { phases, result: step.value };
}

beforeEach(() => {
  vi.clearAllMocks();
  (extractFromDocument as Mock).mockResolvedValue({
    ok: true,
    value: { extraction: structuredClone(COHERENT_EXTRACTION), parsed: PARSED_DOC },
  });
});

// ─── Live extraction progress bridge ────────────────────────────────────────

describe('orchestrateExtraction — live extraction progress', () => {
  it('re-yields the extractor question counts as extracting-progress phase events', async () => {
    // No verifier/repair agent is seeded, so verify is fail-soft — the only phases that
    // carry progress are the extractor's own extracting-progress events, which we assert on.
    (extractFromDocument as ExtractMock).mockImplementation(async (_upload, ctx) => {
      // The real extractor fires these from inside the streamed capability call.
      ctx.onExtractionProgress?.(1);
      ctx.onExtractionProgress?.(2);
      ctx.onExtractionProgress?.(5);
      return {
        ok: true,
        value: { extraction: structuredClone(COHERENT_EXTRACTION), parsed: PARSED_DOC },
      };
    });
    const { ctx } = makeCtx();

    const { phases, result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    const progressCounts = phases
      .filter((p) => p.phase === 'extracting' && p.progress)
      .map((p) => p.progress?.done);
    // At least one progress event; counts strictly increase and reach the latest.
    expect(progressCounts.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < progressCounts.length; i += 1) {
      expect(progressCounts[i]!).toBeGreaterThan(progressCounts[i - 1]!);
    }
    expect(progressCounts.at(-1)).toBe(5);
    // The client renders `message` verbatim, so the count must be stated in prose.
    const latest = phases.find((p) => p.progress?.done === 5);
    expect(latest?.message).toMatch(/5 questions so far/);
  });

  it('completes cleanly when the extractor reports no counts (blocking fallback)', async () => {
    // The default beforeEach mock resolves without calling onExtractionProgress.
    const { ctx } = makeCtx();

    const { phases, result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    // No progress events fabricated, and only the single opener "extracting" phase is emitted
    // (the extractor never streamed a count — later verify phases are a separate phase kind).
    expect(phases.filter((p) => p.progress).length).toBe(0);
    expect(phases.filter((p) => p.phase === 'extracting')).toHaveLength(1);
  });
});

// ─── Verify: fail-soft paths ─────────────────────────────────────────────────

describe('orchestrateExtraction — verify fail-soft', () => {
  it('falls back to the raw extraction when the verifier agent is not seeded', async () => {
    seedAgents({ verifier: false });
    const { ctx, log } = makeCtx();

    const { phases, result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.extraction).toEqual(COHERENT_EXTRACTION);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'ingest verifier agent not seeded; skipping verification',
      expect.objectContaining({ slug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG })
    );
    const cleanPhase = phases.find(
      (p) => p.phase === 'verifying' && 'message' in p && p.message.includes('faithful')
    );
    expect(cleanPhase).toBeDefined();
  });

  it('falls back to the raw extraction when the verifier dispatch returns a malformed result', async () => {
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: { result: { garbage: true } },
      },
    });
    const { ctx, log } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.extraction).toEqual(COHERENT_EXTRACTION);
    // Only the verify dispatch ran — the malformed payload never reaches repair.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'ingest verification returned an unparseable result; persisting raw extraction',
      expect.objectContaining({ issues: expect.any(Array) })
    );
  });

  it('falls back to the raw extraction when the verifier dispatch fails', async () => {
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: false,
        error: { code: 'rate_limited', message: 'Verifier is rate limited' },
      },
    });
    const { ctx, log } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.extraction).toEqual(COHERENT_EXTRACTION);
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'ingest verification failed; persisting raw extraction',
      expect.objectContaining({ code: 'rate_limited' })
    );
  });
});

// ─── Verify + repair: the happy repair path ──────────────────────────────────

describe('orchestrateExtraction — repair applied', () => {
  it('merges a valid repair into the returned extraction when one question is flagged', async () => {
    seedAgents();
    const verifyResult: VerifyResult = {
      verdicts: [{ key: 'name', verdict: 'suspect', issue: 'type_mismatch', detail: 'is a scale' }],
      matrixGroups: [],
    };
    const repairResult: RepairResult = {
      repairs: [
        { originalKeys: ['name'], action: 'correct', questions: [q('name', 'likert', goodLikert)] },
      ],
    };
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: { result: verifyResult },
      },
      [REPAIR_QUESTIONS_CAPABILITY_SLUG]: { success: true, data: { result: repairResult } },
    });
    const { ctx } = makeCtx();

    const { phases, result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Proof the repair was actually merged in — not just that dispatch was called.
      expect(result.value.extraction.questions[0].suggestedType).toBe('likert');
      expect(result.value.extraction.changes).toHaveLength(1);
    }
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      REPAIR_QUESTIONS_CAPABILITY_SLUG,
      expect.objectContaining({ targets: [expect.objectContaining({ key: 'name' })] }),
      expect.objectContaining({ userId: 'admin-1', agentId: 'repair-1' })
    );
    expect(phases.some((p) => p.phase === 'repairing')).toBe(true);
  });
});

// ─── Repair ceiling ───────────────────────────────────────────────────────────

describe('orchestrateExtraction — repair ceiling', () => {
  it('skips repair and logs a warning when more than the ceiling is flagged', async () => {
    seedAgents();
    const manySuspects: VerifyResult['verdicts'] = Array.from({ length: 21 }, (_, i) => ({
      key: `q${i}`,
      verdict: 'suspect' as const,
    }));
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: { result: { verdicts: manySuspects, matrixGroups: [] } },
      },
    });
    const { ctx, log } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    // Only the verify dispatch ran — repair was never attempted.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'ingest verify flagged too many questions; skipping repair',
      expect.objectContaining({ flagged: 21, total: 1 })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.extraction).toEqual(COHERENT_EXTRACTION);
  });
});

// ─── Post-repair coherence gate ───────────────────────────────────────────────

describe('orchestrateExtraction — coherence after the (fail-soft) verify/repair pass', () => {
  it('returns an EXTRACTION_INCOHERENT 422 when the extraction has an orphaned section', async () => {
    // extractFromDocument's OWN internal coherence check is mocked out here, so we can hand
    // back an already-incoherent extraction to exercise the orchestrator's post-repair
    // `assertPersistable` gate directly. (mergeRepairs always preserves the original
    // question's sectionOrdinal for both `correct` and `merge` repairs, so a repair can
    // never introduce a NEW orphan on its own — this proves the shared gate still catches
    // one, whichever pass produced it.) Verify is fail-soft (agent unseeded) so no
    // verify/repair dispatch noise interferes with the assertion.
    const incoherent: ExtractQuestionnaireStructureData = {
      sections: [{ ordinal: 0, title: 'Section' }],
      questions: [
        {
          sectionOrdinal: 9,
          key: 'orphan',
          prompt: 'Orphan question?',
          suggestedType: 'free_text',
          extractionConfidence: 0.5,
        },
      ],
      changes: [],
    };
    (extractFromDocument as Mock).mockResolvedValue({
      ok: true,
      value: { extraction: incoherent, parsed: PARSED_DOC },
    });
    seedAgents({ verifier: false });
    const { ctx, log } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(422);
      const body = await result.response.json();
      expect(body.error.code).toBe('EXTRACTION_INCOHERENT');
      expect(body.error.details).toEqual({ orphanSectionOrdinals: [9] });
    }
    expect(log.warn).toHaveBeenCalledWith(
      'ingest extraction incoherent after repair',
      expect.objectContaining({ orphanSectionOrdinals: [9] })
    );
  });
});
