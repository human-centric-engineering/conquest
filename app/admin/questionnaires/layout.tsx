/**
 * Scope wrapper for the Questionnaires admin subtree.
 *
 * Applies the ConQuest app-surface identity — the `.cq-surface` accent tokens
 * (defined in `globals.css`) — to everything under `/admin/questionnaires`.
 * Typography matches the rest of `/admin` (the platform's default sans).
 * Purely presentational: no data fetching or flag gating happens here (each page
 * owns its own guards), so the wrapper stays cheap and never blocks rendering.
 */
export default function QuestionnairesAdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="cq-surface">{children}</div>;
}
