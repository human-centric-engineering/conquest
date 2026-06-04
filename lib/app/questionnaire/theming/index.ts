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
  SUNRISE_THEME_DEFAULTS,
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
