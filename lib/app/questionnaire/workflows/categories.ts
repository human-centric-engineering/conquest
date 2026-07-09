/**
 * Behind-the-Scenes workflow categories — pure, client-safe presentation metadata.
 *
 * The visualizer groups its pipeline diagrams by the part of ConQuest that runs
 * them (authoring → conversation → reporting → evaluation) so the picker reads as
 * a map of the product's lifecycle rather than a flat wall of chips. This module
 * is the single source of truth for that grouping and its display order.
 * Membership is pinned to the live `WORKFLOW_DIAGRAMS` registry by the integrity
 * test — a new diagram must be filed under a category or CI fails.
 *
 * "Category" here means a **workflow grouping** (lifecycle stage); do not confuse
 * it with the visualizer's per-node treatment categories (retrieval / agentic /
 * hybrid / deterministic) in `types.ts`.
 *
 * Kept free of server / prisma / React imports so the client picker can import it
 * directly without dragging server code into the bundle.
 *
 * @see .context/app/questionnaire/workflow-visualizer.md
 */

/** The part of ConQuest a workflow belongs to. */
export type WorkflowCategory = 'creation' | 'config' | 'conversation' | 'reporting' | 'evaluation';

export interface WorkflowCategoryMeta {
  id: WorkflowCategory;
  /** Group heading shown in the picker. */
  label: string;
  /** One line: which part of ConQuest runs these workflows. */
  description: string;
  /** Diagram slugs in this category, in intended display order. */
  slugs: readonly string[];
}

/**
 * Categories in questionnaire-lifecycle order; slugs in display order within each.
 * The order here drives the picker's group order and the order of items in a group.
 */
export const WORKFLOW_CATEGORIES: readonly WorkflowCategoryMeta[] = [
  {
    id: 'creation',
    label: 'Questionnaire Creation',
    description: 'Building a questionnaire — from a document, a brief, or by hand.',
    slugs: [
      'document-ingestion',
      'generative-authoring',
      'design-evaluation',
      'structure-edit',
      'data-slot-generation',
    ],
  },
  {
    id: 'config',
    label: 'Config / Settings',
    description: 'AI advisors that review configuration and agent settings.',
    slugs: ['config-advisor', 'agent-settings-advisor'],
  },
  {
    id: 'conversation',
    label: 'Live conversation',
    description: 'What runs each turn while a respondent completes the questionnaire.',
    slugs: ['conversation-turn', 'answer-extraction', 'data-slot-turn'],
  },
  {
    id: 'reporting',
    label: 'Reporting',
    description: 'Turning completed responses into reports.',
    slugs: ['respondent-report', 'cohort-report'],
  },
  {
    id: 'evaluation',
    label: 'Evaluation & QA',
    description: 'Inspecting and scoring a single preview turn.',
    slugs: ['turn-inspector', 'turn-evaluation'],
  },
] as const;

/** slug → category id, derived once from {@link WORKFLOW_CATEGORIES}. */
const CATEGORY_ID_BY_SLUG: Record<string, WorkflowCategory> = Object.fromEntries(
  WORKFLOW_CATEGORIES.flatMap((cat) => cat.slugs.map((slug) => [slug, cat.id] as const))
);

/** The category a diagram belongs to, or `undefined` if it hasn't been filed yet. */
export function categoryForSlug(slug: string): WorkflowCategory | undefined {
  return CATEGORY_ID_BY_SLUG[slug];
}
