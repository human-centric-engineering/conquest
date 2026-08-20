/**
 * Definition-import persister (F14.9).
 *
 * Writes a validated {@link DefinitionImport} envelope into the app graph as a **brand-new**
 * questionnaire (v1 draft) — `AppQuestionnaire` → `AppQuestionnaireVersion` → sections → questions
 * (+ tags, config, data slots, Adaptive Scope topics + settings, scoring schema) — in one
 * transaction, all-or-nothing. The import is always create-only: it never touches an existing
 * questionnaire, so a bad/duplicate file can't clobber live work.
 *
 * This is the import counterpart of {@link file://./persist.ts}'s `persistIngestion`, written
 * separately because that path is lossy for a full-fidelity definition (it hard-codes weight, writes
 * no tags, and uses `createMany` so it can't attach per-question tags). Embeddings are NOT written
 * here — the route regenerates question + data-slot vectors after commit (they're reproducible from
 * the text). Cross-references survive by stable `key`: tags are remapped by normalised label,
 * data-slot↔question + scoring refs by question key, and Adaptive Scope topic membership
 * (`questionKeys`/`dataSlotKeys`) is remapped from the envelope's original keys to whatever key each
 * question/slot actually landed on after dedup.
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` module stays Prisma-free.
 */

import { Prisma } from '@prisma/client';

import { executeTransaction } from '@/lib/db/utils';
import { slugifyKey, nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';
import { normalizeGlossarySurface } from '@/lib/app/questionnaire/glossary/normalize';
import { normalizeTagLabel } from '@/lib/app/questionnaire/tagging';
import { AUDIENCE_FIELDS } from '@/lib/app/questionnaire/types';
import type { DefinitionImport } from '@/lib/app/questionnaire/authoring';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import {
  buildTopicCreateInput,
  patchAdaptiveScopeSettings,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

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
  topicCount: number;
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

  return executeTransaction(
    async (tx) => {
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

      // 3. Tags — minted fresh; remap by normalised label so question links resolve. Deduped
      //    in-memory (DB enforces unique), then written in one batch to keep the transaction short.
      const tagIdByNormalized = new Map<string, string>();
      const tagRows: Prisma.AppQuestionTagCreateManyInput[] = [];
      const seenTagLabels = new Set<string>();
      for (const tag of version.tags) {
        const normalized = normalizeTagLabel(tag.label);
        if (seenTagLabels.has(normalized)) continue; // collapse duplicates
        seenTagLabels.add(normalized);
        tagRows.push({
          versionId,
          label: tag.label,
          normalizedLabel: normalized,
          ...(tag.color != null ? { color: tag.color } : {}),
        });
      }
      if (tagRows.length > 0) {
        const createdTags = await tx.appQuestionTag.createManyAndReturn({
          data: tagRows,
          select: { id: true, normalizedLabel: true },
        });
        for (const t of createdTags) tagIdByNormalized.set(t.normalizedLabel, t.id);
      }

      // 4. Sections + questions (full fidelity), each written in one batch. Keys are deduped against
      //    what's already taken; a map from the ORIGINAL exported key lets data-slot + scoring refs
      //    resolve even if a key shifted. Returned rows are matched by their unique key/ordinal, so the
      //    batch order is irrelevant.
      const sectionIdByOrdinal = new Map<number, string>();
      if (version.sections.length > 0) {
        const createdSections = await tx.appQuestionnaireSection.createManyAndReturn({
          data: version.sections.map((section) => ({
            versionId,
            ordinal: section.ordinal,
            title: section.title,
            ...(section.description != null ? { description: section.description } : {}),
          })),
          select: { id: true, ordinal: true },
        });
        for (const s of createdSections) sectionIdByOrdinal.set(s.ordinal, s.id);
      }

      // Resolve deduped keys + ordinals in a pure pass, then write all questions in one batch. The
      // deduped key is unique within the version, so we map it back to the original exported key.
      const takenKeys = new Set<string>();
      const originalKeyByDeduped = new Map<string, string>();
      // Reverse of the above — lets Adaptive Scope topics (which reference questions by their
      // ORIGINAL exported key) remap onto whatever key a question actually landed on. A duplicate
      // original key resolves to the last-declared question, same as `questionIdByOriginalKey` below.
      const dedupedQuestionKeyByOriginal = new Map<string, string>();
      const questionRows: Prisma.AppQuestionSlotCreateManyInput[] = [];
      let questionCount = 0;
      for (const section of version.sections) {
        // assertion-free: section ordinals are unique per validated envelope, mirroring persist.ts.
        const sectionId = sectionIdByOrdinal.get(section.ordinal) as string;
        for (const q of section.questions) {
          const key = nextAvailableKey(q.key || slugifyKey(q.prompt), takenKeys);
          takenKeys.add(key);
          originalKeyByDeduped.set(key, q.key);
          dedupedQuestionKeyByOriginal.set(q.key, key);
          questionRows.push({
            versionId,
            sectionId,
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
          });
          questionCount += 1;
        }
      }

      const questionIdByOriginalKey = new Map<string, string>();
      if (questionRows.length > 0) {
        const createdQuestions = await tx.appQuestionSlot.createManyAndReturn({
          data: questionRows,
          select: { id: true, key: true },
        });
        const idByDedupedKey = new Map(createdQuestions.map((c) => [c.key, c.id]));
        // Iterate in question order (not DB-return order) so a duplicate ORIGINAL key resolves
        // deterministically to the last-declared question — matching the prior per-row behaviour.
        for (const row of questionRows) {
          const dedupedKey = row.key;
          const originalKey = originalKeyByDeduped.get(dedupedKey);
          const id = idByDedupedKey.get(dedupedKey);
          if (originalKey !== undefined && id !== undefined) {
            questionIdByOriginalKey.set(originalKey, id);
          }
        }
      }

      // 5. Question → tag links, resolved through the remapped vocabulary (skip unknown labels), all in
      //    one batch. Tag ids are matched per question through the original→id map built above.
      const slotTagRows: Prisma.AppQuestionSlotTagCreateManyInput[] = [];
      for (const section of version.sections) {
        for (const q of section.questions) {
          const questionSlotId = questionIdByOriginalKey.get(q.key);
          if (questionSlotId === undefined) continue;
          const tagIds = [...new Set(q.tagLabels.map(normalizeTagLabel))]
            .map((n) => tagIdByNormalized.get(n))
            .filter((id): id is string => id !== undefined);
          for (const tagId of tagIds) slotTagRows.push({ questionSlotId, tagId });
        }
      }
      if (slotTagRows.length > 0) {
        await tx.appQuestionSlotTag.createMany({ data: slotTagRows });
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

      // 7. Data slots + question links (by original question key; unknown keys skipped). Slots are
      //    written in one batch, then matched back by their unique deduped key to wire the question
      //    links — also one batch. The slot's deduped key carries the original questionKeys forward.
      const takenSlotKeys = new Set<string>();
      const slotRows: Prisma.AppDataSlotCreateManyInput[] = [];
      const slotQuestionKeysByDeduped = new Map<string, string[]>();
      // Reverse map for Adaptive Scope topics (below), same reasoning as `dedupedQuestionKeyByOriginal`.
      const dedupedSlotKeyByOriginal = new Map<string, string>();
      for (const slot of version.dataSlots) {
        const key = nextAvailableKey(slot.key || slugifyKey(slot.name), takenSlotKeys);
        takenSlotKeys.add(key);
        slotQuestionKeysByDeduped.set(key, slot.questionKeys);
        dedupedSlotKeyByOriginal.set(slot.key, key);
        slotRows.push({
          versionId,
          key,
          name: slot.name,
          description: slot.description,
          theme: slot.theme,
          ordinal: slot.ordinal,
          weight: slot.weight,
        });
      }

      const dataSlotCount = slotRows.length;
      if (slotRows.length > 0) {
        const createdSlots = await tx.appDataSlot.createManyAndReturn({
          data: slotRows,
          select: { id: true, key: true },
        });
        const slotQuestionRows: Prisma.AppDataSlotQuestionCreateManyInput[] = [];
        for (const created of createdSlots) {
          const questionKeys = slotQuestionKeysByDeduped.get(created.key) ?? [];
          const mappings = [...new Set(questionKeys)]
            .map((qk) => questionIdByOriginalKey.get(qk))
            .filter((id): id is string => id !== undefined)
            .map((questionSlotId) => ({ dataSlotId: created.id, questionSlotId }));
          slotQuestionRows.push(...mappings);
        }
        if (slotQuestionRows.length > 0) {
          await tx.appDataSlotQuestion.createMany({ data: slotQuestionRows });
        }
      }

      // 8. Adaptive Scope (P17) topics — membership is KEYS (never row ids), so each topic's
      //    `questionKeys`/`dataSlotKeys` are remapped from the ORIGINAL exported key to whatever key
      //    the question/slot actually landed on above; an unresolvable key is silently skipped, same
      //    as everywhere else in this feature (a stale reference must never break the import).
      const topicRows: Prisma.AppQuestionnaireTopicCreateManyInput[] = [];
      for (const topic of version.topics) {
        const questionKeys = topic.questionKeys
          .map((k) => dedupedQuestionKeyByOriginal.get(k))
          .filter((k): k is string => k !== undefined);
        const dataSlotKeys = topic.dataSlotKeys
          .map((k) => dedupedSlotKeyByOriginal.get(k))
          .filter((k): k is string => k !== undefined);
        topicRows.push(
          buildTopicCreateInput(
            versionId,
            { ...topic, questionKeys, dataSlotKeys },
            topic.ordinal,
            topic.source
          )
        );
      }
      const topicCount = topicRows.length;
      if (topicRows.length > 0) {
        await tx.appQuestionnaireTopic.createMany({ data: topicRows });
      }

      // 8b. Adaptive Scope (P17) settings — a top-level envelope field, not part of `version.config`
      //     (see definition-export.ts for why). Routed through the same read-narrow-merge-write
      //     helper the Topics tab's settings PATCH uses, rather than a raw write, so rule ordinals get
      //     re-stamped and every field is normalised exactly as a live read would produce — a fresh
      //     version has no "current" settings to merge onto, so this effectively seeds from defaults.
      //     Runs AFTER the data-slot dedup map (step 7) exists: a hard rule's `dataSlotKey` is a key
      //     reference exactly like a topic's membership, and needs the same remap onto whatever key a
      //     collided data slot actually landed on — `topicKey` needs no such remap because topic keys
      //     are never deduped (uniqueness is enforced by the import schema, not `nextAvailableKey`).
      if (version.adaptiveScope !== undefined) {
        const rules = version.adaptiveScope.rules?.map((rule) => ({
          ...rule,
          dataSlotKey: dedupedSlotKeyByOriginal.get(rule.dataSlotKey) ?? rule.dataSlotKey,
        }));
        await patchAdaptiveScopeSettings(
          versionId,
          { ...version.adaptiveScope, ...(rules !== undefined ? { rules } : {}) },
          tx
        );
      }

      // 9. Scoring schema (1:1) — authored, so source 'manual'. Its item/band refs use question +
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

      // 10. Definitions / glossary (P16) — the curated vocabulary the questions were written
      //    against. Carried at every status: a rejected term is a decision worth preserving, so
      //    a later analysis run on the imported copy doesn't resurrect it as a fresh proposal.
      for (let i = 0; i < version.glossary.length; i += 1) {
        const term = version.glossary[i];
        const normalizedTerm = normalizeGlossarySurface(term.term);
        if (normalizedTerm.length === 0) continue;
        await tx.appGlossaryTerm.create({
          data: {
            versionId,
            term: term.term,
            normalizedTerm,
            aliases: jsonInput(term.aliases),
            status: term.status,
            source: term.source,
            ordinal: i,
            ...(term.rationale ? { rationale: term.rationale } : {}),
            ...(term.contextQuote ? { contextQuote: term.contextQuote } : {}),
            createdBy: adminId,
            definitions: {
              create: term.definitions.map((definition, ordinal) => ({
                text: definition.text,
                selected: definition.selected,
                source: definition.source,
                edited: definition.edited,
                ordinal,
                ...(definition.sourceQuote ? { sourceQuote: definition.sourceQuote } : {}),
              })),
            },
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
        topicCount,
      };
      // Batched writes keep this short, but a very large import on a high-latency prod DB still
      // benefits from headroom over Prisma's 5s default interactive-transaction timeout.
    },
    {
      timeout: 20_000,
      maxWait: 10_000,
    }
  );
}
