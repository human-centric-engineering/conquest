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
  exportedAt: string
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
