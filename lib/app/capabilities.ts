/**
 * App capability (agent tool) registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: `registerBuiltInCapabilities()` calls this once before the first
 * agent dispatch (server route-handler runtime). Add
 * `registerAppCapability(new YourTool())` calls (your tools extend
 * `BaseCapability`).
 *
 * Full guide + example: CUSTOMIZATION.md §4 · .context/orchestration/capabilities.md
 */
import { registerAppCapability } from '@/lib/orchestration/capabilities/registry';
import {
  AppAnalyseGlossaryTermsCapability,
  AppAnalyseRoutingCapability,
  AppAssignDataSlotsCapability,
  AppAuthorIntroBackgroundCapability,
  AppComposeCompletionOfferCapability,
  AppComposeQuestionnaireCapability,
  AppDetectContradictionsCapability,
  AppDetectScopeCandidacyCapability,
  AppEvaluateScopeCapability,
  AppEvaluateStructureCapability,
  AppReconcileSuggestionsCapability,
  AppExtractAnswerSlotsCapability,
  AppExtractQuestionnaireStructureCapability,
  AppGenerateDataSlotsCapability,
  AppRefineAnswerCapability,
  AppRefineDataSlotCapability,
  AppRefineQuestionnaireStructureCapability,
  AppRepairQuestionsCapability,
  AppSuggestRoundBriefingCapability,
  AppVerifyExtractionStructureCapability,
  AppWebSearchCapability,
} from '@/lib/app/questionnaire/capabilities';

/**
 * Register every ConQuest capability with the app capability dispatcher.
 *
 * Registration is wiring only: it makes a capability *dispatchable*, it does not run anything.
 * Each capability executes solely when its owning route or orchestrator dispatches it by slug,
 * so registering the full set unconditionally here is safe — an unused capability simply sits
 * in the table. Access control lives on the routes (`withAdminAuth`), not here.
 */
export function initAppCapabilities(): void {
  // F1.1 — questionnaire ingestion. Dispatched by the ingestion route.
  registerAppCapability(new AppExtractQuestionnaireStructureCapability());

  // F4.2 — answer extraction. Dispatched by the preview route.
  registerAppCapability(new AppExtractAnswerSlotsCapability());

  // F4.3 — contradiction detection. Dispatched by the preview route.
  registerAppCapability(new AppDetectContradictionsCapability());

  // F4.4 — answer refinement. Dispatched by the refine-answer route.
  registerAppCapability(new AppRefineAnswerCapability());

  // F4.5 — completion-offer composition. Dispatched by the completion-status route.
  registerAppCapability(new AppComposeCompletionOfferCapability());

  // F5.1 — design-time structure evaluation. Dispatched by the evaluate-preview route.
  registerAppCapability(new AppEvaluateStructureCapability());

  // Cross-judge reconciliation — runs once after the panel, over the questions more than one
  // judge flagged. Dispatched by `runEvaluationPanel`.
  registerAppCapability(new AppReconcileSuggestionsCapability());

  // Ingest verify + repair — the extraction critic + scales/matrix repair specialist that run
  // between extract and persist on the streaming ingest surface. Dispatched by the orchestrator.
  registerAppCapability(new AppVerifyExtractionStructureCapability());
  registerAppCapability(new AppRepairQuestionsCapability());

  // Definitions / glossary (P16) — proposes ambiguous terms + candidate definitions for an admin
  // to adjudicate. Dispatched by the Definitions tab's analysis route.
  registerAppCapability(new AppAnalyseGlossaryTermsCapability());

  // Adaptive Scope (P17.4) — the Routing Analyst. Reads the uploaded instrument's own instruction
  // pages and proposes the topics + hard rules they describe. Dispatched by the Topics tab's
  // analysis route; writes nothing live.
  registerAppCapability(new AppAnalyseRoutingCapability());

  // Adaptive Scope (P17.19) — the ingestion-time candidacy check. A cheap triage read that decides
  // whether a freshly-uploaded document is worth flagging as a routing candidate. Dispatched by the
  // ingest pipeline, on every fresh upload; writes nothing itself.
  registerAppCapability(new AppDetectScopeCandidacyCapability());

  // Adaptive Scope (F17.21) — the scope-evaluation judge panel. One judge per dimension
  // (criteria_quality, rule_integrity, budget_realism, coverage_and_burden) scoring the authored
  // topics/rules/budget. Dispatched once per dimension by the scope evaluate-preview route.
  registerAppCapability(new AppEvaluateScopeCapability());

  // Data Slots — the data-slot generator. Dispatched by the generate-data-slots route.
  registerAppCapability(new AppGenerateDataSlotsCapability());

  // Data Slots — single-slot refinement. Reuses the generator agent; dispatched by the refine route.
  registerAppCapability(new AppRefineDataSlotCapability());

  // Data Slots — assign newly-added (orphaned) questions to existing slots or new ones. Reuses the
  // generator agent; dispatched by the assign route.
  registerAppCapability(new AppAssignDataSlotsCapability());

  // Generative authoring — compose a questionnaire from a plain-English brief. Dispatched by the
  // compose routes.
  registerAppCapability(new AppComposeQuestionnaireCapability());

  // Generative authoring — conversational refinement of a composed structure. Reuses the composer
  // agent; dispatched by the refine route.
  registerAppCapability(new AppRefineQuestionnaireStructureCapability());

  // Respondent intro — generate / refine the "about this questionnaire" background markdown. Reuses
  // the composer agent; dispatched by the intro-background author route.
  registerAppCapability(new AppAuthorIntroBackgroundCapability());

  // Round Additional Context — propose interviewer "briefing" notes from a questionnaire (+ optional
  // source material). Reuses the composer agent; dispatched by the suggest route.
  registerAppCapability(new AppSuggestRoundBriefingCapability());

  // Report web search — the query-only search tool the Report Research agent calls in its tool loop.
  // Dispatched by the report research loop, and inert unless the search backend is configured
  // (Brave key + allowlisted host); it returns a structured error rather than throwing when not.
  registerAppCapability(new AppWebSearchCapability());
}
