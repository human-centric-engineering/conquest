import { ConquestHeaderMark } from '@/components/app/questionnaire/conquest-header-mark';

/**
 * Scope wrapper for the Demo clients admin subtree.
 *
 * Applies the same ConQuest app-surface identity as the Questionnaires subtree —
 * the `.cq-surface` accent tokens — so the two app surfaces read as a cohesive
 * pair, distinct from orchestration. Typography matches the rest of `/admin`
 * (the platform's default sans). Presentational only; pages keep their own flag
 * guards.
 *
 * Stamps the same ConQuest header wordmark as the Questionnaires subtree (via
 * `ConquestHeaderMark`) so the brand persists across the whole nav section.
 */
export default function DemoClientsAdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="cq-surface">
      <ConquestHeaderMark />
      {children}
    </div>
  );
}
