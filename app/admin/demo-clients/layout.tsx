/**
 * Scope wrapper for the Demo clients admin subtree.
 *
 * Applies the same ConQuest app-surface identity as the Questionnaires subtree —
 * the `--font-display` serif variable plus the `.cq-surface` accent tokens — so
 * the two app surfaces read as a cohesive pair, distinct from orchestration.
 * Presentational only; pages keep their own flag guards.
 */
import { displaySerif } from '@/components/admin/cq-fonts';
import { cn } from '@/lib/utils';

export default function DemoClientsAdminLayout({ children }: { children: React.ReactNode }) {
  return <div className={cn(displaySerif.variable, 'cq-surface')}>{children}</div>;
}
