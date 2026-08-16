/**
 * Adaptive Scope (P17) — the routing map's graph, built from the authoring payload.
 *
 * Turns a version's topics, hard rules and settings into a laid-out node/edge graph the admin canvas
 * renders. Pure: no Prisma, no Next, and deliberately **no `@xyflow/react` import** — it emits its own
 * neutral shape and the component maps that onto React Flow's `Node`/`Edge`. That keeps `scope/**` the
 * pure leaf the rest of the feature relies on, and lets the whole layout be asserted without a DOM.
 *
 * ## What is drawn, and what deliberately is not
 *
 * **There are no topic-to-topic edges, because there is no such mechanism.** Topics do not flow into one
 * another — a topic is selected or it is not. Arrows between them would draw a state machine the runtime
 * does not have. What Adaptive Scope actually is, is a decision pipeline, and the pipeline is what the
 * map shows:
 *
 * ```
 * start ──> opening topics ──> hard rules ──────────────────────────┐
 *       │                  └─> planner ──> guardrails ──> conditional topics
 *       └──────────────────────────────────> always asked (core + closing)
 * ```
 *
 * The geometry carries the one claim an author most often gets wrong: a rule edge **skips over** the
 * planner and the guardrails, because `applyGuardrails` seats rule includes before the cap and never
 * truncates them. A cap the model is imagined to be honouring, rather than one applied to its answer, is
 * the misreading the settings card's numbering already fights; here it is a picture.
 *
 * ## Structural, never predictive
 *
 * No fills exist at authoring time, so no rule can be evaluated and no plan can be known. Every rule
 * therefore draws its edge and the guardrails draw a candidate edge to every conditional topic — this is
 * the map of what **can** happen, not a forecast of what will. `evaluateScopeRules` and
 * `plannerCandidates` are deliberately not called: both need a session's fills, and a map that pretended
 * to have them would be a preview that lies. The dry-run card (F17.14) is the surface that answers "what
 * would this actually do".
 *
 * The one thing the structure *can* settle is where a rule's evidence comes from, and it classifies that
 * exactly as `validateAdaptiveScope` does — **opening, `core`, or neither**. A rule reading a slot the
 * opening does not gather never matches; for `not_exists` it is worse, and fires for everybody. Those
 * rules hang off an explicit "not gathered in the opening" node rather than off nothing, so the failure is
 * visible as a shape rather than only as a sentence in the findings list above the map.
 */

import type { TopicCost } from '@/lib/app/questionnaire/scope/budget';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import {
  SCOPE_RULE_OPERATOR_LABELS,
  TOPIC_DEPTH_LABELS,
  TOPIC_PHASE_LABELS,
  VALUELESS_SCOPE_OPERATORS,
  type AdaptiveScopeSettings,
  type ScopeRuleOperator,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';
import type { TopicDataSlotRef, TopicsCostView } from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a node stands for. The kind drives both the tone it is painted in and what the detail panel
 * offers — a topic node gets "Edit this topic", a guardrail node cannot.
 *
 * A rule's action is part of its kind rather than a field beside it, because include and exclude are
 * the one pair on this map that must never be confused at a glance. Splitting them here means the
 * renderer picks a colour and an icon by exhaustive lookup, with no branch that could fall through to
 * the wrong direction.
 */
export type ScopeNodeKind =
  | 'start'
  | 'opening'
  | 'ungathered'
  | 'ruleInclude'
  | 'ruleExclude'
  | 'planner'
  | 'guardrails'
  | 'conditional'
  | 'always'
  | 'alwaysBand';

/** A chip on a node. `tone` is advisory — the renderer maps it to colour. */
export interface ScopeNodeBadge {
  label: string;
  tone: 'neutral' | 'positive' | 'negative' | 'warning';
}

/** One line of the detail panel: a label and its value. */
export interface ScopeDetailRow {
  label: string;
  value: string;
}

/** Everything the detail panel shows for a node. */
export interface ScopeNodeDetail {
  title: string;
  /** A sentence or two on what this node is. Never a respondent-facing string. */
  summary: string;
  rows: ScopeDetailRow[];
  /**
   * The topic key, when this node IS a topic. Its presence is what enables the "Edit this topic"
   * jump — a guardrail or a rule has no row in the topic list to land on.
   */
  topicKey?: string;
  /** The author's criteria, verbatim and untruncated. Only conditional topics carry one. */
  criteria?: string;
}

/** One node, already positioned. */
export interface ScopeGraphNode {
  id: string;
  kind: ScopeNodeKind;
  x: number;
  y: number;
  label: string;
  /** The node's second line — a phase, a cost, an operator. */
  sublabel?: string;
  badges?: ScopeNodeBadge[];
  detail: ScopeNodeDetail;
}

/**
 * How an edge should read.
 *
 * - `always` — solid. Happens for every respondent.
 * - `candidate` — dashed. The agent *may* choose it; nothing here is settled at authoring time.
 * - `ruleInclude` / `ruleExclude` — an author's certainty, drawn as one. Both bypass the planner and
 *   the guardrails, which is exactly where they sit in `applyGuardrails`.
 * - `evidence` — an opening topic gathers the slot a rule reads.
 * - `evidenceWeak` — a `core` topic gathers it, or nothing reachable does. Either way the rule cannot
 *   rely on the slot having been filled by the moment the rules are evaluated.
 */
export type ScopeEdgeKind =
  'always' | 'candidate' | 'ruleInclude' | 'ruleExclude' | 'evidence' | 'evidenceWeak';

export interface ScopeGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: ScopeEdgeKind;
  label?: string;
}

export interface ScopeGraph {
  nodes: ScopeGraphNode[];
  edges: ScopeGraphEdge[];
}

export interface BuildScopeGraphInput {
  topics: readonly Topic[];
  settings: AdaptiveScopeSettings;
  costs: TopicsCostView;
  /** The version's data slots — for resolving a rule's slot key to the name an author recognises. */
  dataSlots: readonly TopicDataSlotRef[];
  /**
   * Fan the always-asked band out into one node per topic.
   *
   * Off by default at the call site, and that default is the point: ingest seeds one `core` topic per
   * extracted section, so fifteen-plus always-asked topics is the ordinary first sight of a version.
   * Drawn individually they crowd out the conditional band, which is the only part of the picture any
   * decision is ever taken about.
   */
  expandAlways: boolean;
}

/* -------------------------------------------------------------------------- */
/* Stable node ids                                                            */
/* -------------------------------------------------------------------------- */

export const START_NODE_ID = 'start';
export const PLANNER_NODE_ID = 'planner';
export const GUARDRAILS_NODE_ID = 'guardrails';
export const UNGATHERED_NODE_ID = 'ungathered';

/**
 * The always-asked band's head node — present whether or not the band is expanded.
 *
 * It stays on the canvas in both states on purpose. It is the band's only anchor: `start` points at it
 * rather than at fifteen individual topics, and a weak-evidence edge from a `core` topic falls back to
 * it while the band is collapsed. An edge whose endpoint is not on the canvas is silently dropped by
 * React Flow, so a head that came and went would take those edges with it.
 */
export const ALWAYS_BAND_NODE_ID = 'always:band';

const topicNodeId = (phase: 'opening' | 'conditional' | 'always', key: string): string =>
  `${phase}:${key}`;

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Column pitch and row pitch, in canvas units.
 *
 * Wider than `workflow-mappers.ts`'s 220/150 because these nodes carry more text — a topic node shows a
 * label, a cost and a membership count, where a workflow node shows an icon and a name.
 */
const X_STEP = 300;
const Y_STEP = 120;

/** Column index per stage. Fixed, because the pipeline's order is fixed. */
const COL = {
  start: 0,
  opening: 1,
  rule: 2,
  planner: 3,
  guardrails: 4,
  conditional: 5,
} as const;

/**
 * Vertical gap between the decision pipeline and the always-asked band beneath it.
 *
 * The band is drawn apart rather than interleaved because that separation IS the invariant: the planner
 * touches the conditional phase and nothing else, and a reader should be able to see which topics no
 * decision is ever taken about without reading a single label.
 */
const ALWAYS_BAND_GAP = 180;

/** How many expanded always-topics sit in one row before wrapping. */
const ALWAYS_BAND_COLUMNS = 4;

/** Centre a column of `count` nodes on y = 0, so the pipeline reads along one spine. */
function columnY(index: number, count: number): number {
  return (index - (count - 1) / 2) * Y_STEP;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function memberSummary(topic: Topic): string {
  const q = topic.members.questionKeys.length;
  const s = topic.members.dataSlotKeys.length;
  const parts: string[] = [];
  if (q > 0) parts.push(plural(q, 'question'));
  if (s > 0) parts.push(plural(s, 'data slot'));
  return parts.length > 0 ? parts.join(' · ') : 'no members';
}

/** The rows every topic node's detail panel shows, whatever its phase. */
function topicDetailRows(topic: Topic, cost: TopicCost | undefined): ScopeDetailRow[] {
  const rows: ScopeDetailRow[] = [
    { label: 'Key', value: topic.key },
    { label: 'Phase', value: TOPIC_PHASE_LABELS[topic.phase] },
    { label: 'Depth', value: TOPIC_DEPTH_LABELS[topic.depth] },
    { label: 'Members', value: memberSummary(topic) },
  ];
  if (cost) {
    rows.push({ label: 'Full depth', value: formatSeconds(cost.full) });
    // Only worth a line when it differs: for a one- or two-member topic the light sample IS the topic,
    // and a second identical duration reads as a rounding artefact rather than as the same number twice.
    if (cost.light !== cost.full) {
      rows.push({ label: 'Light depth', value: formatSeconds(cost.light) });
    }
  }
  return rows;
}

/**
 * Render a rule the way the rules editor states it: subject, operator, operand.
 *
 * `exists` / `not_exists` take no operand (`VALUELESS_SCOPE_OPERATORS`), and printing an empty pair of
 * quotes after them would suggest the author left a field blank.
 */
function ruleSentence(slotName: string, operator: ScopeRuleOperator, value: string | null): string {
  const verb = SCOPE_RULE_OPERATOR_LABELS[operator];
  if (VALUELESS_SCOPE_OPERATORS.includes(operator)) return `${slotName} ${verb}`;
  return `${slotName} ${verb} “${value ?? ''}”`;
}

function byOrdinal(a: Topic, b: Topic): number {
  return a.ordinal - b.ordinal;
}

/* -------------------------------------------------------------------------- */
/* The builder                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the routing map for one version.
 *
 * Deterministic and total: an empty topic set yields the start node and an empty band, so the canvas
 * always has something to render rather than collapsing to a blank rectangle an author reads as a bug.
 */
export function buildScopeGraph(input: BuildScopeGraphInput): ScopeGraph {
  const { topics, settings, costs, dataSlots, expandAlways } = input;

  const nodes: ScopeGraphNode[] = [];
  const edges: ScopeGraphEdge[] = [];

  const byPhase = (phase: TopicPhase): Topic[] =>
    topics.filter((t) => t.phase === phase).sort(byOrdinal);

  const opening = byPhase('opening');
  const conditional = byPhase('conditional');
  const always = [...byPhase('core'), ...byPhase('closing')];

  const topicByKey = new Map(topics.map((t) => [t.key, t]));
  const slotNameByKey = new Map(dataSlots.map((s) => [s.key, s.name]));
  const fallbackKeys = new Set(settings.fallbackTopicKeys);
  const checkPreference = new Set(settings.checkTopicPreference);

  /* --- start ------------------------------------------------------------- */

  nodes.push({
    id: START_NODE_ID,
    kind: 'start',
    x: COL.start * X_STEP,
    y: 0,
    label: 'Interview starts',
    sublabel: settings.enabled ? 'adaptive scope on' : 'adaptive scope off',
    detail: {
      title: 'Interview starts',
      summary:
        'Every respondent begins here. The opening runs first, and what they say in it is the only evidence the routing decision ever reads.',
      rows: [
        { label: 'Adaptive scope', value: settings.enabled ? 'On' : 'Off' },
        { label: 'Topics', value: plural(topics.length, 'topic') },
      ],
    },
  });

  /* --- opening ----------------------------------------------------------- */

  for (const [i, topic] of opening.entries()) {
    const id = topicNodeId('opening', topic.key);
    nodes.push({
      id,
      kind: 'opening',
      x: COL.opening * X_STEP,
      y: columnY(i, opening.length),
      label: topic.label,
      sublabel: memberSummary(topic),
      detail: {
        title: topic.label,
        summary:
          'Runs first, for everyone. What the respondent says here is what the hard rules test and what the agent reads. The routing decision waits until every member of every opening topic is covered.',
        rows: topicDetailRows(topic, costs.byTopicKey[topic.key]),
        topicKey: topic.key,
      },
    });
    edges.push({ id: `e:start:${id}`, source: START_NODE_ID, target: id, kind: 'always' });
  }

  /* --- where each rule's evidence comes from ------------------------------ */

  // Classified exactly as `validateAdaptiveScope` classifies it, and for the same reason: rules are
  // evaluated at one moment — when the opening completes — so only the opening reliably has an answer by
  // then. `core` runs alongside it in an order nothing guarantees; `conditional` and `closing` are by
  // construction not in scope until the plan exists, which puts them in the same bucket as a slot no
  // topic gathers at all. If this drifted from the validator the map would contradict the warning
  // printed directly above it.
  const openingSlotOwner = new Map<string, string>();
  for (const topic of opening) {
    for (const key of topic.members.dataSlotKeys) {
      if (!openingSlotOwner.has(key)) openingSlotOwner.set(key, topic.key);
    }
  }
  const coreSlotOwner = new Map<string, string>();
  for (const topic of topics) {
    if (topic.phase !== 'core') continue;
    for (const key of topic.members.dataSlotKeys) {
      if (!coreSlotOwner.has(key)) coreSlotOwner.set(key, topic.key);
    }
  }

  const rules = [...settings.rules].sort((a, b) => a.ordinal - b.ordinal);
  const needsUngathered = rules.some(
    (r) => !openingSlotOwner.has(r.dataSlotKey) && !coreSlotOwner.has(r.dataSlotKey)
  );

  if (needsUngathered) {
    nodes.push({
      id: UNGATHERED_NODE_ID,
      kind: 'ungathered',
      // Seated at the foot of the opening column: it stands where the evidence would have come from.
      x: COL.opening * X_STEP,
      y: columnY(opening.length, opening.length + 1),
      label: 'Not gathered in the opening',
      sublabel: 'the rules beside this have nothing to read',
      badges: [{ label: 'Check this', tone: 'warning' }],
      detail: {
        title: 'Not gathered in the opening',
        summary:
          'Hard rules are evaluated at exactly one moment — when the opening completes — so a rule can only read a data slot the opening gathered. A rule reading anything else never matches. The exception is worse: “was never answered” matches on absence, so an ungathered slot makes that rule fire for every respondent.',
        rows: [
          { label: 'Fix', value: 'Add the data slot to an opening topic, or drop the rule.' },
          {
            label: 'Note',
            value:
              'A conditional or closing topic gathering the slot does not help — neither is in scope until after the decision has been taken.',
          },
        ],
      },
    });
  }

  /* --- hard rules --------------------------------------------------------- */

  for (const [i, rule] of rules.entries()) {
    const id = `rule:${rule.id}`;
    const slotName = slotNameByKey.get(rule.dataSlotKey) ?? `${rule.dataSlotKey} (missing)`;
    const target = topicByKey.get(rule.topicKey);
    const include = rule.action === 'include';

    const badges: ScopeNodeBadge[] = [
      { label: include ? 'Include' : 'Exclude', tone: include ? 'positive' : 'negative' },
    ];
    if (!target) badges.push({ label: 'Unknown topic', tone: 'warning' });

    nodes.push({
      id,
      kind: include ? 'ruleInclude' : 'ruleExclude',
      x: COL.rule * X_STEP,
      y: columnY(i, rules.length),
      label: ruleSentence(slotName, rule.operator, rule.value),
      sublabel: `${include ? 'always include' : 'never include'} ${target?.label ?? rule.topicKey}`,
      badges,
      detail: {
        title: 'Hard rule',
        summary: include
          ? 'Checked before the agent runs, and seated before the cap — an author’s “always” is never truncated by a limit, so a plan can legitimately hold more topics than the cap allows.'
          : 'Checked before the agent runs. Exclude beats include: a topic vetoed here stays out however many other rules ask for it.',
        rows: [
          { label: 'Reads', value: slotName },
          { label: 'When', value: ruleSentence(slotName, rule.operator, rule.value) },
          { label: 'Then', value: include ? 'always include' : 'never include' },
          { label: 'Topic', value: target ? target.label : `${rule.topicKey} — no such topic` },
        ],
      },
    });

    // Where the evidence comes from — and, when it comes from nowhere, saying so.
    const openingOwner = openingSlotOwner.get(rule.dataSlotKey);
    if (openingOwner) {
      const source = topicNodeId('opening', openingOwner);
      edges.push({ id: `e:${source}:${id}`, source, target: id, kind: 'evidence' });
    } else {
      const coreOwner = coreSlotOwner.get(rule.dataSlotKey);
      // While the band is collapsed the individual core topic is not on the canvas, so the edge falls
      // back to the band's head. It still tells the truth — the slot is gathered by something that is
      // not the opening — and expanding the band sharpens it to the exact topic.
      const source = coreOwner
        ? expandAlways
          ? topicNodeId('always', coreOwner)
          : ALWAYS_BAND_NODE_ID
        : UNGATHERED_NODE_ID;
      edges.push({
        id: `e:${source}:${id}`,
        source,
        target: id,
        kind: 'evidenceWeak',
        label: coreOwner ? 'timing not guaranteed' : 'never gathered in time',
      });
    }

    // A rule naming a topic that does not exist draws no target edge: an arrow into nothing reads as a
    // rendering fault, where the badge on the node reads as the authoring fault it is.
    if (target && target.phase === 'conditional') {
      edges.push({
        id: `e:${id}:${topicNodeId('conditional', target.key)}`,
        source: id,
        target: topicNodeId('conditional', target.key),
        kind: include ? 'ruleInclude' : 'ruleExclude',
      });
    }
  }

  /* --- the planner -------------------------------------------------------- */

  nodes.push({
    id: PLANNER_NODE_ID,
    kind: 'planner',
    x: COL.planner * X_STEP,
    y: 0,
    label: 'The agent decides',
    sublabel: plural(conditional.length, 'candidate'),
    badges: [{ label: 'AI', tone: 'neutral' }],
    detail: {
      title: 'The agent decides',
      summary:
        'One call, once, when the opening completes. It reads what the respondent said and what was captured from it, weighs each conditional topic’s criteria, and proposes a set. It never gets the last word — everything it returns passes through the guardrails.',
      rows: [
        { label: 'Candidates', value: plural(conditional.length, 'conditional topic') },
        { label: 'Confidence floor', value: settings.minConfidence.toFixed(2) },
        {
          label: 'Extra instructions',
          value: settings.plannerInstructions.trim().length > 0 ? 'Set' : 'None',
        },
      ],
    },
  });
  for (const topic of opening) {
    const source = topicNodeId('opening', topic.key);
    edges.push({ id: `e:${source}:planner`, source, target: PLANNER_NODE_ID, kind: 'always' });
  }
  // With no opening topic the pipeline still has to read as one — and this IS the `no_opening_topic`
  // finding: the planner would run on the first turn, over an empty transcript.
  if (opening.length === 0) {
    edges.push({
      id: 'e:start:planner',
      source: START_NODE_ID,
      target: PLANNER_NODE_ID,
      kind: 'always',
    });
  }

  /* --- guardrails --------------------------------------------------------- */

  const budgetValue =
    settings.sessionBudgetSeconds > 0
      ? `${formatSeconds(settings.sessionBudgetSeconds)} — ${formatSeconds(costs.routedAllowanceSeconds)} left once the always-asked topics are paid for`
      : 'No budget set';

  nodes.push({
    id: GUARDRAILS_NODE_ID,
    kind: 'guardrails',
    x: COL.guardrails * X_STEP,
    y: 0,
    label: 'Guardrails',
    sublabel: `at most ${plural(settings.maxConditionalTopics, 'topic')}`,
    detail: {
      title: 'Guardrails',
      summary:
        'Applied to the agent’s answer, in this order: the cap, the fallback if nothing was seated at all, the time fit, then the blind-spot check. Deterministic code, not a request the model is trusted to honour — which is why the rule edges above arrive already seated and pass straight through.',
      rows: [
        { label: 'Cap', value: plural(settings.maxConditionalTopics, 'conditional topic') },
        { label: 'Time budget', value: budgetValue },
        {
          label: 'Fallback',
          value:
            settings.fallbackTopicKeys.length > 0
              ? `${plural(settings.fallbackTopicKeys.length, 'topic')}, used only when nothing is seated`
              : 'None — a failed decision runs the always-asked topics only',
        },
        {
          label: 'Blind-spot check',
          value: settings.includeCheckTopic
            ? 'On — one topic that was not selected is sampled at light depth'
            : 'Off',
        },
      ],
    },
  });
  edges.push({
    id: 'e:planner:guardrails',
    source: PLANNER_NODE_ID,
    target: GUARDRAILS_NODE_ID,
    kind: 'always',
  });

  /* --- conditional topics -------------------------------------------------- */

  for (const [i, topic] of conditional.entries()) {
    const id = topicNodeId('conditional', topic.key);
    const cost = costs.byTopicKey[topic.key];
    const badges: ScopeNodeBadge[] = [];
    if (!topic.criteria || topic.criteria.trim().length === 0) {
      badges.push({ label: 'No criteria', tone: 'warning' });
    }
    if (fallbackKeys.has(topic.key)) badges.push({ label: 'Fallback', tone: 'neutral' });
    if (checkPreference.has(topic.key)) badges.push({ label: 'Preferred check', tone: 'neutral' });

    nodes.push({
      id,
      kind: 'conditional',
      x: COL.conditional * X_STEP,
      y: columnY(i, conditional.length),
      label: topic.label,
      sublabel: cost
        ? `${memberSummary(topic)} · ${formatSeconds(cost.full)}`
        : memberSummary(topic),
      ...(badges.length > 0 ? { badges } : {}),
      detail: {
        title: topic.label,
        summary:
          'Asked only when it is selected. Nothing on this map says whether it will be — that depends on what a respondent says, which is what “Try it” on the Adaptive scope tab answers.',
        rows: topicDetailRows(topic, cost),
        topicKey: topic.key,
        ...(topic.criteria && topic.criteria.trim().length > 0 ? { criteria: topic.criteria } : {}),
      },
    });
    edges.push({
      id: `e:guardrails:${id}`,
      source: GUARDRAILS_NODE_ID,
      target: id,
      kind: 'candidate',
    });
  }

  /* --- the always-asked band ------------------------------------------------ */

  // Seated below the deepest point of the pipeline so the two never overlap, whichever column is tallest.
  const tallest = Math.max(
    opening.length + (needsUngathered ? 1 : 0),
    rules.length,
    conditional.length,
    1
  );
  const bandY = ((tallest - 1) / 2) * Y_STEP + ALWAYS_BAND_GAP;

  nodes.push({
    id: ALWAYS_BAND_NODE_ID,
    kind: 'alwaysBand',
    x: COL.opening * X_STEP,
    y: bandY,
    label:
      always.length > 0
        ? `Always asked — ${plural(always.length, 'topic')}`
        : 'Nothing else is always asked',
    ...(costs.alwaysSeconds > 0
      ? { sublabel: `${formatSeconds(costs.alwaysSeconds)} of the interview, before any routing` }
      : {}),
    detail: {
      title: 'Always asked',
      summary:
        'Core and closing topics run for every respondent whatever they say. They are drawn apart from the pipeline because no decision is ever taken about them — the agent only ever chooses between conditional topics. Their cost is spent before the routed allowance is worked out, which is why a heavy always-asked set leaves less room for anything else.',
      rows: [
        { label: 'Topics', value: `${always.length}` },
        { label: 'Cost', value: formatSeconds(costs.alwaysSeconds) },
        {
          label: 'Includes',
          value: always.length > 0 ? always.map((t) => t.label).join(', ') : 'the opening only',
        },
      ],
    },
  });
  edges.push({
    id: `e:start:${ALWAYS_BAND_NODE_ID}`,
    source: START_NODE_ID,
    target: ALWAYS_BAND_NODE_ID,
    kind: 'always',
  });

  if (expandAlways) {
    for (const [i, topic] of always.entries()) {
      const id = topicNodeId('always', topic.key);
      nodes.push({
        id,
        kind: 'always',
        // Laid out left to right and wrapped, rather than down a column: the band is a list, not a stage
        // of the pipeline, and stacking it vertically would make it read as one.
        x: (COL.rule + (i % ALWAYS_BAND_COLUMNS)) * X_STEP,
        y: bandY + Math.floor(i / ALWAYS_BAND_COLUMNS) * Y_STEP,
        label: topic.label,
        sublabel: `${TOPIC_PHASE_LABELS[topic.phase]} · ${memberSummary(topic)}`,
        detail: {
          title: topic.label,
          summary:
            'Runs for every respondent. No decision is ever taken about it, which is why it sits outside the pipeline above.',
          rows: topicDetailRows(topic, costs.byTopicKey[topic.key]),
          topicKey: topic.key,
        },
      });
      edges.push({
        id: `e:${ALWAYS_BAND_NODE_ID}:${id}`,
        source: ALWAYS_BAND_NODE_ID,
        target: id,
        kind: 'always',
      });
    }
  }

  return { nodes, edges };
}
