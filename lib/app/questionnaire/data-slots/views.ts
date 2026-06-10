/**
 * Client-safe view contracts for the data-slots feature (the semantic abstraction layer
 * over questions). Pure types — no Prisma / Next / server-only imports — so both the route
 * serializers and the `'use client'` admin + respondent components import one contract.
 *
 * A **data slot** is a short (1–4 word) name + a description that abstracts over one or more
 * questions; the live conversation targets data slots while questions fill in the background.
 */

/** One data slot the generator proposes (pre-persistence; the admin reviews these). */
export interface GeneratedDataSlot {
  /** 1–4 word semantic name (the panel label + the targeting prompt). */
  name: string;
  /** Why it matters + what counts as filled (the targeting guidelines). */
  description: string;
  /** Short group label for panel grouping. */
  theme: string;
  /** Keys of the question(s) this slot abstracts over (must exist in the version). */
  questionKeys: string[];
  /** Generator's 0–1 confidence in this slot. */
  confidence: number;
}

/** A persisted data slot as the admin + runtime surfaces consume it. */
export interface DataSlotView {
  id: string;
  /** Slug, unique per version (fills/links reference it). */
  key: string;
  name: string;
  description: string;
  theme: string;
  ordinal: number;
  weight: number;
  /** Keys of the mapped questions. */
  questionKeys: string[];
}

/** A question summary the review UI shows next to each slot (which questions it covers). */
export interface DataSlotQuestionRef {
  key: string;
  prompt: string;
}
