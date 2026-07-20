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
import {
  Building2,
  ClipboardList,
  MessageSquareText,
  Route,
  SlidersHorizontal,
  TicketCheck,
  Workflow,
} from 'lucide-react';

import { QuestionnairesNavBrand } from '@/components/app/questionnaire/questionnaires-nav-brand';
import { registerNavSection } from '@/lib/admin-nav/registry';
import { IS_ALPHA } from '@/lib/app/release-stage';

export function initAppNav(): void {
  // ConQuest questionnaires (P2 / F2.1). Routes under this surface are admin-only
  // (`withAdminAuth`); this nav entry is only rendered for admins by the sidebar.
  registerNavSection({
    title: 'Questionnaires',
    // Replace the plain uppercase label with the ConQuest brand lockup so the
    // app surface carries the product identity (matches the marketing pages).
    titleNode: createElement(QuestionnairesNavBrand),
    items: [
      // DEMO-ONLY (F2.5.1): demo-client attribution + branding for the sales demo.
      // A real client engagement strips demo tenancy — see forking.md.
      {
        href: '/admin/demo-clients',
        label: 'Demo clients',
        icon: Building2,
        description: 'Attribute questionnaires to a prospect for branded demos',
      },
      {
        href: '/admin/questionnaires',
        label: 'Questionnaires',
        icon: ClipboardList,
        description: 'Ingest, review, and edit conversational questionnaires',
        // Exact match: sibling pages live under `/admin/questionnaires/*` (e.g. the
        // prompt library), so a prefix match would light this item up on those too.
        exact: true,
      },
      // Experiences (P15): journeys composed from questionnaires. Sits directly beneath
      // Questionnaires because it consumes them — an experience sequences questionnaires you have
      // already authored, it never replaces authoring them.
      {
        href: '/admin/experiences',
        label: 'Experiences',
        icon: Route,
        description: 'Compose journeys from your questionnaires',
      },
      {
        href: '/admin/questionnaires/prompts',
        label: 'Prompt library',
        icon: MessageSquareText,
        description: 'Read the exact prompts each questionnaire agent sends',
      },
      {
        href: '/admin/questionnaires/behind-the-scenes',
        label: 'Agentic Workflows',
        icon: Workflow,
        description: 'See the agentic pipelines — agents, prompts, tools, knowledge',
      },
      {
        href: '/admin/questionnaires/agent-settings',
        label: 'Agent settings',
        icon: SlidersHorizontal,
        description: 'Review and tune agent models, temperatures and cost trade-offs',
      },
      // NOTE: no standalone "Turn evaluations" nav item — turn evaluations live WITHIN a session (the
      // Sessions drawer's Evaluations tab). The cross-session Turn Evaluations page still exists at
      // `/admin/questionnaires/turn-evaluations` and is reached from that drawer's "Open Turn
      // evaluations" link; it is intentionally not surfaced as a top-level menu entry.
      // ALPHA-ONLY: the Sessions console — browse/filter sessions, open one (transcript + report +
      // its turn evaluations). Present only while the product is in the alpha release stage; the page +
      // API 404 otherwise, so the entry hides to match.
      ...(IS_ALPHA
        ? [
            {
              href: '/admin/questionnaires/sessions',
              label: 'Sessions',
              icon: TicketCheck,
              description:
                'Alpha: browse and filter respondent sessions, open a conversation + report',
            },
          ]
        : []),
    ],
  });
}
