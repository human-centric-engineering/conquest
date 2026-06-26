/**
 * Unit tests for the Config Advisor snapshot assembler.
 *
 * File under test: app/api/v1/app/questionnaires/_lib/advisor-context.ts
 *
 * Covers:
 *   - graph not found → ok:false 404, no further prisma queries issued
 *   - questionnaire not found → ok:false 404
 *   - happy path: derived counts (questionCount, requiredCount, optionalCount),
 *     type histogram, sectionCount, sessionCount / dataSlotCount passthrough
 *     (using distinct sentinel values to catch field swaps), scoring.present
 *     true/false, demoClientName null fallback, config passthrough by reference
 *   - bounding: samplePrompts capped at 3 per section; data-slot query uses take:12
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoist prisma mock so vi.mock() closures can reference it ─────────────────

const prismaMock = vi.hoisted(() => ({
  appQuestionnaire: { findUnique: vi.fn() },
  appQuestionnaireSession: { count: vi.fn() },
  appDataSlot: { count: vi.fn(), findMany: vi.fn() },
  appScoringSchema: { findUnique: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/detail', () => ({
  getVersionGraph: vi.fn(),
}));

// ─── Deferred imports (after mocks) ──────────────────────────────────────────

import { loadAdvisorContext } from '@/app/api/v1/app/questionnaires/_lib/advisor-context';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import type {
  ConfigView,
  QuestionSlotView,
  SectionView,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A sentinel config object — referenced by identity in the passthrough assertion.
 * The assembler must not copy, transform, or substitute the config from the graph.
 */
const FIXTURE_CONFIG = { saved: true } as unknown as ConfigView;

function makeQuestion(overrides: Partial<QuestionSlotView> = {}): QuestionSlotView {
  return {
    id: 'q-default',
    ordinal: 0,
    key: 'q_default',
    prompt: 'Default prompt',
    guidelines: null,
    rationale: null,
    type: 'free_text',
    typeConfig: null,
    required: false,
    weight: 1,
    extractionConfidence: null,
    tags: [],
    ...overrides,
  };
}

function makeSection(
  id: string,
  title: string,
  questions: Partial<QuestionSlotView>[] = [],
  ordinal = 0
): SectionView {
  return {
    id,
    ordinal,
    title,
    description: null,
    questions: questions.map((q, i) =>
      makeQuestion({ id: `${id}-q${i}`, ordinal: i, key: `q_${i}`, ...q })
    ),
  };
}

function makeGraph(overrides: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
    goal: null,
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [],
    tags: [],
    config: FIXTURE_CONFIG,
    ...overrides,
  };
}

function makeQuestionnaire(
  overrides: {
    title?: string;
    status?: string;
    demoClient?: { name: string } | null;
  } = {}
) {
  return {
    title: 'Test Questionnaire',
    status: 'draft',
    demoClient: null,
    ...overrides,
  };
}

// ─── Non-trivial happy-path graph ─────────────────────────────────────────────
//
//  Two sections with a deliberate mix of required/optional and question types:
//
//  Section A "Background" (2 questions):
//    - Q0  free_text   required   "What is your role?"
//    - Q1  single_choice  optional  "Which team?"
//
//  Section B "Experience" (3 questions):
//    - Q0  likert      required   "Rate your workload"
//    - Q1  free_text   optional   "Other comments?"
//    - Q2  numeric     optional   "Years of experience?"
//
//  Expected derived values after assembly:
//    sectionCount  = 2
//    questionCount = 5
//    requiredCount = 2  (one required per section)
//    optionalCount = 3
//    typeHistogram = { free_text: 2, single_choice: 1, likert: 1, numeric: 1 }

const HAPPY_GRAPH = makeGraph({
  status: 'launched',
  versionNumber: 3,
  sections: [
    makeSection(
      'sec-a',
      'Background',
      [
        { type: 'free_text', required: true, prompt: 'What is your role?' },
        { type: 'single_choice', required: false, prompt: 'Which team?' },
      ],
      0
    ),
    makeSection(
      'sec-b',
      'Experience',
      [
        { type: 'likert', required: true, prompt: 'Rate your workload' },
        { type: 'free_text', required: false, prompt: 'Other comments?' },
        { type: 'numeric', required: false, prompt: 'Years of experience?' },
      ],
      1
    ),
  ],
});

// ─── Default test setup ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersionGraph).mockResolvedValue(HAPPY_GRAPH);
  prismaMock.appQuestionnaire.findUnique.mockResolvedValue(makeQuestionnaire());
  prismaMock.appQuestionnaireSession.count.mockResolvedValue(0);
  prismaMock.appDataSlot.count.mockResolvedValue(0);
  prismaMock.appDataSlot.findMany.mockResolvedValue([]);
  prismaMock.appScoringSchema.findUnique.mockResolvedValue(null);
});

// ═════════════════════════════════════════════════════════════════════════════
// loadAdvisorContext
// ═════════════════════════════════════════════════════════════════════════════

describe('loadAdvisorContext', () => {
  // ─── graph not found ──────────────────────────────────────────────────────

  describe('graph not found', () => {
    beforeEach(() => {
      vi.mocked(getVersionGraph).mockResolvedValue(null);
    });

    it('returns ok:false with a 404 response', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-missing');

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('narrowing');
      expect(result.response.status).toBe(404);
    });

    it('includes NOT_FOUND error code in the 404 body', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-missing');

      if (result.ok) throw new Error('narrowing');
      const body = (await result.response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('does not issue any prisma queries when the graph is absent', async () => {
      await loadAdvisorContext('qn-1', 'ver-missing');

      expect(prismaMock.appQuestionnaire.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.appQuestionnaireSession.count).not.toHaveBeenCalled();
      expect(prismaMock.appDataSlot.count).not.toHaveBeenCalled();
      expect(prismaMock.appDataSlot.findMany).not.toHaveBeenCalled();
      expect(prismaMock.appScoringSchema.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─── questionnaire not found ──────────────────────────────────────────────

  describe('questionnaire not found', () => {
    it('returns ok:false with a 404 response when the questionnaire row is absent', async () => {
      prismaMock.appQuestionnaire.findUnique.mockResolvedValue(null);

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('narrowing');
      expect(result.response.status).toBe(404);
    });

    it('includes NOT_FOUND error code in the body', async () => {
      prismaMock.appQuestionnaire.findUnique.mockResolvedValue(null);

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (result.ok) throw new Error('narrowing');
      const body = (await result.response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  // ─── happy path ───────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns ok:true when both graph and questionnaire exist', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      expect(result.ok).toBe(true);
    });

    it('looks up the version graph with the given questionnaireId and versionId', async () => {
      await loadAdvisorContext('qn-abc', 'ver-xyz');

      expect(getVersionGraph).toHaveBeenCalledWith('qn-abc', 'ver-xyz');
    });

    it('sums questionCount across all sections (2 + 3 = 5)', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.structure.questionCount).toBe(5);
    });

    it('counts only required questions in requiredCount', async () => {
      // HAPPY_GRAPH: sec-a Q0 (required), sec-b Q0 (required) → 2 required
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.structure.requiredCount).toBe(2);
    });

    it('computes optionalCount as questionCount minus requiredCount', async () => {
      // 5 total − 2 required = 3 optional
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      const { questionCount, requiredCount, optionalCount } = result.value.structure;
      expect(optionalCount).toBe(questionCount - requiredCount);
      expect(optionalCount).toBe(3);
    });

    it('builds typeHistogram with a count per question type across all sections', async () => {
      // free_text×2, single_choice×1, likert×1, numeric×1
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.structure.typeHistogram).toEqual({
        free_text: 2,
        single_choice: 1,
        likert: 1,
        numeric: 1,
      });
    });

    it('sets sectionCount to the number of sections in the graph', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.structure.sectionCount).toBe(2);
    });

    it('assigns the prisma session count to version.sessionCount (not the data-slot count)', async () => {
      // Distinct sentinel values so a field swap would fail
      prismaMock.appQuestionnaireSession.count.mockResolvedValue(7);
      prismaMock.appDataSlot.count.mockResolvedValue(99);

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.version.sessionCount).toBe(7);
    });

    it('assigns the prisma data-slot count to dataSlots.count (not the session count)', async () => {
      prismaMock.appQuestionnaireSession.count.mockResolvedValue(7);
      prismaMock.appDataSlot.count.mockResolvedValue(99);

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.dataSlots.count).toBe(99);
    });

    it('scopes both count queries to the given versionId', async () => {
      await loadAdvisorContext('qn-1', 'ver-42');

      expect(prismaMock.appQuestionnaireSession.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { versionId: 'ver-42' } })
      );
      expect(prismaMock.appDataSlot.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { versionId: 'ver-42' } })
      );
    });

    it('sets scoring.present=true when a scoring schema row exists', async () => {
      prismaMock.appScoringSchema.findUnique.mockResolvedValue({ name: 'NPS Score' });

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.scoring.present).toBe(true);
    });

    it('sets scoring.present=false when no scoring schema row exists', async () => {
      // Default beforeEach: appScoringSchema.findUnique returns null
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.scoring.present).toBe(false);
    });

    it('surfaces scoring.name from the schema row when one is present', async () => {
      prismaMock.appScoringSchema.findUnique.mockResolvedValue({ name: 'NPS Score' });

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.scoring.name).toBe('NPS Score');
    });

    it('sets scoring.name=null when no scoring schema row exists', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.scoring.name).toBeNull();
    });

    it('sets questionnaire.demoClientName=null when demoClient is null', async () => {
      prismaMock.appQuestionnaire.findUnique.mockResolvedValue(
        makeQuestionnaire({ demoClient: null })
      );

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.questionnaire.demoClientName).toBeNull();
    });

    it('sets questionnaire.demoClientName from demoClient.name when a demo client is assigned', async () => {
      prismaMock.appQuestionnaire.findUnique.mockResolvedValue(
        makeQuestionnaire({ demoClient: { name: 'Acme Corp' } })
      );

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.questionnaire.demoClientName).toBe('Acme Corp');
    });

    it('passes graph.config through to value.config by reference (no copy or transform)', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.config).toBe(FIXTURE_CONFIG);
    });

    it('reports the questionnaire row status on questionnaire.status, the version status on version.status', async () => {
      // questionnaire row status = 'draft' (makeQuestionnaire); HAPPY_GRAPH.status = 'launched'.
      // The two are distinct facts: questionnaire.status must NOT be overwritten by the version status.
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      expect(result.value.questionnaire.status).toBe('draft');
      expect(result.value.version.status).toBe('launched');
    });

    it('includes per-section title and questionCount in structure.sections', async () => {
      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      const { sections } = result.value.structure;
      expect(sections[0]).toMatchObject({ title: 'Background', questionCount: 2 });
      expect(sections[1]).toMatchObject({ title: 'Experience', questionCount: 3 });
    });
  });

  // ─── bounding — snapshot caps ─────────────────────────────────────────────

  describe('bounding — snapshot caps', () => {
    it('caps samplePrompts at 3 per section when a section has more questions', async () => {
      vi.mocked(getVersionGraph).mockResolvedValue(
        makeGraph({
          sections: [
            makeSection('sec-big', 'Big Section', [
              { prompt: 'Prompt 1', type: 'free_text' },
              { prompt: 'Prompt 2', type: 'free_text' },
              { prompt: 'Prompt 3', type: 'free_text' },
              { prompt: 'Prompt 4', type: 'free_text' },
              { prompt: 'Prompt 5', type: 'free_text' },
            ]),
          ],
        })
      );

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      const { samplePrompts } = result.value.structure.sections[0];
      expect(samplePrompts).toHaveLength(3);
      expect(samplePrompts).toEqual(['Prompt 1', 'Prompt 2', 'Prompt 3']);
    });

    it('still includes all prompts when a section has exactly SAMPLE_PROMPTS_PER_SECTION (3) questions', async () => {
      vi.mocked(getVersionGraph).mockResolvedValue(
        makeGraph({
          sections: [
            makeSection('sec-exact', 'Exact Section', [
              { prompt: 'Alpha', type: 'free_text' },
              { prompt: 'Beta', type: 'free_text' },
              { prompt: 'Gamma', type: 'free_text' },
            ]),
          ],
        })
      );

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      if (!result.ok) throw new Error('narrowing');
      const { samplePrompts } = result.value.structure.sections[0];
      expect(samplePrompts).toHaveLength(3);
      expect(samplePrompts).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('queries data-slot samples with take:12 to bound the snapshot size', async () => {
      await loadAdvisorContext('qn-1', 'ver-1');

      expect(prismaMock.appDataSlot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 12 })
      );
    });

    it('maps each returned data-slot row to a { name, theme } sample (dropping other columns)', async () => {
      // The assembler projects each slot to exactly { name, theme }; rows carry extra columns the
      // snapshot must not leak. Returning real rows exercises the sample mapper, not just the cap.
      prismaMock.appDataSlot.findMany.mockResolvedValue([
        { name: 'budget', theme: 'finance', ordinal: 0 },
        { name: 'timeline', theme: null, ordinal: 1 },
      ]);

      const result = await loadAdvisorContext('qn-1', 'ver-1');

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.dataSlots.samples).toEqual([
        { name: 'budget', theme: 'finance' },
        { name: 'timeline', theme: null },
      ]);
    });
  });
});
