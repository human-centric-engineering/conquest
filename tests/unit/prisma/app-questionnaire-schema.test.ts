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

function readInitMigrationSql(): string {
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const folder = readdirSync(migrationsDir).find((d) => d.endsWith('_app_questionnaire_init'));
  if (!folder) throw new Error('app_questionnaire_init migration folder not found');
  return readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8');
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
});

describe('app_questionnaire_init migration SQL', () => {
  const sql = readInitMigrationSql();
  // Executable DDL only — drop `--` comment lines so the explanatory header
  // (which names the stripped platform objects) doesn't trip the guard below.
  const executableSql = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('creates exactly the two app tables', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire"');
    expect(sql).toContain('CREATE TABLE "app_questionnaire_version"');
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
