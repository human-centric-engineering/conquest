/**
 * App admin-sidebar nav registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: `components/admin/admin-sidebar.tsx` calls this once at module
 * load (client runtime). Add `registerNavSection({ … })` calls. Keep this file
 * client-safe — registrar + icon imports only, no server code — and use a
 * `title` distinct from the core sections.
 *
 * Full guide + example: CUSTOMIZATION.md §4 · lib/admin-nav/registry.ts
 */
import { createElement } from 'react';
import { Building2, ClipboardList, Gauge, MessageSquareText } from 'lucide-react';

import { QuestionnairesNavBrand } from '@/components/app/questionnaire/questionnaires-nav-brand';
import { registerNavSection } from '@/lib/admin-nav/registry';

export function initAppNav(): void {
  // ConQuest questionnaires (P2 / F2.1). The whole surface is flag-gated server
  // side (`APP_QUESTIONNAIRES_ENABLED`); this nav entry is always present in the
  // sidebar, but every page/route under it 404s when the flag is off.
  registerNavSection({
    title: 'Questionnaires',
    // Replace the plain uppercase label with the ConQuest brand lockup so the
    // app surface carries the product identity (matches the marketing pages).
    titleNode: createElement(QuestionnairesNavBrand),
    items: [
      {
        href: '/admin/questionnaires',
        label: 'Questionnaires',
        icon: ClipboardList,
        description: 'Ingest, review, and edit conversational questionnaires',
        // Exact match: sibling pages live under `/admin/questionnaires/*` (e.g. the
        // prompt library), so a prefix match would light this item up on those too.
        exact: true,
      },
      {
        href: '/admin/questionnaires/prompts',
        label: 'Prompt library',
        icon: MessageSquareText,
        description: 'Read the exact prompts each questionnaire agent sends',
      },
      {
        href: '/admin/questionnaires/turn-evaluations',
        label: 'Turn evaluations',
        icon: Gauge,
        description: 'Search, review, and flag persisted interview-turn evaluations',
      },
      // DEMO-ONLY (F2.5.1): demo-client attribution + branding for the sales demo.
      // A real client engagement strips demo tenancy — see forking.md.
      {
        href: '/admin/demo-clients',
        label: 'Demo clients',
        icon: Building2,
        description: 'Attribute questionnaires to a prospect for branded demos',
      },
    ],
  });
}
