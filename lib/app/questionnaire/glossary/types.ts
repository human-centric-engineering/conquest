/**
 * Definitions / glossary — pure domain vocabulary and view shapes (P16).
 *
 * A questionnaire routinely leans on words whose meaning is not settled: "higher self", "ego",
 * "engagement", "leadership". Left undefined, the interviewer phrases a question around one
 * reading, the answer extractor infers another, the contradiction detector flags two answers that
 * merely used the word in two senses, and the respondent guesses. A GLOSSARY pins the reading
 * down once, in one place, and every surface that asks, interprets, or reports on an answer reads
 * from it.
 *
 * No Prisma, no Next, no React: the same shapes serve the admin curation UI, the server-side
 * prompt injection, and the respondent-facing matcher. Vocabularies are `as const` tuples
 * validated at the seam (house style — the DB columns are plain `String`).
 *
 * @see .context/app/questionnaire/definitions-glossary.md
 */

/**
 * The curation state of a term. This is the gate the whole feature hangs on: only `accepted`
 * terms carrying at least one selected definition reach prompt injection, the respondent hints,
 * or the report appendix.
 *
 * - `proposed` — the analyst suggested it; inert until an admin adjudicates. Because it is inert,
 *   writing one does NOT fork a launched version (the AppDataSlotDraft rule).
 * - `accepted` — live. Enforced by `saveGlossarySchema` to carry ≥1 selected definition.
 * - `rejected` — adjudicated away. KEPT rather than deleted so a re-run of the analyst does not
 *   re-propose a term the admin already turned down.
 */
export const GLOSSARY_TERM_STATUSES = ['proposed', 'accepted', 'rejected'] as const;
export type GlossaryTermStatus = (typeof GLOSSARY_TERM_STATUSES)[number];

/**
 * Where a term came from. A later per-demo-client term LIBRARY adds `library` here and a nullable
 * pointer column — no migration of existing rows, which is why this is a String and not an enum.
 */
export const GLOSSARY_TERM_SOURCES = ['ai_proposed', 'admin', 'document'] as const;
export type GlossaryTermSource = (typeof GLOSSARY_TERM_SOURCES)[number];

/**
 * Where a definition's wording came from. `document` means it was drawn from the admin's uploaded
 * authoritative definitions document and carries a `sourceQuote`; that provenance is what lets the
 * admin trust it without re-reading the source.
 */
export const GLOSSARY_DEFINITION_SOURCES = ['ai_proposed', 'admin', 'document'] as const;
export type GlossaryDefinitionSource = (typeof GLOSSARY_DEFINITION_SOURCES)[number];

/** Hard cap on terms per version — bounds the curation UI, the payload, and the matcher index. */
export const GLOSSARY_MAX_TERMS_PER_VERSION = 60;

/** Hard cap on aliases per term. Named so the matcher's surface cap can be derived from it. */
export const GLOSSARY_MAX_ALIASES_PER_TERM = 8;

/** Hard cap on candidate definitions per term. More than a handful is not a choice, it's noise. */
export const GLOSSARY_MAX_DEFINITIONS_PER_TERM = 4;

/** One candidate reading of a term, as the admin surface sees it. */
export interface GlossaryDefinitionView {
  id: string;
  text: string;
  /** Ticked by the admin. Only selected definitions reach prompts, hints, or the appendix. */
  selected: boolean;
  source: GlossaryDefinitionSource;
  /** Span from the definitions document backing this wording, when `source === 'document'`. */
  sourceQuote: string | null;
  /** The admin changed the AI's wording — a later re-run leaves a hand-tuned definition alone. */
  edited: boolean;
  ordinal: number;
}

/** One term with its candidate definitions, as the admin curation surface sees it. */
export interface GlossaryTermView {
  id: string;
  term: string;
  normalizedTerm: string;
  /** Extra surface forms the matcher should also hit (irregular plurals, spellings, acronyms). */
  aliases: string[];
  status: GlossaryTermStatus;
  source: GlossaryTermSource;
  /** Why the analyst judged this term ambiguous — the admin's main adjudication signal. */
  rationale: string | null;
  /** A span from the questionnaire showing the term in use. */
  contextQuote: string | null;
  ordinal: number;
  definitions: GlossaryDefinitionView[];
}

/** The optional authoritative definitions document attached to a version. */
export interface GlossaryDocumentView {
  id: string;
  fileName: string;
  byteSize: number;
  mimeType: string | null;
  /** Character length of the extracted text — the admin's "did that parse?" signal. */
  textLength: number;
  createdAt: string;
}

/** What `GET .../glossary` returns: the whole curated set plus any attached source document. */
export interface GlossaryView {
  terms: GlossaryTermView[];
  document: GlossaryDocumentView | null;
}

/**
 * The minimal, serialisable shape the MATCHER consumes — the only glossary data that crosses to
 * the client. Deliberately narrower than {@link GlossaryTermView}: a respondent has no business
 * receiving rejected terms, unselected candidate definitions, or the analyst's rationale.
 *
 * `surfaces` is pre-normalised (see `normalize.ts`) and already includes the term itself, its
 * aliases, and their derived inflections, so the client never re-derives them.
 */
export interface GlossaryEntry {
  termId: string;
  /** Display form — the popover heading. */
  term: string;
  /** Every normalised surface that should match. Longest-first ordering is the index's job. */
  surfaces: string[];
  /** Selected definitions in ordinal order. Rendered as numbered senses when there is >1. */
  definitions: string[];
}

/** One entry of the deterministic report/PDF glossary appendix. */
export interface GlossaryAppendixEntry {
  term: string;
  definitions: string[];
}

/** The deterministic glossary appendix — `null` when there is nothing to show. */
export interface GlossaryAppendixView {
  heading: string;
  entries: GlossaryAppendixEntry[];
}
