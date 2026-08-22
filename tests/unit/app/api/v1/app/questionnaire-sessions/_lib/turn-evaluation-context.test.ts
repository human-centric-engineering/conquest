/**
 * Unit test: the turn-evaluator's questionnaire context.
 *
 * This is the seam that decides what the judge knows about the interviewer it is scoring. Before
 * the interviewer-policy features landed it knew four things (goal, audience, selection strategy,
 * tone); a `must_ask` question — required to be put verbatim with its options recited — therefore
 * read to the rubric as a closed, leading question and was marked down for doing exactly as it was
 * told. These tests pin the two properties that fix stays correct on:
 *
 *   1. a configured block is described, in neutral third-person prose, and
 *   2. an unconfigured one is described as unconfigured ("House rules: None") rather than omitted
 *      — a judge that is simply not told about a policy cannot tell "none is in force" from "you
 *      weren't told", and speculates. This is the one place the interviewer's own off-is-silent
 *      rule is deliberately NOT copied.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-context.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionSlot: { findFirst: vi.fn(), findUnique: vi.fn() },
  aiAgent: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  buildObjectivesContext,
  describeTurnFidelity,
  summariseAudience,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-context';
import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  QUESTION_FIDELITY_STOP_BY_LEVEL,
  type QuestionnaireConfigShape,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';

type Mock = ReturnType<typeof vi.fn>;

/**
 * A config row as `CONFIG_SELECT` returns it. `toConfigView` narrows the Json columns, so passing
 * the real default objects through exercises the same narrowing the live read path does.
 */
function configRow(overrides: Partial<QuestionnaireConfigShape> = {}) {
  return { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...overrides } as unknown as Parameters<
    typeof buildObjectivesContext
  >[0]['config'];
}

function version(overrides: Partial<QuestionnaireConfigShape> = {}) {
  return { goal: 'Understand housing security', audience: null, config: configRow(overrides) };
}

const configView = (overrides: Partial<QuestionnaireConfigShape> = {}): ConfigView => ({
  ...DEFAULT_QUESTIONNAIRE_CONFIG,
  ...overrides,
  saved: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildObjectivesContext — an unconfigured questionnaire', () => {
  it('states the negative for each policy block rather than omitting it', () => {
    const ctx = buildObjectivesContext(version());
    expect(ctx.houseRules).toMatch(/none/i);
    expect(ctx.adaptiveScope).toMatch(/disabled/i);
    expect(ctx.questionFidelity).toMatch(/off/i);
  });

  it('describes the funnel arc, which is on by default for every questionnaire', () => {
    // `DEFAULT_INTERVIEWER_STRATEGY.enabled` is true, so this is not an opt-in the judge can
    // ignore — every session runs an arc, and a turn's openness is a function of where in it
    // the turn fell.
    const ctx = buildObjectivesContext(version());
    expect(ctx.interviewerStrategy).toMatch(/funnel/i);
  });

  it('omits tone entirely when no dial and no persona is set', () => {
    // The one descriptor that genuinely emits nothing — and the pre-existing behaviour, since the
    // old summariser returned undefined without a persona.
    expect(buildObjectivesContext(version()).tone).toBeUndefined();
  });

  it('still carries the objectives it always carried', () => {
    const ctx = buildObjectivesContext(version());
    expect(ctx.goal).toBe('Understand housing security');
    expect(ctx.selectionStrategy).toBe(DEFAULT_QUESTIONNAIRE_CONFIG.selectionStrategy);
  });

  it('falls back to the documented defaults when the version has no config row', () => {
    // A version with no saved config still runs sessions — it runs them on the defaults, so the
    // context must describe those rather than describing nothing.
    const ctx = buildObjectivesContext({ goal: 'A goal', audience: null, config: null });
    expect(ctx.goal).toBe('A goal');
    expect(ctx.selectionStrategy).toBe(DEFAULT_QUESTIONNAIRE_CONFIG.selectionStrategy);
    expect(ctx.houseRules).toMatch(/none/i);
  });
});

describe('buildObjectivesContext — describing a configured policy', () => {
  it('summarises house rules by kind rather than reprinting the client’s text', () => {
    const ctx = buildObjectivesContext(
      version({
        houseRules: {
          enabled: true,
          rules: [
            { id: 'r1', kind: 'always', enabled: true, text: 'Always confirm the timeframe.' },
            { id: 'r2', kind: 'never', enabled: true, text: 'Never use humour.' },
            { id: 'r3', kind: 'never', enabled: false, text: 'Parked draft.' },
          ],
        },
      })
    );
    expect(ctx.houseRules).toBeDefined();
    // Counted by kind — the judge needs to know a policy is in force, not to read twenty rules.
    expect(ctx.houseRules).toMatch(/always/i);
    expect(ctx.houseRules).toMatch(/never/i);
    // A disabled rule is a draft and must not be counted as in force.
    expect(ctx.houseRules).not.toMatch(/Parked draft/);
  });

  it('describes the questioning approach and, for a funnel, its pace', () => {
    const ctx = buildObjectivesContext(
      version({
        interviewerStrategy: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
          enabled: true,
          approach: 'funnel',
          pace: 'brisk',
        },
      })
    );
    expect(ctx.interviewerStrategy).toMatch(/funnel/i);
    expect(ctx.interviewerStrategy).toMatch(/pace/i);
  });

  it('describes adaptive scope when the interview is narrowed', () => {
    const ctx = buildObjectivesContext(
      version({
        adaptiveScope: { ...DEFAULT_QUESTIONNAIRE_CONFIG.adaptiveScope, enabled: true },
      })
    );
    expect(ctx.adaptiveScope).toMatch(/enabled/i);
  });

  it('renders as a description, never as an instruction to the judge', () => {
    // The trap this guards: reusing the `chat/**` prompt builders, which emit second-person
    // imperatives written AT the interviewer ("You have wide latitude with this question...").
    // Splicing one into a judge's context would tell the judge to behave that way.
    const ctx = buildObjectivesContext(
      version({
        houseRules: {
          enabled: true,
          rules: [{ id: 'r1', kind: 'never', enabled: true, text: 'Never use humour.' }],
        },
      })
    );
    expect(ctx.houseRules).not.toMatch(/\bYou (?:must|may|should|have)\b/);
  });
});

describe('describeTurnFidelity', () => {
  const gateOn = configView({ questionFidelity: { enabled: true, defaultFidelity: 0.5 } });

  it('returns nothing when the turn targeted no question', async () => {
    // Completion and offer turns target nothing — there is no question to have been faithful to.
    expect(await describeTurnFidelity('ver-1', gateOn, {})).toBeUndefined();
    expect(prismaMock.appQuestionSlot.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionSlot.findUnique).not.toHaveBeenCalled();
  });

  it('describes a must-ask question, which is the case the rubric got wrong', async () => {
    (prismaMock.appQuestionSlot.findFirst as Mock).mockResolvedValue({
      fidelity: QUESTION_FIDELITY_STOP_BY_LEVEL.must_ask,
    });
    const out = await describeTurnFidelity('ver-1', gateOn, { questionId: 'q-1' });
    expect(out).toMatch(/must ask/i);
    // Carries the explanation, not just the label — "Must ask" alone is jargon to a judge.
    expect(out).toMatch(/as written/i);
  });

  it('scopes the by-id lookup to the version, since the turn column carries no FK', async () => {
    (prismaMock.appQuestionSlot.findFirst as Mock).mockResolvedValue(null);
    await describeTurnFidelity('ver-1', gateOn, { questionId: 'q-from-another-questionnaire' });
    expect(prismaMock.appQuestionSlot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'q-from-another-questionnaire', versionId: 'ver-1' },
      })
    );
  });

  it('looks a live-drawer turn up by its stable key', async () => {
    (prismaMock.appQuestionSlot.findUnique as Mock).mockResolvedValue({
      fidelity: QUESTION_FIDELITY_STOP_BY_LEVEL.close,
    });
    const out = await describeTurnFidelity('ver-1', gateOn, { questionKey: 'housing-tenure' });
    expect(prismaMock.appQuestionSlot.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { versionId_key: { versionId: 'ver-1', key: 'housing-tenure' } },
      })
    );
    expect(out).toMatch(/close/i);
  });

  it('says nothing at the default stop', async () => {
    (prismaMock.appQuestionSlot.findFirst as Mock).mockResolvedValue({
      fidelity: QUESTION_FIDELITY_STOP_BY_LEVEL.balanced,
    });
    // `balanced` is the behaviour the rubric already assumes, so stating it spends tokens telling
    // the judge nothing — and risks it over-weighting a redundant line.
    expect(await describeTurnFidelity('ver-1', gateOn, { questionId: 'q-1' })).toBeUndefined();
  });

  it('says nothing when the version-level gate is off, however the slider was left', async () => {
    // The two-layer no-op: an admin may pre-set sliders before switching the feature on. Reading
    // the column raw would describe a dial that is not in force.
    (prismaMock.appQuestionSlot.findFirst as Mock).mockResolvedValue({
      fidelity: QUESTION_FIDELITY_STOP_BY_LEVEL.must_ask,
    });
    const gateOff = configView({ questionFidelity: { enabled: false, defaultFidelity: 0.5 } });
    expect(await describeTurnFidelity('ver-1', gateOff, { questionId: 'q-1' })).toBeUndefined();
  });

  it('says nothing when the question has since been deleted', async () => {
    (prismaMock.appQuestionSlot.findFirst as Mock).mockResolvedValue(null);
    expect(await describeTurnFidelity('ver-1', gateOn, { questionId: 'gone' })).toBeUndefined();
  });
});

describe('summariseAudience', () => {
  it('drops an empty audience rather than printing "{}"', () => {
    expect(summariseAudience({})).toBeUndefined();
    expect(summariseAudience(null)).toBeUndefined();
    expect(summariseAudience(undefined)).toBeUndefined();
  });

  it('serialises and bounds a real audience', () => {
    expect(summariseAudience({ role: 'renters' })).toContain('renters');
    expect(summariseAudience({ role: 'x'.repeat(5_000) })?.length).toBeLessThanOrEqual(2_000);
  });
});
