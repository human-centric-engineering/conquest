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
  AppComposeCompletionOfferCapability,
  AppDetectContradictionsCapability,
  AppExtractAnswerSlotsCapability,
  AppExtractQuestionnaireStructureCapability,
  AppRefineAnswerCapability,
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
}
