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
import { ClipboardList } from 'lucide-react';

import { registerNavSection } from '@/lib/admin-nav/registry';

export function initAppNav(): void {
  // ConQuest questionnaires (P2 / F2.1). The whole surface is flag-gated server
  // side (`APP_QUESTIONNAIRES_ENABLED`); this nav entry is always present in the
  // sidebar, but every page/route under it 404s when the flag is off.
  registerNavSection({
    title: 'Questionnaires',
    items: [
      {
        href: '/admin/questionnaires',
        label: 'Questionnaires',
        icon: ClipboardList,
        description: 'Ingest, review, and edit conversational questionnaires',
      },
    ],
  });
}
