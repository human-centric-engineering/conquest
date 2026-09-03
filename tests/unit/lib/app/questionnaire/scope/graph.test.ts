/**
 * Unit tests: the routing map's graph builder.
 *
 * The map is the only Conditional Topics surface whose claims are made by *shape* rather than by prose, so
 * the assertions here are mostly about which edges exist and where they come from. Two families matter
 * most:
 *
 * 1. **Every edge runs left to right**, because React Flow draws a same-column edge as a backwards
 *    loop around both of its endpoints.
 * 2. **No edge points at a node that is not on the canvas** — React Flow drops such an edge
 *    silently, so a dangling reference is an arrow that quietly disappears rather than a crash.
 */

import { describe, expect, it } from 'vitest';

import {
  ALWAYS_BAND_NODE_ID,
  GUARDRAILS_NODE_ID,
  PLANNER_NODE_ID,
  START_NODE_ID,
  buildScopeGraph,
  estimateNodeHeight,
  ROUTING_MAP_NODE_WIDTH,
  type BuildScopeGraphInput,
  type ScopeGraph,
} from '@/lib/app/questionnaire/scope/graph';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';
import {
  estimateTopicCosts,
  itemSeconds,
  type TopicCost,
} from '@/lib/app/questionnaire/scope/budget';
import type {
  TopicDataSlotRef,
  TopicQuestionRef,
  TopicsCostView,
} from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function topic(key: string, phase: TopicPhase, overrides: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: `Topic ${key}`,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [`q_${key}`] },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
    ...overrides,
  };
}

function settings(overrides: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true, ...overrides };
}

function costs(overrides: Partial<TopicsCostView> = {}): TopicsCostView {
  return {
    budgetSeconds: 0,
    alwaysSeconds: 0,
    routedAllowanceSeconds: 0,
    byTopicKey: {},
    ...overrides,
  };
}

function slot(key: string, name = key): TopicDataSlotRef {
  return { key, name, theme: 'general', estimatedSeconds: 40, weight: 1 };
}

function question(
  key: string,
  type: string,
  estimatedSeconds: number,
  weight = 1
): TopicQuestionRef {
  return {
    key,
    prompt: `Prompt for ${key}`,
    sectionTitle: 'Section',
    type,
    estimatedSeconds,
    weight,
  };
}

/** The detail panel's timing block for a node, or undefined when it carries none. */
function timingOf(graph: ScopeGraph, nodeId: string) {
  return graph.nodes.find((n) => n.id === nodeId)?.detail.timing;
}

function build(input: Partial<BuildScopeGraphInput> = {}): ScopeGraph {
  return buildScopeGraph({
    topics: [],
    settings: settings(),
    costs: costs(),
    dataSlots: [],
    expandAlways: false,
    ...input,
  });
}

const ids = (graph: ScopeGraph): string[] => graph.nodes.map((n) => n.id);
const edgeBetween = (graph: ScopeGraph, source: string, target: string) =>
  graph.edges.find((e) => e.source === source && e.target === target);

/* -------------------------------------------------------------------------- */

describe('buildScopeGraph', () => {
  describe('the pipeline skeleton', () => {
    it('always renders the pipeline and the band, even with no topics at all', () => {
      const graph = build();

      expect(ids(graph)).toEqual(
        expect.arrayContaining([
          START_NODE_ID,
          PLANNER_NODE_ID,
          GUARDRAILS_NODE_ID,
          ALWAYS_BAND_NODE_ID,
        ])
      );
      // A blank canvas reads to an author as a broken feature rather than as an empty version.
      expect(graph.nodes.length).toBeGreaterThan(0);
    });

    /**
     * No edge may run inside a single column.
     *
     * React Flow leaves every node's source handle on the right and its target handle on the left, so
     * two nodes sharing an `x` are joined by a path that leaves the right side, doubles back over both
     * boxes and re-enters from the left. It reads as a rendering fault rather than as a relationship.
     *
     * This is a whole-graph invariant rather than a fact about one edge, because the way it was
     * introduced was a layout decision made for unrelated reasons — the band sat one column too far
     * right. The `start` → band-head edge is
     * the one deliberate exception: the head is directly below `start`, and it is drawn vertically
     * because that node takes its inbound edge on the top.
     */
    it('never draws an edge inside a single column', () => {
      for (const expandAlways of [false, true]) {
        const graph = build({
          expandAlways,
          topics: [
            topic('open', 'opening', {
              members: { dataSlotKeys: ['headcount'], questionKeys: [] },
            }),
            topic('spine', 'core', { members: { dataSlotKeys: ['tenure'], questionKeys: [] } }),
            topic('pricing', 'conditional'),
            topic('wrap', 'closing'),
          ],
          settings: settings(),
          dataSlots: [slot('headcount'), slot('tenure')],
        });

        const xById = new Map(graph.nodes.map((n) => [n.id, n.x]));
        const sameColumn = graph.edges.filter((e) => xById.get(e.source) === xById.get(e.target));

        expect(
          sameColumn.map((e) => e.id),
          `expandAlways=${expandAlways}`
        ).toEqual([`e:start:${ALWAYS_BAND_NODE_ID}`]);
      }
    });

    it('runs every other edge left to right', () => {
      const graph = build({
        expandAlways: true,
        topics: [
          topic('open', 'opening', { members: { dataSlotKeys: ['tenure'], questionKeys: [] } }),
          topic('spine', 'core', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          topic('pricing', 'conditional'),
        ],
        settings: settings(),
        dataSlots: [slot('headcount'), slot('tenure')],
      });

      const xById = new Map(graph.nodes.map((n) => [n.id, n.x]));
      for (const edge of graph.edges) {
        if (edge.id === `e:start:${ALWAYS_BAND_NODE_ID}`) continue;
        expect(xById.get(edge.target)!, `${edge.id} runs backwards or flat`).toBeGreaterThan(
          xById.get(edge.source)!
        );
      }
    });

    it('leaves no edge pointing at a node that is not on the canvas', () => {
      // React Flow silently drops an edge whose endpoint is missing, so a dangling reference is not a
      // crash — it is an arrow that quietly disappears. Asserted over the interesting shape rather
      // than the empty one.
      const graph = build({
        topics: [
          topic('open', 'opening', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          topic('pricing', 'conditional'),
          topic('spine', 'core'),
          topic('wrap', 'closing'),
        ],
        settings: settings(),
        dataSlots: [slot('headcount')],
      });

      const present = new Set(ids(graph));
      for (const edge of graph.edges) {
        expect(present.has(edge.source), `source ${edge.source}`).toBe(true);
        expect(present.has(edge.target), `target ${edge.target}`).toBe(true);
      }
    });

    it('gives every node and every edge a unique id', () => {
      const graph = build({
        topics: [topic('open', 'opening'), topic('a', 'conditional'), topic('b', 'conditional')],
        settings: settings(),
        dataSlots: [slot('headcount')],
      });

      expect(new Set(ids(graph)).size).toBe(graph.nodes.length);
      expect(new Set(graph.edges.map((e) => e.id)).size).toBe(graph.edges.length);
    });
  });

  describe('phases', () => {
    it('draws opening topics into the planner and conditional topics out of the guardrails', () => {
      const graph = build({
        topics: [topic('open', 'opening'), topic('pricing', 'conditional')],
      });

      expect(edgeBetween(graph, 'opening:open', PLANNER_NODE_ID)?.kind).toBe('always');
      expect(edgeBetween(graph, GUARDRAILS_NODE_ID, 'conditional:pricing')?.kind).toBe('candidate');
    });

    it('does not give an always-run topic a candidate edge', () => {
      // The claim the separation makes: the agent chooses between conditional topics and nothing else.
      const graph = build({
        topics: [topic('spine', 'core'), topic('wrap', 'closing')],
        expandAlways: true,
      });

      expect(graph.edges.filter((e) => e.kind === 'candidate')).toHaveLength(0);
    });

    it('runs the pipeline from start when no opening topic is authored', () => {
      // This IS the `no_opening_topic` finding — the planner would decide on turn one, over an empty
      // transcript — and the map must not leave the planner floating unconnected while it is true.
      const graph = build({ topics: [topic('pricing', 'conditional')] });

      expect(edgeBetween(graph, START_NODE_ID, PLANNER_NODE_ID)).toBeDefined();
    });
  });

  describe('the always-asked band', () => {
    const band = [topic('a', 'core'), topic('b', 'core'), topic('c', 'closing')];

    it('collapses to a single head node by default, priced from the payload', () => {
      const graph = build({ topics: band, costs: costs({ alwaysSeconds: 266 }) });

      const head = graph.nodes.find((n) => n.id === ALWAYS_BAND_NODE_ID);
      expect(head?.label).toContain('3 topics');
      expect(head?.sublabel).toContain('4m 26s');
      expect(graph.nodes.filter((n) => n.kind === 'always')).toHaveLength(0);
      expect(edgeBetween(graph, START_NODE_ID, ALWAYS_BAND_NODE_ID)).toBeDefined();
    });

    it('fans out to one node per topic when expanded, still anchored to the head', () => {
      const graph = build({ topics: band, expandAlways: true });

      expect(graph.nodes.filter((n) => n.kind === 'always')).toHaveLength(3);
      // The head survives expansion: it is what `start` and any weak-evidence edge point at.
      expect(ids(graph)).toContain(ALWAYS_BAND_NODE_ID);
      expect(edgeBetween(graph, ALWAYS_BAND_NODE_ID, 'always:a')).toBeDefined();
    });

    it('never overlaps the pipeline, however tall the tallest column is', () => {
      // Twelve conditional topics is the pilot instrument's shape, and the column it makes is over a
      // thousand units tall. The band is not pushed below all of that — it is laid out clear of the
      // conditional column's `x`, so it can sit under the short spine and keep the map compact.
      const many = Array.from({ length: 12 }, (_, i) =>
        topic(`c${i}`, 'conditional', { ordinal: i })
      );
      const graph = build({ topics: [...many, ...band], expandAlways: true });

      const isBand = (kind: string) => kind === 'always' || kind === 'alwaysBand';
      const bandNodes = graph.nodes.filter((n) => isBand(n.kind));
      const pipeline = graph.nodes.filter((n) => !isBand(n.kind));
      expect(bandNodes.length).toBeGreaterThan(1);

      for (const b of bandNodes) {
        for (const p of pipeline) {
          const apart =
            b.x + ROUTING_MAP_NODE_WIDTH <= p.x ||
            p.x + ROUTING_MAP_NODE_WIDTH <= b.x ||
            b.y >= p.y + estimateNodeHeight(p) ||
            p.y >= b.y + estimateNodeHeight(b);
          expect(apart, `${b.id} overlaps ${p.id}`).toBe(true);
        }
      }

      // And it is genuinely below the spine, not beside it: the separation is the invariant the band
      // exists to draw.
      const spine = graph.nodes.find((n) => n.id === PLANNER_NODE_ID)!;
      expect(graph.nodes.find((n) => n.id === ALWAYS_BAND_NODE_ID)!.y).toBeGreaterThan(
        spine.y + estimateNodeHeight(spine)
      );
    });
  });

  describe('what the nodes say', () => {
    it('badges a conditional topic that has no criteria', () => {
      const graph = build({ topics: [topic('pricing', 'conditional', { criteria: '   ' })] });

      expect(graph.nodes.find((n) => n.id === 'conditional:pricing')?.badges).toContainEqual({
        label: 'No criteria',
        tone: 'warning',
      });
    });

    it('never draws a badge the detail panel cannot explain', () => {
      // The invariant, asserted over every badge-bearing node the builder can produce: a pill on the
      // canvas is written in the system's own vocabulary (`Fallback`, `Preferred check`), so one that
      // arrives without a sentence behind it is a node that cannot be read.
      const graph = build({
        topics: [
          topic('open', 'opening'),
          topic('pricing', 'conditional', { criteria: '   ' }),
          topic('growth', 'conditional'),
        ],
        settings: settings({
          fallbackTopicKeys: ['growth'],
          checkTopicPreference: ['growth'],
        }),
        dataSlots: [slot('headcount')],
      });

      const badged = graph.nodes.filter((n) => (n.badges?.length ?? 0) > 0);
      // start, opening, planner, guardrails, two conditional topics — the badged ones are the
      // planner and both conditional topics.
      expect(badged.length).toBeGreaterThanOrEqual(3);

      for (const node of badged) {
        expect(
          node.detail.badgeNotes?.map((n) => n.label),
          node.id
        ).toEqual(node.badges?.map((b) => b.label));
        for (const note of node.detail.badgeNotes ?? []) {
          expect(note.meaning.length, `${node.id} · ${note.label}`).toBeGreaterThan(40);
        }
      }
    });

    it('marks a topic named as a fallback and one preferred for the blind-spot check', () => {
      const graph = build({
        topics: [topic('pricing', 'conditional'), topic('talent', 'conditional', { ordinal: 1 })],
        settings: settings({ fallbackTopicKeys: ['pricing'], checkTopicPreference: ['talent'] }),
      });

      const labels = (id: string) =>
        (graph.nodes.find((n) => n.id === id)?.badges ?? []).map((b) => b.label);
      expect(labels('conditional:pricing')).toContain('Fallback');
      expect(labels('conditional:talent')).toContain('Preferred check');
    });

    it('carries the topic key on a topic node and withholds it from a machinery node', () => {
      // The key is what enables "Edit this topic"; a guardrail has no row in the topic list to land on.
      const graph = build({ topics: [topic('pricing', 'conditional')] });

      expect(graph.nodes.find((n) => n.id === 'conditional:pricing')?.detail.topicKey).toBe(
        'pricing'
      );
      expect(graph.nodes.find((n) => n.id === GUARDRAILS_NODE_ID)?.detail.topicKey).toBeUndefined();
      expect(graph.nodes.find((n) => n.id === PLANNER_NODE_ID)?.detail.topicKey).toBeUndefined();
    });

    it('carries a conditional topic’s criteria verbatim rather than truncated', () => {
      const criteria = 'Ask about pricing when they sell through partners, or resell at all.';
      const graph = build({ topics: [topic('pricing', 'conditional', { criteria })] });

      expect(graph.nodes.find((n) => n.id === 'conditional:pricing')?.detail.criteria).toBe(
        criteria
      );
    });

    it('states the routed allowance on the guardrails when a budget is set, and says so when none is', () => {
      const withBudget = build({
        settings: settings({ sessionBudgetSeconds: 600 }),
        costs: costs({ budgetSeconds: 600, alwaysSeconds: 266, routedAllowanceSeconds: 334 }),
      });
      const value = (graph: ScopeGraph) =>
        graph.nodes
          .find((n) => n.id === GUARDRAILS_NODE_ID)!
          .detail.rows.find((r) => r.label === 'Time budget')!.value;

      expect(value(withBudget)).toContain('5m 34s');
      expect(value(build())).toBe('No budget set');
    });
  });

  describe('it is structural, never predictive', () => {
    it('draws the whole pipeline while the feature is switched off', () => {
      // "What would routing do to this instrument" is the question to answer BEFORE switching on — the
      // same stance the comparability checks take.
      const graph = build({
        topics: [topic('open', 'opening'), topic('pricing', 'conditional')],
        settings: settings({ enabled: false }),
      });

      expect(edgeBetween(graph, GUARDRAILS_NODE_ID, 'conditional:pricing')).toBeDefined();
      expect(graph.nodes.find((n) => n.id === START_NODE_ID)?.sublabel).toContain('off');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Layout                                                                    */
  /* ------------------------------------------------------------------------ */

  describe('layout', () => {
    // A version shaped like the pilot instrument: a long conditional column, badged nodes in it, and a
    // two-line label — the three things a fixed row pitch cannot serve at once.
    const crowded: Topic[] = [
      topic('open', 'opening', { label: 'Opening — Situation, Goals, Challenges, Priorities' }),
      ...Array.from({ length: 12 }, (_, i) =>
        topic(`c${i}`, 'conditional', {
          label: `Conditional topic number ${i} with a label long enough to wrap`,
          ordinal: i,
        })
      ),
    ];

    /** Nodes sharing an x, in the order they were built — which is the order they are stacked in. */
    function column(graph: ScopeGraph, x: number) {
      return graph.nodes.filter((n) => n.x === x);
    }

    it('leaves clear air between every pair of stacked nodes', () => {
      const graph = build({
        topics: crowded,
        settings: settings({
          fallbackTopicKeys: ['c0'],
          checkTopicPreference: ['c0'],
        }),
        dataSlots: [slot('headcount')],
      });

      const xs = [...new Set(graph.nodes.map((n) => n.x))];
      for (const x of xs) {
        const stacked = column(graph, x).sort((a, b) => a.y - b.y);
        for (const [i, node] of stacked.entries()) {
          const next = stacked[i + 1];
          if (!next) continue;
          // The gap is measured from the node's *bottom* edge, so a tall node earns its own room
          // rather than borrowing its neighbour's.
          expect(next.y - (node.y + estimateNodeHeight(node))).toBeGreaterThan(24);
        }
      }
    });

    it('leaves a gutter between one column and the next that is wider than half a node', () => {
      const graph = build({ topics: crowded });

      const xs = [...new Set(graph.nodes.map((n) => n.x))].sort((a, b) => a - b);
      expect(xs.length).toBeGreaterThan(1);
      for (const [i, x] of xs.entries()) {
        const next = xs[i + 1];
        if (next === undefined) continue;
        expect(next - (x + ROUTING_MAP_NODE_WIDTH)).toBeGreaterThan(ROUTING_MAP_NODE_WIDTH / 2);
      }
    });

    it('gives a badged, two-line node more room than a bare one', () => {
      const bare = estimateNodeHeight({ label: 'Talent' });
      const dressed = estimateNodeHeight({
        label: 'Deal / Opportunity Management across the whole funnel',
        sublabel: '4 questions · 1m 9s and a second line of detail beyond that',
        badges: [
          { label: 'Fallback', tone: 'neutral' },
          { label: 'Preferred check', tone: 'neutral' },
        ],
      });

      expect(dressed).toBeGreaterThan(bare);
    });

    it('stacks the expanded band in one column, so the head fans out without crossing a box', () => {
      const band = Array.from({ length: 9 }, (_, i) =>
        topic(`a${i}`, 'core', { label: `Always-asked topic ${i}`, ordinal: i })
      );
      const graph = build({ topics: [...crowded, ...band], expandAlways: true });

      const items = graph.nodes.filter((n) => n.kind === 'always');
      expect(items).toHaveLength(9);

      // One `x` for the whole band: every topic gets a horizontal lane of its own, which is the only
      // layout in which nine edges out of one head can be drawn without running through a node.
      expect(new Set(items.map((n) => n.x)).size).toBe(1);
      expect(new Set(items.map((n) => n.y)).size).toBe(9);

      const stacked = [...items].sort((a, b) => a.y - b.y);
      for (const [i, node] of stacked.entries()) {
        const next = stacked[i + 1];
        if (!next) continue;
        expect(next.y - (node.y + estimateNodeHeight(node))).toBeGreaterThan(24);
      }
    });

    it('gives every column its own vertical lane, so no two adjacent columns share an edge run', () => {
      const graph = build({
        topics: crowded,
        settings: settings(),
        dataSlots: [slot('headcount')],
      });

      const centre = (id: string) => {
        const node = graph.nodes.find((n) => n.id === id)!;
        return node.y + estimateNodeHeight(node) / 2;
      };

      // The spine alternates rather than running dead flat...
      expect(Math.abs(centre('opening:open') - centre(START_NODE_ID))).toBeGreaterThan(24);
      expect(Math.abs(centre(PLANNER_NODE_ID) - centre('opening:open'))).toBeGreaterThan(24);
    });
  });

  describe('ordering', () => {
    it('lays topics out in ordinal order, not payload order', () => {
      const graph = build({
        topics: [
          topic('second', 'conditional', { ordinal: 5 }),
          topic('first', 'conditional', { ordinal: 1 }),
        ],
      });

      const y = (key: string) => graph.nodes.find((n) => n.id === `conditional:${key}`)!.y;
      expect(y('first')).toBeLessThan(y('second'));
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The detail panel's timing block                                          */
  /* ------------------------------------------------------------------------ */

  describe('what a topic’s duration is made of', () => {
    // Five members priced as the pilot instrument prices them: four ratings and one open question.
    const MEMBERS = ['q_a', 'q_b', 'q_c', 'q_d', 'q_open'];
    const INVENTORY: TopicQuestionRef[] = [
      question('q_a', 'likert', 8, 5),
      question('q_b', 'likert', 8, 4),
      question('q_c', 'likert', 8, 3),
      question('q_d', 'likert', 8, 2),
      question('q_open', 'free_text', 45, 1),
    ];
    const COST: TopicCost = { full: 77, light: 16 };

    // `null` rather than `undefined` for "the server priced nothing": an explicit `undefined` would
    // fall back to the default parameter and quietly test the opposite case.
    function buildTiming(overrides: Partial<Topic> = {}, cost: TopicCost | null = COST) {
      const subject = topic('sales', 'conditional', {
        members: { dataSlotKeys: [], questionKeys: MEMBERS },
        ...overrides,
      });
      const graph = build({
        topics: [subject],
        costs: costs(cost ? { byTopicKey: { sales: cost } } : {}),
        questions: INVENTORY,
      });
      return timingOf(graph, 'conditional:sales');
    }

    it('carries both figures and the depth the topic is actually set to', () => {
      const timing = buildTiming();

      expect(timing).toMatchObject({
        depth: 'full',
        fullSeconds: 77,
        lightSeconds: 16,
        memberCount: 5,
        lightMemberCount: 2,
      });
    });

    it('breaks the full figure into lines that add up to it, one line per rate', () => {
      const timing = buildTiming();

      expect(timing?.groups).toEqual([
        { label: 'Free text', count: 1, secondsEach: 45, seconds: 45 },
        { label: 'Likert', count: 4, secondsEach: 8, seconds: 32 },
      ]);
      const summed = timing?.groups.reduce((total, g) => total + g.seconds, 0);
      expect(summed).toBe(timing?.fullSeconds);
    });

    it('agrees with the arithmetic the server and the planner use', () => {
      // The panel would be worse than useless if its breakdown and the budget module disagreed: the
      // planner drops topics by the budget module's numbers, and an author reads these.
      const seconds = itemSeconds(
        INVENTORY.map((q) => ({ key: q.key, type: q.type })),
        [],
        settings()
      );
      const subject = topic('sales', 'conditional', {
        members: { dataSlotKeys: [], questionKeys: MEMBERS },
      });
      const priced = estimateTopicCosts([subject], seconds, {
        byQuestionKey: new Map(INVENTORY.map((q) => [q.key, q.weight])),
      });

      expect(priced.get('sales')).toEqual(COST);
    });

    it('names the members a light run samples — the highest-weighted, not the first authored', () => {
      const timing = buildTiming();

      expect(timing?.lightItems.map((i) => i.key)).toEqual(['q_a', 'q_b']);
      expect(timing?.lightItems[0]).toMatchObject({
        label: 'Prompt for q_a',
        typeLabel: 'Likert',
        seconds: 8,
      });
    });

    it('lists no light sample when a light run is the whole topic', () => {
      const timing = buildTiming(
        { members: { dataSlotKeys: [], questionKeys: ['q_a', 'q_b'] } },
        {
          full: 16,
          light: 16,
        }
      );

      expect(timing?.lightItems).toEqual([]);
    });

    it('samples up to two of EACH kind, because that is what the resolver does', () => {
      const graph = build({
        topics: [
          topic('sales', 'conditional', {
            members: { dataSlotKeys: ['s_a', 's_b', 's_c'], questionKeys: ['q_a', 'q_b', 'q_c'] },
          }),
        ],
        costs: costs({ byTopicKey: { sales: { full: 144, light: 96 } } }),
        questions: INVENTORY,
        dataSlots: [slot('s_a'), slot('s_b'), slot('s_c')],
      });

      const timing = timingOf(graph, 'conditional:sales');
      expect(timing?.lightMemberCount).toBe(4);
      expect(timing?.lightItems.map((i) => i.key)).toEqual(['q_a', 'q_b', 's_a', 's_b']);
    });

    it('counts members whose key the version no longer has, since they are charged nothing', () => {
      const timing = buildTiming({
        members: { dataSlotKeys: [], questionKeys: [...MEMBERS, 'q_deleted'] },
      });

      expect(timing?.memberCount).toBe(6);
      expect(timing?.unresolvedCount).toBe(1);
      expect(timing?.groups.reduce((total, g) => total + g.count, 0)).toBe(5);
    });

    it('claims no unresolved members when no inventory was supplied to price against', () => {
      const graph = build({
        topics: [topic('sales', 'conditional')],
        costs: costs({ byTopicKey: { sales: COST } }),
      });

      const timing = timingOf(graph, 'conditional:sales');
      expect(timing?.unresolvedCount).toBe(0);
      expect(timing?.groups).toEqual([]);
      expect(timing?.fullSeconds).toBe(77);
    });

    it('carries no timing at all for a topic the server did not price', () => {
      expect(buildTiming({}, null)).toBeUndefined();
    });

    it('gives opening and always-asked topics the same block, since both cost the same way', () => {
      const graph = build({
        topics: [topic('open', 'opening'), topic('wrap', 'closing')],
        costs: costs({
          byTopicKey: { open: { full: 45, light: 45 }, wrap: { full: 8, light: 8 } },
        }),
        questions: [question('q_open', 'free_text', 45), question('q_wrap', 'likert', 8)],
        expandAlways: true,
      });

      expect(timingOf(graph, 'opening:open')?.fullSeconds).toBe(45);
      expect(timingOf(graph, 'always:wrap')?.fullSeconds).toBe(8);
    });

    it('no longer prints bare duration rows — the figures live in the timing block', () => {
      const graph = build({
        topics: [topic('sales', 'conditional')],
        costs: costs({ byTopicKey: { sales: COST } }),
        questions: INVENTORY,
      });

      const labels = graph.nodes
        .find((n) => n.id === 'conditional:sales')!
        .detail.rows.map((r) => r.label);
      expect(labels).not.toContain('Full depth');
      expect(labels).not.toContain('Light depth');
    });

    it('counts only the light members it can actually name', () => {
      // Two questions is at or below `LIGHT_DEPTH_MEMBER_COUNT`, so `membersAtDepth` returns BOTH
      // without consulting weights — including the one whose question was deleted. That key costs
      // nothing and is dropped from `lightItems`, so counting it printed "the 4 members carrying the
      // most weight" above a list of three.
      const graph = build({
        topics: [
          topic('sales', 'conditional', {
            depth: 'light',
            members: {
              dataSlotKeys: ['s_a', 's_b', 's_c'],
              questionKeys: ['q_a', 'q_deleted'],
            },
          }),
        ],
        costs: costs({ byTopicKey: { sales: { full: 200, light: 80 } } }),
        questions: [question('q_a', 'free_text', 20, 9)],
        dataSlots: [slot('s_a'), slot('s_b'), slot('s_c')],
      });

      const timing = timingOf(graph, 'conditional:sales');
      expect(timing?.lightItems.map((i) => i.key)).toEqual(['q_a', 's_a', 's_b']);
      expect(timing?.lightMemberCount).toBe(3);
    });
  });

  describe('a topic keyed like an internal node', () => {
    // `ALWAYS_BAND_NODE_ID` and a topic node id are built from the same `always:` prefix, and
    // `topicKeySchema` permits the key `band`. A single colon put both on the canvas under one id:
    // React Flow got a duplicate node, a self-edge, and the dialog resolved that topic's clicks to
    // the band head. The double colon in the head's id is what makes the collision unreachable.
    const bandKeyed = () =>
      build({
        topics: [topic('band', 'core'), topic('pricing', 'conditional')],
        expandAlways: true,
      });

    it('does not collide with the always-asked band head', () => {
      const graph = bandKeyed();

      expect(new Set(ids(graph)).size).toBe(graph.nodes.length);
      expect(ids(graph)).toContain(ALWAYS_BAND_NODE_ID);
      expect(graph.nodes.filter((n) => n.id === ALWAYS_BAND_NODE_ID)).toHaveLength(1);
    });

    it('draws the head→topic edge rather than a self-edge', () => {
      const graph = bandKeyed();

      const own = graph.nodes.find((n) => n.detail.topicKey === 'band');
      expect(own).toBeDefined();
      expect(own!.id).not.toBe(ALWAYS_BAND_NODE_ID);
      expect(edgeBetween(graph, ALWAYS_BAND_NODE_ID, own!.id)).toBeDefined();
      expect(graph.edges.filter((e) => e.source === e.target)).toEqual([]);
    });
  });
});
