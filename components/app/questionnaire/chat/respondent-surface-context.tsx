'use client';

/**
 * What a PORTALLED piece of the respondent surface needs in order to still look like it.
 *
 * The surface's identity lives entirely on the `BrandThemeProvider`'s own `<div>`:
 * `data-surface="respondent"` re-scopes the palette to the neutral white-label canvas (see
 * `app/brand-theme.css`), and an inline style carries the client's `--app-*` brand variables.
 * Anything rendered through a React portal — the answer review drawer, the interviewer switcher,
 * the final-check modal — lands on `document.body`, OUTSIDE that div, and therefore inherits
 * neither: it comes out wearing the surrounding ConQuest consumer brand (cream canvas, Fraunces
 * headings) with none of the client's colours, in the middle of a neutral questionnaire.
 *
 * That was survivable while the only portalled panel was a phone-width sheet nobody saw on a
 * desktop. It stopped being survivable when a layout kept that sheet at every width.
 *
 * Portalling INTO the provider's div would fix it too, but couples every portal to a DOM ref and
 * quietly depends on no ancestor ever gaining a `transform` — which would make it the containing
 * block for `position: fixed` and break every portal at once (the carousel already does exactly
 * that, deeper in the tree). Re-applying the marker and the variables at the portal's own root has
 * neither problem.
 *
 * ## Why this is its own file
 *
 * `BrandThemeProvider` is a SERVER component — the respondent pages render it directly — so it can
 * hold neither a context nor a hook. It renders this client provider around its children instead,
 * passing the already-computed attributes down as plain serialisable props. Keeping the two apart
 * also stops the drawer's `useRespondentSurfaceAttrs` import from dragging the whole brand band
 * into the client bundle.
 */

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';

import type { RespondentDesign } from '@/lib/app/questionnaire/types';

export interface RespondentSurfaceAttrs {
  /** Put on the portalled root: re-scopes the palette to the respondent canvas. */
  'data-surface': 'respondent';
  /** Present only for an unbranded questionnaire, where ConQuest owns the surface. */
  'data-brand'?: 'conquest';
  /**
   * Present only when the client set a canvas colour of their own. Switches the whole
   * neutral palette — cards, borders, muted text — to tones derived from that ground, so a
   * portalled panel over a midnight canvas is not a white card (see app/brand-theme.css).
   */
  'data-canvas'?: 'custom';
  /**
   * The questionnaire's DESIGN — corners, rules, and how structural the brand is. Always present,
   * unlike the two above, because every questionnaire has a design (`rounded` by default) whereas
   * only some have a ConQuest fallback or a custom ground.
   *
   * It has to travel to portals for the same reason the palette does, and the symptom is louder: a
   * `press` questionnaire whose answers drawer slid up with soft corners and a drop shadow would
   * not look like a subtle inconsistency, it would look like a different product. The answers
   * drawer is the portal that matters most here — one layout keeps it on screen at every width.
   */
  'data-design': RespondentDesign;
  /** The client's `--app-*` brand variables. */
  style: CSSProperties;
}

const RespondentSurfaceContext = createContext<RespondentSurfaceAttrs | null>(null);

export function RespondentSurfaceProvider({
  attrs,
  children,
}: {
  attrs: RespondentSurfaceAttrs;
  children: ReactNode;
}) {
  return (
    <RespondentSurfaceContext.Provider value={attrs}>{children}</RespondentSurfaceContext.Provider>
  );
}

/**
 * Attributes to spread onto a portalled root so it inherits the respondent surface.
 *
 * `null` outside a `BrandThemeProvider` — spread it conditionally rather than assuming, since
 * several of these components are also rendered by admin surfaces that have no brand at all.
 */
export function useRespondentSurfaceAttrs(): RespondentSurfaceAttrs | null {
  return useContext(RespondentSurfaceContext);
}
