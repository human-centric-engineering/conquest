import { ConquestHeaderMark } from '@/components/app/questionnaire/conquest-header-mark';

/**
 * Scope wrapper for the Experiences admin subtree.
 *
 * Mirrors the Questionnaires layout exactly: applies the ConQuest app-surface identity (the
 * `.cq-surface` accent tokens defined in `globals.css`) to everything under `/admin/experiences`,
 * and stamps the wordmark into the admin header bar. Experiences are part of the same product
 * surface as questionnaires, so they carry the same chrome rather than inventing their own.
 *
 * Purely presentational — no data fetching or gating happens here; each page owns its guards.
 */
export default function ExperiencesAdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="cq-surface">
      <ConquestHeaderMark />
      {children}
    </div>
  );
}
