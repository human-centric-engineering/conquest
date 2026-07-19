import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Schema-shape test for the Experience models (P15.1).
 *
 * Two layers, neither needing a live DB — mirroring `app-questionnaire-schema.test.ts`:
 *  - `Prisma.dmmf` — model presence, `@@map` table names, field names/types, relation wiring.
 *    (Prisma 7's runtime DMMF is minimal: defaults, `onDelete` and indexes are NOT in it.)
 *  - the committed migration SQL — the constraint-level DDL the DMMF cannot see (FK cascade, the
 *    unique + lookup indexes), PLUS the guard that the phantom pgvector `DROP INDEX` statements
 *    were stripped before the migration was committed.
 *
 * The FK-posture assertions are the load-bearing ones. `questionnaireId`, `versionId`, `roundId`
 * and `cohortId` must stay plain Strings with no relation: a real FK would let archiving a
 * questionnaire cascade away an experience's authored structure and its run history, and the
 * UG-1 house rule keeps identity↔answer pointers unwalkable from config.
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

function readExperienceMigrationSql(): string {
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const folder = readdirSync(migrationsDir).find((d) => d.endsWith('_add_app_experience'));
  if (!folder) throw new Error('add_app_experience migration folder not found');
  return readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8');
}

/** Strip `--` comment lines so the explanatory header (which names the stripped pgvector
 *  indexes) doesn't trip the no-phantom-DDL guard below. */
function executableLines(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('experience datamodel (Prisma.dmmf)', () => {
  it('AppExperience maps app_experience with the expected fields', () => {
    const model = getModel('AppExperience');
    expect(model.dbName).toBe('app_experience');

    for (const [name, type] of [
      ['id', 'String'],
      ['title', 'String'],
      ['kind', 'String'],
      ['status', 'String'],
      ['continuityMode', 'String'],
      ['routingFallback', 'String'],
      ['minRoutingConfidence', 'Float'],
      ['costBudgetUsd', 'Float'],
      ['accessMode', 'String'],
      ['settings', 'Json'],
      ['createdAt', 'DateTime'],
      ['updatedAt', 'DateTime'],
    ] as const) {
      expect(getField(model, name).type).toBe(type);
    }

    // demoClientId is app-internal CONFIG scoping, so it IS a modelled relation (cascade asserted
    // against the migration SQL below).
    expect(getField(model, 'demoClientId').kind).toBe('scalar');
    const demoClient = getField(model, 'demoClient');
    expect(demoClient.kind).toBe('object');
    expect(demoClient.type).toBe('AppDemoClient');

    const steps = getField(model, 'steps');
    expect(steps.kind).toBe('object');
    expect(steps.type).toBe('AppExperienceStep');
  });

  it('keeps AppExperience roster and author pointers unmodelled (UG-1)', () => {
    const model = getModel('AppExperience');

    // Prisma 7's runtime DMMF is minimal and omits nullability, so `kind`/`type` are asserted
    // here and the nullable-column check lives in the migration-SQL block below.
    for (const name of ['cohortId', 'createdBy'] as const) {
      expect(getField(model, name).kind).toBe('scalar');
      expect(getField(model, name).type).toBe('String');
    }
    // No relation field may exist for them — that is what "unmodelled pointer" means.
    expect(model.fields.some((f) => f.kind === 'object' && f.type === 'AppCohort')).toBe(false);
    expect(model.fields.some((f) => f.kind === 'object' && f.type === 'User')).toBe(false);
  });

  it('AppExperienceStep maps app_experience_step with the expected fields', () => {
    const model = getModel('AppExperienceStep');
    expect(model.dbName).toBe('app_experience_step');

    for (const [name, type] of [
      ['id', 'String'],
      ['key', 'String'],
      ['kind', 'String'],
      ['title', 'String'],
      ['ordinal', 'Int'],
    ] as const) {
      expect(getField(model, name).type).toBe(type);
    }

    const experience = getField(model, 'experience');
    expect(experience.kind).toBe('object');
    expect(experience.type).toBe('AppExperience');
  });

  it('keeps every AppExperienceStep target pointer unmodelled (UG-1)', () => {
    // The critical assertion. A real FK here would let deleting or archiving a questionnaire
    // cascade away the experience's structure and, through it, respondent history.
    const model = getModel('AppExperienceStep');

    for (const name of ['questionnaireId', 'versionId', 'roundId'] as const) {
      const field = getField(model, name);
      expect(field.kind).toBe('scalar');
      expect(field.type).toBe('String');
    }

    for (const type of [
      'AppQuestionnaire',
      'AppQuestionnaireVersion',
      'AppQuestionnaireRound',
    ] as const) {
      expect(model.fields.some((f) => f.kind === 'object' && f.type === type)).toBe(false);
    }
  });
});

describe('experience migration SQL', () => {
  const sql = readExperienceMigrationSql();

  it('cascades both config relations on delete', () => {
    // An experience is meaningless without its client; a step is meaningless without its
    // experience. Both are config edges, so cascade is correct here.
    expect(sql).toMatch(
      /ALTER TABLE "app_experience" ADD CONSTRAINT "app_experience_demoClientId_fkey"[\s\S]*?ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /ALTER TABLE "app_experience_step" ADD CONSTRAINT "app_experience_step_experienceId_fkey"[\s\S]*?ON DELETE CASCADE/
    );
  });

  it('declares no foreign key for the unmodelled pointers', () => {
    for (const column of ['questionnaireId', 'versionId', 'roundId', 'cohortId'] as const) {
      expect(sql).not.toMatch(new RegExp(`FOREIGN KEY \\("${column}"\\)`));
    }
  });

  it('leaves every unmodelled pointer nullable', () => {
    // A step is legitimately half-authored (added, questionnaire not yet chosen), and an
    // experience need not have a cohort. NOT NULL on any of these would force placeholder rows.
    for (const column of [
      'questionnaireId',
      'versionId',
      'roundId',
      'cohortId',
      'createdBy',
    ] as const) {
      expect(sql).toMatch(new RegExp(`"${column}" TEXT,`));
      expect(sql).not.toMatch(new RegExp(`"${column}" TEXT NOT NULL`));
    }
  });

  it('scopes step keys to their experience and indexes the lookups', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "app_experience_step_experienceId_key_key" ON "app_experience_step"("experienceId", "key")'
    );
    expect(sql).toContain('CREATE UNIQUE INDEX "app_experience_publicRef_key"');
    expect(sql).toContain('CREATE INDEX "app_experience_demoClientId_idx"');
    expect(sql).toContain('CREATE INDEX "app_experience_status_idx"');
    expect(sql).toContain('CREATE INDEX "app_experience_step_experienceId_idx"');
  });

  it('does not drop the raw-SQL pgvector / tsvector indexes', () => {
    // Prisma's diff engine cannot see these (they are raw-SQL and invisible to the schema), so
    // every autogenerated app migration proposes dropping them. They must be stripped by hand
    // before committing — this guard is what catches a migration that forgot.
    const executable = executableLines(sql);

    expect(executable).not.toMatch(/DROP INDEX/i);
    for (const index of [
      'idx_ai_knowledge_chunk_search_vector',
      'idx_knowledge_embedding',
      'idx_message_embedding',
      'idx_app_data_slot_embedding',
      'idx_app_question_slot_embedding',
    ]) {
      expect(executable).not.toContain(index);
    }
    // The same diff also proposes dropping a generated default on a platform table.
    expect(executable).not.toMatch(/ALTER TABLE "ai_knowledge_chunk"/);
  });

  it('touches only the two new experience tables', () => {
    const created = [...executableLines(sql).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(['app_experience', 'app_experience_step']);
  });
});
