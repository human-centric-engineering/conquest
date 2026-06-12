/**
 * Scope wrapper for the Questionnaires admin subtree.
 *
 * Applies the ConQuest app-surface identity — the `--font-display` serif
 * variable (from `cq-fonts.ts`) plus the `.cq-surface` accent tokens (defined in
 * `globals.css`) — to everything under `/admin/questionnaires`. Purely
 * presentational: no data fetching or flag gating happens here (each page owns
 * its own guards), so the wrapper stays cheap and never blocks rendering.
 */
import { displaySerif } from '@/components/admin/cq-fonts';
import { cn } from '@/lib/utils';

export default function QuestionnairesAdminLayout({ children }: { children: React.ReactNode }) {
  return <div className={cn(displaySerif.variable, 'cq-surface')}>{children}</div>;
}
