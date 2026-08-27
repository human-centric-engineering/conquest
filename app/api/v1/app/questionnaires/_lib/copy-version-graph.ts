/**
 * Deep-copy a version's structural graph from one version into another.
 *
 * Single-sources the "what a version copy includes" contract for the two callers that
 * duplicate a version's structure: the F2.1 version fork ({@link forkVersionIfLaunched})
 * and the clone-for-client utility. Copies, within a caller-supplied transaction, into
 * an already-created (empty) target version:
 *   - the run-time config row (F3.1, 1:1 with the version) when one exists,
 *   - the section → question-slot graph (ordinals verbatim; per-version-unique `key`s
 *     carried 1:1, so uniqueness holds by construction),
 *   - the question-slot and data-slot pgvector `embedding`s (F4.1 adaptive selection),
 *     copied via raw SQL keyed on `key` — the typed `createMany` can't carry an
 *     `Unsupported(...)` column, so without this the copy would land adaptive-blind,
 *   - the tag vocabulary (F2.2) with each assignment re-linked to the copied slot,
 *   - the definitions / glossary (P16): curated terms with their candidate definitions, and the
 *     authoritative definitions document they were drawn from,
 *   - the source documents (F17.29): the instrument the structure was extracted from, plus any
 *     supporting documents attached beside it, with their timestamps — the readers order by those.
 *
 * Returns the old→new id maps so a caller can retarget anything that references the
 * originals (the fork's child-mutation retarget; not needed by clone).
 *
 * Goal / audience / provenance live on the version *row* and are set by each caller at
 * version-create (a fork keeps them, a clone copies them) — NOT here. Deliberately not
 * copied: extraction-change records (a copy starts a clean editorial lineage),
 * sessions, invitations, answers, turns, evaluation runs.
 *
 * Route-local DB seam — `lib/app/questionnaire/**` stays Prisma-free.
 */

import { executeTransaction } from '@/lib/db/utils';
import { CONFIG_SELECT } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { copySlotEmbeddings } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { copyDataSlotEmbeddings } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';

/** The transaction client `executeTransaction` hands its callback (mirrors persist.ts). */
type CopyTx = Parameters<Parameters<typeof executeTransaction>[0]>[0];

/** Old→new id maps for everything copied, so callers can re-link references. */
export interface CopiedGraphMaps {
  sectionIdMap: Map<string, string>;
  questionIdMap: Map<string, string>;
  tagIdMap: Map<string, string>;
  dataSlotIdMap: Map<string, string>;
}

/**
 * Copy `sourceVersionId`'s config + section/slot graph + tag vocabulary into the
 * already-created `targetVersionId`, inside `tx`. Returns the old→new id maps.
 */
export async function copyVersionGraph(
  tx: CopyTx,
  sourceVersionId: string,
  targetVersionId: string
): Promise<CopiedGraphMaps> {
  const source = await tx.appQuestionnaireVersion.findUniqueOrThrow({
    where: { id: sourceVersionId },
    select: {
      // Reuse the read view's column set so a new config column is copied automatically
      // — no separate list here to fall out of sync (F3.1).
      config: { select: CONFIG_SELECT },
      // Deterministic scoring schema (F14.4): forks with the version (like config/tags).
      scoringSchema: { select: { name: true, content: true, source: true } },
      tags: {
        select: {
          id: true,
          label: true,
          normalizedLabel: true,
          color: true,
          slots: { select: { questionSlotId: true } },
        },
      },
      // Definitions / glossary (P16): the curated terms + their candidate definitions fork with
      // the version, and so does the authoritative definitions document they were drawn from —
      // otherwise a fork would silently lose the vocabulary the questions were written against.
      glossaryTerms: {
        orderBy: { ordinal: 'asc' },
        select: {
          term: true,
          normalizedTerm: true,
          aliases: true,
          status: true,
          source: true,
          rationale: true,
          contextQuote: true,
          ordinal: true,
          createdBy: true,
          definitions: {
            orderBy: { ordinal: 'asc' },
            select: {
              text: true,
              selected: true,
              source: true,
              sourceQuote: true,
              edited: true,
              ordinal: true,
            },
          },
        },
      },
      glossaryDocument: {
        select: {
          fileName: true,
          fileHash: true,
          byteSize: true,
          mimeType: true,
          extractedText: true,
          uploadedBy: true,
        },
      },
      // Source documents (F17.29): the instrument the version was extracted from, and any
      // supporting documents attached beside it, fork with it. Before this they did not, and the
      // consequence was silent: fork a launched version and the Routing Analyst — whose whole job
      // is to read the author's own routing guidance — had no document to read, so it fell back to
      // inferring from question wording and reported `fromDocument: false`.
      sourceDocuments: {
        orderBy: { createdAt: 'asc' },
        select: {
          role: true,
          fileName: true,
          fileHash: true,
          byteSize: true,
          mimeType: true,
          pageCount: true,
          warnings: true,
          extractedText: true,
          createdAt: true,
        },
      },
      // Conditional Topics (P17): topics fork with the version. Their membership is KEYS, not row ids,
      // so — unlike tags and data-slot links — there is nothing to re-link: a verbatim copy lands on
      // the copied questions automatically, because those carry their keys over 1:1.
      topics: {
        orderBy: { ordinal: 'asc' },
        select: {
          key: true,
          label: true,
          description: true,
          phase: true,
          criteria: true,
          depth: true,
          members: true,
          ordinal: true,
          source: true,
          trigger: true,
        },
      },
      // Data Slots feature: the abstraction layer forks with the version (like tags).
      dataSlots: {
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          theme: true,
          ordinal: true,
          weight: true,
          generationConfidence: true,
          questions: { select: { questionSlotId: true } },
        },
      },
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          ordinal: true,
          title: true,
          description: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              ordinal: true,
              key: true,
              prompt: true,
              guidelines: true,
              rationale: true,
              type: true,
              typeConfig: true,
              required: true,
              weight: true,
              fidelity: true,
              extractionConfidence: true,
            },
          },
        },
      },
    },
  });

  // F3.1: copy the run-time config row when one exists (1:1 with the version). A
  // no-config source copies to a no-config target — both resolve to the same defaults.
  if (source.config) {
    await tx.appQuestionnaireConfig.create({
      data: {
        versionId: targetVersionId,
        // Spread the selected columns (CONFIG_SELECT) verbatim; only the JSON columns
        // need the null-sentinel wrapper. New scalar columns (accessMode) ride along.
        ...source.config,
        profileFields: jsonInput(source.config.profileFields),
        inviteeFields: jsonInput(source.config.inviteeFields),
        tone: jsonInput(source.config.tone),
        personas: jsonInput(source.config.personas),
        personaSelection: jsonInput(source.config.personaSelection),
        interviewerStrategy: jsonInput(source.config.interviewerStrategy),
        houseRules: jsonInput(source.config.houseRules),
        questionFidelity: jsonInput(source.config.questionFidelity),
        respondentReport: jsonInput(source.config.respondentReport),
        cohortReport: jsonInput(source.config.cohortReport),
        intro: jsonInput(source.config.intro),
        milestoneBannerThresholds: jsonInput(source.config.milestoneBannerThresholds),
        conditionalTopics: jsonInput(source.config.conditionalTopics),
      },
    });
  }

  // F14.4: copy the scoring schema when one exists (1:1 with the version).
  if (source.scoringSchema) {
    await tx.appScoringSchema.create({
      data: {
        versionId: targetVersionId,
        name: source.scoringSchema.name,
        content: jsonInput(source.scoringSchema.content),
        source: source.scoringSchema.source,
      },
    });
  }

  // Sections first (slots reference them); copy ordinal verbatim, mapping each original
  // section id to its copy so a caller can retarget child mutations.
  const sectionIdMap = new Map<string, string>();
  for (const section of source.sections) {
    const newSection = await tx.appQuestionnaireSection.create({
      data: {
        versionId: targetVersionId,
        ordinal: section.ordinal,
        title: section.title,
        ...(section.description !== null ? { description: section.description } : {}),
      },
      select: { id: true },
    });
    sectionIdMap.set(section.id, newSection.id);

    if (section.questions.length > 0) {
      await tx.appQuestionSlot.createMany({
        data: section.questions.map((q) => ({
          versionId: targetVersionId,
          sectionId: newSection.id,
          ordinal: q.ordinal,
          key: q.key, // copied 1:1 into a fresh version — uniqueness holds by construction
          prompt: q.prompt,
          type: q.type,
          required: q.required,
          weight: q.weight,
          fidelity: q.fidelity,
          ...(q.guidelines !== null ? { guidelines: q.guidelines } : {}),
          ...(q.rationale !== null ? { rationale: q.rationale } : {}),
          ...(q.typeConfig !== null ? { typeConfig: jsonInput(q.typeConfig) } : {}),
          ...(q.extractionConfidence !== null
            ? { extractionConfidence: q.extractionConfidence }
            : {}),
        })),
      });
    }
  }

  // Carry the question-slot embeddings (F4.1 adaptive selection) over to the copy.
  // The slot text is copied verbatim above, so the vectors are still valid — and
  // the `embedding` column is Prisma-Unsupported, so the typed `createMany` could
  // not include it. Copying here (vs. forcing a re-embed) keeps the new draft
  // adaptive-ready without an extra embed cost.
  await copySlotEmbeddings(tx, sourceVersionId, targetVersionId);

  // Map original question ids to their copies via the per-version-unique `key`
  // (createMany returns no ids; key is the stable join).
  const newIdByKey = new Map(
    (
      await tx.appQuestionSlot.findMany({
        where: { versionId: targetVersionId },
        select: { id: true, key: true },
      })
    ).map((q) => [q.key, q.id])
  );
  const questionIdMap = new Map<string, string>();
  for (const section of source.sections) {
    for (const q of section.questions) {
      const newId = newIdByKey.get(q.key);
      if (newId) questionIdMap.set(q.id, newId);
    }
  }

  // F2.2: copy the version's tag vocabulary, then re-link each assignment to the copied
  // question + copied tag. Done after the slot loop because re-linking needs the
  // fully-assembled questionIdMap. A copied tag's `normalizedLabel` is unique by
  // construction (carried 1:1 into a fresh version).
  if (source.tags.length > 0) {
    await tx.appQuestionTag.createMany({
      data: source.tags.map((tag) => ({
        versionId: targetVersionId,
        label: tag.label,
        normalizedLabel: tag.normalizedLabel,
        ...(tag.color !== null ? { color: tag.color } : {}),
      })),
    });
  }
  // Map original tag ids to copies via the per-version-unique `normalizedLabel` (createMany returns no
  // ids). One createMany + one findMany replaces a per-tag round-trip — bounding the interactive
  // transaction's DB chatter so a tag-heavy version copy stays well inside its timeout.
  const newTagIdByNormalized = new Map(
    (
      await tx.appQuestionTag.findMany({
        where: { versionId: targetVersionId },
        select: { id: true, normalizedLabel: true },
      })
    ).map((t) => [t.normalizedLabel, t.id])
  );
  const tagIdMap = new Map<string, string>();
  const newSlotTags: { questionSlotId: string; tagId: string }[] = [];
  for (const tag of source.tags) {
    const newTagId = newTagIdByNormalized.get(tag.normalizedLabel);
    if (!newTagId) continue;
    tagIdMap.set(tag.id, newTagId);
    for (const link of tag.slots) {
      const newSlotId = questionIdMap.get(link.questionSlotId);
      if (newSlotId) newSlotTags.push({ questionSlotId: newSlotId, tagId: newTagId });
    }
  }
  if (newSlotTags.length > 0) {
    await tx.appQuestionSlotTag.createMany({ data: newSlotTags });
  }

  // Data Slots feature: copy the data slots in one createMany, then re-link each slot's question
  // mappings to the copied question ids (via questionIdMap). A copied key is unique by construction
  // (carried 1:1), so — like the question slots above — one createMany + one findMany-by-key replaces
  // the per-slot create round-trip. This is the loop that overran the interactive-transaction budget
  // on a data-slot-heavy version in prod (P2028); collapsing it keeps the copy inside the timeout.
  if (source.dataSlots.length > 0) {
    await tx.appDataSlot.createMany({
      data: source.dataSlots.map((slot) => ({
        versionId: targetVersionId,
        key: slot.key,
        name: slot.name,
        description: slot.description,
        theme: slot.theme,
        ordinal: slot.ordinal,
        weight: slot.weight,
        ...(slot.generationConfidence !== null
          ? { generationConfidence: slot.generationConfidence }
          : {}),
      })),
    });
  }
  const newDataSlotIdByKey = new Map(
    (
      await tx.appDataSlot.findMany({
        where: { versionId: targetVersionId },
        select: { id: true, key: true },
      })
    ).map((ds) => [ds.key, ds.id])
  );
  const dataSlotIdMap = new Map<string, string>();
  const newDataSlotQuestions: { dataSlotId: string; questionSlotId: string }[] = [];
  for (const slot of source.dataSlots) {
    const newSlotId = newDataSlotIdByKey.get(slot.key);
    if (!newSlotId) continue;
    dataSlotIdMap.set(slot.id, newSlotId);
    for (const link of slot.questions) {
      const newQuestionId = questionIdMap.get(link.questionSlotId);
      if (newQuestionId) {
        newDataSlotQuestions.push({ dataSlotId: newSlotId, questionSlotId: newQuestionId });
      }
    }
  }
  if (newDataSlotQuestions.length > 0) {
    await tx.appDataSlotQuestion.createMany({ data: newDataSlotQuestions });
  }

  // Conditional Topics (P17): one createMany, no re-linking. See the select above for why.
  // The DRAFT is deliberately NOT copied: a fork is a new editing surface, and carrying an
  // un-reviewed proposal into it would make the same proposal reviewable in two places at once.
  if (source.topics.length > 0) {
    await tx.appQuestionnaireTopic.createMany({
      data: source.topics.map((topic) => ({
        versionId: targetVersionId,
        key: topic.key,
        label: topic.label,
        phase: topic.phase,
        criteria: topic.criteria,
        depth: topic.depth,
        members: jsonInput(topic.members),
        ordinal: topic.ordinal,
        source: topic.source,
        ...(topic.description !== null ? { description: topic.description } : {}),
        // F17.31a. A trigger that did not survive a fork would fail silently on the copy the client
        // actually fields, which is the worst place for it to go missing.
        ...(topic.trigger !== null ? { trigger: jsonInput(topic.trigger) } : {}),
      })),
    });
  }

  // Carry the data-slot embeddings over too (same rationale as the question slots:
  // verbatim text → still-valid vectors, on a Prisma-Unsupported column).
  await copyDataSlotEmbeddings(tx, sourceVersionId, targetVersionId);

  // Definitions / glossary (P16): terms + their definitions, copied normalizedTerm-for-
  // normalizedTerm (unique by construction in a fresh version). One createMany + one findMany
  // re-links the definitions, rather than a per-term create round-trip — the same collapse the
  // data slots above needed after a per-slot loop overran the interactive-transaction budget on a
  // large version in prod (P2028). No id map is returned: nothing addresses a glossary row by
  // URL, so there is nothing for a caller to retarget.
  if (source.glossaryTerms.length > 0) {
    await tx.appGlossaryTerm.createMany({
      data: source.glossaryTerms.map((term) => ({
        versionId: targetVersionId,
        term: term.term,
        normalizedTerm: term.normalizedTerm,
        aliases: jsonInput(term.aliases),
        status: term.status,
        source: term.source,
        ordinal: term.ordinal,
        ...(term.rationale !== null ? { rationale: term.rationale } : {}),
        ...(term.contextQuote !== null ? { contextQuote: term.contextQuote } : {}),
        ...(term.createdBy !== null ? { createdBy: term.createdBy } : {}),
      })),
    });

    const newTermIdByNormalized = new Map(
      (
        await tx.appGlossaryTerm.findMany({
          where: { versionId: targetVersionId },
          select: { id: true, normalizedTerm: true },
        })
      ).map((term) => [term.normalizedTerm, term.id])
    );
    const newDefinitions = source.glossaryTerms.flatMap((term) => {
      const termId = newTermIdByNormalized.get(term.normalizedTerm);
      if (!termId) return [];
      return term.definitions.map((definition) => ({
        termId,
        text: definition.text,
        selected: definition.selected,
        source: definition.source,
        edited: definition.edited,
        ordinal: definition.ordinal,
        ...(definition.sourceQuote !== null ? { sourceQuote: definition.sourceQuote } : {}),
      }));
    });
    if (newDefinitions.length > 0) {
      await tx.appGlossaryDefinition.createMany({ data: newDefinitions });
    }
  }

  // Source documents (F17.29). `createdAt` is copied verbatim rather than defaulted, because the
  // readers order by it: the newest PRIMARY row is the current instrument (re-ingest appends), and
  // supplementary rows are budgeted oldest-first. Re-stamping them all with the fork's timestamp
  // would preserve the rows and lose the order that gives them meaning.
  if (source.sourceDocuments.length > 0) {
    await tx.appQuestionnaireSourceDocument.createMany({
      data: source.sourceDocuments.map((document) => ({
        versionId: targetVersionId,
        role: document.role,
        fileName: document.fileName,
        fileHash: document.fileHash,
        byteSize: document.byteSize,
        ...(document.mimeType !== null ? { mimeType: document.mimeType } : {}),
        ...(document.pageCount !== null ? { pageCount: document.pageCount } : {}),
        ...(document.warnings !== null ? { warnings: jsonInput(document.warnings) } : {}),
        extractedText: document.extractedText,
        createdAt: document.createdAt,
      })),
    });
  }

  // The definitions document the terms were drawn from (1:1 with the version, when one exists).
  if (source.glossaryDocument) {
    await tx.appGlossaryDocument.create({
      data: {
        versionId: targetVersionId,
        fileName: source.glossaryDocument.fileName,
        fileHash: source.glossaryDocument.fileHash,
        byteSize: source.glossaryDocument.byteSize,
        extractedText: source.glossaryDocument.extractedText,
        ...(source.glossaryDocument.mimeType !== null
          ? { mimeType: source.glossaryDocument.mimeType }
          : {}),
        ...(source.glossaryDocument.uploadedBy !== null
          ? { uploadedBy: source.glossaryDocument.uploadedBy }
          : {}),
      },
    });
  }

  return { sectionIdMap, questionIdMap, tagIdMap, dataSlotIdMap };
}
