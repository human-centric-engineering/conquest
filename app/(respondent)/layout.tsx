import type { Metadata } from 'next';
import { MaintenanceWrapper } from '@/components/maintenance-wrapper';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: {
    template: `%s - ${BRAND.name}`,
    default: BRAND.name,
  },
};

/**
 * Respondent layout — deliberately almost nothing.
 *
 * `/q`, `/x` and `/m` lived in `(public)` and therefore inherited the marketing header, the
 * marketing footer and a nav a respondent could wander into half-way through answering. Route
 * groups do not change URLs, so moving them here changes no link anyone holds; it only stops them
 * inheriting chrome they never chose.
 *
 * The chrome each page DOES want is now a per-questionnaire setting, rendered by the page itself
 * through `<RespondentChrome>` — which is also what makes the surface's height self-measuring
 * rather than a `calc()` against whatever chrome the page assumed. That is why nothing here
 * renders a shell: a layout that drew one would be a fourth thing with an opinion about the height,
 * and the point of this phase is that exactly one thing has that opinion.
 *
 * `MaintenanceWrapper` stays, because a respondent surface is exactly where a maintenance window
 * must be honoured — a half-answered questionnaire against a database that is going down is worse
 * than a closed sign.
 *
 * The title template stays too, so `full` and `co_branded` tabs read as they always have. A
 * `white_label` page overrides it with an absolute title, since a client presenting the instrument
 * as their own should not have our name in the respondent's tab — see `/q`'s `generateMetadata`.
 */
export default function RespondentLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <MaintenanceWrapper>{children}</MaintenanceWrapper>;
}
