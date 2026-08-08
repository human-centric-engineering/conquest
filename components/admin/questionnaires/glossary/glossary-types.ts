/**
 * Client-side working shapes for the glossary editor (P16).
 *
 * The editor holds the WHOLE curated set in memory and saves it as a replace-set, so the working
 * shapes carry a stable client id that the server never sees: without it, editing a term's text
 * would remount its card mid-keystroke (React keys off array index would shift on reorder), and
 * the admin would lose focus after every character.
 */

import type {
  GlossaryDefinitionSource,
  GlossaryTermSource,
  GlossaryTermStatus,
  GlossaryTermView,
} from '@/lib/app/questionnaire/glossary';

/** One editable candidate definition. */
export interface DraftDefinition {
  /** Stable client-side React key. Not persisted. */
  id: string;
  text: string;
  selected: boolean;
  source: GlossaryDefinitionSource;
  sourceQuote: string | null;
  /** True once the admin has changed the AI's wording — persisted, so a re-run leaves it alone. */
  edited: boolean;
}

/** One editable term with its candidate definitions. */
export interface DraftTerm {
  /** Stable client-side React key. Not persisted. */
  id: string;
  term: string;
  aliases: string[];
  status: GlossaryTermStatus;
  source: GlossaryTermSource;
  rationale: string | null;
  contextQuote: string | null;
  definitions: DraftDefinition[];
}

/** Monotonic client-id source — `crypto.randomUUID` is not available in every target browser. */
let nextClientId = 0;
export function clientId(prefix: string): string {
  nextClientId += 1;
  return `${prefix}-${nextClientId}`;
}

/** Project a server view into the editor's working shape. */
export function toDraftTerm(view: GlossaryTermView): DraftTerm {
  return {
    id: clientId('term'),
    term: view.term,
    aliases: view.aliases,
    status: view.status,
    source: view.source,
    rationale: view.rationale,
    contextQuote: view.contextQuote,
    definitions: view.definitions.map((definition) => ({
      id: clientId('def'),
      text: definition.text,
      selected: definition.selected,
      source: definition.source,
      sourceQuote: definition.sourceQuote,
      edited: definition.edited,
    })),
  };
}

/** A blank hand-authored term, ready for the admin to type into. */
export function blankTerm(): DraftTerm {
  return {
    id: clientId('term'),
    term: '',
    aliases: [],
    status: 'accepted',
    source: 'admin',
    rationale: null,
    contextQuote: null,
    definitions: [
      {
        id: clientId('def'),
        text: '',
        selected: true,
        source: 'admin',
        sourceQuote: null,
        edited: false,
      },
    ],
  };
}

/** One term as `PUT .../glossary` expects it — the client mirror of `glossaryTermInputSchema`. */
export interface GlossarySavePayloadTerm {
  term: string;
  aliases: string[];
  status: GlossaryTermStatus;
  source: GlossaryTermSource;
  rationale: string | null;
  contextQuote: string | null;
  definitions: {
    text: string;
    selected: boolean;
    source: GlossaryDefinitionSource;
    sourceQuote: string | null;
    edited: boolean;
  }[];
}

/**
 * The payload `PUT .../glossary` expects (ordinals come from array order).
 *
 * Definitions with empty text are dropped rather than sent: a blank row is an "Add a definition"
 * the admin thought better of, and the save schema would reject it as a hard error rather than
 * quietly ignoring the thing they had already abandoned.
 */
export function toSavePayload(terms: DraftTerm[]): GlossarySavePayloadTerm[] {
  return terms.map((term) => ({
    term: term.term.trim(),
    aliases: term.aliases.map((alias) => alias.trim()).filter(Boolean),
    status: term.status,
    source: term.source,
    rationale: term.rationale,
    contextQuote: term.contextQuote,
    definitions: term.definitions
      .filter((definition) => definition.text.trim().length > 0)
      .map((definition) => ({
        text: definition.text.trim(),
        selected: definition.selected,
        source: definition.source,
        sourceQuote: definition.sourceQuote,
        edited: definition.edited,
      })),
  }));
}
