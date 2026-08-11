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
