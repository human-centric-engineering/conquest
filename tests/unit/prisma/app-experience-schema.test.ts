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

describe('experience pointers on other models (F15.4)', () => {
  it('keeps AppQuestionnaireSession.experienceStepId a plain scalar String', () => {
    const session = getModel('AppQuestionnaireSession');
    const field = getField(session, 'experienceStepId');

    // Same UG-1 posture as roundId / cohortMemberId / cohortSubgroupId beside it: an
    // identity↔answer pointer read for report SCOPING and stats, never a graph edge.
    expect(field.kind).toBe('scalar');
    expect(field.type).toBe('String');
  });

  it('declares NO relation from a session to an experience step', () => {
    // The load-bearing assertion. A real relation would let editing a journey's steps cascade
    // into respondent answers, and would make answers reachable by walking experience config.
    const session = getModel('AppQuestionnaireSession');
    const stepRelations = session.fields.filter(
      (f) => f.kind === 'object' && f.type === 'AppExperienceStep'
    );
    expect(stepRelations).toEqual([]);
  });

  it('keeps AppCohortReport.experienceStepOwnerId a plain scalar String with no relation', () => {
    // No FK: a step is experience CONFIG, and a cascade would delete a generated report about
    // respondents who already ran it.
    const report = getModel('AppCohortReport');
    const field = getField(report, 'experienceStepOwnerId');
    expect(field.kind).toBe('scalar');
    expect(field.type).toBe('String');

    const stepRelations = report.fields.filter(
      (f) => f.kind === 'object' && f.type === 'AppExperienceStep'
    );
    expect(stepRelations).toEqual([]);
  });
});

describe('F15.4 migration SQL', () => {
  /** Read one migration by folder suffix. */
  function readMigration(suffix: string): string {
    const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
    const folder = readdirSync(migrationsDir).find((d) => d.endsWith(suffix));
    if (!folder) throw new Error(`${suffix} migration folder not found`);
    return readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8');
  }

  const sessionSql = readMigration('_add_session_experience_step_id');
  const reportSql = readMigration('_add_cohort_report_experience_step_scope');

  it('adds experienceStepId NULLABLE — every pre-existing session correctly has none', () => {
    const line = executableLines(sessionSql).match(/ADD COLUMN\s+"experienceStepId"[^;]*/)?.[0];
    expect(line).toBeTruthy();
    expect(line).toContain('TEXT');
    // A NOT NULL would have required a backfill for every session ever taken.
    expect(line).not.toContain('NOT NULL');
  });

  it('indexes experienceStepId — it is the per-step report scope filter', () => {
    expect(executableLines(sessionSql)).toMatch(
      /CREATE INDEX .*app_questionnaire_session.*"experienceStepId"/
    );
  });

  it('adds experienceStepOwnerId nullable and UNIQUE — one report per step', () => {
    const exec = executableLines(reportSql);
    const line = exec.match(/ADD COLUMN\s+"experienceStepOwnerId"[^;]*/)?.[0];
    expect(line).toBeTruthy();
    // Nullable is what lets the round- and version-scoped rows coexist in the same table:
    // Postgres permits multiple NULLs in a unique index.
    expect(line).not.toContain('NOT NULL');
    expect(exec).toMatch(/CREATE UNIQUE INDEX .*"experienceStepOwnerId"/);
  });

  it('declares no foreign key for either new pointer', () => {
    expect(executableLines(sessionSql)).not.toMatch(/FOREIGN KEY/i);
    expect(executableLines(reportSql)).not.toMatch(/FOREIGN KEY/i);
  });

  it('does not drop the raw-SQL pgvector / tsvector indexes', () => {
    // Both migrations were hand-stripped; Prisma's diff proposes these drops every time because
    // it cannot see raw-SQL indexes. A regression here silently destroys vector search.
    for (const sql of [sessionSql, reportSql]) {
      const exec = executableLines(sql);
      expect(exec).not.toMatch(/DROP INDEX/i);
      // The GENERATED ALWAYS searchVector column draws a phantom DROP DEFAULT for the same reason.
      expect(exec).not.toMatch(/DROP DEFAULT/i);
    }
  });

  it('touches only its own table', () => {
    expect(executableLines(sessionSql)).not.toMatch(/ALTER TABLE "ai_knowledge_chunk"/);
    expect(executableLines(reportSql)).not.toMatch(/ALTER TABLE "ai_knowledge_chunk"/);
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
