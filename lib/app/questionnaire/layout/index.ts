/**
 * Shared layout geometry for the respondent surface.
 *
 * The respondent workspace is hosted by three different pages — the no-login `/q/[versionId]`
 * surface, the Experience-run `/x/[publicRef]` surface, and the signed-in
 * `/questionnaires/[sessionId]` surface. They differ in chrome and in how much vertical budget
 * they can spare, but the *horizontal* composition must be identical: a respondent who moves
 * between legs of an Experience (signed-in leg → no-login leg) would otherwise watch the whole
 * conversation jump width mid-journey. Hence one exported class string rather than three copies
 * that drift.
 *
 * Class strings (not numbers) because the values are consumed as Tailwind utilities; Tailwind 4
 * scans this file like any other source, so the arbitrary variants below are emitted normally.
 */

/**
 * The respondent shell's width.
 *
 * Historically this was a flat `max-w-6xl` (72rem), which meant a 27" display showed the same
 * 1152px ribbon as a 13" laptop with ~700px of dead space either side. It then briefly ran its own
 * width ladder (76 → 90 → 104 → 112rem), which fixed the dead space but introduced a worse
 * problem: the shell no longer agreed with the page chrome around it. The site header and footer
 * are `container mx-auto px-4`, so on a 1800px display the conversation sat ~32px inside the
 * header's logo and account button on both edges — a visible, unexplainable misalignment on the
 * one surface a respondent stares at for twenty minutes.
 *
 * So the shell simply *is* the header's container. One rule, no ladder to keep in step: whatever
 * width the header content occupies, the conversation occupies exactly the same. Widescreen
 * comfort comes from the other two moves instead — {@link RESPONDENT_SPLIT} hands the surplus to
 * the answer panel, and `--cq-chat-viewport-scale` in `globals.css` grows the conversation
 * *typographically* rather than just running the lines longer.
 *
 * Host pages supply the matching `px-4` themselves (the signed-in surface inherits it from the
 * protected layout's own `container`), which is what makes the inner edges line up rather than
 * just the outer ones.
 *
 * `cq-respondent-shell` is the hook the viewport text-scale media queries key off; it rides here
 * so every host gets the scale by construction.
 */
export const RESPONDENT_SHELL = 'cq-respondent-shell container mx-auto';

/**
 * The chat surface's two-column split: conversation ⇄ answer panel.
 *
 * The panel track widens with the viewport so the extra room lands on content that genuinely wants
 * it — captured paraphrases at 22rem wrap after a handful of words — rather than all of it
 * inflating the transcript's line length. The conversation column takes the remainder via
 * `minmax(0,1fr)`; `0` (not `auto`) is what stops a long unbroken token in a reply from forcing
 * the track wider than its share.
 *
 * The ladder stops at the `2xl` step because {@link RESPONDENT_SHELL} stops there too (the header
 * container caps at 96rem). Past that point a wider panel would only be taking width off the
 * conversation, not spending width the shell had just gained.
 *
 * Below `lg` the panel is hidden entirely (the respondent reviews answers through the bottom
 * sheet instead), so the ladder starts there.
 */
export const RESPONDENT_SPLIT =
  'gap-4 2xl:gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem] 2xl:grid-cols-[minmax(0,1fr)_30rem]';
