/**
 * Workflow diagram: Document Ingestion / Structure Extraction.
 *
 * Documents the admin "upload a document → extract a questionnaire" pipeline in
 * `app/api/v1/app/questionnaires/_lib/extract-pipeline.ts` (+ `persist.ts`).
 * Linear: parse → scanned/empty guard → LLM extraction → coherence check →
 * persist. Applies to any version that was built by ingestion (has source docs).
 */

import {
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const ingestionWorkflow = diagram({
  slug: 'document-ingestion',
  title: 'Document ingestion',
  description:
    'An admin uploads a questionnaire document; an agent reads it and proposes a full structure — sections, typed questions, an inferred goal and audience, and an editorial change log.',
  sourceModule: 'app/api/v1/app/questionnaires/_lib/extract-pipeline.ts',
  entryStepId: 'parse',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'parse',
      name: 'Parse document',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Guard the upload (size, extension allowlist), hash it (SHA-256) to dedupe, and extract plain text — .xlsx via the workbook flattener, everything else via the document parser router.',
      meta: {
        note: 'Deterministic pre-processing before any model call. No LLM.',
      },
      next: ['scan-guard'],
    }),
    node({
      id: 'scan-guard',
      name: 'Scanned / empty check',
      type: 'guard',
      x: 220,
      y: 0,
      description:
        'Reject documents that produced no usable text (scanned images, empty files) before spending a model call. Pass → extract; Fail → the upload is rejected with a clear error.',
      meta: { note: 'A deterministic quality gate — Pass continues, Fail rejects the upload.' },
      next: [{ targetStepId: 'extract', condition: 'Pass' }],
    }),
    node({
      id: 'extract',
      name: 'Extract structure',
      type: 'agent_call',
      x: 440,
      y: 0,
      description:
        'The Structure Extractor reads the document text (plus any admin-supplied goal/audience) and returns sections, typed questions, an inferred goal/audience, and a change log. Zod-validated with an in-capability repair retry.',
      meta: {
        agentSlug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
        promptSpecimenId: 'extract.default',
        capabilitySlugs: [EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG],
        kb: {
          status: 'pluggable',
          mechanism: 'agent-grant',
          description:
            'The extractor runs with restricted knowledge access. Attach reference material — a house style guide, taxonomy, or prior questionnaires — as agent knowledge grants to ground the extraction.',
        },
        note: 'The one LLM call in this pipeline.',
      },
      next: ['coherence'],
    }),
    node({
      id: 'coherence',
      name: 'Coherence check',
      type: 'guard',
      x: 660,
      y: 0,
      description:
        'assertPersistable() verifies every extracted question maps to a real section before anything is written. Pass → persist; Fail → the extraction is rejected rather than persisting a broken graph.',
      meta: { note: 'A deterministic structural check on the model output.' },
      next: [{ targetStepId: 'persist', condition: 'Pass' }],
    }),
    node({
      id: 'persist',
      name: 'Persist questionnaire',
      type: 'report',
      x: 880,
      y: 0,
      description:
        'Write the section/question graph as a new questionnaire + draft version (or replace a draft version’s structure on re-ingest), recording the source document and change log.',
      meta: { note: 'Deterministic write — the admin then reviews and edits the draft.' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.master) return unavailable('The questionnaires surface is not enabled.');
    if (ctx.sourceDocumentCount > 0) {
      return applies('This version was built by ingesting an uploaded document.');
    }
    return inactive('This version was composed from a brief, not ingested from a document.');
  },
});
