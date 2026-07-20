/**
 * Unit tests: the live per-experience canvas diagram.
 *
 * The behaviour worth pinning here is resilience, not prettiness. Step targets and rule targets are
 * unmodelled pointers (UG-1) that may dangle, and this builder feeds a whole admin tab — a throw on
 * a deleted questionnaire would take the page out. Every dangling case is asserted to render
 * something visible and to keep the definition valid.
 */

import { describe, expect, it } from 'vitest';

import { buildExperienceDiagram } from '@/lib/app/questionnaire/experiences/diagram/build';
import type { RoutingRule } from '@/lib/app/questionnaire/experiences/routing/types';
import type {
  ExperienceDetailView,
  ExperienceStepView,
} from '@/lib/app/questionnaire/experiences/views';

function step(overrides: Partial<ExperienceStepView> & { id: string }): ExperienceStepView {
  return {
    key: overrides.id,
    kind: 'branch',
    title: `Step ${overrides.id}`,
    purpose: null,
    selectionCriteria: null,
    ordinal: 0,
    questionnaireId: 'q1',
    questionnaireTitle: 'A questionnaire',
    versionId: null,
    versionNumber: null,
    roundId: null,
    durationSeconds: null,
    briefing: null,
    synthesisFocus: null,
    rooms: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function experience(overrides: Partial<ExperienceDetailView> = {}): ExperienceDetailView {
  return {
    id: 'exp1',
    title: 'An experience',
    description: null,
    kind: 'agentic_switcher',
    status: 'draft',
    continuityMode: 'linked',
    accessMode: 'invitation_only',
    demoClientId: 'dc1',
    demoClientName: 'Client',
    stepCount: 0,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    routingFallback: 'conclude',
    minRoutingConfidence: 0.6,
    routingInstructions: null,
    costBudgetUsd: null,
    publicRef: null,
    cohortId: null,
    settings: {} as ExperienceDetailView['settings'],
    steps: [],
    ...overrides,
  };
}

const rule = (overrides: Partial<RoutingRule> & { id: string }): RoutingRule => ({
  dataSlotKey: 'role',
  operator: 'equals',
  value: 'manager',
  targetStepKey: 'b1',
  ordinal: 0,
  ...overrides,
});

/** Every edge must land on a step that exists, or the canvas renders a dangling connection. */
function assertEdgesResolve(definition: ReturnType<typeof buildExperienceDiagram>) {
  const ids = new Set(definition.steps.map((s) => s.id));
  for (const s of definition.steps) {
    for (const edge of s.nextSteps ?? []) {
      expect(ids.has(edge.targetStepId), `${s.id} → ${edge.targetStepId}`).toBe(true);
    }
  }
  expect(ids.has(definition.entryStepId)).toBe(true);
}

describe('buildExperienceDiagram', () => {
  it('renders a valid placeholder when nothing is authored', () => {
    const definition = buildExperienceDiagram(experience());

    expect(definition.steps).toHaveLength(1);
    expect(definition.steps[0].name).toBe('No steps yet');
    assertEdgesResolve(definition);
  });

  it('does not throw and shows "may have been deleted" for a dangling questionnaire', () => {
    const definition = buildExperienceDiagram(
      experience({
        steps: [
          step({ id: 'e1', kind: 'entry', questionnaireId: 'gone', questionnaireTitle: null }),
        ],
      })
    );

    const entry = definition.steps.find((s) => s.id === 'step-e1');
    expect(entry?.description).toContain('may have been deleted');
    assertEdgesResolve(definition);
  });

  it('distinguishes "no questionnaire yet" from a deleted one', () => {
    const definition = buildExperienceDiagram(
      experience({
        steps: [step({ id: 'e1', kind: 'entry', questionnaireId: null, questionnaireTitle: null })],
      })
    );

    const entry = definition.steps.find((s) => s.id === 'step-e1');
    expect(entry?.description).toContain('No questionnaire attached yet');
    expect(entry?.description).not.toContain('may have been deleted');
  });

  it('gives the decision node one labelled output per rule, plus a selector output', () => {
    const definition = buildExperienceDiagram(
      experience({
        steps: [
          step({ id: 'e1', key: 'e1', kind: 'entry', ordinal: 0 }),
          step({ id: 'b1', key: 'b1', ordinal: 1 }),
          step({ id: 'b2', key: 'b2', ordinal: 2 }),
        ],
      }),
      [rule({ id: 'r1', targetStepKey: 'b1' }), rule({ id: 'r2', targetStepKey: 'b2', ordinal: 1 })]
    );

    const decision = definition.steps.find((s) => s.id === '__decision');
    const routes = decision?.config.routes as Array<{ label: string }>;

    // Two rules + "No rule matched".
    expect(routes).toHaveLength(3);
    expect(routes[2].label).toBe('No rule matched');
    expect(decision?.nextSteps).toHaveLength(3);
    assertEdgesResolve(definition);
  });

  it('evaluates rules in ordinal order, not insertion order', () => {
    const definition = buildExperienceDiagram(
      experience({
        steps: [step({ id: 'e1', key: 'e1', kind: 'entry' }), step({ id: 'b1', key: 'b1' })],
      }),
      [
        rule({ id: 'second', dataSlotKey: 'later', ordinal: 5 }),
        rule({ id: 'first', dataSlotKey: 'earlier', ordinal: 1 }),
      ]
    );

    const routes = definition.steps.find((s) => s.id === '__decision')?.config.routes as Array<{
      label: string;
    }>;
    expect(routes[0].label).toContain('earlier');
    expect(routes[1].label).toContain('later');
  });

  it('surfaces a rule pointing at a step key that no longer exists', () => {
    const definition = buildExperienceDiagram(
      experience({
        steps: [step({ id: 'e1', key: 'e1', kind: 'entry' }), step({ id: 'b1', key: 'b1' })],
      }),
      [rule({ id: 'r1', targetStepKey: 'deleted-step' })]
    );

    const unresolved = definition.steps.find((s) => s.id === '__unresolved');
    expect(unresolved).toBeDefined();
    expect(unresolved?.description).toContain('deleted-step');
    assertEdgesResolve(definition);
  });

  it('names the configured fallback on the selector, not a generic one', () => {
    const conclude = buildExperienceDiagram(experience({ routingFallback: 'conclude' }));
    const first = buildExperienceDiagram(
      experience({
        routingFallback: 'first_candidate',
        steps: [step({ id: 'e1', key: 'e1', kind: 'entry' })],
      })
    );

    // The empty experience short-circuits to the placeholder, so only the authored one has a
    // selector — assert the fallback wording is drawn from the experience rather than hard-coded.
    expect(conclude.steps.find((s) => s.id === '__selector')).toBeUndefined();
    expect(first.steps.find((s) => s.id === '__selector')?.description).toContain(
      'use the first candidate step'
    );
  });

  it('fans a breakout out to one branch per room', () => {
    const definition = buildExperienceDiagram(
      experience({
        kind: 'facilitated_meeting',
        steps: [
          step({ id: 'e1', key: 'e1', kind: 'entry', ordinal: 0 }),
          step({
            id: 'bk1',
            key: 'bk1',
            kind: 'breakout',
            ordinal: 1,
            rooms: [
              { id: 'r1', name: 'Room A', mode: 'scribe', ordinal: 0 },
              { id: 'r2', name: 'Room B', mode: 'individual', ordinal: 1 },
            ],
          }),
        ],
      })
    );

    const breakout = definition.steps.find((s) => s.id === 'step-bk1');
    expect(breakout?.type).toBe('parallel');
    expect(breakout?.config.branches).toHaveLength(2);
    expect(breakout?.description).toContain('Room A (scribe)');
    assertEdgesResolve(definition);
  });

  it('draws a facilitated meeting as a sequence, with no routing decision', () => {
    const definition = buildExperienceDiagram(
      experience({
        kind: 'facilitated_meeting',
        steps: [
          step({ id: 'e1', key: 'e1', kind: 'entry', ordinal: 0 }),
          step({ id: 'bk1', key: 'bk1', kind: 'breakout', ordinal: 1 }),
        ],
      })
    );

    expect(definition.steps.find((s) => s.id === '__decision')).toBeUndefined();
    expect(definition.steps.find((s) => s.id === '__selector')).toBeUndefined();
    expect(definition.steps.find((s) => s.id === 'step-e1')?.nextSteps?.[0].targetStepId).toBe(
      'step-bk1'
    );
    assertEdgesResolve(definition);
  });

  it('describes a report step as an authored marker rather than implying it runs', () => {
    const definition = buildExperienceDiagram(
      experience({
        steps: [
          step({ id: 'e1', key: 'e1', kind: 'entry', ordinal: 0 }),
          step({ id: 'rp1', key: 'rp1', kind: 'report', ordinal: 1 }),
        ],
      })
    );

    const report = definition.steps.find((s) => s.id === 'step-rp1');
    expect(report?.description).toContain('Authored marker only');
  });

  it('always funnels to a single conclude node', () => {
    const definition = buildExperienceDiagram(
      experience({
        steps: [
          step({ id: 'e1', key: 'e1', kind: 'entry', ordinal: 0 }),
          step({ id: 'b1', key: 'b1', ordinal: 1 }),
          step({ id: 'b2', key: 'b2', ordinal: 2 }),
        ],
      })
    );

    const conclude = definition.steps.filter((s) => s.id === '__conclude');
    expect(conclude).toHaveLength(1);
    expect(conclude[0].nextSteps).toHaveLength(0);
    assertEdgesResolve(definition);
  });

  it('mentions the run budget on the conclude node when one is set', () => {
    const withBudget = buildExperienceDiagram(
      experience({ costBudgetUsd: 5, steps: [step({ id: 'e1', key: 'e1', kind: 'entry' })] })
    );
    const without = buildExperienceDiagram(
      experience({ costBudgetUsd: null, steps: [step({ id: 'e1', key: 'e1', kind: 'entry' })] })
    );

    expect(withBudget.steps.find((s) => s.id === '__conclude')?.description).toContain('$5');
    expect(without.steps.find((s) => s.id === '__conclude')?.description).toContain(
      'No run budget is set'
    );
  });
});
