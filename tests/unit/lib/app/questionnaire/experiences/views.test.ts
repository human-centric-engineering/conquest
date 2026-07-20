import { describe, it, expect } from 'vitest';

import {
  entryStep,
  experienceBlockers,
  routableSteps,
  toExperienceDetailView,
  toExperienceListView,
  toExperienceStepView,
  type ExperienceDetailView,
  type ExperienceRow,
  type ExperienceStepRow,
  type ExperienceStepView,
} from '@/lib/app/questionnaire/experiences/views';
import { DEFAULT_EXPERIENCE_SETTINGS } from '@/lib/app/questionnaire/experiences/types';

const NOW = new Date('2026-07-19T10:00:00.000Z');

function experienceRow(overrides: Partial<ExperienceRow> = {}): ExperienceRow {
  return {
    id: 'exp_1',
    demoClientId: 'client_1',
    title: 'Leadership diagnostic',
    description: null,
    kind: 'agentic_switcher',
    status: 'draft',
    continuityMode: 'linked',
    routingFallback: 'conclude',
    minRoutingConfidence: 0.6,
    routingInstructions: null,
    costBudgetUsd: null,
    accessMode: 'invitation_only',
    publicRef: null,
    cohortId: null,
    createdBy: 'user_1',
    settings: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function stepRow(overrides: Partial<ExperienceStepRow> = {}): ExperienceStepRow {
  return {
    id: 'step_1',
    experienceId: 'exp_1',
    key: 'entry',
    kind: 'entry',
    questionnaireId: 'q_1',
    versionId: null,
    roundId: null,
    title: 'Opening questions',
    purpose: null,
    selectionCriteria: null,
    ordinal: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function stepView(overrides: Partial<ExperienceStepView> = {}): ExperienceStepView {
  return { ...toExperienceStepView(stepRow()), ...overrides };
}

function detailView(
  rowOverrides: Partial<ExperienceRow> = {},
  steps: ExperienceStepView[] = []
): ExperienceDetailView {
  return toExperienceDetailView(experienceRow(rowOverrides), 'Acme', steps);
}

describe('experience view mappers', () => {
  it('narrows every vocabulary column and serialises dates as ISO strings', () => {
    const view = toExperienceListView(experienceRow(), 'Acme', 3);

    expect(view.kind).toBe('agentic_switcher');
    expect(view.status).toBe('draft');
    expect(view.continuityMode).toBe('linked');
    expect(view.accessMode).toBe('invitation_only');
    expect(view.demoClientName).toBe('Acme');
    expect(view.stepCount).toBe(3);
    expect(view.createdAt).toBe(NOW.toISOString());
  });

  it('falls back to a safe member when a column holds an unrecognised value', () => {
    // These are plain String columns, not Prisma enums, so a stray value is reachable — from a
    // hand-edited row or a vocabulary that has since shrunk. It must never escape untyped.
    const view = toExperienceListView(
      experienceRow({
        kind: 'something_removed',
        status: 'bogus',
        continuityMode: 'nonsense',
        accessMode: 'invalid',
      }),
      null,
      0
    );

    expect(view.kind).toBe('agentic_switcher');
    expect(view.status).toBe('draft');
    expect(view.continuityMode).toBe('linked');
    expect(view.accessMode).toBe('invitation_only');
  });

  it('narrows the settings blob on the detail view', () => {
    const view = detailView({ settings: { summariseCarryOver: false, junk: true } });

    expect(view.settings.summariseCarryOver).toBe(false);
    expect(view.settings.carryProfile).toBe(DEFAULT_EXPERIENCE_SETTINGS.carryProfile);
    expect(view.settings).not.toHaveProperty('junk');
  });

  it('renders an unresolvable questionnaire pointer as null rather than throwing', () => {
    // Step pointers are deliberately unmodelled (UG-1), so the questionnaire they name may have
    // been deleted. The view must degrade to "missing", never crash the steps page.
    const view = toExperienceStepView(stepRow({ questionnaireId: 'deleted_q' }), {});

    expect(view.questionnaireId).toBe('deleted_q');
    expect(view.questionnaireTitle).toBeNull();
    expect(view.versionNumber).toBeNull();
  });

  it('carries resolved questionnaire metadata when supplied', () => {
    const view = toExperienceStepView(stepRow({ versionId: 'v_2' }), {
      questionnaireTitle: 'Discovery',
      versionNumber: 4,
    });

    expect(view.questionnaireTitle).toBe('Discovery');
    expect(view.versionNumber).toBe(4);
  });
});

describe('routableSteps', () => {
  it('returns only branch steps that actually have a questionnaire, in ordinal order', () => {
    // A branch with no questionnaire is half-authored, not a candidate — offering it to the
    // selector would let a run route into nothing.
    const steps = [
      stepView({ id: 'a', kind: 'branch', questionnaireId: 'q_a', ordinal: 2 }),
      stepView({ id: 'b', kind: 'branch', questionnaireId: null, ordinal: 1 }),
      stepView({ id: 'c', kind: 'branch', questionnaireId: 'q_c', ordinal: 0 }),
      stepView({ id: 'd', kind: 'entry', questionnaireId: 'q_d', ordinal: 3 }),
      stepView({ id: 'e', kind: 'report', questionnaireId: 'q_e', ordinal: 4 }),
    ];

    expect(routableSteps(steps).map((s) => s.id)).toEqual(['c', 'a']);
  });

  it('does not mutate the input array', () => {
    const steps = [
      stepView({ id: 'a', kind: 'branch', questionnaireId: 'q', ordinal: 5 }),
      stepView({ id: 'b', kind: 'branch', questionnaireId: 'q', ordinal: 1 }),
    ];
    routableSteps(steps);

    expect(steps.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('returns empty for a journey with no branches', () => {
    expect(routableSteps([stepView({ kind: 'entry' })])).toEqual([]);
    expect(routableSteps([])).toEqual([]);
  });
});

describe('entryStep', () => {
  it('finds the entry step', () => {
    const entry = stepView({ id: 'e', kind: 'entry' });
    expect(entryStep([stepView({ id: 'b', kind: 'branch' }), entry])?.id).toBe('e');
  });

  it('returns null when no step is designated as the entry', () => {
    expect(entryStep([stepView({ kind: 'branch' })])).toBeNull();
    expect(entryStep([])).toBeNull();
  });
});

describe('experienceBlockers', () => {
  it('reports a switcher with an entry and a usable branch as ready', () => {
    const view = detailView({ kind: 'agentic_switcher' }, [
      stepView({ id: 'e', kind: 'entry', questionnaireId: 'q_e' }),
      stepView({ id: 'b', kind: 'branch', questionnaireId: 'q_b' }),
    ]);

    expect(experienceBlockers(view)).toEqual([]);
  });

  it('flags a missing entry step', () => {
    const view = detailView({}, [stepView({ kind: 'branch', questionnaireId: 'q' })]);

    expect(experienceBlockers(view).join(' ')).toMatch(/entry step/i);
  });

  it('flags an entry step with no questionnaire attached', () => {
    const view = detailView({}, [
      stepView({ id: 'e', kind: 'entry', questionnaireId: null }),
      stepView({ id: 'b', kind: 'branch', questionnaireId: 'q_b' }),
    ]);

    expect(experienceBlockers(view).join(' ')).toMatch(/entry step has no questionnaire/i);
  });

  it('flags more than one entry step', () => {
    const view = detailView({}, [
      stepView({ id: 'e1', kind: 'entry', questionnaireId: 'q1' }),
      stepView({ id: 'e2', kind: 'entry', questionnaireId: 'q2' }),
      stepView({ id: 'b', kind: 'branch', questionnaireId: 'q3' }),
    ]);

    expect(experienceBlockers(view).join(' ')).toMatch(/only one entry step/i);
  });

  it('flags a switcher with nowhere to route', () => {
    // A switcher with no candidates would always conclude — a plain questionnaire wearing a
    // costlier hat.
    const view = detailView({ kind: 'agentic_switcher' }, [
      stepView({ kind: 'entry', questionnaireId: 'q_e' }),
    ]);

    expect(experienceBlockers(view).join(' ')).toMatch(/branch step/i);
  });

  it('does not demand branch steps of a facilitated meeting', () => {
    const view = detailView({ kind: 'facilitated_meeting' }, [
      stepView({ id: 'e', kind: 'entry', questionnaireId: 'q_e' }),
      stepView({ id: 'b', kind: 'breakout', questionnaireId: 'q_b' }),
    ]);

    expect(experienceBlockers(view)).toEqual([]);
  });

  it('flags a facilitated meeting with no usable breakout', () => {
    const view = detailView({ kind: 'facilitated_meeting' }, [
      stepView({ id: 'e', kind: 'entry', questionnaireId: 'q_e' }),
      stepView({ id: 'b', kind: 'breakout', questionnaireId: null }),
    ]);

    expect(experienceBlockers(view).join(' ')).toMatch(/breakout step/i);
  });

  it('flags a default_step fallback with no step to fall back to', () => {
    const view = detailView({ kind: 'agentic_switcher', routingFallback: 'default_step' }, [
      stepView({ kind: 'entry', questionnaireId: 'q_e' }),
    ]);

    expect(experienceBlockers(view).join(' ')).toMatch(/default step/i);
  });
});
