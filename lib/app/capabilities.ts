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
import { AppExtractQuestionnaireStructureCapability } from '@/lib/app/questionnaire/capabilities';

export function initAppCapabilities(): void {
  // F1.1 — questionnaire ingestion. The capability is inert until the
  // APP_QUESTIONNAIRES_ENABLED flag is on (only the flag-gated ingestion route
  // dispatches it), so registering it unconditionally here is safe.
  registerAppCapability(new AppExtractQuestionnaireStructureCapability());
}
