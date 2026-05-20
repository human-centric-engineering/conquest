import { permanentRedirect } from 'next/navigation';

/**
 * Legacy URL: the live engine dashboard used to live here at
 * `/admin/orchestration/executions/live`. It has been folded into
 * the executions page (`/admin/orchestration/executions`) so cards
 * and rows share one URL.
 *
 * The redirect preserves any sidebar bookmarks, deep links from
 * Slack alerts, or partner-shared URLs that referenced the old
 * location. `permanentRedirect()` (308) tells crawlers and SDKs to
 * update their cached link target.
 */
export default function LiveEngineRedirectPage(): never {
  permanentRedirect('/admin/orchestration/executions');
}
