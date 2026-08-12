/**
 * Adaptive Scope (P17) — the shapes the admin surfaces read.
 *
 * One declaration of what `GET …/versions/:vid/topics` returns, shared by the server fetcher
 * (`workspace-data.ts`), the Topics tab page, and the client panel. Without it the payload would be
 * re-typed at each of the three seams and could drift silently — the route is the only writer.
 *
 * Pure: no Prisma, no Next. Safe to import from client components.
 */

import type {
  AdaptiveScopeSettings,
  ProposedTopicSet,
  Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';

/** One question the membership picker can offer, with the section it sits in. */
export interface TopicQuestionRef {
  key: string;
  prompt: string;
  sectionTitle: string;
}

/** One data slot the membership picker can offer. */
export interface TopicDataSlotRef {
  key: string;
  name: string;
  theme: string;
}

/**
 * Everything the Topics tab needs in one payload: the topics, the resolved settings, the coherence
 * findings computed server-side, and the key inventory the membership pickers offer.
 *
 * The findings are computed on the server rather than in the browser because the launch gate runs
 * the same `validateAdaptiveScope` — one evaluation, so the page and the gate can never disagree
 * about whether a version is coherent.
 */
export interface TopicsPayload {
  topics: Topic[];
  settings: AdaptiveScopeSettings;
  issues: ScopeIssue[];
  inventory: {
    questions: TopicQuestionRef[];
    dataSlots: TopicDataSlotRef[];
  };
  /**
   * The Routing Analyst's pending proposal, or null.
   *
   * Carried in the same payload as the live set rather than fetched separately, because the review
   * surface's whole job is to show the two side by side: "this proposal replaces four of the topics
   * you have" is the sentence an admin needs, and it cannot be written from either half alone.
   */
  draft: ProposedTopicSet | null;
}

/** The empty payload — what a failed fetch degrades to, so a tab renders rather than crashing. */
export const EMPTY_TOPICS_PAYLOAD: Omit<TopicsPayload, 'settings'> = {
  topics: [],
  issues: [],
  inventory: { questions: [], dataSlots: [] },
  draft: null,
};
