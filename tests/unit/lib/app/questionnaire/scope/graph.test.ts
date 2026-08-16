/**
 * Unit tests: the routing map's graph builder.
 *
 * The map is the only Adaptive Scope surface whose claims are made by *shape* rather than by prose, so
 * the assertions here are mostly about which edges exist and where they come from. Two families matter
 * most:
 *
 * 1. **Rule edges bypass the planner and the guardrails.** That is not decoration — it is the picture of
 *    `applyGuardrails` seating rule includes before the cap and never truncating them. An edge routed
 *    through the guardrails node would draw a limit that does not apply.
 * 2. **A rule's evidence is classified exactly as `validateAdaptiveScope` classifies it** — opening,
 *    `core`, or neither. The map is rendered directly beneath that validator's warnings, so a
 *    disagreement between the two would be visible on one screen.
 */

import { describe, expect, it } from 'vitest';

import {
  ALWAYS_BAND_NODE_ID,
  GUARDRAILS_NODE_ID,
  PLANNER_NODE_ID,
  START_NODE_ID,
  UNGATHERED_NODE_ID,
  buildScopeGraph,
  type BuildScopeGraphInput,
  type ScopeGraph,
} from '@/lib/app/questionnaire/scope/graph';
import { validateAdaptiveScope } from '@/lib/app/questionnaire/scope/validate';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type AdaptiveScopeSettings,
  type ScopeRule,
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
    ...overrides,
  };
}

function rule(overrides: Partial<ScopeRule> = {}): ScopeRule {
  return {
    id: 'r1',
    dataSlotKey: 'headcount',
    operator: 'gt',
    value: '50',
    action: 'include',
    topicKey: 'pricing',
    ordinal: 0,
    ...overrides,
  };
}

function settings(overrides: Partial<AdaptiveScopeSettings> = {}): AdaptiveScopeSettings {
  return { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true, ...overrides };
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
        settings: settings({ rules: [rule()] }),
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
        settings: settings({
          rules: [rule({ id: 'r1', topicKey: 'a' }), rule({ id: 'r2', topicKey: 'b' })],
        }),
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

  describe('hard rules', () => {
    it('routes a rule straight to its topic, bypassing the planner and the guardrails', () => {
      const graph = build({
        topics: [topic('open', 'opening'), topic('pricing', 'conditional')],
        settings: settings({ rules: [rule({ topicKey: 'pricing' })] }),
        dataSlots: [slot('headcount')],
      });

      const edge = edgeBetween(graph, 'rule:r1', 'conditional:pricing');
      expect(edge?.kind).toBe('ruleInclude');
      // The geometry is the argument: an include seated before the cap is not subject to it.
      expect(edgeBetween(graph, 'rule:r1', GUARDRAILS_NODE_ID)).toBeUndefined();
      expect(edgeBetween(graph, 'rule:r1', PLANNER_NODE_ID)).toBeUndefined();
    });

    it('distinguishes an exclude from an include', () => {
      const graph = build({
        topics: [topic('open', 'opening'), topic('pricing', 'conditional')],
        settings: settings({ rules: [rule({ action: 'exclude', topicKey: 'pricing' })] }),
        dataSlots: [slot('headcount')],
      });

      expect(edgeBetween(graph, 'rule:r1', 'conditional:pricing')?.kind).toBe('ruleExclude');
      expect(graph.nodes.find((n) => n.id === 'rule:r1')?.badges).toContainEqual({
        label: 'Exclude',
        tone: 'negative',
      });
    });

    it('draws no target edge for a rule naming a topic that does not exist, and badges it instead', () => {
      const graph = build({
        topics: [topic('open', 'opening')],
        settings: settings({ rules: [rule({ topicKey: 'gone' })] }),
        dataSlots: [slot('headcount')],
      });

      // An arrow into nothing reads as a rendering fault; a badge reads as the authoring fault it is.
      expect(graph.edges.filter((e) => e.source === 'rule:r1')).toHaveLength(0);
      expect(graph.nodes.find((n) => n.id === 'rule:r1')?.badges).toContainEqual({
        label: 'Unknown topic',
        tone: 'warning',
      });
    });

    it('names the data slot rather than its key, and omits the operand for a valueless operator', () => {
      const graph = build({
        topics: [topic('open', 'opening')],
        settings: settings({ rules: [rule({ operator: 'not_exists', value: null })] }),
        dataSlots: [slot('headcount', 'How many staff')],
      });

      const label = graph.nodes.find((n) => n.id === 'rule:r1')?.label ?? '';
      expect(label).toContain('How many staff');
      expect(label).toContain('was never answered');
      // `not_exists` takes no operand — an empty pair of quotes would read as a blank field.
      expect(label).not.toContain('“');
    });
  });

  describe('where a rule reads its evidence from', () => {
    const conditional = topic('pricing', 'conditional');

    it('draws a solid evidence edge when an opening topic gathers the slot', () => {
      const graph = build({
        topics: [
          topic('open', 'opening', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          conditional,
        ],
        settings: settings({ rules: [rule()] }),
        dataSlots: [slot('headcount')],
      });

      expect(edgeBetween(graph, 'opening:open', 'rule:r1')?.kind).toBe('evidence');
      expect(ids(graph)).not.toContain(UNGATHERED_NODE_ID);
    });

    it('weakens the edge when only a core topic gathers the slot', () => {
      // `rule_slot_not_in_opening`: core runs alongside the opening in an order nothing guarantees.
      const graph = build({
        topics: [
          topic('open', 'opening'),
          topic('spine', 'core', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          conditional,
        ],
        settings: settings({ rules: [rule()] }),
        dataSlots: [slot('headcount')],
      });

      const edge = graph.edges.find((e) => e.target === 'rule:r1');
      expect(edge?.kind).toBe('evidenceWeak');
      expect(edge?.label).toBe('timing not guaranteed');
      // Collapsed, the core topic is not on the canvas, so the edge anchors to the band's head.
      expect(edge?.source).toBe(ALWAYS_BAND_NODE_ID);
    });

    it('sharpens that edge to the exact core topic once the band is expanded', () => {
      const graph = build({
        topics: [
          topic('open', 'opening'),
          topic('spine', 'core', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          conditional,
        ],
        settings: settings({ rules: [rule()] }),
        dataSlots: [slot('headcount')],
        expandAlways: true,
      });

      expect(graph.edges.find((e) => e.target === 'rule:r1')?.source).toBe('always:spine');
    });

    it('hangs the rule off an explicit marker when nothing reachable gathers the slot', () => {
      const graph = build({
        topics: [topic('open', 'opening'), conditional],
        settings: settings({ rules: [rule()] }),
        dataSlots: [slot('headcount')],
      });

      expect(ids(graph)).toContain(UNGATHERED_NODE_ID);
      const edge = edgeBetween(graph, UNGATHERED_NODE_ID, 'rule:r1');
      expect(edge?.kind).toBe('evidenceWeak');
      expect(edge?.label).toBe('never gathered in time');
    });

    it('treats a conditional topic gathering the slot as no better than nothing', () => {
      // Matching `validateAdaptiveScope`, which buckets conditional and closing with "never gathered":
      // neither is in scope until after the decision that would have read it has been taken.
      const graph = build({
        topics: [
          topic('open', 'opening'),
          topic('pricing', 'conditional', {
            members: { dataSlotKeys: ['headcount'], questionKeys: [] },
          }),
        ],
        settings: settings({ rules: [rule()] }),
        dataSlots: [slot('headcount')],
      });

      expect(edgeBetween(graph, UNGATHERED_NODE_ID, 'rule:r1')).toBeDefined();
    });

    it('adds no marker when every rule reads an opening slot', () => {
      const graph = build({
        topics: [
          topic('open', 'opening', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          conditional,
        ],
        settings: settings({ rules: [rule()] }),
        dataSlots: [slot('headcount')],
      });

      expect(ids(graph)).not.toContain(UNGATHERED_NODE_ID);
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

    it('sits clear of the pipeline however tall the tallest column is', () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        topic(`c${i}`, 'conditional', { ordinal: i })
      );
      const graph = build({ topics: [...many, ...band] });

      const lowestPipelineY = Math.max(
        ...graph.nodes.filter((n) => n.kind === 'conditional').map((n) => n.y)
      );
      expect(graph.nodes.find((n) => n.id === ALWAYS_BAND_NODE_ID)!.y).toBeGreaterThan(
        lowestPipelineY
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
    it('offers every conditional topic to the guardrails even when a rule already excludes it', () => {
      // A rule's match depends on a session's fills, which do not exist while authoring. Suppressing the
      // candidate edge here would draw an outcome the map cannot know — the failure the dry-run exists
      // to answer instead.
      const graph = build({
        topics: [topic('open', 'opening'), topic('pricing', 'conditional')],
        settings: settings({ rules: [rule({ action: 'exclude', topicKey: 'pricing' })] }),
        dataSlots: [slot('headcount')],
      });

      expect(edgeBetween(graph, GUARDRAILS_NODE_ID, 'conditional:pricing')?.kind).toBe('candidate');
    });

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

  // The map is rendered on the same screen as `validateAdaptiveScope`'s findings, so the two must agree
  // about whether a rule can read what it tests. They compute it independently — the validator to word a
  // warning, the builder to choose an edge — which is exactly the pair that drifts silently.
  describe('it agrees with the validator about a rule’s reachability', () => {
    const conditional = topic('pricing', 'conditional');
    const REACHABILITY_CODES = [
      'rule_slot_unreachable',
      'rule_veto_always_fires',
      'rule_slot_not_in_opening',
    ];

    function verdicts(topics: Topic[], r: ScopeRule) {
      const s = settings({ rules: [r] });
      const graph = build({ topics, settings: s, dataSlots: [slot('headcount')] });
      const issues = validateAdaptiveScope({
        topics,
        settings: s,
        allQuestionKeys: topics.flatMap((t) => t.members.questionKeys),
        allDataSlotKeys: ['headcount'],
      });
      return {
        graphSaysWeak:
          graph.edges.find((e) => e.target === `rule:${r.id}`)?.kind === 'evidenceWeak',
        validatorComplains: issues.some((i) => REACHABILITY_CODES.includes(i.code)),
      };
    }

    it('agrees when the opening gathers the slot — solid edge, no finding', () => {
      const v = verdicts(
        [
          topic('open', 'opening', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          conditional,
        ],
        rule()
      );
      expect(v.graphSaysWeak).toBe(false);
      expect(v.validatorComplains).toBe(false);
    });

    it('agrees when only a core topic gathers it — weak edge, and a finding', () => {
      const v = verdicts(
        [
          topic('open', 'opening'),
          topic('spine', 'core', { members: { dataSlotKeys: ['headcount'], questionKeys: [] } }),
          conditional,
        ],
        rule()
      );
      expect(v.graphSaysWeak).toBe(true);
      expect(v.validatorComplains).toBe(true);
    });

    it('agrees when nothing gathers it — weak edge, and a finding', () => {
      const v = verdicts([topic('open', 'opening'), conditional], rule());
      expect(v.graphSaysWeak).toBe(true);
      expect(v.validatorComplains).toBe(true);
    });

    it('agrees about a veto reading an ungathered slot — the sharpest case of all', () => {
      const v = verdicts(
        [topic('open', 'opening'), conditional],
        rule({ operator: 'not_exists', value: null, action: 'exclude' })
      );
      expect(v.graphSaysWeak).toBe(true);
      expect(v.validatorComplains).toBe(true);
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

    it('lays rules out in ordinal order', () => {
      const graph = build({
        topics: [topic('open', 'opening'), topic('a', 'conditional')],
        settings: settings({
          rules: [
            rule({ id: 'late', ordinal: 9, topicKey: 'a' }),
            rule({ id: 'early', ordinal: 0, topicKey: 'a' }),
          ],
        }),
        dataSlots: [slot('headcount')],
      });

      const y = (id: string) => graph.nodes.find((n) => n.id === `rule:${id}`)!.y;
      expect(y('early')).toBeLessThan(y('late'));
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
  });
});
