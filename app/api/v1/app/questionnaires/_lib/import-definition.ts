/**
 * Definition-import persister (F14.9).
 *
 * Writes a validated {@link DefinitionImport} envelope into the app graph as a **brand-new**
 * questionnaire (v1 draft) — `AppQuestionnaire` → `AppQuestionnaireVersion` → sections → questions
 * (+ tags, config, data slots, scoring schema) — in one transaction, all-or-nothing. The import is
 * always create-only: it never touches an existing questionnaire, so a bad/duplicate file can't
 * clobber live work.
 *
 * This is the import counterpart of {@link file://./persist.ts}'s `persistIngestion`, written
 * separately because that path is lossy for a full-fidelity definition (it hard-codes weight, writes
 * no tags, and uses `createMany` so it can't attach per-question tags). Embeddings are NOT written
 * here — the route regenerates question + data-slot vectors after commit (they're reproducible from
 * the text). Cross-references survive by stable `key`: tags are remapped by normalised label,
 * data-slot↔question + scoring refs by question key.
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` module stays Prisma-free.
 */

import { Prisma } from '@prisma/client';

import { executeTransaction } from '@/lib/db/utils';
import { slugifyKey, nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';
import { normalizeTagLabel } from '@/lib/app/questionnaire/tagging';
import { AUDIENCE_FIELDS } from '@/lib/app/questionnaire/types';
import type { DefinitionImport } from '@/lib/app/questionnaire/authoring';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

export interface ImportDefinitionInput {
  envelope: DefinitionImport;
  /** Admin performing the import — recorded as `createdBy` on the scoring schema. */
  adminId: string;
  /** DEMO-ONLY (F2.5.1): attribute the new questionnaire to this demo client (pre-checked to exist). */
  demoClientId?: string;
}

export interface ImportDefinitionResult {
  questionnaireId: string;
  versionId: string;
  sectionCount: number;
  questionCount: number;
  tagCount: number;
  dataSlotCount: number;
}

/**
 * Persist an imported definition as a new draft questionnaire in a single transaction. Returns the
 * new ids and structural counts. Call with an already-validated envelope (the route parses the file
 * through `parseDefinitionImport` first).
 */
export async function persistDefinitionImport(
  input: ImportDefinitionInput
): Promise<ImportDefinitionResult> {
  const { envelope, adminId, demoClientId } = input;
  const { questionnaire, version } = envelope;

  return executeTransaction(async (tx) => {
    // 1. Questionnaire (draft) + 2. version (v1 draft). An import is authored, not extracted, so
    //    goal/audience provenance is 'admin-supplied' — the read surface won't mark it inferred.
    const audience = version.audience ?? null;
    const audienceProvenance: Record<string, 'admin-supplied'> = {};
    if (audience) {
      for (const f of AUDIENCE_FIELDS) {
        if (audience[f] !== undefined) audienceProvenance[f] = 'admin-supplied';
      }
    }

    const createdQuestionnaire = await tx.appQuestionnaire.create({
      data: {
        title: questionnaire.title,
        status: 'draft',
        ...(demoClientId !== undefined ? { demoClientId } : {}),
      },
      select: { id: true },
    });

    const createdVersion = await tx.appQuestionnaireVersion.create({
      data: {
        questionnaireId: createdQuestionnaire.id,
        versionNumber: 1,
        status: 'draft',
        goal: version.goal ?? null,
        audience: audience === null ? Prisma.JsonNull : jsonInput(audience),
        goalProvenance: version.goal ? 'admin-supplied' : null,
        audienceProvenance:
          Object.keys(audienceProvenance).length > 0
            ? jsonInput(audienceProvenance)
            : Prisma.JsonNull,
      },
      select: { id: true },
    });
    const versionId = createdVersion.id;

    // 3. Tags — minted fresh; remap by normalised label so question links resolve.
    const tagIdByNormalized = new Map<string, string>();
    for (const tag of version.tags) {
      const normalized = normalizeTagLabel(tag.label);
      if (tagIdByNormalized.has(normalized)) continue; // collapse duplicates (DB enforces unique)
      const created = await tx.appQuestionTag.create({
        data: {
          versionId,
          label: tag.label,
          normalizedLabel: normalized,
          ...(tag.color != null ? { color: tag.color } : {}),
        },
        select: { id: true },
      });
      tagIdByNormalized.set(normalized, created.id);
    }

    // 4. Sections + questions (full fidelity). Keys are deduped against what's already taken; a map
    //    from the ORIGINAL exported key lets data-slot + scoring refs resolve even if a key shifted.
    const takenKeys = new Set<string>();
    const questionIdByOriginalKey = new Map<string, string>();
    let questionCount = 0;

    for (const section of version.sections) {
      const createdSection = await tx.appQuestionnaireSection.create({
        data: {
          versionId,
          ordinal: section.ordinal,
          title: section.title,
          ...(section.description != null ? { description: section.description } : {}),
        },
        select: { id: true },
      });

      for (const q of section.questions) {
        const key = nextAvailableKey(q.key || slugifyKey(q.prompt), takenKeys);
        takenKeys.add(key);

        const createdQuestion = await tx.appQuestionSlot.create({
          data: {
            versionId,
            sectionId: createdSection.id,
            ordinal: questionCount,
            key,
            prompt: q.prompt,
            type: q.type,
            required: q.required,
            weight: q.weight,
            ...(q.guidelines != null ? { guidelines: q.guidelines } : {}),
            ...(q.rationale != null ? { rationale: q.rationale } : {}),
            ...(q.typeConfig !== undefined && q.typeConfig !== null
              ? { typeConfig: jsonInput(q.typeConfig) }
              : {}),
          },
          select: { id: true },
        });
        questionIdByOriginalKey.set(q.key, createdQuestion.id);
        questionCount += 1;

        // 5. Question → tag links, resolved through the remapped vocabulary (skip unknown labels).
        const tagIds = [...new Set(q.tagLabels.map(normalizeTagLabel))]
          .map((n) => tagIdByNormalized.get(n))
          .filter((id): id is string => id !== undefined);
        if (tagIds.length > 0) {
          await tx.appQuestionSlotTag.createMany({
            data: tagIds.map((tagId) => ({ questionSlotId: createdQuestion.id, tagId })),
          });
        }
      }
    }

    // 6. Config — create the row so the new draft is launch-eligible without a re-save. JSON columns
    //    are wrapped exactly as the config PATCH route does.
    if (version.config) {
      const {
        profileFields,
        inviteeFields,
        tone,
        respondentReport,
        cohortReport,
        intro,
        ...scalars
      } = version.config;
      await tx.appQuestionnaireConfig.create({
        data: {
          versionId,
          ...scalars,
          ...(profileFields !== undefined ? { profileFields: jsonInput(profileFields) } : {}),
          ...(inviteeFields !== undefined ? { inviteeFields: jsonInput(inviteeFields) } : {}),
          ...(tone !== undefined ? { tone: jsonInput(tone) } : {}),
          ...(respondentReport !== undefined
            ? { respondentReport: jsonInput(respondentReport) }
            : {}),
          ...(cohortReport !== undefined ? { cohortReport: jsonInput(cohortReport) } : {}),
          ...(intro !== undefined ? { intro: jsonInput(intro) } : {}),
        },
        select: { id: true },
      });
    }

    // 7. Data slots + question links (by original question key; unknown keys skipped).
    const takenSlotKeys = new Set<string>();
    let dataSlotCount = 0;
    for (const slot of version.dataSlots) {
      const key = nextAvailableKey(slot.key || slugifyKey(slot.name), takenSlotKeys);
      takenSlotKeys.add(key);

      const createdSlot = await tx.appDataSlot.create({
        data: {
          versionId,
          key,
          name: slot.name,
          description: slot.description,
          theme: slot.theme,
          ordinal: slot.ordinal,
          weight: slot.weight,
        },
        select: { id: true },
      });
      dataSlotCount += 1;

      const mappings = [...new Set(slot.questionKeys)]
        .map((qk) => questionIdByOriginalKey.get(qk))
        .filter((id): id is string => id !== undefined)
        .map((questionSlotId) => ({ dataSlotId: createdSlot.id, questionSlotId }));
      if (mappings.length > 0) {
        await tx.appDataSlotQuestion.createMany({ data: mappings });
      }
    }

    // 8. Scoring schema (1:1) — authored, so source 'manual'. Its item/band refs use question +
    //    data-slot keys, preserved above, so they need no remap.
    if (version.scoringSchema) {
      await tx.appScoringSchema.create({
        data: {
          versionId,
          name: version.scoringSchema.name,
          content: jsonInput(version.scoringSchema.content),
          source: 'manual',
          createdBy: adminId,
        },
        select: { id: true },
      });
    }

    return {
      questionnaireId: createdQuestionnaire.id,
      versionId,
      sectionCount: version.sections.length,
      questionCount,
      tagCount: tagIdByNormalized.size,
      dataSlotCount,
    };
  });
}
