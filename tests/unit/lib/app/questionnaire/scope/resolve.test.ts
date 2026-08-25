import { describe, it, expect } from 'vitest';

import {
  isDataSlotInScope,
  isQuestionInScope,
  resolveScope,
  type ScopeInput,
} from '@/lib/app/questionnaire/scope/resolve';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
  type InterviewPlan,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';

function topic(key: string, phase: TopicPhase, overrides: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: null,
    depth: 'full',
    members: { dataSlotKeys: [`${key}_ds`], questionKeys: [`${key}_q1`, `${key}_q2`] },
    ordinal: 0,
    source: 'seeded',
    ...overrides,
  };
}

function settings(overrides: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true, ...overrides };
}

function plan(
  topics: InterviewPlan['topics'],
  overrides: Partial<InterviewPlan> = {}
): InterviewPlan {
  return {
    v: 1,
    topics,
    excluded: [],
    checkTopicKey: null,
    confidence: 0.9,
    source: 'llm',
    respondentMessage: '',
    decidedAtTurn: 4,
    decidedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

/** The standard fixture: an opening, a core, two conditionals and a closing. */
function fixture(overrides: Partial<ScopeInput> = {}): ScopeInput {
  return {
    topics: [
      topic('open', 'opening'),
      topic('spine', 'core'),
      topic('pipeline', 'conditional'),
      topic('talent', 'conditional'),
      topic('close', 'closing'),
    ],
    plan: null,
    settings: settings(),
    ...overrides,
  };
}

describe('resolveScope — the inert guarantee', () => {
  it('admits everything and reports inactive when the feature is off', () => {
    const scope = resolveScope(fixture({ settings: settings({ enabled: false }) }));

    expect(scope.active).toBe(false);
    // Every question is askable, including ones belonging to conditional topics no plan chose.
    expect(isQuestionInScope(scope, 'pipeline_q1')).toBe(true);
    expect(isQuestionInScope(scope, 'talent_q2')).toBe(true);
    expect(isDataSlotInScope(scope, 'talent_ds')).toBe(true);
    expect(scope.notAskedQuestionKeys.size).toBe(0);
  });

  it('admits a key it has never heard of when inactive', () => {
    // The pre-P17 behaviour for a version with no topics authored: nothing is filtered, so a key
    // that appears in no topic must still be askable.
    const scope = resolveScope(fixture({ settings: settings({ enabled: false }) }));
    expect(isQuestionInScope(scope, 'a_key_from_nowhere')).toBe(true);
  });

  it('admits everything when the feature is on but no topics were ever authored', () => {
    const scope = resolveScope(fixture({ topics: [], settings: settings({ enabled: true }) }));

    expect(scope.active).toBe(false);
    expect(isQuestionInScope(scope, 'anything')).toBe(true);
  });

  it('still maps questions to their topics when inactive, so grouping survives a toggle-off', () => {
    const scope = resolveScope(fixture({ settings: settings({ enabled: false }) }));
    expect(scope.topicByQuestionKey.get('pipeline_q1')).toBe('pipeline');
  });
});

describe('resolveScope — before a plan exists', () => {
  it('admits the always-run phases and withholds the conditional ones', () => {
    const scope = resolveScope(fixture({ plan: null }));

    expect(scope.active).toBe(true);
    expect([...scope.topicKeys].sort()).toEqual(['close', 'open', 'spine']);
    expect(isQuestionInScope(scope, 'open_q1')).toBe(true);
    expect(isQuestionInScope(scope, 'spine_q1')).toBe(true);
    expect(isQuestionInScope(scope, 'close_q1')).toBe(true);
    // The whole point: the opening decides the rest, rather than running alongside it.
    expect(isQuestionInScope(scope, 'pipeline_q1')).toBe(false);
    expect(isQuestionInScope(scope, 'talent_q1')).toBe(false);
  });

  it('treats an unreadable plan as no plan — widening, never narrowing', () => {
    // narrowInterviewPlan hands us null for anything malformed; that must not strand the session
    // with an empty scope.
    const scope = resolveScope(fixture({ plan: null }));
    expect(scope.questionKeys.size).toBeGreaterThan(0);
  });
});

describe('resolveScope — with a plan', () => {
  it('admits the planned conditional topics alongside the always-run ones', () => {
    const scope = resolveScope(
      fixture({
        plan: plan([{ key: 'pipeline', depth: 'full', source: 'llm', rationale: 'deals stall' }]),
      })
    );

    expect([...scope.topicKeys].sort()).toEqual(['close', 'open', 'pipeline', 'spine']);
    expect(isQuestionInScope(scope, 'pipeline_q1')).toBe(true);
    expect(isQuestionInScope(scope, 'talent_q1')).toBe(false);
  });

  it('ignores a planned topic that no longer exists', () => {
    const scope = resolveScope(
      fixture({
        plan: plan([
          { key: 'pipeline', depth: 'full', source: 'llm', rationale: '' },
          { key: 'deleted_since', depth: 'full', source: 'llm', rationale: '' },
        ]),
      })
    );

    expect(scope.topicKeys.has('deleted_since')).toBe(false);
    expect(scope.topicKeys.has('pipeline')).toBe(true);
  });

  it('never admits a conditional topic the plan left out, whatever else is in the plan', () => {
    const scope = resolveScope({
      ...fixture(),
      plan: plan([{ key: 'pipeline', depth: 'full', source: 'llm', rationale: '' }]),
      allQuestionKeys: ['open_q1', 'pipeline_q1', 'talent_q1', 'talent_q2'],
    });

    expect([...scope.notAskedQuestionKeys].sort()).toEqual(['talent_q1', 'talent_q2']);
  });
});

describe('resolveScope — light depth (the blind-spot check)', () => {
  const wide = topic('data', 'conditional', {
    members: { dataSlotKeys: ['data_ds'], questionKeys: ['d1', 'd2', 'd3', 'd4', 'd5'] },
  });

  it('contributes only the two highest-weight members', () => {
    const scope = resolveScope({
      topics: [topic('open', 'opening'), wide],
      plan: plan([{ key: 'data', depth: 'light', source: 'check', rationale: 'blind spot' }]),
      settings: settings(),
      weightByQuestionKey: new Map([
        ['d1', 0.2],
        ['d2', 0.9],
        ['d3', 0.5],
        ['d4', 0.95],
        ['d5', 0.1],
      ]),
    });

    expect([...scope.questionKeys].filter((k) => k.startsWith('d')).sort()).toEqual(['d2', 'd4']);
    expect(scope.depthByTopicKey.get('data')).toBe('light');
  });

  it('falls back to authored order when no weights are supplied', () => {
    const scope = resolveScope({
      topics: [wide],
      plan: plan([{ key: 'data', depth: 'light', source: 'check', rationale: '' }]),
      settings: settings(),
    });

    expect([...scope.questionKeys].sort()).toEqual(['d1', 'd2']);
  });

  it('is stable across runs when weights tie', () => {
    const input: ScopeInput = {
      topics: [wide],
      plan: plan([{ key: 'data', depth: 'light', source: 'check', rationale: '' }]),
      settings: settings(),
      weightByQuestionKey: new Map([
        ['d1', 0.5],
        ['d2', 0.5],
        ['d3', 0.5],
        ['d4', 0.5],
        ['d5', 0.5],
      ]),
    };

    expect([...resolveScope(input).questionKeys]).toEqual([...resolveScope(input).questionKeys]);
  });

  it("lets the plan's depth override the topic's authored depth", () => {
    // The check topic is forced light at planning time regardless of how its author set it up:
    // its job in THIS interview is to sample, not to score.
    const authoredFull = topic('data', 'conditional', {
      depth: 'full',
      members: { dataSlotKeys: [], questionKeys: ['d1', 'd2', 'd3', 'd4'] },
    });
    const scope = resolveScope({
      topics: [authoredFull],
      plan: plan([{ key: 'data', depth: 'light', source: 'check', rationale: '' }]),
      settings: settings(),
    });

    expect(scope.questionKeys.size).toBe(2);
  });

  it('honours an authored light depth even when the plan says nothing about depth', () => {
    const authoredLight = topic('spine', 'core', {
      depth: 'light',
      members: { dataSlotKeys: [], questionKeys: ['s1', 's2', 's3'] },
    });
    const scope = resolveScope({ topics: [authoredLight], plan: null, settings: settings() });

    expect(scope.questionKeys.size).toBe(2);
  });

  it('keeps every member when the topic is smaller than the light-depth sample', () => {
    const tiny = topic('tiny', 'conditional', {
      members: { dataSlotKeys: [], questionKeys: ['t1'] },
    });
    const scope = resolveScope({
      topics: [tiny],
      plan: plan([{ key: 'tiny', depth: 'light', source: 'check', rationale: '' }]),
      settings: settings(),
    });

    expect([...scope.questionKeys]).toEqual(['t1']);
  });
});

describe('resolveScope — not-asked reporting', () => {
  it('reports nothing as not-asked unless the caller supplies the full key list', () => {
    const scope = resolveScope(fixture({ plan: plan([]) }));
    expect(scope.notAskedQuestionKeys.size).toBe(0);
  });

  it('names the topic a not-asked question belonged to', () => {
    const scope = resolveScope({
      ...fixture(),
      plan: plan([]),
      allQuestionKeys: ['talent_q1'],
    });

    expect(scope.notAskedQuestionKeys.has('talent_q1')).toBe(true);
    // So a report can say "we did not assess Talent" rather than listing an orphan key.
    expect(scope.topicByQuestionKey.get('talent_q1')).toBe('talent');
  });

  it('reports out-of-scope data slots too', () => {
    const scope = resolveScope({
      ...fixture(),
      plan: plan([]),
      allDataSlotKeys: ['open_ds', 'talent_ds'],
    });

    expect([...scope.notAskedDataSlotKeys]).toEqual(['talent_ds']);
  });

  it('counts a light topic’s trimmed members as not-asked', () => {
    // A light topic is a sample: the members it did not contribute genuinely were not asked, and
    // the report must not present the topic as fully assessed.
    const wide = topic('data', 'conditional', {
      members: { dataSlotKeys: [], questionKeys: ['d1', 'd2', 'd3'] },
    });
    const scope = resolveScope({
      topics: [wide],
      plan: plan([{ key: 'data', depth: 'light', source: 'check', rationale: '' }]),
      settings: settings(),
      allQuestionKeys: ['d1', 'd2', 'd3'],
    });

    expect([...scope.notAskedQuestionKeys]).toEqual(['d3']);
  });
});

describe('resolveScope — robustness', () => {
  it('does not throw on a topic naming keys that no longer exist', () => {
    const stale = topic('stale', 'core', {
      members: { dataSlotKeys: ['gone_ds'], questionKeys: ['gone_q'] },
    });
    expect(() => resolveScope({ topics: [stale], plan: null, settings: settings() })).not.toThrow();
  });

  it('resolves to the always-phases when the plan selected nothing at all', () => {
    // The fallback set can legitimately be empty: an interview of opening + core + closing is
    // thin, but coherent, and is strictly better than stranding the respondent.
    const scope = resolveScope(fixture({ plan: plan([]) }));
    expect([...scope.topicKeys].sort()).toEqual(['close', 'open', 'spine']);
  });

  it('attributes a question shared by two topics to the first that claims it', () => {
    const a = topic('a', 'core', { members: { dataSlotKeys: [], questionKeys: ['shared'] } });
    const b = topic('b', 'core', { members: { dataSlotKeys: [], questionKeys: ['shared'] } });
    const scope = resolveScope({ topics: [a, b], plan: null, settings: settings() });

    expect(scope.topicByQuestionKey.get('shared')).toBe('a');
    expect(scope.questionKeys.has('shared')).toBe(true);
  });
});

describe('a plan that names a SUBSET of a topic (C6 / F17.29)', () => {
  const wide = topic('wide', 'conditional', {
    members: {
      dataSlotKeys: ['wide_ds1', 'wide_ds2'],
      questionKeys: ['wide_q1', 'wide_q2', 'wide_q3', 'wide_q4'],
    },
  });

  function resolveWith(members: { questionKeys?: string[]; dataSlotKeys?: string[] } | undefined) {
    return resolveScope({
      settings: settings(),
      topics: [topic('open', 'opening'), wide],
      plan: plan([
        {
          key: 'wide',
          depth: 'full',
          source: 'llm',
          rationale: 'part of it',
          ...(members
            ? {
                members: {
                  questionKeys: members.questionKeys ?? [],
                  dataSlotKeys: members.dataSlotKeys ?? [],
                },
              }
            : {}),
        },
      ]),
      allQuestionKeys: [...wide.members.questionKeys, 'open_q1', 'open_q2'],
      allDataSlotKeys: [...wide.members.dataSlotKeys, 'open_ds'],
    });
  }

  it('asks only the named items, and reports the rest as not asked', () => {
    const scope = resolveWith({ questionKeys: ['wide_q3', 'wide_q1'], dataSlotKeys: ['wide_ds2'] });

    expect(isQuestionInScope(scope, 'wide_q1')).toBe(true);
    expect(isQuestionInScope(scope, 'wide_q3')).toBe(true);
    expect(isQuestionInScope(scope, 'wide_q2')).toBe(false);
    expect(isDataSlotInScope(scope, 'wide_ds2')).toBe(true);
    expect(isDataSlotInScope(scope, 'wide_ds1')).toBe(false);
    // The unnamed members are not silently forgotten — a report has to be able to say what this
    // interview did not cover.
    expect(scope.notAskedQuestionKeys.has('wide_q2')).toBe(true);
  });

  it('keeps the instrument’s own order, not the order the model listed', () => {
    const scope = resolveWith({ questionKeys: ['wide_q4', 'wide_q2'] });
    const asked = [...wide.members.questionKeys].filter((k) => isQuestionInScope(scope, k));
    expect(asked).toEqual(['wide_q2', 'wide_q4']);
  });

  it('never widens a topic into a question its author did not put in it', () => {
    const scope = resolveWith({ questionKeys: ['wide_q1', 'spine_q1', 'made_up'] });

    expect(isQuestionInScope(scope, 'wide_q1')).toBe(true);
    expect(isQuestionInScope(scope, 'spine_q1')).toBe(false);
    expect(isQuestionInScope(scope, 'made_up')).toBe(false);
  });

  it('falls back to the whole topic when nothing named survives the intersection', () => {
    // Degrading toward asking MORE is this module's rule everywhere. A topic in scope that asks
    // nothing would report as covered while contributing no answer.
    const scope = resolveWith({ questionKeys: ['nothing_real'] });

    for (const key of wide.members.questionKeys) expect(isQuestionInScope(scope, key)).toBe(true);
  });

  it('leaves the topic whole when the plan named nothing', () => {
    const scope = resolveWith(undefined);
    for (const key of wide.members.questionKeys) expect(isQuestionInScope(scope, key)).toBe(true);
  });

  it('narrowing the questions leaves the data slots to the depth, and vice versa', () => {
    // Naming three questions is not a statement about the topic's data slots.
    const scope = resolveWith({ questionKeys: ['wide_q1'] });

    expect(isQuestionInScope(scope, 'wide_q2')).toBe(false);
    expect(isDataSlotInScope(scope, 'wide_ds1')).toBe(true);
    expect(isDataSlotInScope(scope, 'wide_ds2')).toBe(true);
  });
});
