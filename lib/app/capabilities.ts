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
  AppAssignDataSlotsCapability,
  AppAuthorIntroBackgroundCapability,
  AppComposeCompletionOfferCapability,
  AppComposeQuestionnaireCapability,
  AppDetectContradictionsCapability,
  AppEvaluateStructureCapability,
  AppExtractAnswerSlotsCapability,
  AppExtractQuestionnaireStructureCapability,
  AppGenerateDataSlotsCapability,
  AppRefineAnswerCapability,
  AppRefineDataSlotCapability,
  AppRefineQuestionnaireStructureCapability,
} from '@/lib/app/questionnaire/capabilities';

export function initAppCapabilities(): void {
  // F1.1 — questionnaire ingestion. The capability is inert until the
  // APP_QUESTIONNAIRES_ENABLED flag is on (only the flag-gated ingestion route
  // dispatches it), so registering it unconditionally here is safe.
  registerAppCapability(new AppExtractQuestionnaireStructureCapability());

  // F4.2 — answer extraction. Inert until the APP_QUESTIONNAIRES_ENABLED master
  // flag and the APP_QUESTIONNAIRES_ANSWER_EXTRACTION sub-flag are both on (only
  // the flag-gated preview route dispatches it), so unconditional registration
  // here is safe.
  registerAppCapability(new AppExtractAnswerSlotsCapability());

  // F4.3 — contradiction detection. Inert until the APP_QUESTIONNAIRES_ENABLED
  // master flag and the APP_QUESTIONNAIRES_CONTRADICTION_DETECTION sub-flag are
  // both on (only the flag-gated preview route dispatches it), so unconditional
  // registration here is safe.
  registerAppCapability(new AppDetectContradictionsCapability());

  // F4.4 — answer refinement. Inert until the APP_QUESTIONNAIRES_ENABLED master
  // flag and the APP_QUESTIONNAIRES_ANSWER_REFINEMENT sub-flag are both on (only
  // the flag-gated refine-answer route dispatches it), so unconditional
  // registration here is safe.
  registerAppCapability(new AppRefineAnswerCapability());

  // F4.5 — completion-offer composition. Inert until the APP_QUESTIONNAIRES_ENABLED
  // master flag and the APP_QUESTIONNAIRES_COMPLETION sub-flag are both on (only the
  // flag-gated completion-status route dispatches it), so unconditional registration
  // here is safe.
  registerAppCapability(new AppComposeCompletionOfferCapability());

  // F5.1 — design-time structure evaluation. Inert until the APP_QUESTIONNAIRES_ENABLED
  // master flag and the APP_QUESTIONNAIRES_DESIGN_EVALUATION sub-flag are both on (only
  // the flag-gated evaluate-preview route dispatches it), so unconditional registration
  // here is safe.
  registerAppCapability(new AppEvaluateStructureCapability());

  // Data Slots — the data-slot generator. Inert until the APP_QUESTIONNAIRES_ENABLED master
  // flag and the APP_QUESTIONNAIRES_DATA_SLOTS sub-flag are both on (only the flag-gated
  // generate-data-slots route dispatches it), so unconditional registration here is safe.
  registerAppCapability(new AppGenerateDataSlotsCapability());

  // Data Slots — single-slot refinement. Reuses the generator agent; inert until the same flags
  // are on (only the flag-gated refine route dispatches it), so unconditional registration is safe.
  registerAppCapability(new AppRefineDataSlotCapability());

  // Data Slots — assign newly-added (orphaned) questions to existing slots or new ones. Reuses the
  // generator agent; inert until the same flags are on (only the flag-gated assign route dispatches
  // it), so unconditional registration here is safe.
  registerAppCapability(new AppAssignDataSlotsCapability());

  // Generative authoring — compose a questionnaire from a plain-English brief. Inert until the
  // APP_QUESTIONNAIRES_ENABLED master flag and the APP_QUESTIONNAIRES_GENERATIVE_AUTHORING sub-flag
  // are both on (only the flag-gated compose routes dispatch it), so unconditional registration is safe.
  registerAppCapability(new AppComposeQuestionnaireCapability());

  // Generative authoring — conversational refinement of a composed structure. Reuses the composer
  // agent; inert until the same flags are on (only the flag-gated refine route dispatches it), so
  // unconditional registration here is safe.
  registerAppCapability(new AppRefineQuestionnaireStructureCapability());

  // Respondent intro — generate / refine the "about this questionnaire" background markdown. Reuses
  // the composer agent; inert until the APP_QUESTIONNAIRES_ENABLED + intro-screen flags are on (only
  // the flag-gated intro-background author route dispatches it), so unconditional registration is safe.
  registerAppCapability(new AppAuthorIntroBackgroundCapability());
}
