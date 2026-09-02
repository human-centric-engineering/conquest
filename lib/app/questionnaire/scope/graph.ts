/**
 * Conditional Topics (P17) — the routing map's graph, built from the authoring payload.
 *
 * Turns a version's topics and settings into a laid-out node/edge graph the admin canvas
 * renders. Pure: no Prisma, no Next, and deliberately **no `@xyflow/react` import** — it emits its own
 * neutral shape and the component maps that onto React Flow's `Node`/`Edge`. That keeps `scope/**` the
 * pure leaf the rest of the feature relies on, and lets the whole layout be asserted without a DOM.
 *
 * ## What is drawn, and what deliberately is not
 *
 * **There are no topic-to-topic edges, because there is no such mechanism.** Topics do not flow into one
 * another — a topic is selected or it is not. Arrows between them would draw a state machine the runtime
 * does not have. What Conditional Topics actually is, is a decision pipeline, and the pipeline is what the
 * map shows:
 *
 * ```
 * start ──> opening topics ──> planner ──> guardrails ──> conditional topics
 *       └──────────────────────────────────> always asked (core + closing)
 * ```
 *
 * The geometry carries the one claim an author most often gets wrong: the cap is applied to the
 * model's answer rather than honoured by the model. A cap the model is imagined to be obeying is
 * the misreading the settings card's numbering already fights; here it is a picture.
 *
 * ## Structural, never predictive
 *
 * No fills exist at authoring time, so no plan can be known. The guardrails therefore draw a candidate
 * edge to every conditional topic — this is the map of what **can** happen, not a forecast of what will.
 * The dry-run card (F17.14) is the surface that answers "what would this actually do".
 */

import type { TopicCost } from '@/lib/app/questionnaire/scope/budget';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import { membersAtDepth } from '@/lib/app/questionnaire/scope/resolve';
import { questionTypeLabel } from '@/lib/app/questionnaire/types';
import {
  TOPIC_DEPTH_LABELS,
  TOPIC_PHASE_LABELS,
  type ConditionalTopicsSettings,
  type Topic,
  type TopicDepth,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';
import type {
  TopicDataSlotRef,
  TopicQuestionRef,
  TopicsCostView,
} from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a node stands for. The kind drives both the tone it is painted in and what the detail panel
 * offers — a topic node gets "Edit this topic", a guardrail node cannot.
 *
 */
export type ScopeNodeKind =
  'start' | 'opening' | 'planner' | 'guardrails' | 'conditional' | 'always' | 'alwaysBand';

/** A chip on a node. `tone` is advisory — the renderer maps it to colour. */
export interface ScopeNodeBadge {
  label: string;
  tone: 'neutral' | 'positive' | 'negative' | 'warning';
}

/**
 * Every badge the map can draw, and what it means.
 *
 * A badge is the shortest thing on a node and the only one written in the system's own vocabulary —
 * `Fallback` and `Preferred check` name guardrail mechanics that an author has met once, in a settings
 * field, possibly weeks ago. Two words on a node cannot carry that, and the detail panel is where a
 * reader goes when a node does not explain itself, so the meanings live beside the badges here rather
 * than in the renderer: the pill and its sentence are built from one table and cannot drift apart.
 *
 * Keyed by the badge's own label, so a badge added without a meaning fails the exhaustiveness check
 * below rather than shipping an unexplained chip.
 */
export const SCOPE_BADGES = {
  noCriteria: {
    label: 'No criteria',
    tone: 'warning',
    meaning:
      'There is nothing here for the agent to judge this topic on. It reads each conditional topic’s criteria when it decides what to ask, so with none written, this topic can only be asked because it is a fallback, or because the blind-spot check picks it.',
  },
  fallback: {
    label: 'Fallback',
    tone: 'neutral',
    meaning:
      'Named as a fallback on the Conditional topics tab. It is used only when the decision chooses nothing at all: if the agent fails, or picks no topics, the fallback topics are asked instead, so the respondent gets more than the always-asked ones. It is not a preference — on a normal run it changes nothing.',
  },
  preferredCheck: {
    label: 'Preferred check',
    tone: 'neutral',
    meaning:
      'First in line for the blind-spot check. When that check is on, one topic the agent did NOT choose is asked anyway, at Light depth — just its most important few questions. This topic is picked ahead of the others whenever it is available.',
  },
  checkThis: {
    label: 'Check this',
    tone: 'warning',
    meaning:
      'Something to fix before you publish this version. It is not something that varies from one respondent to the next.',
  },
  ai: {
    label: 'AI',
    tone: 'neutral',
    meaning:
      'The only step on this map that makes a judgement. Everything it chooses still has to get past the guardrails.',
  },
} as const satisfies Record<string, ScopeNodeBadge & { meaning: string }>;

type ScopeBadgeKey = keyof typeof SCOPE_BADGES;

/** The badge as a node carries it — label and tone only, with the meaning left for the panel. */
function badge(key: ScopeBadgeKey): ScopeNodeBadge {
  const { label, tone } = SCOPE_BADGES[key];
  return { label, tone };
}

/** A badge on a node, paired with what it means. What the detail panel renders. */
export interface ScopeBadgeNote {
  label: string;
  tone: ScopeNodeBadge['tone'];
  meaning: string;
}

/** The notes for a node's badges, in the order the node draws them. */
function badgeNotes(keys: readonly ScopeBadgeKey[]): ScopeBadgeNote[] {
  return keys.map((key) => ({ ...SCOPE_BADGES[key] }));
}

/** One line of the detail panel: a label and its value. */
export interface ScopeDetailRow {
  label: string;
  value: string;
}

/**
 * One line of the arithmetic behind a topic's estimate: a rate, how many things are charged at it,
 * and what that comes to.
 *
 * Grouped by rate rather than by type, so a 6-row matrix and a 3-row matrix land in separate lines
 * instead of averaging into a rate that prices neither of them. A reader can add the column up.
 */
export interface ScopeTimingGroup {
  /** What is being charged — a question type's label, or "Data slot". */
  label: string;
  count: number;
  /** Seconds one of these costs. */
  secondsEach: number;
  /** `count * secondsEach`. */
  seconds: number;
}

/** One member of a topic, priced. Used to name the members a light run actually asks. */
export interface ScopeTimingItem {
  key: string;
  /** The question's prompt or the data slot's name — what the author recognises it by. */
  label: string;
  typeLabel: string;
  seconds: number;
}

/**
 * Where a topic's two duration figures come from — the estimate with its assumptions attached.
 *
 * The panel used to print "Full depth 1m 17s" and nothing else, which is a number with no
 * provenance: an author could not tell whether it was measured, guessed, or a property of the chat
 * at all. Everything needed to reconstruct it is carried here instead — the per-rate arithmetic, the
 * members a light run samples, and the count of members that price at nothing because their key no
 * longer resolves.
 *
 * What it deliberately does NOT model is stated at the surface rather than encoded here: the
 * estimate is the respondent's answering time, item by item. The agent's own turns, its follow-ups
 * and any clarifying back-and-forth are not in it, so a real conversation runs longer than the
 * figure. That is a property of `scope/budget.ts` — this type just makes it visible.
 */
export interface ScopeNodeTiming {
  /** The depth this topic is authored at, so the panel can mark which figure actually applies. */
  depth: TopicDepth;
  fullSeconds: number;
  lightSeconds: number;
  /** Members the topic names — questions plus data slots, resolvable or not. */
  memberCount: number;
  /** Members a light run asks — up to two of EACH kind (`LIGHT_DEPTH_MEMBER_COUNT`), not overall. */
  lightMemberCount: number;
  /** The arithmetic behind {@link fullSeconds}, heaviest line first. */
  groups: ScopeTimingGroup[];
  /** The members a light run samples, named. Empty when light and full are the same run. */
  lightItems: ScopeTimingItem[];
  /** Members naming a key the version no longer has. They cost nothing, and that is worth saying. */
  unresolvedCount: number;
}

/** Everything the detail panel shows for a node. */
export interface ScopeNodeDetail {
  title: string;
  /** A sentence or two on what this node is. Never a respondent-facing string. */
  summary: string;
  rows: ScopeDetailRow[];
  /**
   * The topic key, when this node IS a topic. Its presence is what enables the "Edit this topic"
   * jump — a guardrail has no row in the topic list to land on.
   */
  topicKey?: string;
  /** The author's criteria, verbatim and untruncated. Only conditional topics carry one. */
  criteria?: string;
  /** Where this topic's duration figures come from. Only topic nodes carry one. */
  timing?: ScopeNodeTiming;
  /**
   * What each badge on the node means, in the order the node draws them.
   *
   * A node never carries a badge the panel cannot explain: both are built from `SCOPE_BADGES` in the
   * same place, so a pill that appears on the map always has a sentence behind it.
   */
  badgeNotes?: ScopeBadgeNote[];
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
 */
export type ScopeEdgeKind = 'always' | 'candidate';

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
  settings: ConditionalTopicsSettings;
  costs: TopicsCostView;
  /** The version's data slots, priced for the timing figures on each topic node. */
  dataSlots: readonly TopicDataSlotRef[];
  /**
   * The version's questions, priced.
   *
   * Only the detail panel's timing breakdown reads them, and it reads them for one reason: a
   * duration an author cannot take apart is a duration they cannot trust. Optional so a caller that
   * only wants the shape of the map — the layout tests, chiefly — need not build an inventory; the
   * figures then fall back to the server's per-topic totals with no arithmetic behind them.
   */
  questions?: readonly TopicQuestionRef[];
  /**
   * Fan the always-asked band out into one node per topic.
   *
   * On by default at the call site. It was off while the band was drawn as a wrapped row — ingest seeds
   * one `core` topic per extracted section, so fifteen-plus always-asked topics is the ordinary first
   * sight of a version, and wrapped they crowded out the conditional band the map exists to explain.
   * Stacked in a column of their own, clear of every other stage's `x`, they cost the rest of the
   * picture nothing. The flag stays because putting the band away is still worth one click.
   */
  expandAlways: boolean;
}

/* -------------------------------------------------------------------------- */
/* Stable node ids                                                            */
/* -------------------------------------------------------------------------- */

export const START_NODE_ID = 'start';
export const PLANNER_NODE_ID = 'planner';
export const GUARDRAILS_NODE_ID = 'guardrails';

/**
 * The always-asked band's head node — present whether or not the band is expanded.
 *
 * It stays on the canvas in both states on purpose. It is the band's only anchor: `start` points at it
 * rather than at fifteen individual topics. An edge whose endpoint is not on the canvas is silently
 * dropped by React Flow, so a head that came and went would take those edges with it.
 */
export const ALWAYS_BAND_NODE_ID = 'always::band';

/**
 * A topic node's id.
 *
 * The double colon in {@link ALWAYS_BAND_NODE_ID} is what keeps the head out of this namespace. Topic
 * keys are `^[a-z0-9_]+$` (`topicKeySchema`), so no key can ever produce `always::band` — where a
 * single colon would have collided with a topic legitimately keyed `band`, putting two nodes on the
 * canvas under one id, drawing a self-edge, and resolving that topic's clicks to the band head.
 */
const topicNodeId = (phase: 'opening' | 'conditional' | 'always', key: string): string =>
  `${phase}:${key}`;

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Column pitch, in canvas units.
 *
 * Expressed as the node's own width plus the clear air either side of it, rather than as one opaque
 * number, because the gutter is the thing being tuned: at the old 300 pitch a 236-wide node left 64px
 * between one column and the next, which at the zoom `fitView` picks for a twelve-topic column read as
 * boxes touching. The gap is now wider than half a node, which is what makes a column legible as a
 * column at any zoom.
 */
export const ROUTING_MAP_NODE_WIDTH = 236;
const COLUMN_GAP = 120;
const X_STEP = ROUTING_MAP_NODE_WIDTH + COLUMN_GAP;

/** Clear air between two stacked nodes. Not a pitch — the pitch is this plus the node's own height. */
const ROW_GAP = 52;

/** Column index per stage. Fixed, because the pipeline's order is fixed. */
const COL = {
  start: 0,
  opening: 1,
  planner: 2,
  guardrails: 3,
  conditional: 4,
} as const;

type ColumnKey = keyof typeof COL;

/**
 * The vertical lane each column is centred on. Every column on y = 0 is what made the first map
 * unreadable, and not because it looked flat.
 *
 * A left-to-right graph draws its edges as horizontal runs. Put every column on one centre line and
 * each of those runs lands in the same horizontal band, so a reader cannot tell an edge that stops at
 * a node from one that merely passes behind it. Offsetting a column moves its outbound runs into a lane
 * of their own, and the diagonals that result are the cheapest signal that two nodes are not the same
 * kind of thing.
 */
const LANE: Record<ColumnKey, number> = {
  start: 0,
  opening: 56,
  planner: -56,
  guardrails: 0,
  conditional: 0,
};

const COLUMN_KEYS = Object.keys(COL) as ColumnKey[];
const laneByX = new Map<number, number>(COLUMN_KEYS.map((key) => [COL[key] * X_STEP, LANE[key]]));

/**
 * Vertical gap between the decision pipeline and the always-asked band beneath it.
 *
 * The band is drawn apart rather than interleaved because that separation IS the invariant: the planner
 * touches the conditional phase and nothing else, and a reader should be able to see which topics no
 * decision is ever taken about without reading a single label.
 */
const ALWAYS_BAND_GAP = 180;

/**
 * The column an expanded always-asked topic sits in — one to the right of the band's head, exactly as
 * the conditional topics sit one to the right of the guardrails.
 *
 * An earlier cut wrapped the band left-to-right across three columns, on the reasoning that a list
 * should not be drawn as a stage of the pipeline. It drew a picture that lied: every topic hangs off the
 * one head node, and a fan-out of N edges can only be drawn without running through a box if every
 * target has a horizontal lane to itself. Wrapped, the head's edge to the third topic was drawn straight
 * through the first two. The band is kept from reading as a stage by what it is drawn in — dashed
 * borders, muted fill, `ALWAYS_BAND_GAP` of clear air — not by which way it wraps.
 *
 * It also keeps the whole band inside one `x`, so it only ever has to clear the two short columns it
 * hangs beneath and never the twelve-topic conditional column away to the right.
 *
 * **Why the band sits under the first two columns.** Every edge on this map must run left to right:
 * React Flow leaves each node's source handle on the right and its target handle on the left, so an
 * edge between two nodes sharing an `x` is drawn as a backwards loop around both of them. Keeping the
 * band here puts every edge it touches on a left-to-right run. The one edge that cannot be —
 * `start` → head, vertically below it — is why the head is the only node on the map whose inbound
 * handle is on top. See `routing-map-node.tsx`.
 */
const ALWAYS_BAND_HEAD_COLUMN = COL.start;
const ALWAYS_BAND_COLUMN = COL.opening;

/* --- how tall a node will render ------------------------------------------ */

/**
 * A node's rendered height, estimated from what it says.
 *
 * Estimated rather than measured because the layout is computed on the server side of the render — the
 * graph is built before React Flow has ever seen a node, and React Flow's own measurement arrives too
 * late to position anything with. Every constant below is read off `routing-map-node.tsx`: change the
 * node's padding, type scale or badge row and these move with it.
 *
 * Being a few pixels out is harmless. Being height-blind is not: a fixed row pitch has to be set for the
 * tallest node in the graph, so a two-line label with two badges either overlaps its neighbour or forces
 * every single-line node to sit in a pool of dead space. This is what buys the map both at once.
 */
const NODE_CHROME = 24; // border-2 top and bottom + py-2.5
const ICON_PLATE = 30; // h-7 plate + mt-0.5 — the floor on any node's content height
const LABEL_LINE = 18; // text-sm / leading-tight
const SUBLABEL_LINE = 14; // text-[11px] / leading-tight
const SUBLABEL_MARGIN = 2; // mt-0.5
const BADGE_ROW = 18; // the pill itself
const BADGE_MARGIN = 6; // mt-1.5
/** Usable text width inside a node: 236 − px-3 either side − border-2 either side − icon plate − gap. */
const TEXT_WIDTH = 170;
/** Rough advance width per character, per type scale. */
const LABEL_CHAR = 6.6;
const SUBLABEL_CHAR = 5.3;
/**
 * How many lines each style may take before the renderer truncates it.
 *
 * A node's **title is never truncated**. An ellipsis in a title is worse than a tall node, because a
 * truncated sentence reads as a different one. Letting it wrap costs a few units of height that the
 * stacking above already accounts for.
 *
 * The sublabel still stops, at three lines: it is a summary whose full text is one click away in the
 * detail panel, and it is the one field an author can make arbitrarily long by naming a topic in a
 * sentence.
 */
const LABEL_MAX_LINES = Number.POSITIVE_INFINITY;
const SUBLABEL_MAX_LINES = 3;
/** Rough width of one badge pill: px-1.5 either side, plus 9px bold caps, plus the flex gap. */
const BADGE_CHAR = 5.2;
const BADGE_CHROME = 16;

function clampedLines(text: string, charWidth: number, maxLines: number): number {
  return Math.min(maxLines, Math.max(1, Math.ceil((text.length * charWidth) / TEXT_WIDTH)));
}

function badgeRows(badges: readonly ScopeNodeBadge[]): number {
  const width = badges.reduce((sum, b) => sum + b.label.length * BADGE_CHAR + BADGE_CHROME, 0);
  return Math.min(2, Math.max(1, Math.ceil(width / TEXT_WIDTH)));
}

export function estimateNodeHeight(
  node: Pick<ScopeGraphNode, 'label' | 'sublabel' | 'badges'>
): number {
  const body =
    clampedLines(node.label, LABEL_CHAR, LABEL_MAX_LINES) * LABEL_LINE +
    (node.sublabel
      ? SUBLABEL_MARGIN +
        clampedLines(node.sublabel, SUBLABEL_CHAR, SUBLABEL_MAX_LINES) * SUBLABEL_LINE
      : 0) +
    (node.badges && node.badges.length > 0 ? BADGE_MARGIN + badgeRows(node.badges) * BADGE_ROW : 0);
  return NODE_CHROME + Math.max(ICON_PLATE, body);
}

/* --- stacking -------------------------------------------------------------- */

/**
 * Give every pipeline node its `y`, and report each column's lowest edge, keyed by its `x`.
 *
 * Nodes are grouped by the `x` they were built at — the column IS the stage — and each column is
 * stacked in build order (which is ordinal order) and centred on its {@link LANE}, so the pipeline
 * still reads left to right without any two adjacent columns sharing an edge run. Order within a
 * column is never touched.
 *
 * The returned figures are real bottom edges, not last nodes' centres, so a gap measured from one is
 * genuinely that much clear air whatever the column ends with. They are reported per column rather than
 * as one number because the always-asked band only has to clear the columns it sits beneath.
 */
function stackColumns(nodes: ScopeGraphNode[]): Map<number, number> {
  const columns = new Map<number, ScopeGraphNode[]>();
  for (const node of nodes) {
    const column = columns.get(node.x);
    if (column) column.push(node);
    else columns.set(node.x, [node]);
  }

  const bottoms = new Map<number, number>();
  for (const [x, column] of columns) {
    const heights = column.map(estimateNodeHeight);
    const total = heights.reduce((a, b) => a + b, 0) + ROW_GAP * (column.length - 1);
    let y = (laneByX.get(x) ?? 0) - total / 2;
    for (const [i, node] of column.entries()) {
      node.y = y;
      y += heights[i] + ROW_GAP;
    }
    bottoms.set(x, y - ROW_GAP);
  }
  return bottoms;
}

/** Stack the expanded always-asked band down from `top`, one topic per lane, in ordinal order. */
function stackBandRows(band: ScopeGraphNode[], top: number): void {
  let rowTop = top;
  for (const node of band) {
    node.y = rowTop;
    rowTop += estimateNodeHeight(node) + ROW_GAP;
  }
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

/** A member of a topic, priced from the version inventory. */
interface PricedMember {
  label: string;
  typeLabel: string;
  seconds: number;
}

/** What the timing builder needs, resolved once for the whole graph rather than per topic. */
interface PricedInventory {
  byQuestionKey: ReadonlyMap<string, PricedMember>;
  byDataSlotKey: ReadonlyMap<string, PricedMember>;
  weightByQuestionKey: ReadonlyMap<string, number>;
  weightByDataSlotKey: ReadonlyMap<string, number>;
  /** False when no inventory was supplied — the panel then shows totals without the arithmetic. */
  priced: boolean;
}

function priceInventory(
  questions: readonly TopicQuestionRef[] | undefined,
  dataSlots: readonly TopicDataSlotRef[]
): PricedInventory {
  const byQuestionKey = new Map<string, PricedMember>();
  const weightByQuestionKey = new Map<string, number>();
  for (const q of questions ?? []) {
    byQuestionKey.set(q.key, {
      label: q.prompt,
      typeLabel: questionTypeLabel(q.type),
      seconds: q.estimatedSeconds,
    });
    weightByQuestionKey.set(q.key, q.weight);
  }
  const byDataSlotKey = new Map<string, PricedMember>();
  const weightByDataSlotKey = new Map<string, number>();
  for (const slot of dataSlots) {
    byDataSlotKey.set(slot.key, {
      label: slot.name,
      typeLabel: DATA_SLOT_TYPE_LABEL,
      seconds: slot.estimatedSeconds,
    });
    weightByDataSlotKey.set(slot.key, slot.weight);
  }
  return {
    byQuestionKey,
    byDataSlotKey,
    weightByQuestionKey,
    weightByDataSlotKey,
    priced: questions !== undefined,
  };
}

/** How a data slot is named in the arithmetic. Not a question type, and priced by its own rate. */
const DATA_SLOT_TYPE_LABEL = 'Data slot';

/**
 * Take a topic's estimate apart: the rates behind the full figure, and the members a light run asks.
 *
 * Deliberately prices through the SAME `membersAtDepth` the interview resolves with and the same
 * per-item seconds the server summed, so the breakdown adds up to the headline by construction
 * rather than by coincidence. The headline itself still comes from `costs` — the server is the one
 * authority on what a topic costs, and a second implementation here is exactly the drift the cost
 * module's own docblock warns about.
 */
function topicTiming(
  topic: Topic,
  cost: TopicCost | undefined,
  inventory: PricedInventory
): ScopeNodeTiming | undefined {
  if (!cost) return undefined;

  const memberCount = topic.members.questionKeys.length + topic.members.dataSlotKeys.length;

  const resolve = (
    keys: readonly string[],
    priced: ReadonlyMap<string, PricedMember>
  ): ScopeTimingItem[] =>
    keys
      .map((key) => {
        const member = priced.get(key);
        return member ? { key, ...member } : null;
      })
      .filter((item): item is ScopeTimingItem => item !== null);

  const fullItems = [
    ...resolve(topic.members.questionKeys, inventory.byQuestionKey),
    ...resolve(topic.members.dataSlotKeys, inventory.byDataSlotKey),
  ];

  const lightKeys = {
    questions: membersAtDepth(topic.members.questionKeys, 'light', inventory.weightByQuestionKey),
    dataSlots: membersAtDepth(topic.members.dataSlotKeys, 'light', inventory.weightByDataSlotKey),
  };
  const lightItems = [
    ...resolve(lightKeys.questions, inventory.byQuestionKey),
    ...resolve(lightKeys.dataSlots, inventory.byDataSlotKey),
  ];

  // Keyed on the RATE as well as the label so two matrices of different heights stay two lines.
  const groups = new Map<string, ScopeTimingGroup>();
  for (const item of fullItems) {
    const id = `${item.typeLabel}@${item.seconds}`;
    const existing = groups.get(id);
    if (existing) {
      existing.count += 1;
      existing.seconds += item.seconds;
    } else {
      groups.set(id, {
        label: item.typeLabel,
        count: 1,
        secondsEach: item.seconds,
        seconds: item.seconds,
      });
    }
  }

  return {
    depth: topic.depth,
    fullSeconds: cost.full,
    lightSeconds: cost.light,
    memberCount,
    // Counted off the RESOLVED items, not off `lightKeys`: a member naming a key the version no
    // longer has is dropped from `lightItems` below, and counting it here printed "the 2 members
    // carrying the most weight" above a list of one.
    lightMemberCount: lightItems.length,
    // Heaviest first: what an author trims is what costs, not what happens to be authored first.
    groups: [...groups.values()].sort((a, b) => b.seconds - a.seconds || b.count - a.count),
    // Named only when the sample is smaller than the topic. When light IS the whole topic, listing
    // it again beneath the same number reads as a second, different set.
    lightItems: cost.light !== cost.full ? lightItems : [],
    unresolvedCount: inventory.priced ? memberCount - fullItems.length : 0,
  };
}

/** Spread-friendly wrapper: an unpriced topic contributes no key at all rather than `undefined`. */
function timingDetail(
  topic: Topic,
  cost: TopicCost | undefined,
  inventory: PricedInventory
): { timing?: ScopeNodeTiming } {
  const timing = topicTiming(topic, cost, inventory);
  return timing ? { timing } : {};
}

/** The rows every topic node's detail panel shows, whatever its phase. */
function topicDetailRows(topic: Topic): ScopeDetailRow[] {
  const rows: ScopeDetailRow[] = [
    { label: 'Key', value: topic.key },
    { label: 'Phase', value: TOPIC_PHASE_LABELS[topic.phase] },
    { label: 'Depth', value: TOPIC_DEPTH_LABELS[topic.depth] },
    { label: 'Members', value: memberSummary(topic) },
  ];
  // No duration rows here on purpose. Two bare figures labelled "Full depth" and "Light depth" were a
  // number with no provenance — the panel now carries `timing`, which shows the same figures with the
  // arithmetic and the assumptions attached.
  return rows;
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
  const { topics, settings, costs, dataSlots, questions, expandAlways } = input;
  const inventory = priceInventory(questions, dataSlots);

  const nodes: ScopeGraphNode[] = [];
  const edges: ScopeGraphEdge[] = [];

  const byPhase = (phase: TopicPhase): Topic[] =>
    topics.filter((t) => t.phase === phase).sort(byOrdinal);

  const opening = byPhase('opening');
  const conditional = byPhase('conditional');
  const always = [...byPhase('core'), ...byPhase('closing')];

  const fallbackKeys = new Set(settings.fallbackTopicKeys);
  const checkPreference = new Set(settings.checkTopicPreference);

  /* --- start ------------------------------------------------------------- */

  nodes.push({
    id: START_NODE_ID,
    kind: 'start',
    x: COL.start * X_STEP,
    y: 0,
    label: 'Interview starts',
    sublabel: settings.enabled ? 'conditional topics on' : 'conditional topics off',
    detail: {
      title: 'Interview starts',
      summary:
        'Every respondent begins here. The opening runs first, and what they say in it is the only evidence the routing decision ever reads.',
      rows: [
        { label: 'Conditional topics', value: settings.enabled ? 'On' : 'Off' },
        { label: 'Topics', value: plural(topics.length, 'topic') },
      ],
    },
  });

  /* --- opening ----------------------------------------------------------- */

  for (const topic of opening) {
    const id = topicNodeId('opening', topic.key);
    nodes.push({
      id,
      kind: 'opening',
      x: COL.opening * X_STEP,
      y: 0, // stacked by `stackColumns` once the whole pipeline is built

      label: topic.label,
      sublabel: memberSummary(topic),
      detail: {
        title: topic.label,
        summary:
          'Runs first, for everyone. What the respondent says here is what the agent reads. The decision waits until every question and data slot in the opening topics has been covered.',
        rows: topicDetailRows(topic),
        topicKey: topic.key,
        ...timingDetail(topic, costs.byTopicKey[topic.key], inventory),
      },
    });
    edges.push({ id: `e:start:${id}`, source: START_NODE_ID, target: id, kind: 'always' });
  }

  nodes.push({
    id: PLANNER_NODE_ID,
    kind: 'planner',
    x: COL.planner * X_STEP,
    y: 0,
    label: 'The agent decides',
    sublabel: plural(conditional.length, 'candidate'),
    badges: [badge('ai')],
    detail: {
      title: 'The agent decides',
      badgeNotes: badgeNotes(['ai']),
      summary:
        'The agent is asked once, when the opening finishes. It reads what the respondent said and what was captured from it, judges each conditional topic against its criteria, and proposes which ones to ask. It never gets the last word — everything it proposes goes through the guardrails.',
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
      ? `${formatSeconds(settings.sessionBudgetSeconds)} — ${formatSeconds(costs.routedAllowanceSeconds)} left once the always-asked topics are counted`
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
        'Applied to the agent’s answer, in this order: the limit on how many topics, the fallback if nothing was chosen at all, the time check, then the blind-spot check. These are checks in code, not instructions the AI is trusted to follow.',
      rows: [
        { label: 'Limit', value: plural(settings.maxConditionalTopics, 'conditional topic') },
        { label: 'Time budget', value: budgetValue },
        {
          label: 'Fallback',
          value:
            settings.fallbackTopicKeys.length > 0
              ? `${plural(settings.fallbackTopicKeys.length, 'topic')}, used only when nothing else is chosen`
              : 'None — if the decision fails, only the always-asked topics are run',
        },
        {
          label: 'Blind-spot check',
          value: settings.includeCheckTopic
            ? 'On — one topic that was not chosen is asked at Light depth'
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

  for (const topic of conditional) {
    const id = topicNodeId('conditional', topic.key);
    const cost = costs.byTopicKey[topic.key];
    const badgeKeys: ScopeBadgeKey[] = [];
    if (!topic.criteria || topic.criteria.trim().length === 0) badgeKeys.push('noCriteria');
    if (fallbackKeys.has(topic.key)) badgeKeys.push('fallback');
    if (checkPreference.has(topic.key)) badgeKeys.push('preferredCheck');
    const badges = badgeKeys.map(badge);

    nodes.push({
      id,
      kind: 'conditional',
      x: COL.conditional * X_STEP,
      y: 0,

      label: topic.label,
      sublabel: cost
        ? `${memberSummary(topic)} · ${formatSeconds(cost.full)}`
        : memberSummary(topic),
      ...(badges.length > 0 ? { badges } : {}),
      detail: {
        title: topic.label,
        summary:
          'Asked only when it is selected. Nothing on this map says whether it will be — that depends on what a respondent says, which is what “Try it” on the Conditional topics tab answers.',
        rows: topicDetailRows(topic),
        topicKey: topic.key,
        ...(badgeKeys.length > 0 ? { badgeNotes: badgeNotes(badgeKeys) } : {}),
        ...timingDetail(topic, cost, inventory),
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

  // Every pipeline node is on the canvas by this point and nothing below is a column, so this is where
  // the columns get their `y` — and where the band learns how far down it has to sit to clear them.
  //
  // It only has to clear the columns it is actually drawn under — the head's own column and the one the
  // topics stack in — so the twelve-topic conditional column away to the right never gets to push the
  // band down a screen of canvas it does not overlap.
  const bandColumns = new Set([ALWAYS_BAND_HEAD_COLUMN * X_STEP, ALWAYS_BAND_COLUMN * X_STEP]);
  const bandClearance = [...stackColumns(nodes).entries()]
    .filter(([x]) => bandColumns.has(x))
    .reduce((lowest, [, bottom]) => Math.max(lowest, bottom), 0);
  const bandY = bandClearance + ALWAYS_BAND_GAP;

  nodes.push({
    id: ALWAYS_BAND_NODE_ID,
    kind: 'alwaysBand',
    x: ALWAYS_BAND_HEAD_COLUMN * X_STEP,
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
        'Core and closing topics run for every respondent whatever they say. They are drawn apart from the flow above because no decision is ever taken about them — the agent only ever chooses between conditional topics. Their time is counted first, before the time left for chosen topics is worked out, which is why a heavy always-asked set leaves less room for anything else.',
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
    // Collected before they are positioned: each one's `y` depends on the height of every node above
    // it, which is not known until they have all been built.
    const bandNodes: ScopeGraphNode[] = [];
    for (const topic of always) {
      const id = topicNodeId('always', topic.key);
      bandNodes.push({
        id,
        kind: 'always',
        x: ALWAYS_BAND_COLUMN * X_STEP,
        y: 0,
        label: topic.label,
        sublabel: `${TOPIC_PHASE_LABELS[topic.phase]} · ${memberSummary(topic)}`,
        detail: {
          title: topic.label,
          summary:
            'Runs for every respondent. No decision is ever taken about it, which is why it sits apart from the flow above.',
          rows: topicDetailRows(topic),
          topicKey: topic.key,
          ...timingDetail(topic, costs.byTopicKey[topic.key], inventory),
        },
      });
      edges.push({
        id: `e:${ALWAYS_BAND_NODE_ID}:${id}`,
        source: ALWAYS_BAND_NODE_ID,
        target: id,
        kind: 'always',
      });
    }
    stackBandRows(bandNodes, bandY);
    nodes.push(...bandNodes);
  }

  return { nodes, edges };
}
