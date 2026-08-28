/**
 * DEMO-ONLY (F3.4): demo-client theming module barrel.
 *
 * The resolver + CSS-variable projector (`theme.ts`) and the admin field validators
 * (`schemas.ts`). Consumed by the invitation-email send seam (F3.4) and, later, the
 * F7.1 user UI. See .context/app/questionnaire/demo-clients.md.
 */

export {
  type DemoClientTheme,
  type ResolvedTheme,
  CONQUEST_THEME_DEFAULTS,
  MIN_CONTRAST_RATIO,
  NEUTRAL_RESPONDENT_GROUND,
  canvasBackdropVars,
  contrastRatio,
  cssUrl,
  readableTextColor,
  resolveTheme,
  themeToCssVariables,
} from '@/lib/app/questionnaire/theming/theme';

export {
  HEX_COLOR_PATTERN,
  WELCOME_COPY_MAX,
  isHttpsUrl,
  themeFields,
  themeFieldsSchema,
  type ThemeFieldsInput,
} from '@/lib/app/questionnaire/theming/schemas';

export {
  BRAND_BANNER_SPEC,
  BRAND_IMAGE_SPECS,
  BRAND_LOGO_SPEC,
  BRAND_MARK_SPEC,
  type BrandImageKind,
  isBrandImageSrc,
  recommendedSize,
  validateImageDimensions,
  type BrandImageSpec,
} from '@/lib/app/questionnaire/theming/brand-image';

export { DEMO_CLIENT_THEME_SELECT } from '@/lib/app/questionnaire/theming/select';

export {
  DEFAULT_FONT_PAIRING,
  FONT_PAIRINGS,
  FONT_PAIRING_COPY,
  FONT_PAIRING_STACKS,
  MONO_FONT_STACK,
  NEUTRAL_FONT_STACK,
  resolveFontPairing,
  type FontPairing,
} from '@/lib/app/questionnaire/theming/fonts';
