/**
 * Workflow diagram: Adaptive Scope routing analysis (F17.4, F17.19).
 *
 * Structure extraction reads an uploaded document for its questions and discards everything else.
 * Real instruments carry pages it throws away — "Routing", "Guardrails", "How to use this",
 * facilitator notes — and those pages are the author stating which parts apply to whom. Two agents
 * cover that ground, in order:
 *
 *  1. A cheap, fast **candidacy check** runs automatically on every ingest (new + re-ingest,
 *     streaming and non-streaming) and decides ONE thing: do the document's own words describe
 *     routing different respondents differently? It never proposes anything — it only decides
 *     whether the full analysis is worth surfacing.
 *  2. The **Routing Analyst** — a proposer, not an auto-apply — reads the pages the extractor
 *     ignored, plus the version's questions and any already-authored topics, and proposes the
 *     topic set, criteria and hard rules they describe. Everything lands in
 *     `AppQuestionnaireTopicDraft` for review; nothing forks a launched version until the admin
 *     accepts.
 *
 * Grounding is the hard part, not generation: every topic/rule carries a `sourceQuote` when traced
 * to the document's own words, and is left absent when inferred, so an admin can never mistake a
 * guess for a citation. `gaps[]` separately records routing language the proposal could not
 * cleanly formalize into a topic or rule.
 */

import {
  ANALYSE_ROUTING_CAPABILITY_SLUG,
  DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
  QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
  QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

export const scopeRoutingAnalysisWorkflow = diagram({
  slug: 'scope-routing-analysis',
  title: 'Adaptive Scope routing analysis',
  description: 'Read an uploaded document for routing instructions and propose topics and rules.',
  sourceModule: 'app/api/v1/app/questionnaires/_lib/topic-draft.ts',
  entryStepId: 'candidacy-check',
  steps: [
    node({
      id: 'candidacy-check',
      name: 'Ingestion-time candidacy check',
      type: 'agent_call',
      x: 0,
      y: 0,
      description:
        'A fast, routing-tier triage call reads up to ~20k characters of a freshly uploaded document and decides ONE thing: do the document\'s own words describe routing different respondents through different parts of it — eligibility language, a "Routing"/"Guardrails" page, facilitator instructions naming who answers what? Runs unconditionally on every ingest because it is cheap enough to. It never proposes topics or rules — that stays the analyst\'s job below.',
      meta: {
        agentSlug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
        promptSpecimenId: 'candidacy.default',
        capabilitySlugs: [DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG],
        note: 'Fail-soft: a missing agent, no provider, a timeout, or an unparseable reply all resolve to "not run" rather than blocking the ingest.',
      },
      next: ['candidacy-guard'],
    }),
    node({
      id: 'candidacy-guard',
      name: 'Routing signals found?',
      type: 'guard',
      x: 220,
      y: 0,
      description:
        'Pass → the Topics tab surfaces a banner inviting the admin to run the Routing Analyst. Fail → ingestion completes silently; the admin can still open the Topics tab and run the analyst by hand at any time, with or without a document.',
      meta: {
        note: "A deterministic read of the candidacy check's isCandidate verdict. The analyst is never auto-run — this only decides whether to invite the admin to run it.",
      },
      next: [{ targetStepId: 'analyse', condition: 'Pass' }],
    }),
    node({
      id: 'analyse',
      name: 'Routing Analyst',
      type: 'agent_call',
      x: 440,
      y: 0,
      description:
        "Reads the version's questions AND its uploaded source document — exactly the pages structure extraction discarded — plus any already-authored topics, and proposes a topic set, hard rules and gaps. Runs at the `reasoning` tier, a full read unlike the candidacy check's cheap triage. Also reachable directly from the Topics tab's \"Run\" button, independent of the candidacy verdict.",
      meta: {
        agentSlug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
        promptSpecimenId: 'analyse.default',
        capabilitySlugs: [ANALYSE_ROUTING_CAPABILITY_SLUG],
        note: "A proposer, not an editor: sourceQuote is present when a topic/rule traces to the document's own words, absent when inferred — an admin can never mistake a guess for a citation.",
      },
      next: ['save-draft'],
    }),
    node({
      id: 'save-draft',
      name: 'Save topic draft',
      type: 'report',
      x: 660,
      y: 0,
      description:
        "Persist the proposal as the version's pending AppQuestionnaireTopicDraft — the same not-live contract as the data-slot draft. Nothing forks or changes what a respondent sees until the admin reviews and accepts it from the Topics tab.",
      meta: {
        note: 'Uncovered-question and replaces-existing counts are computed server-side before the accept, never trusted from the model.',
      },
    }),
  ],
  applicability: (ctx) => {
    if (ctx.sourceDocumentCount > 0) {
      return applies(
        'This version has an uploaded source document — the candidacy check reads it automatically on ingest, and the Routing Analyst can read it in full.'
      );
    }
    return applies(
      'No uploaded document on this version — the Routing Analyst can still be run manually from the questions and any already-authored topics alone.'
    );
  },
});
