/**
 * Unit tests: experience-wide synthesis (P15.8).
 *
 * Three things carry real weight here and get the most coverage.
 *
 * 1. **Citations are verified, not trusted.** A hallucinated step key is worse than no citation: it
 *    sends a reader to check a source that never said it, and makes an unsupported claim look
 *    sourced.
 * 2. **The module must never re-aggregate sessions.** `buildCohortDataset` silently drops fills
 *    from other versions, and an experience spans versions by definition — so a cross-step dataset
 *    would produce a confident report over a fraction of the data with no error. There is a static
 *    import guard for that below, because it is the failure mode nothing else would catch.
 * 3. **A degenerate response must not be stored as `ready`.** The schema puts no floor on
 *    `narrative`, so a shape-valid-but-empty response used to sail through and leave an admin
 *    staring at a paid-for, content-free card. And the cost of every call — including that one —
 *    must land in `AiCostLog`, or the synthesiser agent's budget ceiling can never fire.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  SYNTHESIS_MAX_FINDINGS,
  isUsableSynthesisContent,
  validateExperienceSynthesisContent,
} from '@/lib/app/questionnaire/experiences/synthesis/types';
import { EXPERIENCE_SYNTHESIS_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';
import { logger } from '@/lib/logging';

const prismaMock = vi.hoisted(() => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
}));
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

const costMock = vi.hoisted(() => ({ logAppLlmCost: vi.fn() }));
vi.mock('@/lib/app/questionnaire/llm/log-app-cost', () => ({
  logAppLlmCost: costMock.logAppLlmCost,
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  generateExperienceSynthesis,
  verifyStepKeys,
} from '@/lib/app/questionnaire/experiences/synthesis/generate';
import type { SynthesisMaterial } from '@/lib/app/questionnaire/experiences/synthesis/material';

describe('verifyStepKeys', () => {
  const contributed = new Set(['intake', 'finance', 'housing']);

  it('keeps keys that name a step which actually contributed', () => {
    expect(verifyStepKeys(['intake', 'housing'], contributed)).toEqual(['intake', 'housing']);
  });

  it('drops a key no contributing step owns', () => {
    // The model inventing a plausible-sounding step is the exact failure this guards.
    expect(verifyStepKeys(['intake', 'wellbeing'], contributed)).toEqual(['intake']);
  });

  it('matches case-insensitively and trims, returning the canonical key', () => {
    // A citation lost to a capitalisation difference is a real citation thrown away.
    expect(verifyStepKeys(['  Intake ', 'FINANCE'], contributed)).toEqual(['intake', 'finance']);
  });

  it('de-duplicates repeated citations', () => {
    expect(verifyStepKeys(['intake', 'intake', 'Intake'], contributed)).toEqual(['intake']);
  });

  it('returns empty when nothing contributed, rather than trusting the model', () => {
    expect(verifyStepKeys(['intake'], new Set())).toEqual([]);
  });

  it('survives an empty citation list', () => {
    expect(verifyStepKeys([], contributed)).toEqual([]);
  });
});

describe('validateExperienceSynthesisContent', () => {
  it('returns a complete shape from a totally malformed blob', () => {
    const content = validateExperienceSynthesisContent('not an object');
    expect(content).toEqual({
      narrative: '',
      findings: [],
      divergences: [],
      coverage: [],
      caveats: [],
    });
  });

  it('drops a claim with no statement rather than rendering an empty bullet', () => {
    const content = validateExperienceSynthesisContent({
      findings: [{ statement: '', sourceStepKeys: [] }, { statement: 'Real one' }],
    });
    expect(content.findings).toHaveLength(1);
    expect(content.findings[0].statement).toBe('Real one');
  });

  it('caps the finding count', () => {
    const content = validateExperienceSynthesisContent({
      findings: Array.from({ length: 50 }, (_, i) => ({ statement: `F${i}` })),
    });
    expect(content.findings).toHaveLength(SYNTHESIS_MAX_FINDINGS);
  });

  it('normalises a missing detail to null', () => {
    const content = validateExperienceSynthesisContent({
      findings: [{ statement: 'A', detail: '   ' }],
    });
    expect(content.findings[0].detail).toBeNull();
  });

  it('falls back an unrecognised coverage reason instead of dropping the entry', () => {
    const content = validateExperienceSynthesisContent({
      coverage: [{ stepKey: 'a', stepTitle: 'A', included: false, reason: 'who_knows' }],
    });
    expect(content.coverage).toHaveLength(1);
    expect(content.coverage[0].reason).toBe('no_report');
  });

  it('treats a non-boolean `included` as not included', () => {
    // Coverage overstating itself is the one direction that misleads a reader about trust.
    const content = validateExperienceSynthesisContent({
      coverage: [{ stepKey: 'a', stepTitle: 'A', included: 'yes', reason: 'included' }],
    });
    expect(content.coverage[0].included).toBe(false);
  });

  it('defaults a missing coverage title to the key', () => {
    const content = validateExperienceSynthesisContent({
      coverage: [{ stepKey: 'a', included: true, reason: 'included' }],
    });
    expect(content.coverage[0].stepTitle).toBe('a');
  });
});

describe('isUsableSynthesisContent', () => {
  it('accepts a narrative with no findings — agreement is a legitimate result', () => {
    const content = validateExperienceSynthesisContent({ narrative: 'Everything agreed.' });
    expect(isUsableSynthesisContent(content)).toBe(true);
  });

  it('accepts findings with no narrative', () => {
    const content = validateExperienceSynthesisContent({ findings: [{ statement: 'A' }] });
    expect(isUsableSynthesisContent(content)).toBe(true);
  });

  it('rejects a wholly empty synthesis', () => {
    expect(isUsableSynthesisContent(validateExperienceSynthesisContent({}))).toBe(false);
  });
});

describe('the re-aggregation guard', () => {
  const rawSource = readFileSync(
    join(process.cwd(), 'lib/app/questionnaire/experiences/synthesis/material.ts'),
    'utf8'
  );

  /**
   * Comments are stripped before asserting.
   *
   * The module's docstring deliberately NAMES the trap it avoids — that explanation is the most
   * useful thing in the file for whoever edits it next. A guard that matched prose would either
   * fail on that documentation or push someone to delete it, which is exactly backwards: the
   * comment is the reason the next person will not reintroduce the bug.
   */
  const materialSource = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never imports the cohort dataset builder', () => {
    // `buildCohortDataset` resolves by a single versionId and joins fills by dataSlotId (the row id,
    // not the key), so fills from another version find no bucket and vanish. An experience spans
    // versions, so importing this would produce a confident report over partial data — silently.
    expect(materialSource).not.toContain('buildCohortDataset');
    expect(materialSource).not.toContain('cohort-report/dataset');
  });

  it('never reads answer slots or sessions directly', () => {
    expect(materialSource).not.toContain('appAnswerSlot');
    expect(materialSource).not.toContain('appDataSlotFill');
    expect(materialSource).not.toContain('appQuestionnaireSession');
  });

  it('reads finished reports and gated insights instead', () => {
    expect(materialSource).toContain('appCohortReport');
    expect(materialSource).toContain('appExperienceInsight');
    // The k-anonymity gate must be re-applied on read, not trusted from write time.
    expect(materialSource).toContain('applySupportGate');
  });
});

/**
 * `generateExperienceSynthesis` — the two bugs fixed alongside this suite.
 *
 * 1. The `parse` callback only ran `synthesisSchema.safeParse`, and the schema puts no floor on
 *    `narrative` or the arrays. `{"narrative":"","findings":[],"divergences":[]}` parsed cleanly and
 *    was stored `ready` — an admin paid for the call and got an empty card with no error. `parse`
 *    now also requires `isUsableSynthesisContent`, probed through `validateExperienceSynthesisContent`
 *    so a whitespace-only narrative is judged on its trimmed value.
 * 2. Nothing logged the spend. `logAppLlmCost` is now called after every completion, because without
 *    it the call is invisible to cost reporting AND the synthesiser agent's seeded
 *    `monthlyBudgetUsd` ceiling — enforced by aggregating `AiCostLog` on `agentId` — can never fire.
 */
describe('generateExperienceSynthesis', () => {
  function material(over: Partial<SynthesisMaterial> = {}): SynthesisMaterial {
    return {
      experienceTitle: 'Q3 Intake Journey',
      experienceKind: 'agentic_switcher',
      blocks: [
        {
          stepKey: 'intake',
          stepTitle: 'Intake',
          stepKind: 'entry',
          body: 'People arrived stressed.',
        },
      ],
      coverage: [],
      routing: [],
      concludedRuns: 4,
      ...over,
    };
  }

  /** A shape-valid, usable completion — enough for the outer call to resolve without throwing. */
  function respondWith(value: {
    narrative: string;
    findings?: unknown[];
    divergences?: unknown[];
    caveats?: string[];
  }) {
    llmMock.runStructuredCompletion.mockResolvedValue({
      value: { findings: [], divergences: [], caveats: [], ...value },
      tokenUsage: { input: 120, output: 80 },
      costUsd: 0.03,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.prisma.aiAgent.findUnique.mockResolvedValue({
      id: 'agent_synth_1',
      slug: 'experience-synthesiser',
      provider: 'openai',
      model: 'gpt-5.4',
      fallbackProviders: [],
    });
    llmMock.resolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-5.4',
    });
    llmMock.getProvider.mockResolvedValue({});
  });

  /**
   * Captures the real `parse` callback `generateExperienceSynthesis` hands to
   * `runStructuredCompletion`, so these tests exercise the shipped guard rather than a
   * reimplementation of it. The outer call is given a usable placeholder response so it resolves
   * without throwing — the placeholder is irrelevant to what's under test, which is the captured
   * function itself.
   */
  async function capturedParse() {
    respondWith({ narrative: 'placeholder so the outer call resolves cleanly' });
    await generateExperienceSynthesis(material());
    return llmMock.runStructuredCompletion.mock.calls[0][0].parse;
  }

  /** The system prompt string actually handed to `runStructuredCompletion` on the last call. */
  function capturedSystemPrompt(): string {
    return llmMock.runStructuredCompletion.mock.calls[0][0].messages[0].content;
  }

  /** A `facilitated_meeting` material — the fork `generateExperienceSynthesis` takes on kind. */
  function meetingMaterial(over: Partial<SynthesisMaterial> = {}): SynthesisMaterial {
    return material({
      experienceKind: 'facilitated_meeting',
      blocks: [
        {
          stepKey: 'room-a',
          stepTitle: 'Room A',
          stepKind: 'breakout',
          body: 'They wanted more time.',
        },
      ],
      ...over,
    });
  }

  describe('the degenerate-response guard', () => {
    it('rejects a wholly empty response — no narrative, no findings, no divergences', async () => {
      // This is the exact shape that used to slip through: shape-valid per the schema (nothing
      // requires a non-empty narrative), but there is nothing here worth showing an admin.
      const parse = await capturedParse();

      const result = parse(JSON.stringify({ narrative: '', findings: [], divergences: [] }));

      expect(result).toBeNull();
    });

    it('rejects a whitespace-only narrative with no findings', async () => {
      // `z.string()` happily accepts '   ' — it's why the guard probes through the validator
      // (which trims) rather than checking `narrative !== ''` on the raw parsed value.
      const parse = await capturedParse();

      const result = parse(JSON.stringify({ narrative: '   ', findings: [], divergences: [] }));

      expect(result).toBeNull();
    });

    it('CRITICAL: accepts a narrative with no findings — every step agreeing is a real result', async () => {
      // The fix must not over-correct. A journey where every step agreed has nothing to put in
      // `findings` or `divergences`, and that is the synthesis working correctly, not failing.
      const parse = await capturedParse();

      const result = parse(
        JSON.stringify({
          narrative: 'Every step told the same story — no disagreement anywhere in the journey.',
          findings: [],
          divergences: [],
        })
      );

      expect(result).not.toBeNull();
      expect(result.narrative).toContain('Every step told the same story');
    });

    it('accepts findings with an empty narrative', async () => {
      const parse = await capturedParse();

      const result = parse(
        JSON.stringify({
          narrative: '',
          findings: [
            { statement: 'Costs rose sharply after step two.', sourceStepKeys: ['intake'] },
          ],
          divergences: [],
        })
      );

      expect(result).not.toBeNull();
      expect(result.findings).toHaveLength(1);
    });
  });

  describe('cost attribution', () => {
    it('logs the resolved agent, provider, model, token usage, capability, and a null versionId', async () => {
      respondWith({ narrative: 'A clean synthesis with real content.' });

      await generateExperienceSynthesis(material());

      expect(costMock.logAppLlmCost).toHaveBeenCalledTimes(1);
      expect(costMock.logAppLlmCost).toHaveBeenCalledWith({
        agentId: 'agent_synth_1',
        provider: 'openai',
        model: 'gpt-5.4',
        tokenUsage: { input: 120, output: 80 },
        capability: 'app_experience_synthesis',
        versionId: null,
      });
    });
  });

  /**
   * Three ways `generateExperienceSynthesis` can fail before it ever calls the model. Each throws a
   * specific, distinct message because the caller (the row processor) surfaces it verbatim to
   * whoever is waiting on the synthesis — a generic "failed" would leave an admin no wiser.
   */
  describe('input validation and resolution failures', () => {
    it('throws before touching the database when there are no finished-report blocks', async () => {
      await expect(generateExperienceSynthesis(material({ blocks: [] }))).rejects.toThrow(
        'Nothing to synthesise — no step has a finished report yet'
      );
      // The check is purely local (an array length), so it must short-circuit before the agent
      // lookup — a caller retrying against still-empty material should not pay for a DB round trip.
      expect(prismaMock.prisma.aiAgent.findUnique).not.toHaveBeenCalled();
    });

    it('throws when the synthesiser agent is not configured', async () => {
      prismaMock.prisma.aiAgent.findUnique.mockResolvedValue(null);

      await expect(generateExperienceSynthesis(material())).rejects.toThrow(
        `Agent ${EXPERIENCE_SYNTHESIS_AGENT_SLUG} is not configured`
      );
    });

    it('throws when no provider can be resolved for the agent', async () => {
      llmMock.resolveAgentProviderAndModel.mockResolvedValue(null);

      await expect(generateExperienceSynthesis(material())).rejects.toThrow(
        'No provider resolved for the experience synthesiser'
      );
    });
  });

  describe('onFinalFailure', () => {
    it('throws the documented error when the response is still unusable after the retry', async () => {
      // `runStructuredCompletion` is mocked wholesale here, so it never runs its own retry loop.
      // This captures the REAL `onFinalFailure` callback that `generateExperienceSynthesis` builds
      // and invokes it exactly as the retry-exhausted path would — proving the message a caller
      // actually sees, rather than re-implementing it independently in the test.
      llmMock.runStructuredCompletion.mockImplementation(
        async (opts: { onFinalFailure: () => Error }) => {
          throw opts.onFinalFailure();
        }
      );

      await expect(generateExperienceSynthesis(material())).rejects.toThrow(
        'Synthesis response was not valid or carried no content after one retry'
      );
    });
  });

  /**
   * Citations are the reader's route back to a source report, so a hallucinated one is worse than
   * none — it sends someone to check evidence that never said what the claim says it did. These
   * tests assert the actual verified output (not the raw model claim) and that a drop is logged
   * with a real count, never silently absorbed.
   */
  describe('citation verification and dropped-citation logging', () => {
    it('strips a step key no contributing step owns and warns with the dropped count', async () => {
      llmMock.runStructuredCompletion.mockResolvedValue({
        value: {
          narrative: 'A journey with one real citation and two hallucinated ones.',
          findings: [{ statement: 'Costs rose.', sourceStepKeys: ['intake', 'ghost-step'] }],
          divergences: [{ statement: 'One room disagreed.', sourceStepKeys: ['another-ghost'] }],
          caveats: [],
        },
        tokenUsage: { input: 100, output: 50 },
        costUsd: 0.02,
      });

      const result = await generateExperienceSynthesis(material());

      // The real citation survives; both hallucinated ones are gone from what gets stored.
      expect(result.content.findings[0].sourceStepKeys).toEqual(['intake']);
      expect(result.content.divergences[0].sourceStepKeys).toEqual([]);

      expect(logger.warn).toHaveBeenCalledWith(
        'experience synthesis: model cited step keys that did not contribute',
        { dropped: 2, contributed: ['intake'] }
      );
    });

    it('does not warn when every citation names a step that actually contributed', async () => {
      respondWith({
        narrative: 'Clean citations only.',
        findings: [{ statement: 'Costs rose.', sourceStepKeys: ['intake'] }],
      });

      await generateExperienceSynthesis(material());

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  /**
   * `caveats` is the one array on the reply the model is free to omit entirely (it's `.optional()`
   * on the schema), so `parsed.caveats ?? []` has two genuinely different branches: an explicit
   * (possibly non-empty) array, and the key missing altogether.
   */
  describe('caveats', () => {
    it('carries the model-provided caveats through into the stored content', async () => {
      respondWith({
        narrative: 'A synthesis with something worth flagging.',
        caveats: ['Coverage is thin — only one of four steps reported.'],
      });

      const result = await generateExperienceSynthesis(material());

      expect(result.content.caveats).toEqual([
        'Coverage is thin — only one of four steps reported.',
      ]);
    });

    it('defaults to an empty array when the model omits the caveats field entirely', async () => {
      // Distinct from an explicit `caveats: []`, which every other fixture in this suite already
      // exercises — this hits the nullish (right-hand) side of `parsed.caveats ?? []`.
      llmMock.runStructuredCompletion.mockResolvedValue({
        value: { narrative: 'No caveats field at all.', findings: [], divergences: [] },
        tokenUsage: { input: 90, output: 40 },
        costUsd: 0.01,
      });

      const result = await generateExperienceSynthesis(material());

      expect(result.content.caveats).toEqual([]);
    });
  });

  /**
   * `renderRouting` only runs when `material.routing.length > 0` — every fixture above uses the
   * default empty routing, so the section (and its percentage math) has never actually executed.
   */
  describe('routing distribution', () => {
    it('omits the routing section entirely when there is no routing data', async () => {
      respondWith({ narrative: 'No routing here.' });

      await generateExperienceSynthesis(material());

      expect(capturedSystemPrompt()).not.toContain('<routing_distribution>');
    });

    it('renders the routing section with a percentage when concludedRuns > 0', async () => {
      respondWith({ narrative: 'Routing present.' });

      await generateExperienceSynthesis(
        material({
          routing: [{ stepKey: 'intake', stepTitle: 'Intake', runs: 3 }],
          concludedRuns: 4,
        })
      );

      const system = capturedSystemPrompt();
      expect(system).toContain('<routing_distribution>');
      expect(system).toContain('• "intake" — Intake: 3 of 4 completed runs (75%)');
    });

    it('renders a bare count with no percentage when concludedRuns is 0', async () => {
      // Guards the ternary inside `renderRouting`: with zero concluded runs there is nothing to
      // divide by, and the reader must see a plain count rather than a NaN% or Infinity%.
      respondWith({ narrative: 'Routing with no concluded runs.' });

      await generateExperienceSynthesis(
        material({
          routing: [{ stepKey: 'finance', stepTitle: 'Finance', runs: 2 }],
          concludedRuns: 0,
        })
      );

      const system = capturedSystemPrompt();
      expect(system).toContain('• "finance" — Finance: 2 of 0 completed runs');
      expect(system).not.toContain('completed runs (');
    });
  });

  /**
   * The prompt forks on `material.experienceKind === 'facilitated_meeting'`: different role framing,
   * different section id for the per-unit material, and a different word threaded through the rules
   * (`breakout` vs `step`). Both sides are asserted so a future edit to one cannot silently leave the
   * other stale.
   */
  describe('the meeting vs switcher fork', () => {
    it('writes the facilitator-facing role, section id, and unit word for a facilitated_meeting', async () => {
      respondWith({ narrative: 'Meeting summary.' });

      await generateExperienceSynthesis(meetingMaterial());

      const system = capturedSystemPrompt();
      expect(system).toContain('across-the-whole-meeting view for a facilitator');
      expect(system).toContain('<what_each_breakout_found>');
      expect(system).not.toContain('<what_each_step_reported>');
      expect(system).toContain('needed more than one breakout to see');
      // The block itself renders with its real key, title, and kind.
      expect(system).toContain('## Step "room-a" — Room A (breakout)');
    });

    it('writes the admin-facing role, section id, and unit word for an agentic_switcher', async () => {
      respondWith({ narrative: 'Switcher summary.' });

      await generateExperienceSynthesis(material());

      const system = capturedSystemPrompt();
      expect(system).toContain('across-the-whole-journey view for an administrator');
      expect(system).toContain('<what_each_step_reported>');
      expect(system).not.toContain('<what_each_breakout_found>');
      expect(system).toContain('needed more than one step to see');
      expect(system).toContain('## Step "intake" — Intake (entry)');
    });
  });
});
