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

/**
 * The source `COHERENT_EXTRACTION` was extracted from — and it really does contain that question,
 * wrapped across two lines the way a document is. `unattributedPromptCount` compares every prompt
 * to this text, so a placeholder body would make the shared baseline a permanently unfaithful
 * ingest and leave the counter with nothing to be zero against.
 */
const PARSED_DOC = {
  title: 'Onboarding',
  fullText: '# Form\n\n## About You\n\n1. What is your\n   name?\n',
} as unknown as ExtractedDocument['parsed'];

const UPLOAD = { file: { name: 'form.md' } } as unknown as GuardedUpload;

// Real-looking bindings: the fidelity record (F14.15) stores the resolved provider/model, so
// empty strings here would let an attribution regression pass unnoticed.
const VERIFIER_AGENT = {
  id: 'verifier-1',
  provider: 'openai',
  model: 'gpt-5.4',
  fallbackProviders: [],
};
const REPAIR_AGENT = {
  id: 'repair-1',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  fallbackProviders: [],
};

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
/**
 * Mock the dispatcher per capability slug.
 *
 * A successful dispatch is topped up with the resolved binding the real capabilities return
 * beside their result, so a test does not have to restate it to get realistic provenance. Pass an
 * explicit `provider`/`model` (including an empty one) to override — the fidelity record's
 * fallback behaviour is exercised that way.
 */
function mockDispatch(byCapability: Record<string, unknown>) {
  (capabilityDispatcher.dispatch as DispatchMock).mockImplementation(async (slug) => {
    if (!(slug in byCapability)) throw new Error(`unmocked dispatch for capability "${slug}"`);
    const mocked = byCapability[slug];
    if (
      typeof mocked === 'object' &&
      mocked !== null &&
      (mocked as { success?: unknown }).success === true
    ) {
      const { data, ...rest } = mocked as { success: true; data?: Record<string, unknown> };
      return { ...rest, data: { provider: 'openai', model: 'gpt-5.4', ...data } };
    }
    return mocked;
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
      // ...and that the change row is the SHAPE the revert path reads. Both halves were wrong
      // until corpus doc 08 caught them: without `key` the row names no question and the earlier
      // `infer_type` row stays un-superseded, and under the old `suggestedType` spelling
      // `planInferType` took its "no prior type recorded" branch and reverted to `free_text`,
      // discarding the type sitting in the row. Asserting only the length lets both regress green.
      expect(result.value.extraction.changes[0]).toMatchObject({
        changeType: 'infer_type',
        beforeJson: { key: 'name', type: 'free_text' },
        afterJson: { key: 'name', type: 'likert' },
      });
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

// ─── Non-questions dropped ────────────────────────────────────────────────────

/**
 * Four questions and the document they came from, one of which is a line of interviewer script.
 *
 * Four is the smallest size that lets the drop actually happen: the ceiling is
 * `max(3, floor(4 * 0.25))` = 3, and the never-empty guard needs at least one question left over.
 * `dropNonQuestions` is unit-tested directly in `drop-non-questions.test.ts`. What these tests
 * cover is the WIRING, which that file structurally cannot reach: that the orchestrator splits the
 * verdicts by issue, reassigns the pruned extraction, keeps the dropped key away from the repair
 * specialist, and carries the keys onto the fidelity record.
 */
const BOT_SCRIPT_PROMPT = "That's useful. Based on what you've said I want to go deeper.";

function withScript(): ExtractQuestionnaireStructureData {
  return {
    sections: [{ ordinal: 0, title: 'About You' }],
    questions: [
      {
        sectionOrdinal: 0,
        key: 'name',
        prompt: 'What is your name?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
      {
        sectionOrdinal: 0,
        key: 'role',
        prompt: 'What is your role?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
      {
        sectionOrdinal: 0,
        key: 'tenure',
        prompt: 'How long have you been in it?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
      {
        sectionOrdinal: 0,
        key: 'bot_script',
        prompt: BOT_SCRIPT_PROMPT,
        suggestedType: 'free_text',
        extractionConfidence: 0.4,
      },
    ],
    changes: [],
  };
}

/** The source all four prompts really appear in, so no prompt reads as an unattributed edit. */
const SCRIPT_DOC = {
  title: 'Onboarding',
  fullText: `# Form\n\n## About You\n\n1. What is your name?\n2. What is your role?\n3. How long have you been in it?\n\n${BOT_SCRIPT_PROMPT}\n`,
} as unknown as ExtractedDocument['parsed'];

function notAQuestion(key: string, detail?: string) {
  return {
    key,
    verdict: 'suspect' as const,
    issue: 'not_a_question' as const,
    ...(detail ? { detail } : {}),
  };
}

describe('orchestrateExtraction — non-questions dropped', () => {
  beforeEach(() => {
    (extractFromDocument as Mock).mockResolvedValue({
      ok: true,
      value: { extraction: withScript(), parsed: SCRIPT_DOC },
    });
  });

  it('removes the flagged line, records it revertibly, and never sends it to repair', async () => {
    seedAgents();
    const verifyResult: VerifyResult = {
      verdicts: [
        { key: 'name', verdict: 'ok' },
        { key: 'role', verdict: 'ok' },
        { key: 'tenure', verdict: 'ok' },
        notAQuestion('bot_script', 'Interviewer script, not a question.'),
      ],
      matrixGroups: [],
    };
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: { result: verifyResult },
      },
    });
    const { ctx } = makeCtx();

    const { phases, result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The drop reached the RETURNED extraction. Forgetting `extraction = pruned.extraction`
      // leaves the pure function correct and the questionnaire unchanged.
      expect(result.value.extraction.questions.map((q) => q.key)).toEqual([
        'name',
        'role',
        'tenure',
      ]);
      // ...and it is recoverable. `prompt` is the field `toNewQuestion` refuses to restore without.
      expect(result.value.extraction.changes).toHaveLength(1);
      expect(result.value.extraction.changes[0]).toMatchObject({
        changeType: 'prune_question',
        targetEntityType: 'question',
        beforeJson: { key: 'bot_script', prompt: BOT_SCRIPT_PROMPT, sectionOrdinal: 0 },
        afterJson: null,
      });
      // The keys reach the provenance row, which is the only thing that tells an admin by name
      // what is missing from the editor.
      expect(result.value.fidelity?.droppedNonQuestionKeys).toEqual(['bot_script']);
      // Every suspect verdict still counts as flagged. The band subtracts the drops itself.
      expect(result.value.fidelity?.flaggedCount).toBe(1);
      // `totalCount` is what the critic was given; `retainedCount` is what the version holds.
      // Collapsing them back into one number is what made the coverage line quote a count the
      // Structure editor does not show.
      expect(result.value.fidelity?.totalCount).toBe(4);
      expect(result.value.fidelity?.retainedCount).toBe(3);
    }
    // Verify dispatched, repair NOT. No answer type rescues a line of narration, so a repair call
    // here spends a model round-trip to get the same unanswerable question back.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalledWith(
      REPAIR_QUESTIONS_CAPABILITY_SLUG,
      expect.anything(),
      expect.anything()
    );
    expect(
      phases.some((p) => p.phase === 'verifying' && p.message?.includes('Removed 1 line'))
    ).toBe(true);
  });

  it('does not also claim the questionnaire was faithful when every flag was a removal', async () => {
    // "All questions look faithful — no repairs needed" would read as "and everything else was
    // fine", which the critic never said. It said only that the rest needed no re-typing.
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: {
            verdicts: [notAQuestion('bot_script')],
            matrixGroups: [],
          } satisfies VerifyResult,
        },
      },
    });
    const { ctx } = makeCtx();

    const { phases, result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.droppedNonQuestionKeys).toEqual(['bot_script']);
    expect(phases.some((p) => p.message?.includes('Removed 1 line'))).toBe(true);
    expect(phases.some((p) => p.message?.includes('look faithful'))).toBe(false);
  });

  it('still repairs the mis-typed questions alongside a dropped one', async () => {
    // The split has to cut both ways: a `not_a_question` in the same batch must not cost the
    // other flags their re-read, and the dropped key must not appear in the repair targets.
    seedAgents();
    const repairResult: RepairResult = {
      repairs: [
        { originalKeys: ['name'], action: 'correct', questions: [q('name', 'likert', goodLikert)] },
      ],
    };
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: {
            verdicts: [
              { key: 'name', verdict: 'suspect', issue: 'type_mismatch', detail: 'is a scale' },
              notAQuestion('bot_script'),
            ],
            matrixGroups: [],
          } satisfies VerifyResult,
        },
      },
      [REPAIR_QUESTIONS_CAPABILITY_SLUG]: { success: true, data: { result: repairResult } },
    });
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      REPAIR_QUESTIONS_CAPABILITY_SLUG,
      expect.objectContaining({ targets: [expect.objectContaining({ key: 'name' })] }),
      expect.objectContaining({ agentId: 'repair-1' })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extraction.questions.map((q) => q.key)).toEqual([
        'name',
        'role',
        'tenure',
      ]);
      expect(result.value.extraction.questions[0].suggestedType).toBe('likert');
      expect(result.value.fidelity?.droppedNonQuestionKeys).toEqual(['bot_script']);
      expect(result.value.fidelity?.repairOutcome).toBe('repaired');
      // Counted after BOTH stages. A `merge` repair collapses several questions into one, so
      // deriving this by subtracting the drops from `totalCount` would overcount on any run that
      // merged, and overcount silently.
      expect(result.value.fidelity?.retainedCount).toBe(3);
    }
  });
});

// ─── Fidelity record (F14.15) ─────────────────────────────────────────────────

describe('orchestrateExtraction — fidelity record repairOutcome', () => {
  it('records none_flagged with the resolved verifier binding when the critic is clean', async () => {
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: { result: { verdicts: [{ key: 'name', verdict: 'ok' }], matrixGroups: [] } },
      },
    });
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fidelity).toMatchObject({
        repairOutcome: 'none_flagged',
        flaggedCount: 0,
        provider: 'openai',
      });
    }
  });

  it('records repaired only when the repair pass actually returned repairs', async () => {
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: {
            verdicts: [{ key: 'name', verdict: 'suspect', issue: 'type_mismatch' }],
            matrixGroups: [],
          },
        },
      },
      [REPAIR_QUESTIONS_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: {
            repairs: [
              {
                originalKeys: ['name'],
                action: 'correct',
                questions: [q('name', 'likert', goodLikert)],
              },
            ],
          },
        },
      },
    });
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.repairOutcome).toBe('repaired');
  });

  it('records repair_failed — not repaired — when the repair dispatch fails', async () => {
    // `runRepair` is fail-soft: a failed dispatch returns zero repairs and the flagged questions
    // persist untouched. Filing that as 'repaired' would reproduce the exact blind spot this
    // record exists to close — a suspect question indistinguishable from a confirmed one.
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: {
            verdicts: [{ key: 'name', verdict: 'suspect', issue: 'type_mismatch' }],
            matrixGroups: [],
          },
        },
      },
      [REPAIR_QUESTIONS_CAPABILITY_SLUG]: { success: false, error: { code: 'PROVIDER_DOWN' } },
    });
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fidelity?.repairOutcome).toBe('repair_failed');
      // The flag itself is still recorded, so the unrepaired question stays traceable.
      expect(result.value.fidelity?.flaggedCount).toBe(1);
    }
  });

  it('records verifier_unavailable with an n/a binding when the verifier agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as FindUniqueMock).mockImplementation(async () => null);
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fidelity).toMatchObject({
        repairOutcome: 'verifier_unavailable',
        provider: 'n/a',
        model: 'n/a',
      });
    }
  });

  it('falls back to the n/a sentinel when the capability reports an EMPTY binding', async () => {
    // The `??` bug this pins. The fidelity record used `verification.provider ?? 'n/a'`, and a
    // verifier that resolves its model at call time reports an empty string — which is not
    // nullish — so the fallback never fired and the `extraction_verify` row stored ''. Empty and
    // nullish must both mean "unresolved", or the provenance column is neither a model nor a
    // legible sentinel.
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: { verdicts: [{ key: 'name', verdict: 'ok' }], matrixGroups: [] },
          provider: '',
          model: '',
        },
      },
    });
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fidelity).toMatchObject({ provider: 'n/a', model: 'n/a' });
    }
  });

  it('records the model the verifier actually resolved, not the agent row value', async () => {
    // The verifier agent ships with an empty configured model and binds to the reasoning tier at
    // call time, so the binding has to come off the dispatch.
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: { verdicts: [{ key: 'name', verdict: 'ok' }], matrixGroups: [] },
          provider: 'openai',
          model: 'gpt-5.4-turbo',
        },
      },
    });
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fidelity).toMatchObject({ provider: 'openai', model: 'gpt-5.4-turbo' });
    }
  });

  it('records skipped_systemic when the flag count exceeds the repair ceiling', async () => {
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: {
          result: {
            verdicts: Array.from({ length: 21 }, (_, i) => ({
              key: `q${i}`,
              verdict: 'suspect' as const,
            })),
            matrixGroups: [],
          },
        },
      },
    });
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.repairOutcome).toBe('skipped_systemic');
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

// ─── Unattributed prompt edits ────────────────────────────────────────────────

/**
 * The counter that notices wording the author never wrote and the extractor never admitted to.
 *
 * Corpus doc 03 is why it exists: three ingests of one file reworded 8, 12 and 10 of its 23
 * questions, and 1, 1 and 2 of those edits arrived with no change record at all — invisible on the
 * review surface, un-revertable, and marked `ok` by the per-question fidelity critic every time
 * (correctly: a reworded question still asks the same thing). Only the source can catch this.
 */
describe('orchestrateExtraction — unattributed prompt edits', () => {
  /** Hand back an extraction whose single question carries `prompt`, plus optional changes. */
  function extractionWithPrompt(
    prompt: string,
    changes: ExtractQuestionnaireStructureData['changes'] = []
  ): void {
    (extractFromDocument as Mock).mockResolvedValue({
      ok: true,
      value: {
        extraction: {
          sections: [{ ordinal: 0, title: 'About You' }],
          questions: [
            {
              sectionOrdinal: 0,
              key: 'name',
              prompt,
              suggestedType: 'free_text',
              extractionConfidence: 0.9,
            },
          ],
          changes,
        },
        parsed: PARSED_DOC,
      },
    });
  }

  /** A clean verifier pass, so nothing but the counter is under test. */
  function cleanCritic(): void {
    seedAgents();
    mockDispatch({
      [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG]: {
        success: true,
        data: { result: { verdicts: [{ key: 'name', verdict: 'ok' }], matrixGroups: [] } },
      },
    });
  }

  it('names nothing when the prompt is a span of the source, despite the source hard-wrapping it', async () => {
    // PARSED_DOC breaks "What is your name?" across a line and an indent. A raw substring test
    // fails here, which would report every long verbatim question as an edit.
    cleanCritic();
    const { ctx, log } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.unattributedPromptKeys).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('names the question whose reworded prompt no change record claims, and warns', async () => {
    cleanCritic();
    extractionWithPrompt('Please tell me what your name is.');
    const { ctx, log } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.unattributedPromptKeys).toEqual(['name']);
    expect(log.warn).toHaveBeenCalledWith(
      'ingest reworded question prompts without recording the edit',
      expect.objectContaining({
        unattributedPromptCount: 1,
        // The keys are the actionable half: a count tells an admin to go looking, this says where.
        unattributedPromptKeys: ['name'],
        totalQuestions: 1,
      })
    );
  });

  it('names nothing when the same rewording IS declared in the editorial log', async () => {
    cleanCritic();
    extractionWithPrompt('Please tell me what your name is.', [
      {
        changeType: 'rewrite_prompt',
        targetEntityType: 'question',
        beforeJson: { prompt: 'What is your name?' },
        afterJson: { prompt: 'Please tell me what your name is.' },
        rationale: 'Rephrased for conversational delivery.',
      },
    ]);
    const { ctx, log } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.unattributedPromptKeys).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads the declared prompt off any change type, not a hard-coded list', async () => {
    // `correct_spelling` also lands a new prompt. Keying on the shape rather than the change type
    // is what keeps a change type added later from reading as an undeclared edit.
    cleanCritic();
    extractionWithPrompt('What is your naem?', [
      {
        changeType: 'correct_spelling',
        targetEntityType: 'question',
        beforeJson: { prompt: 'What is your name?' },
        afterJson: { prompt: 'What is your naem?' },
      },
    ]);
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.unattributedPromptKeys).toEqual([]);
  });

  it('does not let a record for a DIFFERENT wording attribute this one', async () => {
    // The log is matched against the prompt that was actually persisted. A record whose `after`
    // says something else describes an edit that did not survive, and must not launder this one.
    cleanCritic();
    extractionWithPrompt('Please tell me what your name is.', [
      {
        changeType: 'rewrite_prompt',
        targetEntityType: 'question',
        beforeJson: { prompt: 'What is your name?' },
        afterJson: { prompt: 'And your name is?' },
      },
    ]);
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.unattributedPromptKeys).toEqual(['name']);
  });

  it('is not fooled by a change record that carries no prompt at all', async () => {
    // `infer_type` records a type decision and nothing about wording — the shape the repair
    // specialist's `correct` record also has. It must not attribute a prompt it never mentions.
    cleanCritic();
    extractionWithPrompt('Please tell me what your name is.', [
      {
        changeType: 'infer_type',
        targetEntityType: 'question',
        afterJson: { key: 'name', suggestedType: 'free_text' },
      },
    ]);
    const { ctx } = makeCtx();

    const { result } = await drain(UPLOAD, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fidelity?.unattributedPromptKeys).toEqual(['name']);
  });
});
