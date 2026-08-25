/**
 * Unit tests: `annotateScopeGraph` — the three routing-map overlays (F17.29).
 *
 * What carries weight here:
 *
 *  1. **"Chosen and taken back" is a state of its own.** A topic the agent proposed and a guardrail
 *     removed looks identical, on the plan alone, to one the agent never wanted. Telling those
 *     apart is the entire reason the preview returns `proposedKeys` beside the plan, and it is the
 *     one thing this overlay exists to show.
 *  2. **The base graph is never mutated.** A reader who switches an overlay off must get exactly
 *     the picture they had before switching it on.
 *  3. **A toggle is offered only when it has something to say.** An overlay that switches on
 *     nothing reads as "it found nothing", when in fact its data was never loaded.
 */

import { describe, it, expect } from 'vitest';

import {
  annotateScopeGraph,
  availableOverlays,
  type ScopeOverlayInput,
  type ScopeOverlayKind,
} from '@/lib/app/questionnaire/scope/graph-overlays';
import type { ScopeGraph, ScopeGraphNode } from '@/lib/app/questionnaire/scope/graph';

function topicNode(key: string): ScopeGraphNode {
  return {
    id: `topic:${key}`,
    kind: 'conditional',
    x: 0,
    y: 0,
    label: key,
    badges: [{ label: 'Existing', tone: 'neutral' }],
    detail: {
      title: key,
      summary: 'a topic',
      rows: [{ label: 'Phase', value: 'Conditional' }],
      topicKey: key,
    },
  };
}

/** A node with no topic key — a guardrail or a rule. None of the three overlays is about one. */
function guardrailNode(): ScopeGraphNode {
  return {
    id: 'guardrail:cap',
    kind: 'guardrails',
    x: 0,
    y: 0,
    label: 'The limit',
    detail: { title: 'The limit', summary: 'at most 3', rows: [] },
  };
}

function graph(): ScopeGraph {
  return {
    nodes: [topicNode('talent'), topicNode('pricing'), topicNode('never'), guardrailNode()],
    edges: [{ id: 'e1', source: 'topic:talent', target: 'topic:pricing', kind: 'candidate' }],
  };
}

function on(...kinds: ScopeOverlayKind[]): Set<ScopeOverlayKind> {
  return new Set(kinds);
}

function nodeFor(result: ScopeGraph, key: string): ScopeGraphNode {
  const node = result.nodes.find((n) => n.detail.topicKey === key);
  if (!node) throw new Error(`no node for ${key}`);
  return node;
}

const DRY_RUN: ScopeOverlayInput = {
  dryRun: {
    selectedKeys: ['talent'],
    excluded: [
      { key: 'pricing', rationale: 'Chosen, then dropped: the budget was already spent.' },
      { key: 'never', rationale: 'The agent did not choose this.' },
    ],
    proposedKeys: ['talent', 'pricing'],
  },
};

describe('annotateScopeGraph — the last try-it run', () => {
  it('marks a topic the run asked', () => {
    const result = annotateScopeGraph(graph(), DRY_RUN, on('dryRun'));
    const node = nodeFor(result, 'talent');

    expect(node.badges?.map((b) => b.label)).toContain('Chosen on the last run');
    expect(node.detail.rows).toContainEqual({
      label: 'Last try-it run',
      value: 'The agent chose it, and it was asked.',
    });
  });

  it('distinguishes "the agent chose it and a limit took it back" from "never chosen"', () => {
    // The distinction the plan alone cannot carry, and the reason this overlay exists.
    const result = annotateScopeGraph(graph(), DRY_RUN, on('dryRun'));

    const takenBack = nodeFor(result, 'pricing');
    expect(takenBack.badges?.map((b) => b.label)).toContain('Taken back on the last run');
    expect(takenBack.detail.rows.at(-1)?.value).toContain('the budget was already spent');

    const neverChosen = nodeFor(result, 'never');
    expect(neverChosen.badges?.map((b) => b.label)).toContain('Not chosen on the last run');
  });

  it('says nothing about a topic the run never mentioned', () => {
    const result = annotateScopeGraph(
      graph(),
      { dryRun: { selectedKeys: [], excluded: [], proposedKeys: [] } },
      on('dryRun')
    );
    expect(nodeFor(result, 'talent').badges).toEqual([{ label: 'Existing', tone: 'neutral' }]);
  });
});

describe('annotateScopeGraph — how often a topic is really chosen', () => {
  const selection: ScopeOverlayInput = {
    selection: {
      plans: 40,
      byTopicKey: new Map([
        ['talent', { chosen: 30, chosenRate: 0.75 }],
        ['never', { chosen: 0, chosenRate: 0 }],
      ]),
    },
  };

  it('carries the rate AND the sample size, because one without the other is not evidence', () => {
    const result = annotateScopeGraph(graph(), selection, on('selection'));
    const node = nodeFor(result, 'talent');

    expect(node.badges?.map((b) => b.label)).toContain('Chosen 75%');
    expect(node.detail.rows).toContainEqual({
      label: 'Chosen in real interviews',
      value: '30 of 40 interviews (75%).',
    });
  });

  it('flags a topic that never fires without calling it wrong', () => {
    // A topic that never fires may be a rare-case safety net working exactly as designed — only the
    // author can judge that, so the badge states the fact and stops.
    const node = nodeFor(annotateScopeGraph(graph(), selection, on('selection')), 'never');
    expect(node.badges?.map((b) => b.label)).toContain('Chosen 0%');
    expect(node.badges?.find((b) => b.label === 'Chosen 0%')?.tone).toBe('warning');
  });

  it('does not round a real hit down to 0%', () => {
    const result = annotateScopeGraph(
      graph(),
      {
        selection: {
          plans: 400,
          byTopicKey: new Map([['talent', { chosen: 1, chosenRate: 0.0025 }]]),
        },
      },
      on('selection')
    );
    expect(nodeFor(result, 'talent').badges?.map((b) => b.label)).toContain('Chosen <1%');
  });
});

describe('annotateScopeGraph — problems pinned to their node', () => {
  const findings: ScopeOverlayInput = {
    findings: [
      {
        severity: 'error',
        code: 'no_criteria',
        message: 'This topic has no criteria.',
        topicKey: 'talent',
      },
      {
        severity: 'warning',
        code: 'light_depth',
        message: 'A light topic asks two of nine.',
        topicKey: 'talent',
      },
      // A finding about the version as a whole, not about any one topic.
      { severity: 'warning', code: 'budget_tight', message: 'The budget is tight.' },
    ],
  };

  it('pins every finding for a topic onto that topic, counted in the badge', () => {
    const node = nodeFor(annotateScopeGraph(graph(), findings, on('findings')), 'talent');

    expect(node.badges?.map((b) => b.label)).toContain('2 problems');
    expect(node.detail.rows.map((r) => r.value)).toEqual(
      expect.arrayContaining(['This topic has no criteria.', 'A light topic asks two of nine.'])
    );
  });

  it('tones the badge by the worst finding on the node', () => {
    const node = nodeFor(annotateScopeGraph(graph(), findings, on('findings')), 'talent');
    expect(node.badges?.find((b) => b.label === '2 problems')?.tone).toBe('negative');
  });

  it('leaves a version-level finding off the map, since it names no node to pin it to', () => {
    const result = annotateScopeGraph(graph(), findings, on('findings'));
    for (const node of result.nodes) {
      expect(node.detail.rows.map((r) => r.value)).not.toContain('The budget is tight.');
    }
  });
});

describe('annotateScopeGraph — what it never touches', () => {
  it('returns the graph itself when no overlay is on', () => {
    const base = graph();
    expect(annotateScopeGraph(base, DRY_RUN, new Set())).toBe(base);
  });

  it('does not mutate the base graph, so switching an overlay off restores it exactly', () => {
    const base = graph();
    const before = JSON.stringify(base);

    annotateScopeGraph(base, DRY_RUN, on('dryRun'));

    expect(JSON.stringify(base)).toBe(before);
  });

  it('passes a node that is not a topic straight through', () => {
    const result = annotateScopeGraph(graph(), DRY_RUN, on('dryRun', 'selection', 'findings'));
    const guardrail = result.nodes.find((n) => n.id === 'guardrail:cap');
    expect(guardrail).toEqual(guardrailNode());
  });

  it('keeps the edges as they were — none of this is about the paths', () => {
    const base = graph();
    expect(annotateScopeGraph(base, DRY_RUN, on('dryRun')).edges).toBe(base.edges);
  });
});

describe('availableOverlays', () => {
  it('offers nothing on a version with no run, no interviews and no findings', () => {
    // A toggle that switches on nothing reads as "the overlay found nothing", which is a different
    // and wrong statement.
    expect(availableOverlays({})).toEqual(new Set());
    expect(
      availableOverlays({ findings: [{ severity: 'warning', code: 'x', message: 'y' }] })
    ).toEqual(new Set());
  });

  it('offers each overlay the moment its data exists', () => {
    expect(availableOverlays(DRY_RUN)).toEqual(new Set(['dryRun']));
    expect(
      availableOverlays({
        selection: { plans: 1, byTopicKey: new Map([['a', { chosen: 1, chosenRate: 1 }]]) },
      })
    ).toEqual(new Set(['selection']));
    expect(
      availableOverlays({
        findings: [{ severity: 'error', code: 'x', message: 'y', topicKey: 'talent' }],
      })
    ).toEqual(new Set(['findings']));
  });

  it('does not offer selection for a version whose analytics came back empty', () => {
    expect(availableOverlays({ selection: { plans: 0, byTopicKey: new Map() } })).toEqual(
      new Set()
    );
  });
});
