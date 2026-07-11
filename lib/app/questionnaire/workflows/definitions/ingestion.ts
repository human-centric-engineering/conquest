/**
 * Workflow diagram: Document Ingestion / Structure Extraction.
 *
 * Documents the admin "upload a document → extract a questionnaire" pipeline in
 * `app/api/v1/app/questionnaires/_lib/orchestrate-extraction.ts` (+ `extract-pipeline.ts`,
 * `persist.ts`). parse → scanned/empty guard → LLM extraction → (optional verify → repair
 * fidelity pass) → coherence check → persist. Applies to any version that was built by
 * ingestion (has source docs). The verify/repair pair runs only when the ingest verify+repair
 * setting is on; when off, the pipeline is the single extractor pass.
 */

import {
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
  REPAIR_QUESTIONS_CAPABILITY_SLUG,
  VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

/** The verify + repair nodes render inside one labelled container — the optional fidelity pass. */
const FIDELITY_GROUP = { id: 'fidelity-check', label: 'Fidelity check & repair · optional' };

export const ingestionWorkflow = diagram({
  slug: 'document-ingestion',
  title: 'Questionnaire ingestion',
  description: 'Turn an uploaded document into a proposed questionnaire structure.',
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
        note: 'The first LLM call — followed by an optional verify + repair pass.',
      },
      next: ['verify'],
    }),
    node({
      id: 'verify',
      name: 'Verify fidelity',
      type: 'agent_call',
      x: 660,
      y: 0,
      description:
        'A critic reads the extracted questions AGAINST the source and flags any whose answer type/config is unfaithful — a rating scale mis-typed, a likert missing its endpoint anchors, a rating grid flattened or with rows lost. It flags only; it never rewrites. One reasoning call over all questions (flags-only output, so it stays cheap). Runs only when the ingest verify+repair setting is on.',
      meta: {
        agentSlug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG,
        promptSpecimenId: 'verify.default',
        capabilitySlugs: [VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG],
        group: FIDELITY_GROUP,
        note: 'Fail-soft: a missing/failing verifier persists the raw extraction unchanged.',
      },
      next: ['repair'],
    }),
    node({
      id: 'repair',
      name: 'Repair flagged',
      type: 'agent_call',
      x: 880,
      y: 0,
      description:
        'A scales-&-matrix specialist re-extracts ONLY the flagged questions, re-reading their source span — fixing a mis-typed scale, restoring likert anchors, or turning a flattened / mis-split rating grid into one matrix question. Skipped entirely when nothing is flagged. Each correction is accepted only if it validates strictly better than the original (never worse); otherwise the original is kept.',
      meta: {
        agentSlug: QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG,
        promptSpecimenId: 'repair.default',
        capabilitySlugs: [REPAIR_QUESTIONS_CAPABILITY_SLUG],
        group: FIDELITY_GROUP,
        note: 'Surgical: runs over the flagged subset only, and merges under a “never worse” guard.',
      },
      next: ['coherence'],
    }),
    node({
      id: 'coherence',
      name: 'Coherence check',
      type: 'guard',
      x: 1100,
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
      x: 1320,
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
