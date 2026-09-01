/**
 * ConQuest self-branding for the Questionnaire Pack (see `build-pack-model.ts`).
 *
 * The one place the product's own tagline/website/closing blurb are authored, so the PDF, CSV, and
 * Markdown serialisers can't drift from each other. Distinct from `ConquestWordmark`
 * (`components/app/questionnaire/conquest-wordmark.tsx`), which is a DOM component for the admin
 * app chrome — this is plain data, consumed by a React-PDF document and two plain-text serialisers
 * that have no DOM to render into. The colour values mirror
 * `conquest-wordmark.module.css`'s light-mode palette (this artifact is always rendered "light",
 * same as every other exported document in this app).
 */

export const PACK_BRAND = {
  brandInk: '#16213d',
  brandMarigold: '#ffb300',
  brandTaglineColor: '#b4730b',
  tagline: 'Conversational Questionnaires',
  website: 'conquestinsights.com',
  closingHeading: 'About ConQuest',
  closingBlurb:
    'ConQuest turns a static questionnaire into a natural, one-on-one conversation. The same ' +
    "instrument you've always used, delivered as a guided dialogue that adapts its questions to " +
    "what's already been said instead of marching through a form. Teams use it for employee " +
    'engagement and pulse surveys, customer and product feedback, market and UX research, intake ' +
    'and screening forms, and academic or qualitative research — anywhere a questionnaire would ' +
    'otherwise feel like a form to fill in rather than a conversation to have.',
} as const;

/**
 * A timestamp as a person reads it in a document: `6 Jul 2026, 18:01`.
 *
 * Every date the pack printed was a raw ISO string — "Last run 2026-08-30T09:12:44.118Z" over a
 * judge scoreboard, "Generated 2026-08-30T09:12:44.118Z" in the page footer. That is a machine's
 * value in a document that is otherwise written for a reader, and the milliseconds and the `Z` are
 * noise nobody in the audience can use.
 *
 * Not `formatCompactDateTime` (`lib/utils/format-datetime.ts`), which drops the year within the
 * current year. That is right for a dense admin table read today and wrong for a document that is
 * filed, mailed on, and opened next spring.
 *
 * **`en-GB` and UTC explicitly, and the zone is named in the output.** Both are accidents of
 * deployment otherwise: the same run would print as "11 Aug 2026, 00:00" from one region's server
 * and "10 Aug 2026, 20:00" from another's, which for a late-evening run is a different DAY on a
 * document somebody may be reading as a record. Naming the zone costs four characters and makes the
 * value unambiguous to whoever opens it; leaving it to the host makes it unassertable in a test and
 * unexplainable to a reader.
 *
 * Returns `null` for a null/unparseable input, so callers state the absence in their own words
 * rather than printing "Invalid Date".
 */
export function formatPackDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${date}, ${time} UTC`;
}
