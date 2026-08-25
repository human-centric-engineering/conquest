/**
 * Overlays for the routing map (F17.29) — three layers the structural graph deliberately does not
 * compute for itself.
 *
 * `buildScopeGraph` draws what a version CAN do, from its settings alone. That is what makes it
 * trustworthy: it is a pure function of the tab above it, it cannot drift, and it never predicts.
 * Each of these three layers is a fact from somewhere else, and all three answer questions the
 * structure raises but cannot settle:
 *
 * - **What happened on the dry run** (F17.14). The plan preview already returns `proposedKeys`
 *   beside the plan, which is the one thing a plan cannot carry: the difference between "the agent
 *   never picked this" and "the agent picked it and a guardrail took it back".
 * - **What actually happens** (F17.16). Routing analytics counts how often each topic was really
 *   chosen. A criteria sentence that never fires looks exactly like one that fires constantly, on
 *   a map drawn from the settings.
 * - **What is wrong with it** (`validateConditionalTopics`). The findings name topics; the map
 *   draws topics; listing them above the picture leaves the reader to match key to node by eye.
 *
 * Kept OUT of `graph.ts` on purpose. That module's invariant is "structural, never predictive", and
 * a layer that mixes a session's outcome into the structure would quietly end it. This one takes a
 * built graph and returns a new one, so the base map is the same object with or without them.
 *
 * Pure — no Prisma, no React. Every input is optional and an absent one contributes nothing.
 */

import type {
  ScopeGraph,
  ScopeGraphNode,
  ScopeNodeBadge,
} from '@/lib/app/questionnaire/scope/graph';
import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';

/** Which overlays a reader has switched on. */
export type ScopeOverlayKind = 'dryRun' | 'selection' | 'findings';

/** Every overlay, in the order the legend lists them. */
export const SCOPE_OVERLAY_KINDS: readonly ScopeOverlayKind[] = ['dryRun', 'selection', 'findings'];

/** What each overlay is called, and what switching it on actually shows. */
export const SCOPE_OVERLAY_LABELS: Record<ScopeOverlayKind, { label: string; hint: string }> = {
  dryRun: {
    label: 'Last try-it run',
    hint: 'Marks what the last “Try it” run chose, and what it chose and then lost to a limit.',
  },
  selection: {
    label: 'How often it is chosen',
    hint: 'Marks each topic with the share of real interviews that included it.',
  },
  findings: {
    label: 'Problems',
    hint: 'Pins each problem from the checks onto the topic it is about.',
  },
};

/** The last dry run, as the overlay reads it. */
export interface ScopeDryRunOverlay {
  /** Topic keys the plan actually seated. */
  selectedKeys: readonly string[];
  /** Topic keys the plan left out, with the reason recorded against each. */
  excluded: readonly { key: string; rationale: string }[];
  /** What the agent proposed, before any guardrail. Empty when no model call was made. */
  proposedKeys: readonly string[];
}

/** Real selection rates, as the overlay reads them. */
export interface ScopeSelectionOverlay {
  /** Non-preview sessions in the window that reached a plan. */
  plans: number;
  /** Per topic key: how often the ROUTING SETUP chose it, and that as a share of `plans`. */
  byTopicKey: ReadonlyMap<string, { chosen: number; chosenRate: number }>;
}

export interface ScopeOverlayInput {
  dryRun?: ScopeDryRunOverlay | null;
  selection?: ScopeSelectionOverlay | null;
  findings?: readonly ScopeIssue[];
}

/** A tone for a badge that is about an outcome rather than a setting. */
function outcomeBadge(label: string, tone: ScopeNodeBadge['tone']): ScopeNodeBadge {
  return { label, tone };
}

/** Render a 0–1 rate the way the analytics card does: whole percent, never "0%" for a real hit. */
function formatRate(rate: number): string {
  const percent = rate * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/**
 * What the dry run did to one topic.
 *
 * The interesting state is the third one. A topic the agent proposed and a guardrail then took back
 * looks identical, on the plan alone, to one the agent never wanted — and telling those apart is
 * the entire reason `proposedKeys` is returned beside the plan.
 */
function dryRunAnnotation(
  topicKey: string,
  dryRun: ScopeDryRunOverlay
): { badge: ScopeNodeBadge; row: { label: string; value: string } } | null {
  const selected = dryRun.selectedKeys.includes(topicKey);
  const proposed = dryRun.proposedKeys.includes(topicKey);
  const excluded = dryRun.excluded.find((e) => e.key === topicKey);

  if (selected) {
    return {
      badge: outcomeBadge('Chosen on the last run', 'positive'),
      row: {
        label: 'Last try-it run',
        value: proposed ? 'The agent chose it, and it was asked.' : 'It was asked.',
      },
    };
  }

  if (proposed) {
    return {
      badge: outcomeBadge('Taken back on the last run', 'warning'),
      row: {
        label: 'Last try-it run',
        value: excluded
          ? `The agent chose it, then it was taken back: ${excluded.rationale}`
          : 'The agent chose it, then a limit took it back.',
      },
    };
  }

  if (excluded) {
    return {
      badge: outcomeBadge('Not chosen on the last run', 'neutral'),
      row: { label: 'Last try-it run', value: excluded.rationale },
    };
  }

  return null;
}

/** How often this topic is really chosen, and how much that number is worth. */
function selectionAnnotation(
  topicKey: string,
  selection: ScopeSelectionOverlay
): { badge: ScopeNodeBadge; row: { label: string; value: string } } | null {
  const row = selection.byTopicKey.get(topicKey);
  if (!row) return null;

  // A rate is a fact; whether it is a PROBLEM is a judgement only the author can make — a topic
  // that never fires may be a rare-case safety net working exactly as designed. So the badge is
  // toned by nothing but the extremes, and the sample size travels with it.
  const tone: ScopeNodeBadge['tone'] =
    selection.plans === 0 ? 'neutral' : row.chosen === 0 ? 'warning' : 'positive';

  return {
    badge: outcomeBadge(`Chosen ${formatRate(row.chosenRate)}`, tone),
    row: {
      label: 'Chosen in real interviews',
      value: `${row.chosen} of ${selection.plans} ${selection.plans === 1 ? 'interview' : 'interviews'} (${formatRate(row.chosenRate)}).`,
    },
  };
}

/**
 * Layer the overlays a reader has switched on onto a built graph.
 *
 * Returns a NEW graph — nodes are copied, never mutated — so the base map is unchanged and a reader
 * switching an overlay off gets exactly the picture they had before switching it on. Nodes that are
 * not topics are passed through untouched: none of these three facts is about a guardrail or a rule.
 */
export function annotateScopeGraph(
  graph: ScopeGraph,
  overlays: ScopeOverlayInput,
  active: ReadonlySet<ScopeOverlayKind>
): ScopeGraph {
  if (active.size === 0) return graph;

  const findingsByTopic = new Map<string, ScopeIssue[]>();
  if (active.has('findings')) {
    for (const issue of overlays.findings ?? []) {
      if (!issue.topicKey) continue;
      const list = findingsByTopic.get(issue.topicKey);
      if (list) list.push(issue);
      else findingsByTopic.set(issue.topicKey, [issue]);
    }
  }

  const nodes: ScopeGraphNode[] = graph.nodes.map((node) => {
    const topicKey = node.detail.topicKey;
    if (!topicKey) return node;

    const badges = [...(node.badges ?? [])];
    const rows = [...node.detail.rows];

    if (active.has('dryRun') && overlays.dryRun) {
      const annotation = dryRunAnnotation(topicKey, overlays.dryRun);
      if (annotation) {
        badges.push(annotation.badge);
        rows.push(annotation.row);
      }
    }

    if (active.has('selection') && overlays.selection) {
      const annotation = selectionAnnotation(topicKey, overlays.selection);
      if (annotation) {
        badges.push(annotation.badge);
        rows.push(annotation.row);
      }
    }

    const findings = findingsByTopic.get(topicKey) ?? [];
    if (findings.length > 0) {
      badges.push(
        outcomeBadge(
          findings.length === 1 ? '1 problem' : `${findings.length} problems`,
          findings.some((f) => f.severity === 'error') ? 'negative' : 'warning'
        )
      );
      for (const finding of findings) {
        rows.push({
          label: finding.severity === 'error' ? 'Problem' : 'Worth checking',
          value: finding.message,
        });
      }
    }

    if (badges.length === (node.badges?.length ?? 0) && rows.length === node.detail.rows.length) {
      return node;
    }

    return { ...node, badges, detail: { ...node.detail, rows } };
  });

  return { nodes, edges: graph.edges };
}

/**
 * Which overlays have anything to say, so the UI can offer only those.
 *
 * A toggle that switches on nothing is worse than an absent one: the reader concludes the overlay
 * found nothing, when in fact its data was never loaded (nobody has pressed "Try it" yet; the
 * version has no interviews).
 */
export function availableOverlays(overlays: ScopeOverlayInput): Set<ScopeOverlayKind> {
  const available = new Set<ScopeOverlayKind>();
  if (overlays.dryRun) available.add('dryRun');
  if (overlays.selection && overlays.selection.byTopicKey.size > 0) available.add('selection');
  if ((overlays.findings ?? []).some((f) => f.topicKey)) available.add('findings');
  return available;
}
