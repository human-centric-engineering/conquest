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

  it('AppDemoClient maps app_demo_client with the identity + F3.4 theme fields', () => {
    const model = getModel('AppDemoClient');
    expect(model.dbName).toBe('app_demo_client');

    expect(getField(model, 'id').type).toBe('String');
    expect(getField(model, 'slug').type).toBe('String');
    expect(getField(model, 'name').type).toBe('String');
    expect(getField(model, 'description').type).toBe('String');
    expect(getField(model, 'isActive').type).toBe('Boolean');
    expect(getField(model, 'createdAt').type).toBe('DateTime');
    expect(getField(model, 'updatedAt').type).toBe('DateTime');

    // DEMO-ONLY (F3.4): theme columns land now that the invitation email renders
    // them. All nullable String scalars (nullability asserted in the migration SQL);
    // resolveTheme() fills nulls with Sunrise defaults.
    for (const themeField of ['ctaColor', 'accentColor', 'logoUrl', 'welcomeCopy']) {
      const field = getField(model, themeField);
      expect(field.type).toBe('String');
      expect(field.kind).toBe('scalar');
    }

    // Reverse relation back to the attributed questionnaires (count + delete guard).
    const questionnaires = getField(model, 'questionnaires');
    expect(questionnaires.kind).toBe('object');
    expect(questionnaires.type).toBe('AppQuestionnaire');
    expect(questionnaires.relationName).toBe(
      getField(getModel('AppQuestionnaire'), 'demoClient').relationName
    );

    // DEMO-ONLY (F3.4): reverse relation to the invitations carrying this client's
    // brand snapshot — shares the relation with AppQuestionnaireInvitation.demoClient.
    const invitations = getField(model, 'invitations');
    expect(invitations.kind).toBe('object');
    expect(invitations.type).toBe('AppQuestionnaireInvitation');
    expect(invitations.relationName).toBe(
      getField(getModel('AppQuestionnaireInvitation'), 'demoClient').relationName
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

  it('AppQuestionnaireInvitation maps app_questionnaire_invitation (F3.2)', () => {
    const model = getModel('AppQuestionnaireInvitation');
    expect(model.dbName).toBe('app_questionnaire_invitation');

    // versionId is the pinning FK (onDelete/index asserted in migration SQL).
    expect(getField(model, 'versionId').type).toBe('String');
    expect(getField(model, 'versionId').kind).toBe('scalar');

    expect(getField(model, 'email').type).toBe('String');
    expect(getField(model, 'name').type).toBe('String');
    expect(getField(model, 'tokenHash').type).toBe('String');
    expect(getField(model, 'status').type).toBe('String');
    expect(getField(model, 'expiresAt').type).toBe('DateTime');
    expect(getField(model, 'sentAt').type).toBe('DateTime');
    expect(getField(model, 'openedAt').type).toBe('DateTime');
    expect(getField(model, 'registeredAt').type).toBe('DateTime');
    expect(getField(model, 'revokedAt').type).toBe('DateTime');

    // User FKs are plain scalars, no @relation (UG-1) — like revertedByUserId.
    expect(getField(model, 'userId').type).toBe('String');
    expect(getField(model, 'userId').kind).toBe('scalar');
    expect(getField(model, 'invitedByUserId').type).toBe('String');
    expect(getField(model, 'invitedByUserId').kind).toBe('scalar');
    expect(model.fields.some((f) => f.relationName?.includes('User'))).toBe(false);

    // DEMO-ONLY (F3.4): the brand-snapshot FK — a scalar plus a modelled relation to
    // AppDemoClient (onDelete/index asserted in the migration SQL). Unlike the User
    // columns this IS a real @relation (same recipe as AppQuestionnaire.demoClient).
    expect(getField(model, 'demoClientId').type).toBe('String');
    expect(getField(model, 'demoClientId').kind).toBe('scalar');
    const demoClient = getField(model, 'demoClient');
    expect(demoClient.kind).toBe('object');
    expect(demoClient.type).toBe('AppDemoClient');

    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');
    // Both ends share the relation (reverse `invitations` field on the version).
    expect(version.relationName).toBe(
      getField(getModel('AppQuestionnaireVersion'), 'invitations').relationName
    );
  });

  it('AppQuestionnaireVersion carries the F3.2 invitations reverse relation', () => {
    const invitations = getField(getModel('AppQuestionnaireVersion'), 'invitations');
    expect(invitations.kind).toBe('object');
    expect(invitations.type).toBe('AppQuestionnaireInvitation');
  });

  it('AppQuestionnaireSession maps app_questionnaire_session (F4.4 / F4.6)', () => {
    const model = getModel('AppQuestionnaireSession');
    expect(model.dbName).toBe('app_questionnaire_session');

    expect(getField(model, 'versionId').type).toBe('String');
    // status / isPreview are plain columns; status is validated against SESSION_STATUSES
    // at the seam (house style), and F4.6 added `paused` to that tuple.
    expect(getField(model, 'status').type).toBe('String');
    expect(getField(model, 'isPreview').type).toBe('Boolean');
    // respondentUserId is a plain String scalar, no @relation (UG-1); null until F6.1.
    expect(getField(model, 'respondentUserId').type).toBe('String');
    expect(getField(model, 'respondentUserId').kind).toBe('scalar');

    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');

    const answers = getField(model, 'answers');
    expect(answers.kind).toBe('object');
    expect(answers.type).toBe('AppAnswerSlot');
  });

  it('AppAnswerSlot maps app_answer_slot with the F4.4 capture fields', () => {
    const model = getModel('AppAnswerSlot');
    expect(model.dbName).toBe('app_answer_slot');

    expect(getField(model, 'sessionId').type).toBe('String');
    expect(getField(model, 'questionSlotId').type).toBe('String');
    expect(getField(model, 'value').type).toBe('Json');
    expect(getField(model, 'confidence').type).toBe('Float');
    expect(getField(model, 'provenanceLabel').type).toBe('String');
    expect(getField(model, 'refinementHistory').type).toBe('Json');
    // The F6.1 turn-loop seam — reserved, null until the live loop exists.
    expect(getField(model, 'lastUpdatedTurnId').type).toBe('String');
    expect(getField(model, 'lastUpdatedTurnId').kind).toBe('scalar');

    const session = getField(model, 'session');
    expect(session.kind).toBe('object');
    expect(session.type).toBe('AppQuestionnaireSession');
    expect(session.relationName).toBe(
      getField(getModel('AppQuestionnaireSession'), 'answers').relationName
    );

    const questionSlot = getField(model, 'questionSlot');
    expect(questionSlot.kind).toBe('object');
    expect(questionSlot.type).toBe('AppQuestionSlot');
  });

  it('AppQuestionnaireSessionEvent maps app_questionnaire_session_event (F4.6)', () => {
    const model = getModel('AppQuestionnaireSessionEvent');
    expect(model.dbName).toBe('app_questionnaire_session_event');

    expect(getField(model, 'sessionId').type).toBe('String');
    expect(getField(model, 'sessionId').kind).toBe('scalar');
    // eventType / from/toStatus are plain String columns (house style), not Prisma
    // enums — validated against SESSION_EVENT_TYPES / SESSION_STATUSES at the seam.
    expect(getField(model, 'eventType').type).toBe('String');
    expect(getField(model, 'fromStatus').type).toBe('String');
    expect(getField(model, 'toStatus').type).toBe('String');
    expect(getField(model, 'reason').type).toBe('String');
    expect(getField(model, 'metadata').type).toBe('Json');
    expect(getField(model, 'createdAt').type).toBe('DateTime');

    const session = getField(model, 'session');
    expect(session.kind).toBe('object');
    expect(session.type).toBe('AppQuestionnaireSession');
    // Shares the relation with the reverse `events` field on the session.
    expect(session.relationName).toBe(
      getField(getModel('AppQuestionnaireSession'), 'events').relationName
    );
  });

  it('AppQuestionnaireSession carries the F4.6 events reverse relation', () => {
    const events = getField(getModel('AppQuestionnaireSession'), 'events');
    expect(events.kind).toBe('object');
    expect(events.type).toBe('AppQuestionnaireSessionEvent');
  });

  it('AppQuestionnaireEvaluationRun maps app_questionnaire_evaluation_run with the F5.2 fields', () => {
    const model = getModel('AppQuestionnaireEvaluationRun');
    expect(model.dbName).toBe('app_questionnaire_evaluation_run');

    expect(getField(model, 'id').type).toBe('String');
    expect(getField(model, 'versionId').type).toBe('String');
    expect(getField(model, 'questionnaireId').type).toBe('String');
    expect(getField(model, 'status').type).toBe('String');
    // Deferred User FK (UG-1) — a plain scalar, not a relation.
    expect(getField(model, 'triggeredByUserId').type).toBe('String');
    expect(getField(model, 'triggeredByUserId').kind).toBe('scalar');
    expect(getField(model, 'dimensionsRequested').type).toBe('Int');
    expect(getField(model, 'dimensionsRun').type).toBe('Int');
    expect(getField(model, 'dimensionsFailed').type).toBe('Int');
    expect(getField(model, 'totalFindings').type).toBe('Int');
    expect(getField(model, 'dimensionSummary').type).toBe('Json');
    expect(getField(model, 'costUsd').type).toBe('Float');
    expect(getField(model, 'error').type).toBe('String');
    expect(getField(model, 'startedAt').type).toBe('DateTime');
    expect(getField(model, 'completedAt').type).toBe('DateTime');
    expect(getField(model, 'createdAt').type).toBe('DateTime');
    expect(getField(model, 'updatedAt').type).toBe('DateTime');

    // Relates back to the version (and forward to its findings).
    const version = getField(model, 'version');
    expect(version.kind).toBe('object');
    expect(version.type).toBe('AppQuestionnaireVersion');
    expect(version.relationName).toBe(
      getField(getModel('AppQuestionnaireVersion'), 'evaluationRuns').relationName
    );
    const findings = getField(model, 'findings');
    expect(findings.kind).toBe('object');
    expect(findings.type).toBe('AppQuestionnaireEvaluationFinding');
  });

  it('AppQuestionnaireEvaluationFinding maps app_questionnaire_evaluation_finding with the F5.2 fields', () => {
    const model = getModel('AppQuestionnaireEvaluationFinding');
    expect(model.dbName).toBe('app_questionnaire_evaluation_finding');

    expect(getField(model, 'id').type).toBe('String');
    expect(getField(model, 'runId').type).toBe('String');
    expect(getField(model, 'dimension').type).toBe('String');
    expect(getField(model, 'ordinal').type).toBe('Int');
    expect(getField(model, 'targetKey').type).toBe('String');
    expect(getField(model, 'severity').type).toBe('String');
    expect(getField(model, 'proposedChange').type).toBe('String');
    expect(getField(model, 'rationale').type).toBe('String');
    expect(getField(model, 'sourceQuote').type).toBe('String');
    // Minimal review lifecycle column, added at F5.2 so F5.3 extends rows (not a 2nd migration).
    expect(getField(model, 'status').type).toBe('String');
    expect(getField(model, 'createdAt').type).toBe('DateTime');
    expect(getField(model, 'updatedAt').type).toBe('DateTime');

    const run = getField(model, 'run');
    expect(run.kind).toBe('object');
    expect(run.type).toBe('AppQuestionnaireEvaluationRun');
    expect(run.relationName).toBe(
      getField(getModel('AppQuestionnaireEvaluationRun'), 'findings').relationName
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

describe('app_questionnaire_invitation migration SQL (F3.2)', () => {
  const sql = readMigrationSql('_app_questionnaire_invitation');
  const executableSql = executableLines(sql);

  it('creates exactly the app_questionnaire_invitation table', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire_invitation"');
    // Exactly one — guard against a phantom platform CREATE leaking back through
    // the schema-fold footgun.
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(1);
  });

  it('declares the version FK with ON DELETE CASCADE', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_invitation_versionId_fkey"[\s\S]*REFERENCES "app_questionnaire_version"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('enforces the unique index on tokenHash and the lookup indexes', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "app_questionnaire_invitation_tokenHash_key"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_invitation_versionId_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_invitation_status_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_invitation_email_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_invitation_userId_idx"');
  });

  it('declares no relational FK for the User columns (UG-1 plain-String FKs)', () => {
    // userId / invitedByUserId are plain scalars — no FK constraint to "user".
    expect(sql).not.toMatch(/invitation_userId_fkey/);
    expect(sql).not.toMatch(/invitation_invitedByUserId_fkey/);
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // `migrate dev` re-emitted the three pgvector DROP INDEX + the GENERATED
    // searchVector ALTER (the latter even dropped the live indexes once). Stripped
    // by hand; this guard fails if a regeneration leaks them back in.
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_questionnaire_invitation_branding migration SQL (F3.4)', () => {
  const sql = readMigrationSql('_app_questionnaire_invitation_branding');
  const executableSql = executableLines(sql);

  it('adds the four nullable theme columns to app_demo_client', () => {
    for (const col of ['ctaColor', 'accentColor', 'logoUrl', 'welcomeCopy']) {
      // Nullable: TEXT with no NOT NULL — resolveTheme() fills nulls with defaults.
      expect(sql).toMatch(new RegExp(`ADD COLUMN\\s+"${col}" TEXT(?!\\s+NOT NULL)`));
    }
  });

  it('adds the nullable demoClientId brand-snapshot column to the invitation', () => {
    expect(sql).toMatch(
      /ALTER TABLE "app_questionnaire_invitation" ADD COLUMN\s+"demoClientId" TEXT;/
    );
  });

  it('declares the demoClient FK with ON DELETE SET NULL (brand snapshot survives client delete)', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_invitation_demoClientId_fkey"[\s\S]*REFERENCES "app_demo_client"\("id"\)[\s\S]*ON DELETE SET NULL/
    );
  });

  it('indexes the invitation demoClientId lookup', () => {
    expect(sql).toContain('CREATE INDEX "app_questionnaire_invitation_demoClientId_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // `migrate dev` re-emitted the three pgvector DROP INDEX + the GENERATED
    // searchVector ALTER. Stripped by hand; this guard fails if a regeneration
    // leaks them back in.
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
    // Additive only — no CREATE TABLE in this migration.
    expect(executableSql).not.toContain('CREATE TABLE');
  });
});

describe('app_answer_slot_refinement migration SQL (F4.4)', () => {
  const sql = readMigrationSql('_app_answer_slot_refinement');
  const executableSql = executableLines(sql);

  it('creates exactly the session + answer-slot tables', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire_session"');
    expect(sql).toContain('CREATE TABLE "app_answer_slot"');
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(2);
  });

  it('declares the session→version and answer→session/slot FKs with ON DELETE CASCADE', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_session_versionId_fkey"[\s\S]*REFERENCES "app_questionnaire_version"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_answer_slot_sessionId_fkey"[\s\S]*REFERENCES "app_questionnaire_session"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_answer_slot_questionSlotId_fkey"[\s\S]*REFERENCES "app_question_slot"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('enforces the one-answer-per-slot composite unique and the lookup indexes', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "app_answer_slot_sessionId_questionSlotId_key"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_session_versionId_idx"');
    expect(sql).toContain('CREATE INDEX "app_answer_slot_sessionId_idx"');
    expect(sql).toContain('CREATE INDEX "app_answer_slot_questionSlotId_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_session_preview_unique migration SQL (F4.5)', () => {
  const sql = readMigrationSql('_app_session_preview_unique');
  const executableSql = executableLines(sql);

  it('creates the partial unique index scoped to preview sessions', () => {
    // The raw-SQL partial unique index Prisma can't model — guarded live by db-drift.ts.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "idx_app_questionnaire_session_preview_per_version"[\s\S]*ON "app_questionnaire_session" \("versionId"\)[\s\S]*WHERE "isPreview" = true/
    );
  });

  it('dedupes pre-existing duplicate preview sessions before the constraint', () => {
    // Keeps the earliest per version so the new unique index can be created.
    expect(executableSql).toContain('DELETE FROM "app_questionnaire_session"');
    expect(executableSql).toMatch(/row_number\(\) OVER \(PARTITION BY "versionId"/);
  });

  it('is index-only — no table create/drop and no platform DDL', () => {
    expect(executableSql).not.toContain('CREATE TABLE');
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_session_event migration SQL (F4.6)', () => {
  const sql = readMigrationSql('_app_session_event');
  const executableSql = executableLines(sql);

  it('creates exactly the app_questionnaire_session_event table', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire_session_event"');
    // Exactly one — guard against a phantom platform CREATE leaking back through
    // the schema-fold footgun.
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(1);
  });

  it('declares the session FK with ON DELETE CASCADE (events follow the session)', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_session_event_sessionId_fkey"[\s\S]*REFERENCES "app_questionnaire_session"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('indexes the event log by sessionId and by (sessionId,createdAt)', () => {
    expect(sql).toContain('CREATE INDEX "app_questionnaire_session_event_sessionId_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_session_event_sessionId_createdAt_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // `migrate dev` re-emitted the four pgvector DROP INDEX + the GENERATED
    // searchVector ALTER. Stripped by hand; this guard fails if a regeneration
    // leaks them back in (and would, critically, drop the partial unique index the
    // preview-session race-safety depends on if that ever surfaces here).
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('ai_message');
    expect(executableSql).not.toContain('searchVector');
  });
});

describe('app_questionnaire_evaluation_run migration SQL (F5.2)', () => {
  const sql = readMigrationSql('_app_questionnaire_evaluation_run');
  const executableSql = executableLines(sql);

  it('creates exactly the run + finding tables', () => {
    expect(sql).toContain('CREATE TABLE "app_questionnaire_evaluation_run"');
    expect(sql).toContain('CREATE TABLE "app_questionnaire_evaluation_finding"');
    // Exactly two — guard against a phantom platform CREATE leaking back through
    // the schema-fold footgun.
    expect(executableSql.match(/CREATE TABLE/g) ?? []).toHaveLength(2);
  });

  it('declares the version→run and run→finding FKs with ON DELETE CASCADE', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_evaluation_run_versionId_fkey"[\s\S]*REFERENCES "app_questionnaire_version"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "app_questionnaire_evaluation_finding_runId_fkey"[\s\S]*REFERENCES "app_questionnaire_evaluation_run"\("id"\)[\s\S]*ON DELETE CASCADE/
    );
  });

  it('indexes runs newest-first per version and findings by run', () => {
    expect(sql).toContain(
      'CREATE INDEX "app_questionnaire_evaluation_run_versionId_createdAt_idx"'
    );
    expect(sql).toContain('CREATE INDEX "app_questionnaire_evaluation_run_questionnaireId_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_evaluation_run_status_idx"');
    expect(sql).toContain('CREATE INDEX "app_questionnaire_evaluation_finding_runId_idx"');
    expect(sql).toContain(
      'CREATE INDEX "app_questionnaire_evaluation_finding_runId_dimension_idx"'
    );
    expect(sql).toContain('CREATE INDEX "app_questionnaire_evaluation_finding_status_idx"');
  });

  it('contains no platform (unmodelled-object) operations — the schema-fold strip holds', () => {
    // `migrate dev` re-emitted the four pgvector DROP INDEX + the GENERATED
    // searchVector ALTER. Stripped by hand; this guard fails if a regeneration leaks them back.
    expect(executableSql).not.toContain('DROP INDEX');
    expect(executableSql).not.toContain('ai_knowledge');
    expect(executableSql).not.toContain('ai_message');
    expect(executableSql).not.toContain('searchVector');
  });
});
