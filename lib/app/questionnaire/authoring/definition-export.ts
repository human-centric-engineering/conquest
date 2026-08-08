/**
 * Questionnaire **definition** import / export envelope (F14.9).
 *
 * The sibling of {@link file://./config-export.ts}, one level up: where that envelope carries only a
 * version's run-time *settings*, this one carries the whole authored **instrument** — structure
 * (sections → questions → tags), the run-time config, the semantic data slots, and the scoring
 * schema. Export serialises a {@link VersionGraphView} (+ data slots + scoring) into a portable JSON
 * file; import parses such a file back into a typed payload the route persists as a brand-new
 * questionnaire.
 *
 * Pure: no Prisma / Next / DOM. Export reuses {@link extractConfig} so the config block can never
 * drift from the config shape. Import is the **external-data boundary** — {@link definitionImportSchema}
 * (Zod) validates an uploaded file before any of it reaches the persister, so nothing is ever cast
 * off untrusted JSON. Embeddings are deliberately NOT serialised: question + data-slot vectors are
 * regenerated on import (they're large, model-specific, and reproducible from the text).
 */

import { z } from 'zod';

import {
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
  QUESTION_TYPES,
  TAG_COLORS,
  type AudienceShape,
  type QuestionnaireConfigShape,
  type QuestionType,
  type TagColor,
} from '@/lib/app/questionnaire/types';
// Import from the pure scoring submodules (NOT the `scoring` barrel — it re-exports the
// Prisma-touching `compute` module, which would leak server code into the client bundle that
// imports `parseDefinitionImport` through the authoring barrel).
import { scoringSchemaContentSchema } from '@/lib/app/questionnaire/scoring/schema-validation';
import { normalizeGlossarySurface } from '@/lib/app/questionnaire/glossary/normalize';
import {
  GLOSSARY_DEFINITION_SOURCES,
  GLOSSARY_MAX_DEFINITIONS_PER_TERM,
  GLOSSARY_MAX_TERMS_PER_VERSION,
  GLOSSARY_TERM_SOURCES,
  GLOSSARY_TERM_STATUSES,
} from '@/lib/app/questionnaire/glossary/types';
import type { ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import { extractConfig } from '@/lib/app/questionnaire/authoring/config-export';
import { updateConfigSchema } from '@/lib/app/questionnaire/authoring/config-schema';

/** Discriminator stamped on an export so import can reject unrelated JSON (e.g. a settings file). */
export const DEFINITION_EXPORT_KIND = 'conquest.questionnaire.definition';

/** Envelope schema version — bump if the on-disk shape ever changes incompatibly. */
export const DEFINITION_EXPORT_SCHEMA_VERSION = 1;

/** A tag in the export — referenced by `label` (ids are version-local and re-minted on import). */
export interface DefinitionTag {
  label: string;
  color: TagColor | null;
}

/** One question in the export. Carries the stable `key` data slots + scoring reference. */
export interface DefinitionQuestion {
  ordinal: number;
  key: string;
  prompt: string;
  guidelines: string | null;
  rationale: string | null;
  type: QuestionType;
  /** Opaque per-type config (choices / likert bounds + labels / numeric bounds). */
  typeConfig: unknown;
  required: boolean;
  weight: number;
  /** Tags by label — remapped to freshly-minted tag ids on import. */
  tagLabels: string[];
}

/** One section (with its questions) in the export. */
export interface DefinitionSection {
  ordinal: number;
  title: string;
  description: string | null;
  questions: DefinitionQuestion[];
}

/** One semantic data slot in the export — links to questions by their stable `key`. */
export interface DefinitionDataSlot {
  key: string;
  name: string;
  description: string;
  theme: string;
  ordinal: number;
  weight: number;
  questionKeys: string[];
}

/** One curated glossary term in an export. */
export interface DefinitionGlossaryTerm {
  term: string;
  aliases: string[];
  status: string;
  source: string;
  rationale: string | null;
  contextQuote: string | null;
  definitions: {
    text: string;
    selected: boolean;
    source: string;
    sourceQuote: string | null;
    /**
     * Whether an admin changed the AI's wording. Carried through the round-trip because a later
     * analysis re-run leaves an edited definition alone — losing the flag on import would let the
     * next run overwrite exactly the wording it is meant to preserve.
     */
    edited: boolean;
  }[];
}

/** The on-disk envelope written by {@link buildDefinitionExport}. */
export interface DefinitionExport {
  kind: typeof DEFINITION_EXPORT_KIND;
  schemaVersion: number;
  exportedAt: string;
  questionnaire: { title: string };
  version: {
    goal: string | null;
    audience: AudienceShape | null;
    tags: DefinitionTag[];
    sections: DefinitionSection[];
    config: QuestionnaireConfigShape;
    dataSlots: DefinitionDataSlot[];
    scoringSchema: { name: string; content: ScoringSchemaContent } | null;
    /**
     * Definitions / glossary (P16). Carries the CURATED set — terms, their status, and every
     * candidate definition with its selection state — so a round-trip preserves an admin's
     * adjudication rather than making them re-decide. `sourceQuote` travels too, but the source
     * DOCUMENT does not: it is an upload, not part of a portable definition.
     */
    glossary: DefinitionGlossaryTerm[];
  };
}

/**
 * Build the export envelope from a version's graph, its data slots, and its scoring schema (or
 * null). The questionnaire `title` is passed separately (it lives on the questionnaire row, not the
 * version graph). Reuses {@link extractConfig} for the config block (drops the read-only `saved`
 * flag) and flattens each question's `tags` to bare labels.
 */
export function buildDefinitionExport(
  title: string,
  graph: VersionGraphView,
  dataSlots: DataSlotView[],
  scoring: { name: string; content: ScoringSchemaContent } | null,
  exportedAt: string,
  glossary: DefinitionGlossaryTerm[] = []
): DefinitionExport {
  return {
    kind: DEFINITION_EXPORT_KIND,
    schemaVersion: DEFINITION_EXPORT_SCHEMA_VERSION,
    exportedAt,
    questionnaire: { title },
    version: {
      goal: graph.goal,
      audience: graph.audience,
      tags: graph.tags.map((t) => ({ label: t.label, color: t.color })),
      sections: graph.sections.map((s) => ({
        ordinal: s.ordinal,
        title: s.title,
        description: s.description,
        questions: s.questions.map((q) => ({
          ordinal: q.ordinal,
          key: q.key,
          prompt: q.prompt,
          guidelines: q.guidelines,
          rationale: q.rationale,
          type: q.type,
          typeConfig: q.typeConfig,
          required: q.required,
          weight: q.weight,
          tagLabels: q.tags.map((t) => t.label),
        })),
      })),
      config: extractConfig(graph.config),
      dataSlots: dataSlots.map((d) => ({
        key: d.key,
        name: d.name,
        description: d.description,
        theme: d.theme,
        ordinal: d.ordinal,
        weight: d.weight,
        questionKeys: d.questionKeys,
      })),
      scoringSchema: scoring,
      glossary,
    },
  };
}

// ── Import boundary (Zod) ──────────────────────────────────────────────────────────────────────

/** Audience fields validated permissively — every field optional, enums pinned. */
const audienceImportSchema = z
  .object({
    description: z.string().optional(),
    role: z.string().optional(),
    expertiseLevel: z.enum(AUDIENCE_EXPERTISE_LEVELS).optional(),
    estimatedDurationMinutes: z.number().optional(),
    locale: z.string().optional(),
    sensitivity: z.enum(AUDIENCE_SENSITIVITY_LEVELS).optional(),
    notes: z.string().optional(),
  })
  .nullable();

const tagImportSchema = z.object({
  label: z.string().trim().min(1).max(120),
  color: z.enum(TAG_COLORS).nullable().optional(),
});

const questionImportSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  key: z.string().trim().min(1).max(60),
  prompt: z.string().trim().min(1),
  guidelines: z.string().nullable().optional(),
  rationale: z.string().nullable().optional(),
  type: z.enum(QUESTION_TYPES),
  // Opaque per-type config — stored as-is (the editor re-validates on first edit, same as ingest).
  typeConfig: z.unknown().optional(),
  required: z.boolean(),
  weight: z.number(),
  tagLabels: z.array(z.string()).default([]),
});

const sectionImportSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  title: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  questions: z.array(questionImportSchema),
});

const dataSlotImportSchema = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string(),
  theme: z.string(),
  ordinal: z.number().int().nonnegative(),
  weight: z.number(),
  questionKeys: z.array(z.string()),
});

/** One curated glossary term, as an import file carries it. Lenient on vocabulary — a value the
 *  current build doesn't know is rejected by the enum, so a forward-compatible file fails loudly
 *  rather than importing a term in a state nothing can render. */
const glossaryTermImportSchema = z.object({
  term: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
  status: z.enum(GLOSSARY_TERM_STATUSES).default('proposed'),
  source: z.enum(GLOSSARY_TERM_SOURCES).default('admin'),
  rationale: z.string().trim().max(2000).nullish(),
  contextQuote: z.string().trim().max(2000).nullish(),
  definitions: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(2000),
        selected: z.boolean().default(false),
        source: z.enum(GLOSSARY_DEFINITION_SOURCES).default('ai_proposed'),
        sourceQuote: z.string().trim().max(2000).nullish(),
        // Defaults false so a file exported before this field existed still imports.
        edited: z.boolean().default(false),
      })
    )
    .max(GLOSSARY_MAX_DEFINITIONS_PER_TERM)
    .default([]),
});

/**
 * The full envelope validator — the external-data boundary. `config` reuses the all-optional
 * {@link updateConfigSchema} (so an import is validated exactly like a settings PATCH and unknown
 * keys are stripped); `scoringSchema` reuses {@link scoringSchemaContentSchema}. Both optional so a
 * hand-authored or partial file still imports.
 */
export const definitionImportSchema = z.object({
  kind: z.literal(DEFINITION_EXPORT_KIND),
  schemaVersion: z.number(),
  exportedAt: z.string().optional(),
  questionnaire: z.object({ title: z.string().trim().min(1).max(200) }),
  version: z.object({
    goal: z.string().nullable().optional(),
    audience: audienceImportSchema.optional(),
    tags: z.array(tagImportSchema).default([]),
    sections: z.array(sectionImportSchema),
    config: updateConfigSchema.optional(),
    dataSlots: z.array(dataSlotImportSchema).default([]),
    scoringSchema: z
      .object({ name: z.string().trim().min(1).max(120), content: scoringSchemaContentSchema })
      .nullable()
      .optional(),
    // Definitions / glossary (P16). `.default([])` deliberately, NOT a schemaVersion bump: the
    // parser rejects any schemaVersion !== 1 outright, so bumping it would reject every file
    // exported before this feature. With a default, an old file imports (no glossary) and a new
    // file imports into older code too (Zod strips the unknown key) — both directions stay
    // compatible without a migration.
    glossary: z
      .array(glossaryTermImportSchema)
      .max(GLOSSARY_MAX_TERMS_PER_VERSION)
      .default([])
      // The DB's `@@unique([versionId, normalizedTerm])` would otherwise surface a hand-edited or
      // foreign-tool file containing e.g. "higher-self" AND "Higher Self" as a P2002 mid-
      // transaction — a 500 on what is really a bad request. `saveGlossarySchema` rejects the same
      // collision at the save boundary; the import path needs the same guard.
      .superRefine((terms, ctx) => {
        const seen = new Map<string, number>();
        terms.forEach((entry, index) => {
          const normalized = normalizeGlossarySurface(entry.term);
          if (normalized.length === 0) return;
          const first = seen.get(normalized);
          if (first !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'term'],
              message: `Duplicate glossary term — "${entry.term}" repeats the term at position ${first + 1}`,
            });
            return;
          }
          seen.set(normalized, index);
        });
      }),
  }),
});

/** The validated, typed import payload (never a cast off untrusted JSON). */
export type DefinitionImport = z.infer<typeof definitionImportSchema>;

/**
 * Parse + validate an uploaded definition file. Throws a user-facing {@link Error} on any failure
 * (invalid JSON, wrong `kind`, unsupported `schemaVersion`, or a shape Zod rejects) so the route can
 * map it to a clean 400. Accepts only the tagged envelope — a bare/foreign object is rejected, since
 * persisting half a questionnaire is worse than refusing the file.
 */
export function parseDefinitionImport(text: string): DefinitionImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error("This file doesn't look like a questionnaire definition export.");
  }

  const envelope = parsed as Record<string, unknown>;
  if (envelope.kind !== DEFINITION_EXPORT_KIND) {
    throw new Error("This file isn't a questionnaire definition export.");
  }
  if (envelope.schemaVersion !== DEFINITION_EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `This export was written for definition format v${String(envelope.schemaVersion)}, which this version can't import.`
    );
  }

  const result = definitionImportSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? ` (at ${first.path.join('.')})` : '';
    throw new Error(
      `This definition file is malformed${where}: ${first?.message ?? 'invalid shape'}`
    );
  }
  return result.data;
}
