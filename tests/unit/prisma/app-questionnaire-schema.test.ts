import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Schema-shape test for the questionnaire anchor models (F0.1 / T0.1.3).
 *
 * Two layers, neither needing a live DB:
 *  - `Prisma.dmmf` — the generated datamodel: model presence, `@@map` table
 *    names, field names/types, and the relation wiring. (Prisma 7's runtime DMMF
 *    is minimal — defaults, `onDelete`, and indexes are NOT in it.)
 *  - the committed init migration SQL — the constraint-level DDL the runtime DMMF
 *    can't see (FK `ON DELETE CASCADE`, the unique + lookup indexes) PLUS a guard
 *    that the schema-fold strip holds (no platform unmodelled-object operations
 *    leaked back in). Live integrity is also covered by `npm run db:drift-check`.
 */

type Model = Prisma.DMMF.Model;
type Field = Prisma.DMMF.Field;

function getModel(name: string): Model {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
  if (!model) throw new Error(`Model ${name} not found in Prisma datamodel`);
  return model;
}

function getField(model: Model, name: string): Field {
  const field = model.fields.find((f) => f.name === name);
  if (!field) throw new Error(`Field ${name} not found on ${model.name}`);
  return field;
}

function readMigrationSql(suffix: string): string {
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const folder = readdirSync(migrationsDir).find((d) => d.endsWith(suffix));
  if (!folder) throw new Error(`${suffix} migration folder not found`);
  return readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8');
}

function readInitMigrationSql(): string {
  return readMigrationSql('_app_questionnaire_init');
}

/** Strip `--` comment lines so explanatory headers (which name the stripped
 *  platform objects by name) don't trip the no-platform-DDL guards. */
function executableLines(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('questionnaire datamodel (Prisma.dmmf)', () => {
  it('AppQuestionnaire maps app_questionnaire with the expected fields', () => {
    const model = getModel('AppQuestionnaire');
    expect(model.dbName).toBe('app_questionnaire');

    expect(getField(model, 'id').type).toBe('String');
    expect(getField(model, 'title').type).toBe('String');
    expect(getField(model, 'status').type).toBe('String');
    expect(getField(model, 'createdAt').type).toBe('DateTime');
    expect(getField(model, 'updatedAt').type).toBe('DateTime');

    const versions = getField(model, 'versions');
    expect(versions.kind).toBe('object');
    expect(versions.type).toBe('AppQuestionnaireVersion');

    // DEMO-ONLY (F2.5.1): nullable demo-client attribution — a plain scalar FK
    // plus the relation field. onDelete/index are asserted in the migration block.
    expect(getField(model, 'demoClientId').type).toBe('String');
    expect(getField(model, 'demoClientId').kind).toBe('scalar');
    const demoClient = getField(model, 'demoClient');
    expect(demoClient.kind).toBe('object');
    expect(demoClient.type).toBe('AppDemoClient');
  });

  it('AppDemoClient maps app_demo_client with the F2.5.1 identity fields', () => {
    const model = getModel('AppDemoClient');
    expect(model.dbName).toBe('app_demo_client');

    expect(getField(model, 'id').type).toBe('String');
    expect(getField(model, 'slug').type).toBe('String');
    expect(getField(model, 'name').type).toBe('String');
    expect(getField(model, 'description').type).toBe('String');
    expect(getField(model, 'isActive').type).toBe('Boolean');
    expect(getField(model, 'createdAt').type).toBe('DateTime');
    expect(getField(model, 'updatedAt').type).toBe('DateTime');

    // Identity only at F2.5.1 — theme columns land with their first renderer.
    for (const themeField of ['primaryColour', 'logoUrl', 'welcomeMessageMd']) {
      expect(model.fields.find((f) => f.name === themeField)).toBeUndefined();
    }

    // Reverse relation back to the attributed questionnaires (count + delete guard).
    const questionnaires = getField(model, 'questionnaires');
    expect(questionnaires.kind).toBe('object');
    expect(questionnaires.type).toBe('AppQuestionnaire');
    expect(questionnaires.relationName).toBe(
      getField(getModel('AppQuestionnaire'), 'demoClient').relationName
    );
  });

  it('AppQuestionnaireVersion maps app_questionnaire_version and relates back', () => {
    const model = getModel('AppQuestionnaireVersion');
    expect(model.dbName).toBe('app_questionnaire_version');

    expect(getField(model, 'questionnaireId').type).toBe('String');
    expect(getField(model, 'versionNumber').type).toBe('Int');
    expect(getField(model, 'status').type).toBe('String');

    const relation = getField(model, 'questionnaire');
    expect(relation.kind).toBe('object');
    expect(relation.type).toBe('AppQuestionnaire');
    // both ends share the same relation
    expect(relation.relationName).toBe(
      getField(getModel('AppQuestionnaire'), 'versions').relationName
    );
  });

  it('AppQuestionnaireVersion carries the F1.1 goal/audience + ingestion relations', () => {
    const model = getModel('AppQuestionnaireVersion');

    // Goal/audience land on the VERSION (divergence from the deep spec) — see f1.1.md.
    // (Runtime DMMF exposes name/kind/type only — nullability is asserted in the
    // migration SQL block below.)
    expect(getField(model, 'goal').type).toBe('String');
    expect(getField(model, 'audience').type).toBe('Json');

    // Per-field provenance of the merged goal/audience (F2.1 / P2) — stored so the
    // admin UI marks inferred values without re-deriving from the change log.
    expect(getField(model, 'goalProvenance').type).toBe('String');
    expect(getField(model, 'audienceProvenance').type).toBe('Json');

    for (const [field, target] of [
      ['sections', 'AppQuestionnaireSection'],
      ['changeRecords', 'AppQuestionnaireExtractionChange'],
      ['sourceDocuments', 'AppQuestionnaireSourceDocument'],
    ] as const) {
      const rel = getField(model, field);
      expect(rel.kind).toBe('object');
      expect(rel.type).toBe(target);
    }
  });

  it('AppQuestionnaireSection maps app_questionnaire_section with version + questions wiring', () => {
    const model = getModel('AppQuestionnaireSection');
    expect(model.dbName).toBe('app_questionnaire_section');

    expect(getField(model, 'versionId').type).toBe('String');
    expect(getField(model, 'ordinal').type).toBe('Int');
    expect(getField(model, 'title').type).toBe('String');
    expect(getField(model, 'description').type).toBe('String');

    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');
    expect(version.relationName).toBe(
      getField(getModel('AppQuestionnaireVersion'), 'sections').relationName
    );

    const questions = getField(model, 'questions');
    expect(questions.kind).toBe('object');
    expect(questions.type).toBe('AppQuestionSlot');
  });

  it('AppQuestionSlot maps app_question_slot with the canonical field set', () => {
    const model = getModel('AppQuestionSlot');
    expect(model.dbName).toBe('app_question_slot');

    // denormalised versionId (F2.2 tag/slot same-version check) + the slot vocabulary.
    expect(getField(model, 'versionId').type).toBe('String');
    expect(getField(model, 'sectionId').type).toBe('String');
    expect(getField(model, 'ordinal').type).toBe('Int');
    expect(getField(model, 'key').type).toBe('String');
    expect(getField(model, 'prompt').type).toBe('String');
    expect(getField(model, 'guidelines').type).toBe('String');
    expect(getField(model, 'rationale').type).toBe('String');
    expect(getField(model, 'type').type).toBe('String');
    expect(getField(model, 'typeConfig').type).toBe('Json');
    expect(getField(model, 'required').type).toBe('Boolean');
    expect(getField(model, 'weight').type).toBe('Float');
    expect(getField(model, 'extractionConfidence').type).toBe('Float');

    const section = getField(model, 'section');
    expect(section.kind).toBe('object');
    expect(section.type).toBe('AppQuestionnaireSection');
    // No embedding column yet — deferred to F4.1.
    expect(model.fields.find((f) => f.name === 'embedding')).toBeUndefined();
  });

  it('AppQuestionnaireExtractionChange maps app_questionnaire_extraction_change', () => {
    const model = getModel('AppQuestionnaireExtractionChange');
    expect(model.dbName).toBe('app_questionnaire_extraction_change');

    expect(getField(model, 'changeType').type).toBe('String');
    expect(getField(model, 'targetEntityType').type).toBe('String');
    expect(getField(model, 'targetEntityId').type).toBe('String');
    expect(getField(model, 'sourceQuote').type).toBe('String');
    expect(getField(model, 'beforeJson').type).toBe('Json');
    expect(getField(model, 'afterJson').type).toBe('Json');
    expect(getField(model, 'confidence').type).toBe('Float');
    expect(getField(model, 'status').type).toBe('String');
    expect(getField(model, 'revertedAt').type).toBe('DateTime');
    // UG-1: reverter identity is a plain String, not a User FK/relation.
    expect(getField(model, 'revertedByUserId').type).toBe('String');
    expect(getField(model, 'revertedByUserId').kind).toBe('scalar');

    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');
  });

  it('AppQuestionnaireSourceDocument maps app_questionnaire_source_document', () => {
    const model = getModel('AppQuestionnaireSourceDocument');
    expect(model.dbName).toBe('app_questionnaire_source_document');

    expect(getField(model, 'fileName').type).toBe('String');
    expect(getField(model, 'fileHash').type).toBe('String');
    expect(getField(model, 'byteSize').type).toBe('Int');
    expect(getField(model, 'mimeType').type).toBe('String');
    expect(getField(model, 'pageCount').type).toBe('Int');
    expect(getField(model, 'warnings').type).toBe('Json');
    expect(getField(model, 'extractedText').type).toBe('String');
    expect(getField(model, 'bytes').type).toBe('Bytes');

    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');
  });

  it('AppQuestionTag maps app_question_tag and relates to version + slots (F2.2)', () => {
    const model = getModel('AppQuestionTag');
    expect(model.dbName).toBe('app_question_tag');

    expect(getField(model, 'versionId').type).toBe('String');
    expect(getField(model, 'label').type).toBe('String');
    expect(getField(model, 'normalizedLabel').type).toBe('String');
    expect(getField(model, 'color').type).toBe('String');

    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');
    expect(version.relationName).toBe(
      getField(getModel('AppQuestionnaireVersion'), 'tags').relationName
    );

    const slots = getField(model, 'slots');
    expect(slots.kind).toBe('object');
    expect(slots.type).toBe('AppQuestionSlotTag');
  });

  it('AppQuestionSlotTag maps app_question_slot_tag and joins slot↔tag (F2.2)', () => {
    const model = getModel('AppQuestionSlotTag');
    expect(model.dbName).toBe('app_question_slot_tag');

    expect(getField(model, 'questionSlotId').type).toBe('String');
    expect(getField(model, 'tagId').type).toBe('String');

    const slot = getField(model, 'questionSlot');
    expect(slot.kind).toBe('object');
    expect(slot.type).toBe('AppQuestionSlot');
    expect(slot.relationName).toBe(getField(getModel('AppQuestionSlot'), 'tags').relationName);

    const tag = getField(model, 'tag');
    expect(tag.kind).toBe('object');
    expect(tag.type).toBe('AppQuestionTag');
    expect(tag.relationName).toBe(getField(getModel('AppQuestionTag'), 'slots').relationName);
  });

  it('AppQuestionnaireConfig maps app_questionnaire_config 1:1 with the version (F3.1)', () => {
    const model = getModel('AppQuestionnaireConfig');
    expect(model.dbName).toBe('app_questionnaire_config');

    // versionId is the unique 1:1 FK (uniqueness/onDelete asserted in migration SQL).
    expect(getField(model, 'versionId').type).toBe('String');
    expect(getField(model, 'versionId').kind).toBe('scalar');

    // Every config column, with its storage type.
    expect(getField(model, 'selectionStrategy').type).toBe('String');
    expect(getField(model, 'minQuestionsAnswered').type).toBe('Int');
    expect(getField(model, 'coverageThreshold').type).toBe('Float');
    expect(getField(model, 'costBudgetUsd').type).toBe('Float');
    expect(getField(model, 'maxQuestionsPerSession').type).toBe('Int');
    expect(getField(model, 'voiceEnabled').type).toBe('Boolean');
    expect(getField(model, 'contradictionMode').type).toBe('String');
    expect(getField(model, 'contradictionWindowN').type).toBe('Int');
    expect(getField(model, 'anonymousMode').type).toBe('Boolean');
    // Profile fields are stored as JSON (ProfileFieldConfig[]) — not a relation.
    expect(getField(model, 'profileFields').type).toBe('Json');

    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');
    // Both ends share the same relation (reverse `config` field on the version).
    expect(version.relationName).toBe(
      getField(getModel('AppQuestionnaireVersion'), 'config').relationName
    );
  });

  it('AppQuestionnaireVersion carries the F3.1 config reverse relation', () => {
    const config = getField(getModel('AppQuestionnaireVersion'), 'config');
    expect(config.kind).toBe('object');
    expect(config.type).toBe('AppQuestionnaireConfig');
    // Both ends share the relation (1:1 uniqueness is asserted in the migration SQL).
    expect(config.relationName).toBe(
      getField(getModel('AppQuestionnaireConfig'), 'version').relationName
    );
  });
});

describe('app_questionnaire_init migration SQL', () => {
  const sql = readInitMigrationSql();
  // Executable DDL only — drop `--` comment lines so the explanatory header
  // (which names the stripped platform objects) doesn't trip the guard below.
  const executableSql = executableLines(sql);

  it('creates exactly the two app tables', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire"');
    expect(sql).toContain('CREATE TABLE "app_questionnaire_version"');
    // Enforce "exactly" — a phantom platform table leaking back through the
    // schema-fold footgun would otherwise pass the two presence checks above.
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(2);
  });

  it('declares the version→questionnaire FK with ON DELETE CASCADE', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_version_questionnaireId_fkey"[\s\S]*REFERENCES "app_questionnaire"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('creates the composite unique and the lookup indexes', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "app_questionnaire_version_questionnaireId_versionNumber_key"'
    );
    expect(sql).toContain('CREATE INDEX "app_questionnaire_status_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_version_questionnaireId_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // Regression guard: a regenerated migration must never re-introduce DROPs of
    // the platform's pgvector indexes / tsvector column or other ai_* drift.
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('ai_conversation');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_questionnaire_ingestion migration SQL', () => {
  const sql = readMigrationSql('_app_questionnaire_ingestion');
  const executableSql = executableLines(sql);

  it('creates the four ingestion-graph tables', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire_section"');
    expect(sql).toContain('CREATE TABLE "app_question_slot"');
    expect(sql).toContain('CREATE TABLE "app_questionnaire_extraction_change"');
    expect(sql).toContain('CREATE TABLE "app_questionnaire_source_document"');
    // Exactly four — this is the migration where the schema-fold footgun fired,
    // so guard against a phantom platform CREATE TABLE leaking back in.
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(4);
  });

  it('adds goal/audience to the version table', () => {
    expect(sql).toMatch(/ALTER TABLE "app_questionnaire_version" ADD COLUMN\s+"audience" JSONB/);
    // Anchor `goal` to the version ALTER too (not a bare substring that could
    // match any table's DDL) — mirrors the `audience` assertion above.
    expect(sql).toMatch(/ALTER TABLE "app_questionnaire_version"[\s\S]*"goal" TEXT/);
  });

  it('declares every child→version FK with ON DELETE CASCADE', () => {
    for (const table of [
      'app_questionnaire_section',
      'app_questionnaire_extraction_change',
      'app_questionnaire_source_document',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `ADD CONSTRAINT "${table}_versionId_fkey"[\\s\\S]*REFERENCES "app_questionnaire_version"\\("id"\\)[\\s\\S]*ON DELETE CASCADE`
        )
      );
    }
    // Slots cascade through their section (no direct version FK).
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_question_slot_sectionId_fkey"[\s\S]*REFERENCES "app_questionnaire_section"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('enforces the per-version slot key uniqueness and lookup indexes', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "app_question_slot_versionId_key_key"');
    expect(sql).toContain('CREATE INDEX "app_question_slot_versionId_idx"');
    expect(sql).toContain('CREATE INDEX "app_question_slot_sectionId_idx"');
  });

  it('indexes the change log by (versionId,status) and changeType, and docs by fileHash', () => {
    expect(sql).toContain(
      'CREATE INDEX "app_questionnaire_extraction_change_versionId_status_idx"'
    );
    expect(sql).toContain('CREATE INDEX "app_questionnaire_extraction_change_changeType_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_source_document_fileHash_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // The raw `migrate dev` for this migration emitted DROPs of the three pgvector
    // indexes + an (invalid) ALTER of the GENERATED searchVector column. All were
    // stripped by hand; this guard fails if a regeneration leaks them back in.
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('ai_message');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_demo_client migration SQL', () => {
  const sql = readMigrationSql('_app_demo_client');
  const executableSql = executableLines(sql);

  it('creates exactly the app_demo_client table', () => {
    expect(sql).toContain('CREATE TABLE "app_demo_client"');
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(1);
  });

  it('adds the nullable demoClientId column to app_questionnaire', () => {
    expect(sql).toMatch(/ALTER TABLE "app_questionnaire" ADD COLUMN\s+"demoClientId" TEXT;/);
  });

  it('declares the demoClient FK with ON DELETE SET NULL (questionnaire outlives its client)', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_demoClientId_fkey"[\s\S]*REFERENCES "app_demo_client"\("id"\)[\s\S]*ON DELETE SET NULL/
    );
  });

  it('enforces the unique slug and the demoClientId lookup index', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "app_demo_client_slug_key"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_demoClientId_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_questionnaire_version_provenance migration SQL', () => {
  const sql = readMigrationSql('_app_questionnaire_version_provenance');
  const executableSql = executableLines(sql);

  it('adds goalProvenance + audienceProvenance to the version table', () => {
    expect(sql).toMatch(/ALTER TABLE "app_questionnaire_version"[\s\S]*"audienceProvenance" JSONB/);
    expect(sql).toMatch(/ALTER TABLE "app_questionnaire_version"[\s\S]*"goalProvenance" TEXT/);
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // Same footgun as the ingestion migration: `migrate dev` re-emitted the three
    // pgvector DROP INDEX + the GENERATED searchVector ALTER. Stripped by hand;
    // this guard fails if a regeneration leaks them back in.
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
    // Exactly one executable statement — our single ALTER TABLE.
    expect(executableSql.match(/ALTER TABLE/g) ?? []).toHaveLength(1);
  });
});

describe('app_question_tags migration SQL (F2.2)', () => {
  const sql = readMigrationSql('_app_question_tags');
  const executableSql = executableLines(sql);

  it('creates exactly the two tag tables', () => {
    expect(sql).toContain('CREATE TABLE "app_question_tag"');
    expect(sql).toContain('CREATE TABLE "app_question_slot_tag"');
    // Exactly two — guard against a phantom platform CREATE leaking back through
    // the schema-fold footgun.
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(2);
  });

  it('declares both FK directions of the join with ON DELETE CASCADE', () => {
    // Tag → version.
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_question_tag_versionId_fkey"[\s\S]*REFERENCES "app_questionnaire_version"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
    // Join → slot and join → tag.
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_question_slot_tag_questionSlotId_fkey"[\s\S]*REFERENCES "app_question_slot"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_question_slot_tag_tagId_fkey"[\s\S]*REFERENCES "app_question_tag"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('enforces per-version label uniqueness, the join uniqueness, and lookup indexes', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "app_question_tag_versionId_normalizedLabel_key"');
    expect(sql).toContain('CREATE INDEX "app_question_tag_versionId_idx"');
    expect(sql).toContain('CREATE UNIQUE INDEX "app_question_slot_tag_questionSlotId_tagId_key"');
    expect(sql).toContain('CREATE INDEX "app_question_slot_tag_questionSlotId_idx"');
    expect(sql).toContain('CREATE INDEX "app_question_slot_tag_tagId_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_questionnaire_config migration SQL (F3.1)', () => {
  const sql = readMigrationSql('_app_questionnaire_config');
  const executableSql = executableLines(sql);

  it('creates exactly the app_questionnaire_config table', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire_config"');
    // Exactly one — guard against a phantom platform CREATE leaking back through
    // the schema-fold footgun.
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(1);
  });

  it('declares the version FK with ON DELETE CASCADE', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_config_versionId_fkey"[\s\S]*REFERENCES "app_questionnaire_version"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('enforces the 1:1 unique index on versionId', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "app_questionnaire_config_versionId_key"');
  });

  it('defaults profileFields to an empty JSON array', () => {
    expect(sql).toMatch(/"profileFields" JSONB NOT NULL DEFAULT '\[\]'/);
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // `migrate dev` re-emitted the three pgvector DROP INDEX + the GENERATED
    // searchVector ALTER. Stripped by hand; this guard fails if a regeneration
    // leaks them back in.
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
  });
});
